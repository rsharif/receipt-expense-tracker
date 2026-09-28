# Receipt Expense Tracker

Upload receipt photos → open-source OCR reads them → non-receipts are rejected → valid totals are summed in a table.

- **AI parsing.** Receipt photos go to your own Node backend, which calls an open vision model (Meta's Llama Maverick by default) and returns structured JSON.
- **No API keys in the browser.** The key lives server-side in `.env` (`LLM_API_KEY`).

## Run locally

You need **Node 18+** (`node --version`). One-time setup:

```
cd receipt-expense-tracker
npm install
npm test
cp .env.example .env
# edit .env: paste LLM_API_KEY and MONGO_URI (see below)
npm start
# open http://localhost:8000 in a browser
```

## Database (MongoDB Atlas, free)

1. Create a free **M0** cluster at MongoDB Atlas, add a database user, and
   allow network access from `0.0.0.0/0` (needed for hosted backends).
2. Connect → Drivers → Node.js → copy the `mongodb+srv://…` connection
   string into `.env` as `MONGO_URI`.
3. Restart the server (`db connected` in the log confirms it).

Every valid parse is stored in the `receipts` collection as
`{merchant, receiptDate, createdAt, items: [{label, price, category}], total, sourceFile}`,
where `category` is one of food, drinks, groceries, household, clothing,
electronics, transport, health, entertainment, services, other. Receipts
stored before categories existed have no category — re-upload them to fill it in.
Without `MONGO_URI`, parsing still works but nothing persists and the
history/Ask features report "database not configured".

## Ask tab (plain-language questions)

The Ask tab posts to `POST /api/ask`. The backend sends your question plus
the collection schema to the vision model with a single `query_receipts`
tool; the model replies with a MongoDB aggregation pipeline, the backend
validates it (read-only stages `$match/$unwind/$group/$sort/$limit/$project`
on `receipts` only, 50-row cap) and executes it, then the model phrases the
rows into a one-sentence answer. The model never sees credentials and cannot
write — a hostile prompt dies at the allowlist.

Uploading a photo calls `POST /api/parse`: the backend sends it to
`Llama-4-Maverick-17B-128E-Instruct-FP8` via Meta's Llama API
(`https://api.llama.com/v1/chat/completions`) and the result lands in the
expenses table. The backend is required — without it running, uploads are
refused with a message telling you to start it. To use another provider
(Hugging Face, Groq, Ollama…), set `LLM_BASE_URL` / `LLM_API_KEY` /
`LLM_MODEL` in `.env` — profiles are documented in `.env.example`.

## How receipt validation works

`POST /api/parse` sends the photo to the vision model with a strict prompt
demanding JSON only: `{is_receipt, merchant, date, total, items, reason}`,
where `items` is `[{label, price}]` — one entry per expense line. The
backend coerces that JSON defensively (prices must be non-negative numbers,
strings are length-capped, max 100 lines) and the frontend renders one table
row per expense, with a final row carrying only the receipt total. Anything
the model does not confirm as a receipt is marked **invalid** with a reason,
excluding it from the grand total. To use a different model, set `LLM_MODEL`
in `.env`. Server logs are pretty-printed JSON (`llm_request`,
`llm_response`, `parse` lines).

## Open-source image-processing options

This app calls a hosted open vision model. Candidates:

| Model / engine | License | Best for | Notes |
|---|---|---|---|
| **Tesseract** (used here, via Tesseract.js) | Apache-2.0 | Printed receipts, zero-setup | Fast, offline-capable, weak on handwriting/crumpled photos |
| **PaddleOCR** | Apache-2.0 | Best accuracy on messy receipts | Server-side (Python); heavier; good multilingual |
| **EasyOCR** | Apache-2.0 | Quick Python prototyping | PyTorch; GPU helps; simpler than Paddle |
| **TrOCR** (Microsoft) | MIT | Transformer OCR, printed + handwritten | Hugging Face `transformers`; needs Python + GPU for speed |
| **Donut** (NAACL 2022) | MIT | End-to-end receipt parsing (no separate OCR step) | Extracts fields directly; needs fine-tuning/serving infra |

If a model underperforms on your receipts, swap `LLM_MODEL` first (Qwen-VL via Hugging Face is usually the strongest on documents). For fully private parsing, point the backend at a local Ollama endpoint instead — same OpenAI-compatible shape, no key needed (see `.env.example`).

## Deploy to a public domain

With the Node backend you need a host that runs Node (frontend-only static
hosting still works, but you lose AI parsing). Easiest options:

1. **Render Web Service** — point at the repo; build `npm install`, start `npm start`; free tier + custom domains + HTTPS.
2. **Railway** — same build/start commands; simple env-var UI for `HF_TOKEN`.
3. **Fly.io** — `fly launch`, set secrets with `fly secrets set HF_TOKEN=…`.
4. **Any VPS** (Hetzner, DigitalOcean…) — clone, `npm install`, run with `pm2` or systemd; put Caddy/Nginx in front for HTTPS.

Set `LLM_API_KEY` and `MONGO_URI` (and optionally `LLM_BASE_URL`,
`LLM_MODEL`, `PORT`) in the host's environment variables — never commit
`.env`. Custom domain: add it in the host's dashboard and point DNS as
instructed; HTTPS is automatic on 1–3.

## Monitor usage

| What | Tool (free tier) | How |
|---|---|---|
| Page views / uploads (privacy-friendly) | **Plausible** or **Umami** | Add their 1-line `<script>` to `index.html`; custom event on successful parse + on CSV export |
| Backend errors + AI cost | Server logs | Every `/api/parse` logs one JSON line: `{event: "parse", model, is_receipt, latency_ms, usage}` — `usage` carries token counts for spend tracking; alert on `502` rate |
| Errors (JS exceptions) | **Sentry** (browser SDK) | `Sentry.init({ dsn })`; wraps `parseWithBackend()` failures |
| Uptime | **UptimeRobot** / **Better Stack** | Ping `<your-url>/api/health` every 5 min (it also reports whether the API key is set); alert on downtime |

Suggested custom events to track: `receipt_valid`, `receipt_invalid`, `csv_export`. That tells you volume, rejection rate, and power-user behavior without storing any images.

## Project layout

```
index.html   — page + upload UI + expenses table
styles.css   — styling (system fonts, solid colors, reduced-motion aware)
app.js       — upload → POST /api/parse, expenses table/sum/CSV/localStorage
server.js    — Node backend: static hosting, POST /api/parse, GET /api/receipts,
               DELETE /api/receipts/:id, POST /api/ask, GET /api/health
package.json — deps (express, multer, dotenv, mongodb), `npm start`, `npm test`
test/        — committed backend tests (pipeline allowlist, dates, coercion)
.env.example — copy to .env, add LLM_API_KEY (+ MONGO_URI for persistence/Ask)
```

Data persists in `localStorage` (`receipts-v1`); Clear all wipes it.
