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
  console.log(
    "llm_request " +
      JSON.stringify(
        {
          endpoint: endpointHost(LLM_BASE_URL),
          model: LLM_MODEL,
          image_bytes: req.file.size,
          mimetype: req.file.mimetype,
        },
        null,
        2
      )
  );

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
  console.log(
    "llm_response " +
      JSON.stringify(
        {
          status: llmRes.status,
          latency_ms: Date.now() - started,
          preview: JSON.stringify(payload).slice(0, 500),
        },
        null,
        2
      )
  );
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
  console.log(
    "parse " +
      JSON.stringify(
        {
          model: LLM_MODEL,
          is_receipt: result.is_receipt,
          latency_ms: Date.now() - started,
          usage: usage,
        },
        null,
        2
      )
  );
  res.json({ result: result, usage: usage, model: LLM_MODEL });
});

// multer / filter errors -> JSON
// eslint-disable-next-line no-unused-vars
app.use(function (err, req, res, next) {
  return bad(res, 400, err && err.message ? err.message : "upload failed");
});

app.listen(PORT, function () {
  console.log("Receipt tracker on http://localhost:" + PORT);
  console.log("Endpoint: " + LLM_BASE_URL + " | Model: " + LLM_MODEL +
    " | API key set: " + (LLM_API_KEY.length > 0));
});

// Test hook: NODE_ENV=test exposes the pure helpers (no server side effects).
if (typeof module !== "undefined" && process.env.NODE_ENV === "test") {
  module.exports = {
    coerceResult: coerceResult,
    stripFences: stripFences,
    provider: { baseUrl: LLM_BASE_URL, model: LLM_MODEL },
  };
}
