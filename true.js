const { MongoClient } = require("mongodb");
const axios = require("axios");
require("dotenv").config();

// ---------------- ENV ---------------- //

const MONGO_URI = process.env.MONGO_URI_COVER;
const TRUEFUND_API_KEY = "a3f7e92c8b4d156e9f02ab73c5d8e1f4906b2c5a8d7e3f1029b5c8a4d6e9f2b1";

const DB_NAME = "cover";

const LEAD_COLLECTION = "api_user";
const RESPONSE_COLLECTION = "truefund_response";

const LEAD_API_URL = "https://api-backend.truefund.in/partner/submit-lead";

const PARTNER_ID = "Keshava";
const UTM_SOURCE = "KeshvaFinance";

const LENDER_NAME = "truefund";

// ---------------- CONTROL ---------------- //

const MAX_LEADS = 5000000;
const SKIP = 0;
const BATCH_SIZE = 10;
const MAX_WORKERS = 7;
const REQUEST_TIMEOUT = 30000;
const BATCH_DELAY = 1000;

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

  log("INFO", "✅ MongoDB Connected");
}

// ---------------- HELPERS ---------------- //

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDob(dob) {
  if (!dob) return "";
  try {
    const date = new Date(dob);
    if (isNaN(date)) return "";
    return date.toISOString().split("T")[0];
  } catch {
    return "";
  }
}

function normalizePhone(phone) {
  if (!phone) return "";
  return String(phone).replace(/\D/g, "").slice(-10);
}

function normalizePan(pan) {
  if (!pan) return "";
  return String(pan).trim().toUpperCase();
}

// ---------------- VALIDATION ---------------- //

function getValidationResult(lead) {
  if (!lead.phone) return { valid: false, reason: "Missing phone number" };
  if (!lead.pan) return { valid: false, reason: "Missing PAN number" };

  const phone = normalizePhone(lead.phone);
  if (!/^[6-9]\d{9}$/.test(phone)) {
    return { valid: false, reason: `Invalid phone format: ${phone}` };
  }

  const pan = normalizePan(lead.pan);
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan)) {
    return { valid: false, reason: `Invalid PAN format: ${pan}` };
  }

  // Already processed check
  if (lead.processed && Array.isArray(lead.processed)) {
    const alreadyDone = lead.processed.some(
      (item) => String(item).toLowerCase() === LENDER_NAME.toLowerCase()
    );
    if (alreadyDone) {
      return { valid: false, reason: "Already processed for this lender", alreadyProcessed: true };
    }
  }

  return { valid: true };
}

// ---------------- PAYLOAD ---------------- //

function buildPayload(doc) {
  const payload = {
    partner_id: PARTNER_ID,
    phone: normalizePhone(doc.phone),
    pan: normalizePan(doc.pan),
    utm_source: UTM_SOURCE,
    name: doc.name || "",
    email: doc.email || "",
    dob: formatDob(doc.dob),
    employment_type: doc.employment || "",
    pincode: doc.pincode || "",
    state: doc.state || "",
    city: doc.city || "",
    medium: "",
    ppc_campaign: ""
  };

  const income = Number(doc.income);
  if (!isNaN(income) && income > 0) {
    payload.income = income;
  }

  return payload;
}

// ---------------- BATCH WORKER ---------------- //

async function processSingleLead(lead) {
  const validation = getValidationResult(lead);
  
  // If already flagged by a prior run or instance, skip it without logging again
  if (!validation.valid && validation.alreadyProcessed) {
    return { status: "ALREADY_PROCESSED" };
  }

  let finalStatus = "FAILED";
  let apiResponse = null;

  if (!validation.valid) {
    log("WARN", `⚠️ Lead Skipped for ${lead.name || "Unknown"}: ${validation.reason}`);
    finalStatus = "SKIPPED";
    apiResponse = { reason: validation.reason, skippedByScript: true };
  } else {
    const payload = buildPayload(lead);
    try {
      const res = await axios.post(LEAD_API_URL, payload, {
        headers: {
          "X-Api-Key": `${TRUEFUND_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: REQUEST_TIMEOUT
      });
      apiResponse = res.data;
      finalStatus = "SUCCESS";
    } catch (err) {
      finalStatus = "FAILED";
      apiResponse = err.response ? err.response.data : { error: err.message };
      log("WARN", `API Error for ${lead.name || "Unknown"}: ${JSON.stringify(apiResponse)}`);
    }
  }

  // 1. Save standardized logs to the response collection
  try {
    await responseCol.insertOne({
      phone: lead.phone ? String(lead.phone).trim() : "",
      pan: lead.pan ? String(lead.pan).trim().toUpperCase() : "",
      name: lead.name || "",
      status: finalStatus,
      api_response: apiResponse,
      createdAt: new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    });
  } catch (dbError) {
    log("ERROR", `Failed to insert log in responseCol: ${dbError.message}`);
  }

  // 2. Mark lead as processed for this lender (Runs for SUCCESS, FAILED, and SKIPPED)
  try {
    await leadCol.updateOne(
      { _id: lead._id },
      { $addToSet: { processed: LENDER_NAME } }
    );
  } catch (dbError) {
    log("ERROR", `Failed to update processed status in leadCol: ${dbError.message}`);
  }

  return { status: finalStatus };
}

async function processBatch(batch) {
  let successCount = 0;
  let skippedCount = 0;
  const queue = [...batch];

  async function worker() {
    while (queue.length > 0) {
      const lead = queue.shift();
      if (!lead) continue;
      
      const result = await processSingleLead(lead);
      if (result.status === "SUCCESS") successCount++;
      if (result.status === "SKIPPED") skippedCount++;
    }
  }

  const workers = [];
  const activeWorkersCount = Math.min(MAX_WORKERS, queue.length);
  
  for (let i = 0; i < activeWorkersCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return { successCount, skippedCount };
}

// ---------------- PROCESS LEADS ---------------- //

async function processLeads() {
  const cursor = leadCol
    .find({
      $or: [
        { processed: { $exists: false } },
        { processed: { $ne: LENDER_NAME } }
      ]
    })
    .skip(SKIP)
    .limit(MAX_LEADS);

  let totalFetched = 0;
  let totalSuccess = 0;
  let totalSkipped = 0;

  let batch = [];

  for await (const lead of cursor) {
    totalFetched++;
    batch.push(lead);

    if (batch.length >= BATCH_SIZE) {
      log("INFO", `Processing Batch (${batch.length})`);
      const counts = await processBatch(batch);
      
      totalSuccess += counts.successCount;
      totalSkipped += counts.skippedCount;
      batch = [];

      await sleep(BATCH_DELAY);
    }
  }

  // Process remaining items in final batch
  if (batch.length) {
    log("INFO", `Processing Final Batch (${batch.length})`);
    const counts = await processBatch(batch);
    totalSuccess += counts.successCount;
    totalSkipped += counts.skippedCount;
  }

  log("INFO", "--------------------------------------");
  log("INFO", `TOTAL FETCHED : ${totalFetched}`);
  log("INFO", `SUCCESS       : ${totalSuccess}`);
  log("INFO", `SKIPPED       : ${totalSkipped}`);
  log("INFO", `FAILED        : ${totalFetched - totalSkipped - totalSuccess}`);
  log("INFO", "--------------------------------------");
}

// ---------------- MAIN ---------------- //

async function main() {
  try {
    await connectMongo();
    await processLeads();
  } catch (err) {
    log("ERROR", err.stack || err.message);
  } finally {
    if (client) {
      await client.close();
      log("INFO", "MongoDB Connection Closed.");
    }
  }
}

// ---------------- RUN ---------------- //

main();