require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 5657;
const SECRET_HEADER_KEY = process.env.SECRET_KEY || "your-super-secret-key";

// Headers we never forward
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
  "x-proxy-auth",
]);

// ─────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

// ─────────────────────────────────────────────────────────────
// RAW BODY ONLY
// Critical for Riot auth and generic proxying
// ─────────────────────────────────────────────────────────────
app.use(
  express.raw({
    type: "*/*",
    limit: "10mb",
  }),
);

// ─────────────────────────────────────────────────────────────
// Rate limiting
// ─────────────────────────────────────────────────────────────
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Rate limit exceeded. Please wait before trying again.",
    },
  }),
);

// ─────────────────────────────────────────────────────────────
// Health endpoint (NO AUTH)
// ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    port: PORT,
  });
});

// ─────────────────────────────────────────────────────────────
// Auth middleware
// ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const providedKey = req.headers["x-proxy-auth"];

  if (providedKey !== SECRET_HEADER_KEY) {
    return res.status(401).json({
      error: "Unauthorized: Invalid or missing security header.",
    });
  }

  next();
});

// ─────────────────────────────────────────────────────────────
// Proxy route
// ─────────────────────────────────────────────────────────────
app.all("/proxy", async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({
      error: "Missing '?url=' parameter.",
    });
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return res.status(400).json({
      error: "Invalid URL format.",
    });
  }

  try {
    // Forward headers
    const forwardHeaders = {};

    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        forwardHeaders[key] = value;
      }
    }

    // Override host
    forwardHeaders.host = parsedUrl.host;

    // Let fetch calculate this
    delete forwardHeaders["content-length"];

    const method = req.method.toUpperCase();

    const body = ["GET", "HEAD", "OPTIONS"].includes(method)
      ? undefined
      : req.body;

    const response = await fetch(targetUrl, {
      method,
      headers: forwardHeaders,
      body,
      redirect: "manual",
    });

    // Status
    res.status(response.status);

    // Headers (including cookies)
    for (const [key, value] of response.headers.entries()) {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        if (key.toLowerCase() === "set-cookie") {
          res.append("set-cookie", value);
        } else {
          res.setHeader(key, value);
        }
      }
    }

    // Allow browser JS to read headers
    res.setHeader("Access-Control-Expose-Headers", "*");

    // Body
    const buffer = Buffer.from(await response.arrayBuffer());

    res.send(buffer);
  } catch (error) {
    console.error(`[Proxy Error] ${req.method} ${targetUrl}`, error);

    res.status(500).json({
      error: "Failed to fetch the requested URL.",
      detail: error.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
