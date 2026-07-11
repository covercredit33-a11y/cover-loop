const { MongoClient } = require("mongodb");
const axios = require("axios");
require("dotenv").config();


const MONGO_URI = process.env.MONGO_URI_COVER;
const DB_NAME = "cover";

const LEAD_COLLECTION = "api_user";
const RESPONSE_COLLECTION = "vivi_user";

const ACCESS_TOKEN_URL = "https://api.flexsalary.com/apiv1/api/AccessToken/Post";
const LEAD_API_URL = "https://api.flexsalary.com/apiv1/api/LeadCustomer/Post";

const USERNAME = "CoverMantra";
const PASSWORD = "DvI}rMg]HyP[jXa[";
const CAMPAIGN_ID = 9192300;
const LENDER_NAME = "flexsalary";

// ------------ CONTROL ------------ //

const MAX_LEADS = 5000000;
const SKIP = 1;
const BATCH_SIZE = 100;
const MAX_WORKERS = 7;
const REQUEST_TIMEOUT = 30000; // ms
const BATCH_DELAY = 1000; // ms

// ---------------- LOGGING ---------------- //

function log(level, message) {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} - ${level} - ${message}`);
}

// ---------------- MONGO ---------------- //

let client;
let leadCol;
let responseCol;

async function connectMongo() {
  client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  leadCol = db.collection(LEAD_COLLECTION);
  responseCol = db.collection(RESPONSE_COLLECTION);
  log("INFO", "✅ MongoDB Connected Successfully");
}

// ---------------- HELPERS ---------------- //

function splitName(name) {
  const parts = name.trim().split(/\s+/);
  const first = parts[0];
  const last = parts.length > 1 ? parts.slice(1).join(" ") : "";
  return [first, last];
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Converts DOB to DD/MM/YYYY format.
 * Accepts Date objects or strings in common formats.
 * Returns string in DD/MM/YYYY or null if invalid.
 */
function formatDob(dob) {
  if (!dob) return null;

  // Already a Date object
  if (dob instanceof Date && !isNaN(dob.getTime())) {
    return `${pad2(dob.getDate())}/${pad2(dob.getMonth() + 1)}/${dob.getFullYear()}`;
  }

  // If string, try common formats
  if (typeof dob === "string") {
    const formats = [
      { regex: /^(\d{4})-(\d{2})-(\d{2})$/, order: ["y", "m", "d"] }, // %Y-%m-%d
      { regex: /^(\d{2})-(\d{2})-(\d{4})$/, order: ["d", "m", "y"] }, // %d-%m-%Y
      { regex: /^(\d{4})\/(\d{2})\/(\d{2})$/, order: ["y", "m", "d"] }, // %Y/%m/%d
      { regex: /^(\d{2})\/(\d{2})\/(\d{4})$/, order: ["d", "m", "y"] }, // %d/%m/%Y
      { regex: /^(\d{2})\/(\d{2})\/(\d{4})$/, order: ["m", "d", "y"] }, // %m/%d/%Y
    ];

    for (const fmt of formats) {
      const match = dob.match(fmt.regex);
      if (!match) continue;

      const parts = {};
      fmt.order.forEach((key, idx) => {
        parts[key] = match[idx + 1];
      });

      const year = Number(parts.y);
      const month = Number(parts.m);
      const day = Number(parts.d);

      const dt = new Date(year, month - 1, day);
      // Validate the date actually exists (mirrors strptime's strictness)
      if (
        dt.getFullYear() === year &&
        dt.getMonth() === month - 1 &&
        dt.getDate() === day
      ) {
        return `${pad2(day)}/${pad2(month)}/${year}`;
      }
    }
  }

  log("ERROR", `Cannot parse DOB: ${dob}`);
  return null;
}

function mapGender(gender) {
  const map = { male: 0, female: 1, other: 2 };
  return map[(gender || "").toLowerCase()] ?? 0;
}

function mapIncomeType(emp) {
  return emp && emp.toLowerCase() === "self employed" ? 2 : 6;
}

function shouldSkip(lead) {
  const required = ["phone", "pan", "dob", "gender", "name"];
  for (const field of required) {
    if (!lead[field]) return true;
  }
  if (formatDob(lead.dob) === null) return true;
  if (lead.processed && lead.processed.includes(LENDER_NAME)) return true;
  return false;
}

// ---------------- TOKEN ---------------- //

async function getAccessToken() {
  const res = await axios.post(
    ACCESS_TOKEN_URL,
    { UserName: USERNAME, Password: PASSWORD },
    { headers: { "Content-Type": "application/json" } },
  );
  return res.data?.Message;
}

// ---------------- PAYLOAD ---------------- //

function buildPayload(doc) {
  const [first, last] = splitName(doc.name);
  const dobFormatted = formatDob(doc.dob);

  return {
    Campaign: { CampaignId: CAMPAIGN_ID, IsMobile: false },
    PersonerDetails: {
      FirstName: first,
      LastName: last,
      Email: doc.email,
      PhoneNumber: doc.phone,
      DateOfBirth: dobFormatted,
      Gender: mapGender(doc.gender),
      PanNumber: doc.pan,
    },
    CustomerAddressDetails: {
      ResidenceType: 1,
      AddressLine1: doc.NA,
      City: doc.NA,
      State: doc.NA,
      PinCode: doc.pincode,
    },
    CustomerIncomeDetails: {
      IncomeType: mapIncomeType(doc.employment),
      GrossIncome: parseFloat(doc.income || 0),
    },
    CustomerBankDetails: {
      AccountType: 10,
    },
  };
}

// ---------------- WORKER ---------------- //

async function sendLead(lead, headers) {
  const payload = buildPayload(lead);
  console.log(payload, "\n");

  const res = await axios.post(LEAD_API_URL, payload, {
    headers,
    timeout: REQUEST_TIMEOUT,
  });

  const apiResponse = res.data;

  await responseCol.insertOne({
    phone: lead.phone,
    pan: lead.pan,
    name: lead.name,
    api_response: apiResponse,
    createdAt: new Date().toISOString().slice(0, 10), // YYYY-MM-DD, matches Python
  });

  await leadCol.updateOne(
    { _id: lead._id },
    {
      $addToSet: {
        processed: LENDER_NAME,
      },
    }
  );
}

// ---------------- CONCURRENCY HELPER ---------------- //

/**
 * Concurrency helper function jo leads ko concurrent batches (workers) me run karta hai.
 * Yeh dynamic workers pool setup karta hai jo shared index se items pull karte hain.
 */
async function runWithConcurrencyLimit(items, limit, fn) {
  let successCount = 0;
  let nextIndex = 0; // Agla item pick karne ke liye index pointer

  // Worker jo dynamic tarike se items ko consume karega jab tak array khatam nahi hota
  async function worker() {
    while (nextIndex < items.length) {
      // nextIndex ko fetch aur increment karte hain (Javascript single-threaded hai isliye yeh safe hai)
      const currentIndex = nextIndex++;
      
      // Safety check agar increment operations boundary exceed kar jayein
      if (currentIndex >= items.length) {
        break;
      }

      const currentItem = items[currentIndex];
      try {
        await fn(currentItem);
        successCount++;
      } catch (e) {
        log("ERROR", `FAILED → ${e.message}`);
      }
    }
  }

  // Workers ki list create karte hain aur unhe concurrently start karte hain
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());

  // Wait karenge jab tak saare workers apna kaam complete nahi kar lete
  await Promise.all(workers);

  return successCount;
}

async function processBatch(batch, headers) {
  return runWithConcurrencyLimit(batch, MAX_WORKERS, (lead) =>
    sendLead(lead, headers),
  );
}

// ---------------- MAIN PROCESS ---------------- //

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processLeads() {
  const token = await getAccessToken();
  const headers = {
    "Content-Type": "application/json",
    AccessToken: token,
  };

  const cursor = leadCol
    .find({
      $or: [
        { processed: { $exists: false } },
        { processed: { $ne: LENDER_NAME } },
      ],
    })
    .skip(SKIP)
    .limit(MAX_LEADS);

  let total = 0;
  let processed = 0;
  let skipped = 0;
  let batch = [];

  for await (const lead of cursor) {
    total++;

    if (shouldSkip(lead)) {
      skipped++;
      continue;
    }

    batch.push(lead);

    if (batch.length === BATCH_SIZE) {
      processed += await processBatch(batch, headers);
      batch = [];
      await sleep(BATCH_DELAY);
    }
  }

  if (batch.length) {
    processed += await processBatch(batch, headers);
  }

  log("INFO", "----- SUMMARY -----");
  log("INFO", `TOTAL FETCHED : ${total}`);
  log("INFO", `PROCESSED     : ${processed}`);
  log("INFO", `SKIPPED       : ${skipped}`);
}

// ---------------- RUN ---------------- //

async function main() {
  try {
    await connectMongo();
    await processLeads();
  } catch (err) {
    log("ERROR", `Fatal error: ${err.message}`);
  } finally {
    if (client) {
      await client.close();
      log("INFO", "🔒 MongoDB connection closed");
    }
  }
}

main();