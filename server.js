// Local dev server — serves static files + /api/* routes (no Vercel CLI needed)
// Usage: node server.js
// Binds to 0.0.0.0 so your phone can reach it on the same WiFi

import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ---------------------
// Parse .env.local
// ---------------------
function loadEnv() {
  try {
    return Object.fromEntries(
      fs.readFileSync(path.join(__dirname, ".env.local"), "utf8")
        .split("\n")
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
        })
    );
  } catch {
    return {};
  }
}

// ---------------------
// MIME types
// ---------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
};

// ---------------------
// API routes
// ---------------------
async function handleApi(pathname, req, res) {
  if (pathname === "/api/generate-image" && req.method === "POST") {
    const env = loadEnv();
    const token = env.REPLICATE_API_TOKEN;

    if (!token || token.includes("PASTE")) {
      return json(res, 500, { error: "REPLICATE_API_TOKEN not set in .env.local" });
    }

    let body = "";
    req.on("data", (c) => (body += c));
    await new Promise((r) => req.on("end", r));

    try {
      const { prompt, model = "black-forest-labs/flux-schnell" } = JSON.parse(body || "{}");
      if (!prompt) return json(res, 400, { error: "prompt is required" });

      // Start the prediction (ask Replicate to wait up to 60s synchronously)
      const r = await fetch(
        `https://api.replicate.com/v1/models/${model}/predictions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Prefer: "wait=60",
          },
          body: JSON.stringify({ input: { prompt } }),
        }
      );
      let prediction = await r.json();

      // If the sync wait didn't complete it, poll until done (max ~30s)
      if (prediction.status !== "succeeded" && prediction.status !== "failed" && prediction.urls?.get) {
        for (let i = 0; i < 15; i++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const poll = await fetch(prediction.urls.get, {
            headers: { Authorization: `Bearer ${token}` },
          });
          prediction = await poll.json();
          if (prediction.status === "succeeded" || prediction.status === "failed" || prediction.status === "canceled") break;
        }
      }

      console.log("[Replicate] status:", prediction.status, "| output:", prediction.output, "| error:", prediction.error);
      return json(res, prediction.status === "succeeded" ? 200 : 500, prediction);
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  json(res, 404, { error: "Unknown API route" });
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

// ---------------------
// Static file handler
// ---------------------
function serveStatic(pathname, res) {
  // Clean up path
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || !path.extname(rel)) rel = "/index.html";

  const filePath = path.join(__dirname, rel);

  // Prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    // SPA fallback — serve index.html for unknown paths
    try {
      const data = fs.readFileSync(path.join(__dirname, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  }
}

// ---------------------
// Get local network IP
// ---------------------
function getLocalIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "localhost";
}

// ---------------------
// Server
// ---------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // CORS preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname.startsWith("/api/")) {
    return handleApi(url.pathname, req, res);
  }

  serveStatic(url.pathname, res);
});

server.listen(PORT, "0.0.0.0", () => {
  const ip = getLocalIp();
  console.log(`\n  RiffBank dev server`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Phone:   http://${ip}:${PORT}  ← open this on your phone\n`);
});
