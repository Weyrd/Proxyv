require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 5657;
const SECRET_HEADER_KEY = process.env.SECRET_KEY || "your-super-secret-key";

// Fix trust proxy warning from express-rate-limit
app.set("trust proxy", 1);

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
  "content-encoding", // strip — we send decompressed data
]);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    req.body = undefined;
    next();
  } else {
    next(err);
  }
});
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
    const skipOnForward = new Set([
      "host",
      "x-proxy-auth",
      "connection",
      "content-length",
      "accept-encoding",
    ]);

    const forwardHeaders = {
      "user-agent": req.headers["user-agent"] || "proxy",
      "accept-encoding": "gzip, deflate", // no br — Node fetch can't decompress it
    };

    for (const [key, value] of Object.entries(req.headers)) {
      if (!skipOnForward.has(key.toLowerCase())) {
        forwardHeaders[key] = value;
      }
    }

    if (req.headers["x-forward-user-agent"]) {
      forwardHeaders["user-agent"] = req.headers["x-forward-user-agent"];
    }

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

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body,
      redirect: "manual",
    });

    console.log(`[PROXY] ${req.method} ${targetUrl}`);
    console.log(`[PROXY] Status: ${response.status}`);
    console.log(
      `[PROXY] Headers:`,
      Object.fromEntries(response.headers.entries()),
    );

    res.status(response.status);

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
      try {
        const json = await response.json();
        console.log(`[PROXY] JSON OK`);
        return res.json(json);
      } catch (e) {
        const text = await response.text();
        console.error(`[PROXY] JSON parse failed, raw:`, text.slice(0, 200));
        res.setHeader("Content-Type", "application/json");
        return res.send(text);
      }
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    console.log(
      `[PROXY] Binary/text response, ${buffer.length} bytes, type: ${contentType}`,
    );
    return res.send(buffer);
  } catch (err) {
    console.error("[PROXY] Error:", err);
    res.status(500).json({ error: "Proxy failed", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
