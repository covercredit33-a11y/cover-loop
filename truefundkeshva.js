const mongoose = require("mongoose");
const axios = require("axios");
require("dotenv").config();

const BATCH_SIZE = 5;
const SUBMIT_LEAD_API = "https://api-backend.truefund.in/partner/submit-lead";
const PARTNER_API_KEY = "a3f7e92c8b4d156e9f02ab73c5d8e1f4906b2c5a8d7e3f1029b5c8a4d6e9f2b1";

// Target threshold for successful synchronizations
const MAX_SUCCESSFUL_LEADS = 5;

// Configuration placeholders
const PARTNER_ID = "Keshava";
const UTM_SOURCE = "KeshvaFinance";
const REF_ARR_NAME = "truefund";

const RESPONSE_COLLECTION_NAME = "truefundLeadResponses";

const MONGODB_URINEW = process.env.MONGODB_read;

if (!MONGODB_URINEW) {
  console.error("❌ ERROR: MONGODB_read is not defined in your environment variables!");
  process.exit(1);
}

mongoose
  .connect(MONGODB_URINEW)
  .then(() => {
    console.log("✅ MongoDB Connected Successfully");
    // Print current DB and connection details
    const conn = mongoose.connection;
    console.log(`🏠 Connected to Database: "${conn.name}" on host: "${conn.host}"`);
  })
  .catch((err) => {
    console.error("🚫 MongoDB Connection Error:", err);
    process.exit(1);
  });

const UserDB = mongoose.model(
  "api_user",
  new mongoose.Schema({}, { collection: "api_user", strict: false }),
);

// Separate collection: one document per API call, holding just the
// customer identifiers + the raw response + when it happened.
const ResponseDB = mongoose.model(
  "truefundLeadResponses",
  new mongoose.Schema({}, { collection: RESPONSE_COLLECTION_NAME, strict: false }),
);

// Helper function to calculate age based on DOB string (YYYY-MM-DD)
function calculateAge(dobString) {
  if (!dobString) return 0;
  const today = new Date();
  const birthDate = new Date(dobString);
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}

// Validation function checking age, employment, income, and restricted states
function validateLead(user) {
  // 1. Age Validation (21 - 60)
  const age = calculateAge(user.dob);
  if (age < 21 || age > 60) {
    return {
      valid: false,
      reason: `Age restriction failed. Calculated age: ${age} (Requires 21-60)`
    };
  }

  // 2. Employment Validation
  const empType = String(user.employment || "")
    .trim()
    .toLowerCase();

  if (empType !== "salaried") {
    return {
      valid: false,
      reason: `Employment type restriction failed. Type: '${user.employment}' (Requires 'salaried')`
    };
  }

  // 3. Income Validation
  const incomeNum = Number(user.income || 0);
  if (incomeNum < 20000) {
    return {
      valid: false,
      reason: `Income restriction failed. Income: ${incomeNum} (Requires 20000+)`
    };
  }

  // 4. State Exclusion (Case-insensitive)
  const excludedStates = new Set([
    "arunachal pradesh",
    "assam",
    "manipur",
    "meghalaya",
    "mizoram",
    "nagaland",
    "sikkim",
    "tripura",
    "kashmir",
    "jammu",
    "jammu and kashmir"
  ]);

  const userState = String(user.state || "")
    .trim()
    .toLowerCase();

  if (excludedStates.has(userState)) {
    return {
      valid: false,
      reason: `State restriction failed. State '${user.state}' is excluded.`
    };
  }

  return { valid: true };
}

async function submitLead(user) {
  try {
    const payload = {
      partner_id: PARTNER_ID,
      phone: user.phone ? String(user.phone).trim() : "",
      pan: user.pan ? String(user.pan).trim().toUpperCase() : "",
      utm_source: UTM_SOURCE,
      name: user.name ? String(user.name).trim() : "",
      email: user.email ? String(user.email).toLowerCase().trim() : "",
      dob: user.dob || "",
      employment_type: user.employment || "",
      pincode: user.pincode || "",
      income: user.income ? Number(user.income) : undefined
    };

    const response = await axios.post(SUBMIT_LEAD_API, payload, {
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": PARTNER_API_KEY,
      },
    });

    console.log(`✅ API Response for ${user.phone || "unknown"}:`, response.data);
    return response.data;
  } catch (err) {
    const errorData = err.response?.data || { error: err.message };
    console.error(`❌ API Error for ${user.phone || "unknown"}:`, errorData);
    return errorData;
  }
}

// Saves one record per lead into the separate response collection:
// customer name, pan, phone, the raw api response, and createdAt.
// This runs in addition to (not instead of) the existing $push onto
// the user's own document, and never throws — a logging failure here
// shouldn't stop the batch.
async function saveLeadResponse(user, apiResponse) {
  try {
    await ResponseDB.create({
      name: user.name ? String(user.name).trim() : "",
      pan: user.pan ? String(user.pan).trim().toUpperCase() : "",
      phone: user.phone ? String(user.phone).trim() : "",
      api_response: apiResponse,
      createdAt: new Date(),
    });
  } catch (err) {
    console.error(`❌ Failed to save lead response for ${user.phone || "unknown"}:`, err.message);
  }
}

async function processBatch(users) {
  let successfullyRegisteredCount = 0;

  await Promise.allSettled(
    users.map(async (userDoc) => {
      try {
        const phone = userDoc.phone || "No Phone Field";
        console.log(`\n🚀 Processing Lead for user ID: ${userDoc._id} (${phone})`);

        const validation = validateLead(userDoc);
        let apiResponse;

        if (!validation.valid) {
          console.warn(`⚠️ Lead Skipped: ${validation.reason}`);
          apiResponse = { status: "Skipped", success: false, reason: validation.reason, skippedByScript: true };
        } else {
          apiResponse = await submitLead(userDoc);
        }

        const updateOperation = {
          $push: {
            apiResponse: {
              [REF_ARR_NAME]: apiResponse,
              createdAt: new Date().toISOString(),
            },
          },
          $addToSet: {
            RefArr: {
              name: REF_ARR_NAME,
              createdAt: new Date().toISOString(),
            },
          },
          $unset: { accounts: "" },
        };

        await UserDB.updateOne({ _id: userDoc._id }, updateOperation);
        console.log(`✅ Database updated for user: ${phone}`);

        // Also store a standalone copy of this response in its own collection.
        await saveLeadResponse(userDoc, apiResponse);
        console.log(`💾 Response logged to "${RESPONSE_COLLECTION_NAME}" for user: ${phone}`);

        if (apiResponse && (apiResponse.success === true || apiResponse.statusCode === 201) && !apiResponse.skippedByScript) {
          successfullyRegisteredCount++;
          console.log(`⭐ Lead Accepted Successfully for: ${phone}`);
        }
      } catch (error) {
        console.error(`❌ Failed to process user in batch:`, error.message);
      }
    }),
  );

  return successfullyRegisteredCount;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  let totalRegisteredSuccessfully = 0;

  console.log("🚦 Starting TrueFund lead synchronization with explicit criteria checks...");
  console.log(`🎯 Targeted successful synchronizations limit: ${MAX_SUCCESSFUL_LEADS}\n`);

  try {
    // Wait for Mongoose to be fully connected before querying
    if (mongoose.connection.readyState !== 1) {
      console.log("⏳ Waiting for database connection to stabilize...");
      await new Promise((resolve) => mongoose.connection.once("connected", resolve));
    }

    // Diagnostic Check: Total documents in the target collection
    const totalDocsInCollection = await UserDB.countDocuments({});
    console.log(`📊 Target Collection: "${UserDB.collection.name}"`);
    console.log(`📊 Absolute total documents in collection (unfiltered): ${totalDocsInCollection}`);

    // Loop tab tak chalega jab tak hume targeted success limit nahi mil jati
    while (totalRegisteredSuccessfully < MAX_SUCCESSFUL_LEADS) {
      // Unprocessed documents find karenge jinme REF_ARR_NAME marker na ho
      const users = await UserDB.find({
        $or: [
          { RefArr: { $exists: false } },
          { "RefArr.name": { $ne: REF_ARR_NAME } },
        ],
      })
        .limit(BATCH_SIZE)
        .lean();

      if (users.length === 0) {
        console.log("🏁 No more unmatched documents found in the database matching the criteria.");
        
        // Extra Debugging Help: If absolute total > 0 but query finds nothing, it means all docs are already processed
        if (totalDocsInCollection > 0) {
          console.log("🔍 Info: Documents exist, but they all appear to have already been tagged with 'RefArr.name' = '" + REF_ARR_NAME + "'.");
          const sampleDoc = await UserDB.findOne({}).lean();
          console.log("📄 Here is a sample structure of an existing document in your collection:\n", JSON.stringify(sampleDoc, null, 2));
        } else {
          console.log("❌ Warning: The collection is completely empty. Double-check your database name or connection string.");
        }
        break;
      }

      const batchRegisteredCount = await processBatch(users);
      totalRegisteredSuccessfully += batchRegisteredCount;

      console.log(
        `📊 Batch Completed. Total successful syncs so far: ${totalRegisteredSuccessfully}/${MAX_SUCCESSFUL_LEADS}`
      );

      // Agar target limit bachi hai, tabhi 1 second wait karein
      if (totalRegisteredSuccessfully < MAX_SUCCESSFUL_LEADS) {
        console.log("⏳ Waiting 1 second before next batch...");
        await delay(1000);
      }
    }

    if (totalRegisteredSuccessfully >= MAX_SUCCESSFUL_LEADS) {
      console.log(`\n🛑 Reached target limit of ${MAX_SUCCESSFUL_LEADS} successful synchronizations. Halting process.`);
    }

    console.log("--------------------------------------------------");
    console.log("✅ Processing execution concluded.");
    console.log(`🎯 Total Leads Successfully Synchronized in this run: ${totalRegisteredSuccessfully}`);
    console.log("--------------------------------------------------");
  } catch (error) {
    console.error("❌ Fatal error during main processing:", error);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 MongoDB connection closed.");
  }
}

main();