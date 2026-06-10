/*
 * webhook-proxy.js  (multi‑target, API‑key + rate‑limit only)
 * ---------------------------------------------------------
 * 1.  POST /webhook/<key>
 * 2.  Checks optional x-api-key header (if API_KEY env var set)
 * 3.  Looks up <key> in TARGETS (JSON array in env var)
 * 4.  Proxies body to the corresponding URL
 *
 * Environment variables
 * ---------------------
 * PORT       – listener port (default 3000)
 * TARGETS    – **required** JSON array of objects:
 *                [
 *                  { "key": "crm", "url": "http://crm-svc/webhook" },
 *                  { "key": "erp", "url": "http://erp-svc/webhook" }
 *                ]
 * API_KEY    – if set, caller must send header `x-api-key: <API_KEY>`
 * RATE_LIMIT_WINDOW – ms window (default 60000)
 * RATE_LIMIT_MAX    – requests per window (default 60)
 */

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const axios = require('axios');

const {
  PORT = 3000,
  TARGETS,
  API_KEY,
  RATE_LIMIT_WINDOW = 60000,
  RATE_LIMIT_MAX = 60,
} = process.env;

if (!TARGETS) {
  console.error('TARGETS env var required – see docs.');
  process.exit(1);
}

let targetMap = Object.create(null);
try {
  const arr = JSON.parse(TARGETS);
  for (const item of arr) {
    if (!item.key || !item.url) {
      throw new Error('Each TARGETS item needs {key,url}');
    }
    targetMap[item.key] = item.url;
  }
} catch (err) {
  console.error('TARGETS must be valid JSON array:', err.message);
  process.exit(1);
}

const app = express();

// JSON body parser (2 MB limit)
app.use(express.json({ limit: '2mb' }));

// Basic rate‑limiting
app.use(
  rateLimit({
    windowMs: Number(RATE_LIMIT_WINDOW),
    max: Number(RATE_LIMIT_MAX),
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Optional API key guard
function apiKeyGuard(req, res, next) {
  if (!API_KEY) return next();
  const provided = req.get('x-api-key');
  if (provided !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

// Main proxy route
app.post('/webhook/:key', apiKeyGuard, async (req, res) => {
  const key = req.params.key;
  const targetUrl = targetMap[key];
  if (!targetUrl) {
    return res.status(404).json({ error: `Unknown target "${key}"` });
  }

  try {
    const upstream = await axios.post(targetUrl, req.body, {
      headers: { 'content-type': 'application/json' },
      timeout: 5000,
    });
    res.status(upstream.status).send(upstream.data);
  } catch (err) {
    console.error(`Proxy error to ${key}:`, err.message);
    res.status(502).json({ error: 'Bad gateway' });
  }
});

// Health endpoint
app.get('/healthz', (_, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`Webhook proxy listening on :${PORT}`);
  console.table(targetMap);
});
