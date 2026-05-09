require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 5657;

// Configuration
const SECRET_HEADER_KEY = process.env.SECRET_KEY || "your-super-secret-key";

// 1. Enable CORS for all incoming requests to this proxy
app.use(cors());

// 2. Rate Limiter: 120 requests per 1 minute window
// This allows a burst of 120 requests in 5 seconds, then blocks for the remaining 55 seconds.
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // Limit each IP to 120 requests per `window`
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded. Please wait before trying again." },
});
app.use(limiter);

// 3. Security Header Middleware
app.use((req, res, next) => {
  // Check for our custom security header
  const providedKey = req.headers["x-proxy-auth"];

  if (providedKey !== SECRET_HEADER_KEY) {
    return res
      .status(401)
      .json({ error: "Unauthorized: Invalid or missing security header." });
  }
  next();
});

// 4. The Proxy Route
app.get("/proxy", async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({ error: "Missing '?url=' parameter" });
  }

  try {
    // Validate URL format (throws error if invalid)
    new URL(targetUrl);

    // Fetch the target URL
    const response = await fetch(targetUrl, {
      method: "GET",
      // Pass standard headers forward if needed
      headers: {
        "User-Agent": req.headers["user-agent"] || "Node-CORS-Proxy",
      },
    });

    // Forward the HTTP status code from the target
    res.status(response.status);

    // Forward the content type (e.g., application/json, image/png)
    const contentType = response.headers.get("content-type");
    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }

    // Convert response to buffer so it works for text, JSON, and binary (images, etc.)
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Send the data back to the client
    res.send(buffer);
  } catch (error) {
    console.error(`Proxy error for ${targetUrl}:`, error.message);
    res.status(500).json({ error: "Failed to fetch the requested URL." });
  }
});

app.listen(PORT, () => {
  console.log(`Lightweight CORS Proxy running on port ${PORT}`);
});
