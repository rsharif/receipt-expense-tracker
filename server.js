"use strict";

/* Receipt Expense Tracker — Node backend.
 * Serves the static frontend and exposes POST /api/parse, which sends a
 * receipt photo to an open vision model through any OpenAI-compatible
 * chat-completions endpoint (default: Meta's Llama API) and returns
 * structured JSON. Requires Node >= 18 (global fetch) and an API key.
 */

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const PORT = parseInt(process.env.PORT || "8000", 10);
// Provider config. Defaults = Meta's Llama API (multimodal Maverick).
// Alternatives: set LLM_BASE_URL/LLM_API_KEY/LLM_MODEL for Hugging Face,
// Groq, Together, OpenRouter, or local Ollama (see .env.example).
// HF_TOKEN is honored as a legacy alias for LLM_API_KEY (HF router assumed
// unless LLM_BASE_URL is set explicitly).
const LLM_BASE_URL =
  process.env.LLM_BASE_URL ||
  (process.env.HF_TOKEN && !process.env.LLM_API_KEY
    ? "https://router.huggingface.co/v1/chat/completions"
    : "https://api.llama.com/v1/chat/completions");
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.HF_TOKEN || "";
const LLM_MODEL =
  process.env.LLM_MODEL ||
  (LLM_BASE_URL.includes("huggingface")
    ? "meta-llama/Llama-3.2-11B-Vision-Instruct"
    : "Llama-4-Maverick-17B-128E-Instruct-FP8");

const PROMPT =
  "You check whether a photo shows a store receipt. " +
  "Reply with JSON only, no markdown fences, no extra text, using exactly these keys: " +
  '{"is_receipt": boolean, "merchant": string, "date": string or null, ' +
  '"total": number or null, "items": array, "reason": string}. ' +
  "total is the final amount due on the receipt. " +
  "items lists every expense line: [{label, price}] — one entry per purchased " +
  "item or service, excluding tax/tip/total/subtotal lines unless the receipt " +
  "has no other lines. " +
  "If it is not a receipt, set is_receipt false, total null, items [], " +
  "and explain why in reason.";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    if (/^image\//.test(file.mimetype || "")) cb(null, true);
    else cb(new Error("only image uploads are accepted"));
  },
});

app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", function (req, res) {
  res.json({ ok: true, model: LLM_MODEL, configured: LLM_API_KEY.length > 0 });
});

function bad(res, code, msg) {
  return res.status(code).json({ error: msg });
}

function endpointHost(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return "unknown";
  }
}

// Pretty log helper. dest is OLLAMA, ATLAS, or SERVER so every line shows
// where the request went. Metadata and truncated payloads only —
// never log headers, API keys, connection strings, or image bytes.
function log(dest, tag, obj) {
  console.log("---- Sending request to " + dest + " [" + tag + "] ----\n" + JSON.stringify(obj, null, 2));
}

function summarizeMessages(messages) {
  return (messages || []).map(function (m) {
    if (typeof m.content === "string") {
      return { role: m.role, content: m.content.slice(0, 200) };
    }
    if (Array.isArray(m.content)) {
      return {
        role: m.role,
        content: m.content.map(function (p) {
          if (p.type === "text") return { type: "text", text: (p.text || "").slice(0, 200) };
          if (p.type === "image_url") {
            return { type: "image_url", url_chars: ((p.image_url && p.image_url.url) || "").length };
          }
          return { type: p.type || "?" };
        }),
      };
    }
    return { role: m.role };
  });
}

function summarizeToolCalls(msg) {
  if (!msg || !Array.isArray(msg.tool_calls)) return [];
  return msg.tool_calls.map(function (c) {
    return {
      name: c && c.function && c.function.name,
      args: c && c.function ? String(c.function.arguments || "").slice(0, 300) : "",
    };
  });
}

/* ---------- MongoDB (Atlas M0 free tier) ---------- */
// Accepts MONGO_URI or MONGODB_URI — same value, either name works.
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || "";
let receiptsCol = null;

async function connectDb() {
  if (!MONGO_URI) {
    log("ATLAS", "db", { status: "disabled", reason: "MONGO_URI is not set (receipts will not persist)" });
    return;
  }
  log("ATLAS", "db_connect", { host: endpointHost(MONGO_URI), uri_chars: MONGO_URI.length });
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    receiptsCol = client.db().collection("receipts");
    log("ATLAS", "db", { status: "connected", collection: "receipts" });
  } catch (e) {
    log("ATLAS", "db", { status: "connection failed", error: (e && e.message ? e.message : String(e)) });
  }
}

function parseReceiptDate(s) {
  if (typeof s !== "string" || s.trim() === "") return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

async function saveReceipt(result, fileName) {
  if (!receiptsCol) return null;
  const doc = {
    merchant: result.merchant,
    receiptDate: parseReceiptDate(result.date),
    createdAt: new Date(),
    items: result.items,
    total: result.total,
    sourceFile: fileName,
  };
  const r = await receiptsCol.insertOne(doc);
  const id = r.insertedId ? r.insertedId.toString() : null;
  log("ATLAS", "db_save", { id: id, merchant: doc.merchant, total: doc.total, lines: doc.items.length });
  return id;
}

function coercePrice(v) {
  return typeof v === "number" && isFinite(v) && v >= 0
    ? Math.round(v * 100) / 100
    : null;
}

function coerceResult(raw) {
  // raw: parsed JSON from the model; coerce defensively, never trust it.
  const o = raw && typeof raw === "object" ? raw : {};
  const total = coercePrice(o.total);
  const items = Array.isArray(o.items)
    ? o.items.slice(0, 100).map(function (it) {
        return {
          label:
            it && typeof it.label === "string"
              ? it.label.slice(0, 80)
              : "Item",
          price: coercePrice(it && it.price),
        };
      }).filter(function (it) { return it.price !== null; })
    : [];
  const isReceipt = o.is_receipt === true && total !== null;
  return {
    is_receipt: isReceipt,
    merchant: typeof o.merchant === "string" ? o.merchant.slice(0, 80) : "Unknown",
    date: typeof o.date === "string" ? o.date.slice(0, 40) : null,
    total: total,
    items: isReceipt ? items : [],
    reason:
      typeof o.reason === "string"
        ? o.reason.slice(0, 200)
        : isReceipt
          ? ""
          : "model could not confirm a receipt total",
  };
}

function stripFences(s) {
  return String(s || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

app.post("/api/parse", upload.single("image"), async function (req, res) {
  const started = Date.now();
  if (!LLM_API_KEY) return bad(res, 500, "server misconfigured: LLM_API_KEY is not set");
  if (!req.file) return bad(res, 400, "no image uploaded (field name: image)");

  const dataUrl =
    "data:" + req.file.mimetype + ";base64," + req.file.buffer.toString("base64");

  // Request log: metadata only — never log headers or the API key.
  log("OLLAMA", "llm_request", {
    endpoint: endpointHost(LLM_BASE_URL),
    model: LLM_MODEL,
    image_bytes: req.file.size,
    mimetype: req.file.mimetype,
  });

  let llmRes;
  try {
    llmRes = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + LLM_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0,
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROMPT },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    return bad(res, 502, "could not reach inference provider");
  }

  let payload = null;
  try {
    payload = await llmRes.json();
  } catch (e) {
    return bad(res, 502, "inference provider returned non-JSON");
  }
  // Response log: status + truncated body for debugging (no secrets in it).
  log("OLLAMA", "llm_response", {
    status: llmRes.status,
    latency_ms: Date.now() - started,
    preview: JSON.stringify(payload).slice(0, 500),
  });
  if (!llmRes.ok) {
    const err = payload && payload.error;
    const msg =
      (err && (err.message || err)) ||
      (payload && (payload.title || payload.detail)) ||
      "HTTP " + llmRes.status;
    return bad(res, 502, String(msg).slice(0, 200));
  }

  let text = "";
  try {
    text = payload.choices[0].message.content;
  } catch (e) {
    return bad(res, 502, "unexpected inference response shape");
  }

  let parsed;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch (e) {
    return bad(res, 502, "model did not return valid JSON");
  }

  const result = coerceResult(parsed);
  const usage = payload.usage || null; // prompt/completion tokens for cost monitoring
  let savedId = null;
  if (result.is_receipt) {
    try {
      savedId = await saveReceipt(result, req.file.originalname || "upload");
    } catch (e) {
      log("ATLAS", "db_save", { status: "failed", error: (e && e.message ? e.message : String(e)) });
    }
  }
  log("OLLAMA", "parse", {
    model: LLM_MODEL,
    is_receipt: result.is_receipt,
    latency_ms: Date.now() - started,
    usage: usage,
  });
  res.json({ result: result, usage: usage, model: LLM_MODEL, savedId: savedId });
});

/* ---------- receipt history ---------- */
app.get("/api/receipts", async function (req, res) {
  if (!receiptsCol) return bad(res, 500, "database not configured: MONGO_URI is not set");
  try {
    const docs = await receiptsCol
      .find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    log("ATLAS", "db_find", { count: docs.length });
    res.json({
      receipts: docs.map(function (d) {
        return {
          id: d._id ? d._id.toString() : null,
          name: d.sourceFile || "upload",
          merchant: d.merchant || "Unknown",
          date: d.receiptDate ? d.receiptDate.toISOString().slice(0, 10) : "—",
          total: typeof d.total === "number" ? d.total : null,
          items: Array.isArray(d.items) ? d.items : [],
          status: "valid",
          reason: "",
        };
      }),
    });
  } catch (e) {
    return bad(res, 502, "database query failed");
  }
});

app.delete("/api/receipts/:id", async function (req, res) {
  if (!receiptsCol) return bad(res, 500, "database not configured: MONGO_URI is not set");
  let oid;
  try {
    oid = new ObjectId(req.params.id);
  } catch (e) {
    return bad(res, 400, "bad id");
  }
  try {
    const r = await receiptsCol.deleteOne({ _id: oid });
    log("ATLAS", "db_delete", { id: req.params.id, deleted: r.deletedCount });
    res.json({ ok: true });
  } catch (e) {
    return bad(res, 502, "database delete failed");
  }
});

/* ---------- natural-language questions over receipts ---------- */
const ASK_SCHEMA =
  "Collection `receipts`: {merchant: string, receiptDate: Date (may be null), " +
  "createdAt: Date, items: [{label: string, price: number}], total: number, " +
  "sourceFile: string}. Today is " + new Date().toISOString().slice(0, 10) + ".";

const READ_STAGES = ["$match", "$unwind", "$group", "$sort", "$limit", "$project"];

function reviveDates(node) {
  if (Array.isArray(node)) return node.map(reviveDates);
  if (node && typeof node === "object") {
    const keys = Object.keys(node);
    if (keys.length === 1 && keys[0] === "$date" && typeof node.$date === "string") {
      const d = new Date(node.$date);
      return isNaN(d.getTime()) ? node : d;
    }
    const out = {};
    for (const k of keys) out[k] = reviveDates(node[k]);
    return out;
  }
  return node;
}

// Parse + allowlist a model-generated pipeline. Returns {pipeline} or {error}.
// Accepts the bare array or {"pipeline": [...]} (possibly double-encoded),
// since models wrap the argument in an object despite the schema.
function validatePipeline(text) {
  let pipeline;
  try {
    pipeline = JSON.parse(stripFences(text));
  } catch (e) {
    return { error: "model did not return a JSON pipeline" };
  }
  if (pipeline && typeof pipeline === "object" && !Array.isArray(pipeline)) {
    pipeline = pipeline.pipeline !== undefined ? pipeline.pipeline : pipeline;
  }
  if (typeof pipeline === "string") {
    try {
      pipeline = JSON.parse(stripFences(pipeline));
    } catch (e) {
      return { error: "model did not return a JSON pipeline" };
    }
  }
  // Models emit dates as Extended JSON ({"$date": "..."}), which the driver
  // treats as a plain subdocument — a Date field never matches it. Revive
  // those wrappers into real Dates so range queries actually work.
  pipeline = reviveDates(pipeline);
  if (!Array.isArray(pipeline) || pipeline.length === 0 || pipeline.length > 8) {
    return { error: "pipeline must be a non-empty array of at most 8 stages" };
  }
  for (const stage of pipeline) {
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) {
      return { error: "each pipeline stage must be an object" };
    }
    const keys = Object.keys(stage);
    if (keys.length !== 1 || READ_STAGES.indexOf(keys[0]) === -1) {
      return { error: "only read stages allowed: " + READ_STAGES.join(", ") };
    }
  }
  const flat = JSON.stringify(pipeline);
  if (/\$(out|merge|lookup|where|function|accumulator|expr)\b/.test(flat)) {
    return { error: "pipeline contains a forbidden operator" };
  }
  return { pipeline: pipeline };
}

async function llmChat(messages, maxTokens, tools, step) {
  const tag = step || "llm";
  const toolNames = (tools || []).map(function (t) { return t && t.function && t.function.name; });
  log("OLLAMA", tag + "_request", {
    endpoint: endpointHost(LLM_BASE_URL),
    model: LLM_MODEL,
    max_tokens: maxTokens,
    tools: toolNames,
    messages: summarizeMessages(messages),
  });
  let r;
  try {
    r = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + LLM_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL, temperature: 0, max_tokens: maxTokens, messages: messages,
        ...(tools ? { tools: tools } : {}),
      }),
    });
  } catch (e) {
    log("OLLAMA", tag + "_response", { error: "request failed: " + e.message });
    throw e;
  }
  const payload = await r.json();
  if (!r.ok) {
    const err = payload && payload.error;
    log("OLLAMA", tag + "_response", { status: r.status, preview: JSON.stringify(payload).slice(0, 500) });
    throw new Error(String((err && (err.message || err)) || ("HTTP " + r.status)).slice(0, 200));
  }
  const msg = payload.choices[0].message;
  log("OLLAMA", tag + "_response", {
    status: r.status,
    content: ((msg && msg.content) || "").slice(0, 500),
    tool_calls: summarizeToolCalls(msg),
    usage: payload.usage || null,
  });
  return msg;
}

app.post("/api/ask", async function (req, res) {
  const started = Date.now();
  if (!LLM_API_KEY) return bad(res, 500, "server misconfigured: LLM_API_KEY is not set");
  if (!receiptsCol) return bad(res, 500, "database not configured: MONGO_URI is not set");
  const question = req.body && typeof req.body.question === "string" ? req.body.question.trim() : "";
  if (!question) return bad(res, 400, "question is required");

  const tools = [
    {
      type: "function",
      function: {
        name: "query_receipts",
        description: "Run a read-only MongoDB aggregation over the receipts collection and return the rows.",
        parameters: {
          type: "object",
          properties: { pipeline: { type: "string", description: "The aggregation pipeline itself as a JSON array, e.g. [{\"$group\":{\"_id\":null,\"n\":{\"$sum\":1}}}]. Return the array, not an object." } },
          required: ["pipeline"],
        },
      },
    },
  ];
  let msg;
  try {
    msg = await llmChat(
      [
        { role: "system", content: "Answer questions about store receipts. " + ASK_SCHEMA + " Always use query_receipts for data; never guess numbers. " +
          "Granularity: words like expense, item, purchase, or product mean a single line item — $unwind items and use items.price/items.label. " +
          "Only aggregate the receipt total when the question says receipt, transaction, bill, or total spending." },
        { role: "user", content: question },
      ],
      500, tools, "ask_plan"
    );
  } catch (e) {
    return bad(res, 502, "inference provider: " + e.message);
  }

  const call = msg && msg.tool_calls && msg.tool_calls[0];
  const args = call && call.function && call.function.arguments;
  if (!args) {
    return res.json({ answer: (msg && msg.content) || "I could not answer that.", pipeline: null, rows: [] });
  }
  const checked = validatePipeline(args);
  if (checked.error) {
    log("OLLAMA", "ask_rejected", { args: String(args).slice(0, 300) });
    return bad(res, 502, "rejected model query: " + checked.error);
  }

  let rows;
  try {
    rows = await receiptsCol.aggregate(checked.pipeline).toArray();
  } catch (e) {
    return bad(res, 502, "database query failed");
  }
  rows = rows.slice(0, 50);
  log("ATLAS", "db_aggregate", { stages: checked.pipeline.length, rows: rows.length });

  let answer;
  try {
    const final = await llmChat(
      [
        { role: "system", content: "Answer in one or two plain sentences using only these rows." },
        { role: "user", content: "Question: " + question + "\nRows: " + JSON.stringify(rows).slice(0, 2000) },
      ],
      300, null, "ask_answer"
    );
    answer = final.content || "No answer.";
  } catch (e) {
    return bad(res, 502, "inference provider: " + e.message);
  }

  log("SERVER", "ask", { latency_ms: Date.now() - started, rows: rows.length });
  res.json({ answer: answer, pipeline: checked.pipeline, rows: rows });
});

// multer / filter errors -> JSON
// eslint-disable-next-line no-unused-vars
app.use(function (err, req, res, next) {
  return bad(res, 400, err && err.message ? err.message : "upload failed");
});

connectDb();
app.listen(PORT, function () {
  log("SERVER", "server", {
    url: "http://localhost:" + PORT,
    endpoint: endpointHost(LLM_BASE_URL),
    model: LLM_MODEL,
    api_key_set: LLM_API_KEY.length > 0,
    db: receiptsCol ? "connected" : "disabled",
  });
});

// Test hook: NODE_ENV=test exposes the pure helpers (no server side effects).
if (typeof module !== "undefined" && process.env.NODE_ENV === "test") {
  module.exports = {
    coerceResult: coerceResult,
    stripFences: stripFences,
    validatePipeline: validatePipeline,
    parseReceiptDate: parseReceiptDate,
    provider: { baseUrl: LLM_BASE_URL, model: LLM_MODEL },
  };
}
