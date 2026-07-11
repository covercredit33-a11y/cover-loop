const mongoose = require("mongoose");
const path = require("path");
const xlsx = require("xlsx");
const axios = require("axios"); // ✅ Axios import add kar diya hai
require("dotenv").config();

const MONGODB_URINEW = process.env.MONGODB_RSUnity;

mongoose
  .connect(MONGODB_URINEW)
  .then(() => console.log("✅ MongoDB Connected Successfully"))
  .catch((err) => console.error("🚫 MongoDB Connection Error:", err));

const UserDB = mongoose.model(
  "smcoll",
  new mongoose.Schema({}, { collection: "smcoll", strict: false }),
);

const PINCODE_FILE_PATH = path.join(
  __dirname,
  "xlsx",
  "CreditSea_latest.xlsx"
);
const BASE_URL = "https://backend.creditsea.com/api/v1";
const ENDPOINT = "leads/create-lead-dsa";
const SOURCE_ID = "77445946";
const BATCH_SIZE = 500;

let totalSuccessCount = 0;
let totalApiHits = 0;

function getHeaders() {
  return {
    headers: {
      "Content-Type": "application/json",
      sourceid: SOURCE_ID,
    },
  };
}

function loadValidPincodes() {
  try {
    const workbook = xlsx.readFile(PINCODE_FILE_PATH);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

    const pincodes = new Set();
    data.forEach((row) => {
      if (row[0]) {
        pincodes.add(String(row[0]).trim());
      }
    });
    console.log(`✅ Loaded ${pincodes.size} valid pincodes from Excel.`);
    return pincodes;
  } catch (error) {
    console.error(`❌ Error loading pincode file: ${error.message}`);
    return new Set();
  }
}

// ✅ Yeh function ab bilkul sahi hai, saari fields proper map ho rahi hain
async function LeadCreation(user) {
  totalApiHits++;
  try {
    let dobFormatted = "";
    if (user.dob) {
      const date = new Date(user.dob);
      const dd = String(date.getDate()).padStart(2, "0");
      const mm = String(date.getMonth() + 1).padStart(2, "0");
      const yyyy = date.getFullYear();
      dobFormatted = `${dd}-${mm}-${yyyy}`;
    }

    const data = {
      first_name: user.name,
      last_name: user.last_name || ".",
      phoneNumber: Number(user.phone),
      pan: user.pan,
      dob: dobFormatted,
      gender: user.gender?.toLowerCase(),
      pincode: String(user.pincode || "").trim(),
      income: String(user.income || "0"),
      partner_Id: "KeshvaCredit",
      employmentType: user.employment || "Salaried",
    };

    const response = await axios.post(
      `${BASE_URL}/${ENDPOINT}`,
      data,
      getHeaders(),
    );

    console.log(`✅ Lead created for ${user.phone}:`, response.data);
    return response.data;
  } catch (err) {
    const errorData = err.response?.data || {
      error: err.message,
      status: err.response?.status,
    };
    console.error(`🚫 Lead creation failed for ${user.phone}:`, errorData);
    return errorData;
  }
}

async function processUser(user, validPincodes) {
  let leadResponse;
  const userPincode = String(user.pincode || "").trim();

  // --- PINCODE VALIDATION LOGIC ---
  if (!validPincodes.has(userPincode)) {
    console.log(
      `⚠️ Skipping API for ${user.phone}: Pincode ${userPincode} not in list.`,
    );
    leadResponse = {
      success: false,
      message: "Pincode Not Servicable",
      pincodeProvided: userPincode,
    };
  } else {
    // Agar pincode match hua tabhi API hit hogi
    leadResponse = await LeadCreation(user);
  }

  const updateDoc = {
    $push: {
      apiResponse: {
        CreditSea: leadResponse,
        createdAt: new Date().toLocaleString(),
      },
      RefArr: {
        name: "creditsea",
        createdAt: new Date().toLocaleString(),
        status: validPincodes.has(userPincode) ? "hit" : "skipped_pincode",
      },
    },
    $unset: { account: "" },
  };

  try {
    await UserDB.updateOne({ _id: user._id }, updateDoc);
    console.log(`✅ Database updated for user: ${user.phone}`);
  } catch (err) {
    console.error(
      `🚫 Failed to update DB for user ${user.phone}:`,
      err.message,
    );
  }

  if (leadResponse && leadResponse.message === "Lead generated successfully") {
    totalSuccessCount++;
  }
}

async function main() {
  const validPincodes = loadValidPincodes();
  const TARGET_SUCCESS = 3000; // Target set hai

  if (validPincodes.size === 0) {
    console.error("❌ No pincodes found. Check your Excel file.");
    process.exit(1);
  }

  try {
    let batchNumber = 1;

    // Loop tab tak chalega jab tak hum targeted success reach nahi kar lete
    while (totalSuccessCount < TARGET_SUCCESS) {
      const users = await UserDB.find({
        $or: [
          { RefArr: { $exists: false } },
          { "RefArr.name": { $ne: "creditsea" } },
        ],
      }).limit(BATCH_SIZE);

      if (users.length === 0) {
        console.log("🎉 All users processed or no more data.");
        break;
      }

      console.log(
        `\n--- Starting Batch ${batchNumber} (Current Success: ${totalSuccessCount}) ---`,
      );

      for (const user of users) {
        // Har user ko process karne se pehle check karenge
        if (totalSuccessCount >= TARGET_SUCCESS) {
          break; // For loop se bahar
        }

        await processUser(user, validPincodes);
      }

      // Agar target success reach ho gaya hai, toh while loop bhi break karein
      if (totalSuccessCount >= TARGET_SUCCESS) {
        break;
      }

      console.log(`\n--- Batch ${batchNumber} Summary ---`);
      console.log(`🔥 Total API Hits: ${totalApiHits}`);
      console.log(`✅ Success Leads: ${totalSuccessCount}`);
      batchNumber++;
    }

    if (totalSuccessCount >= TARGET_SUCCESS) {
      console.log(
        `\n🎯 Stop Signal: Target of ${TARGET_SUCCESS} success responses reached!`,
      );
    }
  } catch (err) {
    console.error("🚫 Error in main loop:", err);
  } finally {
    console.log(
      `\n🏁 Final Execution Finished. Total Success: ${totalSuccessCount}`,
    );
    mongoose.connection.close();
    console.log("🔒 MongoDB connection closed");
  }
}

// Poora loop execute karne ke liye main() chalaya
main();