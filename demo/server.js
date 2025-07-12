// Simple HTTP/2 server for testing proxy functionality

import fs from "node:fs";
import http2 from "node:http2";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Certificate paths
const certDir = path.join(__dirname, "certs");
const keyPath = path.join(certDir, "server.key");
const certPath = path.join(certDir, "server.crt");

// Check if certificates exist
if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  console.error("Certificates not found!");
  console.error("Please run: node demo/generate-certs.js");
  process.exit(1);
}

// Load certificates
const serverOptions = {
  key: fs.readFileSync(keyPath),
  cert: fs.readFileSync(certPath),
  allowHTTP1: true,
};

// Create HTTP/2 server
const server = http2.createSecureServer(serverOptions);

// API endpoints
server.on("stream", (stream, headers) => {
  const path = headers[":path"];
  const method = headers[":method"];

  console.log(`[HTTP/2 Server] ${method} ${path}`);

  // Simple routing
  if (path === "/api/hello") {
    stream.respond({
      "content-type": "application/json",
      ":status": 200,
    });
    stream.end(
      JSON.stringify({
        message: "Hello from HTTP/2 server!",
        protocol: "HTTP/2",
        timestamp: new Date().toISOString(),
      }),
    );
  } else if (path === "/api/users") {
    stream.respond({
      "content-type": "application/json",
      ":status": 200,
    });
    stream.end(
      JSON.stringify([
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
        { id: 3, name: "Charlie" },
      ]),
    );
  } else if (path.startsWith("/api/echo")) {
    // Echo back request headers
    stream.respond({
      "content-type": "application/json",
      ":status": 200,
    });
    stream.end(
      JSON.stringify({
        path: path,
        method: method,
        headers: headers,
        message: "Echo endpoint",
      }),
    );
  } else {
    stream.respond({
      "content-type": "application/json",
      ":status": 404,
    });
    stream.end(JSON.stringify({ error: "Not found" }));
  }
});

// Handle errors
server.on("error", (err) => console.error("[HTTP/2 Server] Error:", err));

// Also handle HTTP/1.1 requests for compatibility
server.on("request", (req, _res) => {
  // This handles HTTP/1.1 fallback
  console.log(`[HTTP/1.1 Fallback] ${req.method} ${req.url}`);
});

const PORT = 9443;
server.listen(PORT, () => {
  console.log(`HTTP/2 test server running on https://localhost:${PORT}`);
  console.log("Available endpoints:");
  console.log("  - GET /api/hello");
  console.log("  - GET /api/users");
  console.log("  - GET /api/echo/*");
  console.log(
    "\nNote: Using self-signed certificate. Your browser may show a security warning.",
  );
});
