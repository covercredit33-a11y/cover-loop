const crypto = require("crypto");
const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();

app.use(express.json());

function readEnv(name, fallback = "") {
  return (process.env[name] || fallback).trim();
}

const PORT = readEnv("CREDITMANTRI_PORT", "5001");
const SOURCE = readEnv("CREDITMANTRI_SOURCE", "keshvacredit");
const CLIENT_ID = readEnv("CREDITMANTRI_CLIENT_ID");
const SECRET_KEY = readEnv("CREDITMANTRI_SECRET_KEY");

const AUTH_URL =
  readEnv("CREDITMANTRI_AUTH_URL") || "https://cm-vaasal.creditmantri.net.in/anumathi/a";
const OTP_URL =
  readEnv("CREDITMANTRI_OTP_URL") ||
  "https://cm-vaasal.creditmantri.net.in/keshvacredit/generate-otp";
const CHR_URL =
  readEnv("CREDITMANTRI_CHR_URL") ||
  "https://cm-vaasal.creditmantri.net.in/report-service/keshvacredit/generate-chr-report";

const AES_ALGORITHM = readEnv("CREDITMANTRI_AES_ALGORITHM", "aes-256-cbc");
const AES_KEY = readEnv("CREDITMANTRI_AES_KEY");
const AES_IV = readEnv("CREDITMANTRI_AES_IV");

let cachedAuthKey = null;

function decodeCryptoValue(value, expectedBytes, fieldName) {
  if (!value) {
    throw new Error(`${fieldName} is missing in .env`);
  }

  const trimmedValue = value.trim();
  const candidates = [
    Buffer.from(trimmedValue, "base64"),
    Buffer.from(trimmedValue, "hex"),
    Buffer.from(trimmedValue, "utf8"),
  ];

  const matched = candidates.find((candidate) => candidate.length === expectedBytes);
  if (!matched) {
    throw new Error(`${fieldName} must decode to ${expectedBytes} bytes`);
  }

  return matched;
}

function getCipherConfig() {
  return {
    key: decodeCryptoValue(AES_KEY, 32, "CREDITMANTRI_AES_KEY"),
    iv: decodeCryptoValue(AES_IV, 16, "CREDITMANTRI_AES_IV"),
  };
}

function encryptPayload(payload) {
  const { key, iv } = getCipherConfig();
  const cipher = crypto.createCipheriv(AES_ALGORITHM, key, iv);
  const plainText = JSON.stringify(payload);

  return Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]).toString("base64");
}

function decryptPayload(encryptedPayload) {
  const { key, iv } = getCipherConfig();
  const cipherText =
    typeof encryptedPayload === "string" ? encryptedPayload.replace(/^"|"$/g, "") : encryptedPayload;
  const decipher = crypto.createDecipheriv(AES_ALGORITHM, key, iv);
  const decryptedText = Buffer.concat([
    decipher.update(cipherText, "base64"),
    decipher.final(),
  ]).toString("utf8");

  return JSON.parse(decryptedText);
}

function getHeaderValue(headers, headerName) {
  if (!headers) return undefined;

  if (typeof headers.get === "function") {
    const value = headers.get(headerName);
    if (value) return value;
  }

  const matchedHeader = Object.keys(headers).find(
    (key) => key.toLowerCase() === headerName.toLowerCase(),
  );

  return matchedHeader ? headers[matchedHeader] : undefined;
}

function extractAuthKey(headers, body) {
  const headerNames = [
    "Key",
    "key",
    "Authorization",
    "authorization",
    "token",
    "Token",
    "x-auth-token",
    "x-api-key",
  ];

  for (const headerName of headerNames) {
    const value = getHeaderValue(headers, headerName);
    if (value) return value;
  }

  return body?.key || body?.Key || body?.token || body?.Token || body?.authorization;
}

function sanitizeHeaders(headers) {
  if (!headers) return {};

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      /key|token|authorization|secret/i.test(key) ? "[hidden]" : value,
    ]),
  );
}

function getConfigStatus() {
  return {
    source: SOURCE,
    hasClientId: Boolean(CLIENT_ID),
    hasSecretKey: Boolean(SECRET_KEY),
    hasAesKey: Boolean(AES_KEY),
    hasAesIv: Boolean(AES_IV),
    authUrl: AUTH_URL,
    otpUrl: OTP_URL,
    chrUrl: CHR_URL,
  };
}

function validateAuthConfig() {
  const missingFields = [];
  if (!CLIENT_ID) missingFields.push("CREDITMANTRI_CLIENT_ID");
  if (!SECRET_KEY) missingFields.push("CREDITMANTRI_SECRET_KEY");

  if (missingFields.length > 0) {
    const error = new Error(`Missing required .env values: ${missingFields.join(", ")}`);
    error.statusCode = 400;
    error.details = getConfigStatus();
    throw error;
  }
}

async function authenticate() {
  validateAuthConfig();

  const response = await axios.post(
    AUTH_URL,
    {},
    {
      headers: {
        Source: SOURCE,
        clientId: CLIENT_ID,
        secretKey: SECRET_KEY,
        "Content-Type": "application/json",
      },
    },
  );

  if (response.data?.code && Number(response.data.code) !== 200) {
    const error = new Error(`CreditMantri auth failed: ${response.data.status || response.data.code}`);
    error.statusCode = response.data.code === 401 ? 401 : 502;
    error.details = {
      authResponse: response.data,
      config: getConfigStatus(),
      receivedHeaderNames: Object.keys(response.headers || {}),
    };
    throw error;
  }

  const authKey = extractAuthKey(response.headers, response.data);
  if (!authKey) {
    const error = new Error("Authentication succeeded but auth key was not found");
    error.details = {
      authResponse: response.data,
      config: getConfigStatus(),
      receivedHeaders: sanitizeHeaders(response.headers),
      receivedHeaderNames: Object.keys(response.headers || {}),
    };
    throw error;
  }

  cachedAuthKey = authKey;

  return {
    body: response.data,
    key: authKey,
  };
}

async function getAuthKey() {
  if (cachedAuthKey) return cachedAuthKey;
  const auth = await authenticate();
  return auth.key;
}

async function postEncrypted(url, payload) {
  const authKey = await getAuthKey();
  const encryptedPayload = encryptPayload(payload);

  try {
    const response = await axios.post(url, encryptedPayload, {
      headers: {
        Key: authKey,
        Source: SOURCE,
        "Content-Type": "application/json",
      },
    });

    const decrypted = decryptPayload(response.data);
    return {
      encryptedRequest: encryptedPayload,
      encryptedResponse: response.data,
      decryptedResponse: decrypted,
    };
  } catch (error) {
    if (error.response?.status === 401 || error.response?.status === 403) {
      cachedAuthKey = null;
    }
    throw error;
  }
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "CreditMantri integration API is running",
  });
});

app.get("/api/creditmantri/config", (req, res) => {
  res.json({
    success: true,
    config: getConfigStatus(),
  });
});

app.post("/api/creditmantri/auth", async (req, res) => {
  try {
    const result = await authenticate();
    res.json({
      success: true,
      authResponse: result.body,
      key: result.key,
    });
  } catch (error) {
    res.status(error.statusCode || error.response?.status || 500).json({
      success: false,
      error: error.response?.data || error.message,
      details: error.details,
    });
  }
});

app.post("/api/creditmantri/generate-otp", async (req, res) => {
  try {
    if (!req.body.mobile) {
      return res.status(400).json({
        success: false,
        error: "mobile is required",
      });
    }

    const result = await postEncrypted(OTP_URL, {
      mobile: req.body.mobile,
    });

    return res.json({
      success: true,
      ...result.decryptedResponse,
      encryptedRequest: result.encryptedRequest,
      encryptedResponse: result.encryptedResponse,
    });
  } catch (error) {
    return res.status(error.statusCode || error.response?.status || 500).json({
      success: false,
      error: error.response?.data || error.message,
      details: error.details,
    });
  }
});

app.post("/api/creditmantri/generate-chr-report", async (req, res) => {
  try {
    const requiredFields = [
      "mobile",
      "panId",
      "firstName",
      "lastName",
      "dob",
      "pincode",
      "email",
      "no_of_reports",
    ];
    const missingFields = requiredFields.filter((field) => !req.body[field]);

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Missing required fields: ${missingFields.join(", ")}`,
      });
    }

    const result = await postEncrypted(CHR_URL, {
      mobile: req.body.mobile,
      panId: req.body.panId,
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      dob: req.body.dob,
      pincode: req.body.pincode,
      email: req.body.email,
      state: req.body.state || "",
      city: req.body.city || "",
      gender: req.body.gender || "",
      Consent_date: req.body.Consent_date || "",
      lang: req.body.lang || "EN",
      no_of_reports: req.body.no_of_reports,
    });

    return res.json({
      success: true,
      ...result.decryptedResponse,
      encryptedRequest: result.encryptedRequest,
      encryptedResponse: result.encryptedResponse,
    });
  } catch (error) {
    return res.status(error.statusCode || error.response?.status || 500).json({
      success: false,
      error: error.response?.data || error.message,
      details: error.details,
    });
  }
});

app.listen(PORT, () => {
  console.log(`CreditMantri integration API running on port ${PORT}`);
});
