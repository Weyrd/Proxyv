require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 5657;

// ─── Config ───────────────────────────────────────────────────────────────────
const SECRET_HEADER_KEY = process.env.SECRET_KEY || "your-super-secret-key";

// Headers we never forward to the target (proxy-internal or connection-level)
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-proxy-auth", // our own security header, never forward it
]);

// ─── Middlewares ──────────────────────────────────────────────────────────────

// 1. CORS — allow all origins so the browser SPA can reach this proxy
app.use(cors());

// 2. Body parsers — needed to read JSON / form bodies on POST/PUT/PATCH
app.use(express.json({ limit: "10mb" }));
app.use(express.text({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// 3. Rate limiter — 120 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded. Please wait before trying again." },
});
app.use(limiter);

// 4. Secret header auth — every request must carry x-proxy-auth
app.use((req, res, next) => {
  const providedKey = req.headers["x-proxy-auth"];
  if (providedKey !== SECRET_HEADER_KEY) {
    return res
      .status(401)
      .json({ error: "Unauthorized: Invalid or missing security header." });
  }
  next();
});

// ─── Proxy Route ──────────────────────────────────────────────────────────────

// Accepts ALL HTTP methods (GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD)
app.all("/proxy", async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({ error: "Missing '?url=' parameter." });
  }

  // Validate URL
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: "Invalid URL format." });
  }

  // ── Build headers to forward to target ──────────────────────────────────────
  const forwardHeaders = {};

  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      forwardHeaders[key] = value;
    }
  }

  // Override host to match the target (required for most APIs)
  forwardHeaders["host"] = parsedUrl.host;

  // ── Build body ───────────────────────────────────────────────────────────────
  let body = undefined;
  const method = req.method.toUpperCase();

  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    if (typeof req.body === "object" && req.body !== null) {
      body = JSON.stringify(req.body);
      // Ensure Content-Type is set if client forgot
      if (!forwardHeaders["content-type"]) {
        forwardHeaders["content-type"] = "application/json";
      }
    } else if (typeof req.body === "string" && req.body.length > 0) {
      body = req.body;
    }
  }

  // ── Fire the request ─────────────────────────────────────────────────────────
  try {
    const response = await fetch(targetUrl, {
      method,
      headers: forwardHeaders,
      body,
      // Don't follow redirects automatically — let the client handle them
      redirect: "manual",
    });

    // ── Forward response status ──────────────────────────────────────────────
    res.status(response.status);

    // ── Forward ALL response headers (including Set-Cookie) ──────────────────
    // response.headers.entries() gives us every header, including duplicates
    // for Set-Cookie which is critical for Riot auth cookie chaining
    for (const [key, value] of response.headers.entries()) {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        // Express dedups setHeader; use append for Set-Cookie to keep all cookies
        if (key.toLowerCase() === "set-cookie") {
          res.append("set-cookie", value);
        } else {
          res.setHeader(key, value);
        }
      }
    }

    // Also expose headers to the browser (needed for JS to read them)
    res.setHeader("Access-Control-Expose-Headers", "*");

    // ── Stream body back ─────────────────────────────────────────────────────
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    console.error(`[Proxy Error] ${method} ${targetUrl} →`, error.message);
    res.status(500).json({
      error: "Failed to fetch the requested URL.",
      detail: error.message,
    });
  }
});

// ─── Health check (no auth required) ─────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", port: PORT });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ CORS Proxy running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Proxy:  http://localhost:${PORT}/proxy?url=<TARGET_URL>`);
});
