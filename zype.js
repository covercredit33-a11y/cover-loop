const mongoose = require("mongoose");
const axios = require("axios");
require("dotenv").config();

// ==========================================================
// CONFIGURATION (Matches Python Script Constants)
// ==========================================================
const BASE_URL = "https://prod.zype.co.in/attribution-service";
const ELIGIBILITY_URL = `${BASE_URL}/api/v1/underwriting/customerEligibility`;
const PREAPPROVAL_URL = `${BASE_URL}/api/v1/underwriting/preApprovalOffer`;
const PARTNER_ID = "8b9e3456-121a-40cd-84bc-d558758452e8";

const BATCH_SIZE = 20; // Number of records to query from MongoDB per batch
const MAX_SUCCESSFUL_LEADS = 5;
const LENDER_NAME = "zype";
const RESPONSE_COLLECTION_NAME = "zyperesponses";

const MONGODB_URI = process.env.MONGODB_read;

if (!MONGODB_URI) {
  console.error("❌ ERROR: MONGODB_read is not defined in environment variables!");
  process.exit(1);
}

// ==========================================================
// MONGOOSE CONNECT
// ==========================================================
mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB Connected Successfully");
  })
  .catch((err) => {
    console.error("🚫 MongoDB Connection Error:", err);
    process.exit(1);
  });

// Schema definitions
const UserDB = mongoose.model(
  "api_user",
  new mongoose.Schema({}, { collection: "api_user", strict: false })
);

const ResponseDB = mongoose.model(
  "zypeLeadResponses",
  new mongoose.Schema({}, { collection: RESPONSE_COLLECTION_NAME, strict: false })
);

// Helper function for artificial delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ==========================================================
// DATE FORMATTING (Matches Python format_dob)
// ==========================================================
function formatDob(dobString) {
  if (!dobString) return "1990-01-01";

  if (dobString instanceof Date) {
    return dobString.toISOString().split("T")[0];
  }

  const str = String(dobString).trim().replace(/[/.]/g, "-");
  const invalidDates = ["0000-00-00", "01-01-1900", "01-01-0001", "1900-01-01"];
  
  if (invalidDates.includes(str)) return "1990-01-01";

  const parts = str.split("-");
  if (parts.length === 3) {
    let year, month, day;
    if (parts[0].length === 4) {
      [year, month, day] = parts;
    } else if (parts[2].length === 4) {
      [day, month, year] = parts;
    }

    if (year && month && day) {
      const formattedMonth = month.padStart(2, "0");
      const formattedDay = day.padStart(2, "0");
      const parsedDate = new Date(`${year}-${formattedMonth}-${formattedDay}`);
      if (!isNaN(parsedDate.getTime())) {
        return `${year}-${formattedMonth}-${formattedDay}`;
      }
    }
  }
  return "1990-01-01"; // Default fallback
}

// ==========================================================
// ZYPE API CALLS (Matching Python Step 1 & Step 2)
// ==========================================================

// Step 1: Check Eligibility (Dedupe)
async function checkEligibility(user) {
  const payload = {
    mobileNumber: String(user.phone || "").trim(),
    panNumber: String(user.pan || "").trim(),
    partnerId: PARTNER_ID
  };

  try {
    console.log(`📤 [ELIGIBILITY] Sending for user: ${user.phone}`);
    const response = await axios.post(ELIGIBILITY_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });
    console.log(`📩 [ELIGIBILITY] Response for ${user.phone}:`, response.data);
    return response.data;
  } catch (err) {
    const errData = err.response?.data || { error: err.message };
    console.error(`⚠️ [ELIGIBILITY] Error for ${user.phone}:`, errData);
    return errData;
  }
}

// Step 2: Check Pre-Approval Offer
async function checkPreApproval(user) {
  const incomeValue = parseFloat(user.income) || 0;
  const formattedDob = formatDob(user.dob);

  const payload = {
    mobileNumber: String(user.phone || "").trim(),
    email: user.email || "test@gmail.com",
    panNumber: String(user.pan || "").trim(),
    name: user.name || "",
    dob: formattedDob,
    income: incomeValue > 0 ? incomeValue : 0,
    employmentType: String(user.employment || "salaried").toLowerCase(),
    partnerId: PARTNER_ID,
    bureauType: 3
  };

  try {
    console.log(`📤 [PRE-APPROVAL] Sending for user: ${user.phone}`);
    const response = await axios.post(PREAPPROVAL_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });
    console.log(`📩 [PRE-APPROVAL] Response for ${user.phone}:`, response.data);
    return response.data;
  } catch (err) {
    const errData = err.response?.data || { error: err.message };
    console.error(`⚠️ [PRE-APPROVAL] Error for ${user.phone}:`, errData);
    return errData;
  }
}

// ==========================================================
// 2-STEP USER PROCESSOR (Mirrors Python UserProcessor)
// ==========================================================
async function processUser(user) {
  const phone = user.phone || "No Phone";
  console.log(`\n👤 Processing User: ${user.name || "Unknown"} (Phone: ${phone})`);

  const apiResponses = {};
  let isSuccess = false;

  try {
    // 1. First API: Check Eligibility
    apiResponses.dedupe = await checkEligibility(user);

    // If Eligibility status is REJECT, stop early and save response
    if (apiResponses.dedupe?.message === "REJECT" || apiResponses.dedupe?.status === "REJECT") {
      console.log(`❌ Application REJECTED at Eligibility stage for ${phone}`);
    } 
    // If ACCEPT or ALREADY EXISTS -> Proceed to 2nd API
    else if (
      apiResponses.dedupe?.status === "ACCEPT" ||
      ["APPLICATION_ALREADY_EXIST", "APPLICATION_ALREADY_EXISTS"].includes(apiResponses.dedupe?.message)
    ) {
      // Delay before calling 2nd API as per Zype documentation
      await delay(2000);

      // 2. Second API: Pre-Approval Offer
      apiResponses.preApproval = await checkPreApproval(user);

      // Retry logic if dedupe not found
      if (
        apiResponses.preApproval?.message === "SUCCESS_DEDUPE_NOT_FOUND" &&
        apiResponses.dedupe?.status === "ACCEPT"
      ) {
        console.warn(`⚠️ Retrying Pre-Approval for ${phone}...`);
        await delay(2000);
        apiResponses.preApproval = await checkPreApproval(user);
      }

      // Check success status
      if (String(apiResponses.preApproval?.status).toLowerCase() === "success") {
        isSuccess = true;
        console.log(`🎉 Pre-Approval SUCCESS for ${phone}`);
      }
    }

    // Save full API responses (including REJECTs) to MongoDB
    await saveResponse(user, apiResponses);

    // Mark as processed in main collection
    await UserDB.updateOne(
      { _id: user._id },
      { $addToSet: { processed: LENDER_NAME } }
    );

    return isSuccess;
  } catch (error) {
    console.error(`🚫 Error processing user ${user._id} (${phone}):`, error.message);
    await saveResponse(user, { error: error.message });
    
    await UserDB.updateOne(
      { _id: user._id },
      { $addToSet: { processed: LENDER_NAME } }
    );
    return false;
  }
}

async function saveResponse(user, responses) {
  try {
    await ResponseDB.create({
      leadId: user._id,
      phone: user.phone ? String(user.phone).trim() : "",
      pan: user.pan ? String(user.pan).trim().toUpperCase() : "",
      responses: {
        Zype: responses,
        createdAt: new Date().toISOString().slice(0, 10)
      },
      createdAt: new Date()
    });
    console.log(`💾 Response saved to database for: ${user.phone}`);
  } catch (err) {
    console.error(`🚫 Database save error for ${user.phone}:`, err.message);
  }
}

// ==========================================================
// MAIN BATCH LOOP
// ==========================================================
async function main() {
  let totalSuccessfulOffers = 0;

  console.log("🚀 Starting Zype 2-Step Flow Sync...");
  console.log(`🎯 Target Successful Offers Limit: ${MAX_SUCCESSFUL_LEADS}\n`);

  try {
    while (totalSuccessfulOffers < MAX_SUCCESSFUL_LEADS) {
      // Find unprocessed users
      const users = await UserDB.find({
        $or: [
          { processed: { $exists: false } },
          { processed: { $nin: [LENDER_NAME] } }
        ]
      })
        .limit(BATCH_SIZE)
        .lean();

      if (users.length === 0) {
        console.log("🏁 No more unprocessed users found in Database.");
        break;
      }

      console.log(`\n📦 Fetched batch of ${users.length} unprocessed users...`);

      // Process users sequentially to prevent rate limits
      for (const user of users) {
        if (totalSuccessfulOffers >= MAX_SUCCESSFUL_LEADS) {
          console.log("🎯 Max successful offer limit reached!");
          break;
        }

        const isSuccessful = await processUser(user);
        if (isSuccessful) {
          totalSuccessfulOffers++;
        }

        await delay(300); // Inter-request delay matching RATE_LIMIT_DELAY
      }

      console.log(`\n📊 Batch Complete. Total Successful Pre-Approvals: ${totalSuccessfulOffers}/${MAX_SUCCESSFUL_LEADS}`);
      await delay(1000);
    }

    console.log("--------------------------------------------------");
    console.log("✅ Sync execution completed.");
    console.log(`🎯 Total Pre-Approval Offers Achieved: ${totalSuccessfulOffers}`);
    console.log("--------------------------------------------------");
  } catch (error) {
    console.error("❌ Fatal error in main execution:", error);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 MongoDB connection closed.");
  }
}

main();