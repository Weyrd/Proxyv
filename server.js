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
  // Also strip content-encoding — we're sending decompressed data
  "content-encoding",
]);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.raw({ type: "*/*", limit: "10mb" }));

app.use(rateLimit({ windowMs: 60 * 1000, max: 120 }));

app.get("/health", (req, res) => {
  res.json({ status: "ok", port: PORT });
});

app.use((req, res, next) => {
  if (req.headers["x-proxy-auth"] !== SECRET_HEADER_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.all("/proxy", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: "Missing url" });

  try {
    new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  try {
    // Build forwarded headers — pass through what the client sent
    // but strip proxy-specific ones
    const skipOnForward = new Set([
      "host",
      "x-proxy-auth",
      "connection",
      "content-length",
    ]);

    const forwardHeaders = {
      "user-agent": req.headers["user-agent"] || "proxy",
      // Tell the remote server we accept gzip — Node's fetch will auto-decompress
      "accept-encoding": "gzip, deflate",
    };

    // Forward any extra headers the client sent (Authorization, cookies, etc.)
    for (const [key, value] of Object.entries(req.headers)) {
      if (!skipOnForward.has(key.toLowerCase())) {
        forwardHeaders[key] = value;
      }
    }

    // Forward body for POST/PUT/PATCH
    let body;
    if (!["GET", "HEAD"].includes(req.method)) {
      if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        body = req.body;
      } else if (typeof req.body === "string" && req.body.length > 0) {
        body = req.body;
      } else if (
        req.body &&
        typeof req.body === "object" &&
        Object.keys(req.body).length > 0
      ) {
        body = JSON.stringify(req.body);
        forwardHeaders["content-type"] = "application/json";
      }
    }

    // Node 18+ fetch auto-decompresses gzip/br when accept-encoding is set
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body,
      redirect: "manual",
    });

    res.status(response.status);

    // Forward response headers — skip hop-by-hop and content-encoding
    // (since fetch already decompressed the body for us)
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

    // Get the decompressed text/buffer from fetch
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      // Safe: fetch already decompressed, parse and re-serialize cleanly
      try {
        const json = await response.json();
        return res.json(json);
      } catch {
        // If JSON parse fails, fall through to raw send
        const text = await response.text();
        res.setHeader("Content-Type", "application/json");
        return res.send(text);
      }
    }

    // For everything else (images, HTML, binary), send the decompressed buffer
    const buffer = Buffer.from(await response.arrayBuffer());
    return res.send(buffer);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: "Proxy failed", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
