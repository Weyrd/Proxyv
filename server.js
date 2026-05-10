require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 5657;

const SECRET_HEADER_KEY = process.env.SECRET_KEY || "your-super-secret-key";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-proxy-auth",
]);

// ─────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));

// ─────────────────────────────────────────────
// Rate limit
// ─────────────────────────────────────────────
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
  }),
);

// ─────────────────────────────────────────────
// Health check (NO AUTH)
// ─────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", port: PORT });
});

// ─────────────────────────────────────────────
// Auth middleware
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  const key = req.headers["x-proxy-auth"];

  if (key !== SECRET_HEADER_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
});

// ─────────────────────────────────────────────
// Proxy
// ─────────────────────────────────────────────
app.all("/proxy", async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({ error: "Missing url" });
  }

  let url;
  try {
    url = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  try {
    // Build clean headers (DO NOT forward everything)
    const headers = {
      "user-agent": req.headers["user-agent"] || "proxy",
      accept: "*/*",
    };

    // Forward body only when needed
    let body;
    if (!["GET", "HEAD"].includes(req.method)) {
      if (Buffer.isBuffer(req.body)) {
        body = req.body;
      } else if (typeof req.body === "string") {
        body = req.body;
      } else if (req.body) {
        body = JSON.stringify(req.body);
        headers["content-type"] = "application/json";
      }
    }

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });

    res.status(response.status);

    // Forward response headers safely
    response.headers.forEach((value, key) => {
      const k = key.toLowerCase();

      if (HOP_BY_HOP_HEADERS.has(k)) return;

      if (k === "set-cookie") {
        res.append("set-cookie", value);
      } else {
        res.setHeader(key, value);
      }
    });

    res.setHeader("Access-Control-Expose-Headers", "*");

    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const json = await response.json();
      return res.json(json);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // DO NOT force JSON

    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }

    // send raw buffer ALWAYS
    return res.send(buffer);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: "Proxy failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
