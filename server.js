import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const QLM_BASE_URL = process.env.QLM_BASE_URL?.replace(/\/$/, "");
const QLM_VENDOR = process.env.QLM_VENDOR;
const QLM_PASSWORD = process.env.QLM_PASSWORD;
const PORT = process.env.PORT || 3000;

if (!QLM_BASE_URL || !QLM_VENDOR || !QLM_PASSWORD) {
  console.error("Missing required env vars: QLM_BASE_URL, QLM_VENDOR, QLM_PASSWORD");
  process.exit(1);
}

// ─── XML / SOAP helpers ───────────────────────────────────────────────────────
function escapeXml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// QLM's GetLicenseInfo `fieldValue` is dropped directly into a server-side SQL
// WHERE clause with no quoting of its own — we must quote string values and
// double up embedded single quotes ourselves (standard SQL string escaping).
function sqlQuote(str) {
  return `'${String(str ?? "").replace(/'/g, "''")}'`;
}

function decodeEntities(str) {
  return String(str ?? "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractXml(xml, tag) {
  const match = xml.match(new RegExp(`<(?:[^:]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:]+:)?${tag}>`, "i"));
  return match ? match[1].trim() : null;
}

function parseSoapResponse(xml, method) {
  const responseNode = extractXml(xml, `${method}Response`);
  if (!responseNode) return { raw: xml };
  const dataSet = extractXml(responseNode, "dataSet");
  const result = extractXml(responseNode, "result");
  return { dataSet, result };
}

// Parse the <Table>...</Table> rows out of QLM's (double-encoded) dataSet XML
// into plain JS objects, server-side, so the browser never has to touch raw XML.
function parseLicenseTables(decodedXml) {
  const tables = decodedXml.match(/<Table>[\s\S]*?<\/Table>/g) || [];
  return tables.map((block) => {
    const row = {};
    const fieldRe = /<(\w+)(?:\s[^>]*)?>([^<]*)<\/\1>|<(\w+)\s*\/>/g;
    let m;
    while ((m = fieldRe.exec(block)) !== null) {
      if (m[3]) row[m[3]] = "";
      else row[m[1]] = m[2];
    }
    return row;
  });
}

function buildSoap(method, params = {}) {
  const body = Object.entries(params)
    .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`).join("\n        ");
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <QlmSoapHeader xmlns="http://www.interactive-studios.net/qlmweb">
      <CultureName>en</CultureName>
      <User>${escapeXml(QLM_VENDOR)}</User>
      <Password>${escapeXml(QLM_PASSWORD)}</Password>
      <UtcOffset>0</UtcOffset>
    </QlmSoapHeader>
  </soap:Header>
  <soap:Body>
    <${method} xmlns="http://www.interactive-studios.net/qlmweb">
        ${body}
    </${method}>
  </soap:Body>
</soap:Envelope>`;
}

async function qlmSoap(method, params = {}) {
  const soapBody = buildSoap(method, params);
  const response = await fetch(QLM_BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": `"http://www.interactive-studios.net/qlmweb/${method}"`,
    },
    body: soapBody,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`SOAP ${response.status}: ${text.slice(0, 300)}`);
  return parseSoapResponse(text, method);
}

async function getAllLicenses() {
  const { dataSet } = await qlmSoap("GetLicenseInfo", {
    fieldName: "ActivationKey",
    fieldOperator: "like",
    fieldValue: sqlQuote("%"),
    historyTable: "false",
    dataSet: "",
  });
  if (!dataSet) return [];
  return parseLicenseTables(decodeEntities(dataSet));
}

// ─── Simple in-memory cache (avoid hammering QLM on every page view) ─────────
let cache = { data: null, ts: 0 };
const CACHE_MS = 5 * 60 * 1000; // 5 minutes

async function getCachedLicenses() {
  if (cache.data && Date.now() - cache.ts < CACHE_MS) return cache.data;
  const data = await getAllLicenses();
  cache = { data, ts: Date.now() };
  return data;
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const app = express();

app.get("/api/licenses", async (req, res) => {
  try {
    const licenses = await getCachedLicenses();
    res.json({ licenses, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/refresh", async (req, res) => {
  try {
    cache = { data: null, ts: 0 };
    const licenses = await getCachedLicenses();
    res.json({ licenses, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, "0.0.0.0", () => console.log(`Breeze QLM report server on port ${PORT}`));
