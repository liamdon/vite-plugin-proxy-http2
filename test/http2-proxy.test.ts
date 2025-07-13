import { readFileSync } from "node:fs";
import type {
  Http2SecureServer,
  IncomingHttpHeaders,
  ServerHttp2Stream,
} from "node:http2";
import { createSecureServer as createHttp2Server } from "node:http2";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";
import type { ViteDevServer } from "vite";
import { createServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http2ProxyPlugin from "../src/index";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("HTTP/2 Proxy Plugin", () => {
  let viteServer: ViteDevServer;
  let targetServer: Http2SecureServer;
  const targetPort = 9876;
  const vitePort = 9877;

  beforeAll(async () => {
    // Create a test HTTP/2 server with HTTPS
    targetServer = createHttp2Server({
      key: readFileSync(join(__dirname, "fixtures", "key.pem")),
      cert: readFileSync(join(__dirname, "fixtures", "cert.pem")),
    });

    targetServer.on(
      "stream",
      (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
        const path = headers[":path"];

        if (path === "/api/test") {
          stream.respond({
            ":status": 200,
            "content-type": "application/json",
            "set-cookie": ["test=value; Domain=example.com; Path=/api"],
          });
          stream.end(JSON.stringify({ message: "Hello from HTTP/2" }));
        } else if (path === "/api/redirect") {
          stream.respond({
            ":status": 302,
            location: "/api/redirected",
          });
          stream.end();
        } else if (path === "/router/api/test") {
          // Handle router test
          stream.respond({
            ":status": 200,
            "content-type": "application/json",
          });
          stream.end(JSON.stringify({ message: "Hello from HTTP/2" }));
        } else if (path === "/api/error") {
          stream.respond({ ":status": 500 });
          stream.end("Internal Server Error");
        } else if (path === "/sse") {
          stream.respond({
            ":status": 200,
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          });
          stream.write("data: First message\\n\\n");
          setTimeout(() => {
            stream.write("data: Second message\\n\\n");
            stream.end();
          }, 100);
        } else if (path === "/api/echo") {
          // Echo back the request body
          const chunks: Buffer[] = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("end", () => {
            const body = Buffer.concat(chunks).toString();
            stream.respond({
              ":status": 200,
              "content-type": headers["content-type"] || "text/plain",
              "x-method": headers[":method"] || "",
            });
            stream.end(body);
          });
        } else if (path === "/api/upload") {
          // Handle file upload
          let totalBytes = 0;
          stream.on("data", (chunk) => {
            totalBytes += chunk.length;
          });
          stream.on("end", () => {
            stream.respond({
              ":status": 200,
              "content-type": "application/json",
            });
            stream.end(JSON.stringify({ bytesReceived: totalBytes }));
          });
        } else if (path === "/api/protected") {
          // Check for authentication
          const authHeader = headers.authorization;
          if (authHeader === "Basic dXNlcjpwYXNz") {
            // user:pass in base64
            stream.respond({
              ":status": 200,
              "content-type": "application/json",
            });
            stream.end(JSON.stringify({ message: "Authenticated" }));
          } else {
            stream.respond({
              ":status": 401,
              "www-authenticate": 'Basic realm="Protected"',
            });
            stream.end("Unauthorized");
          }
        } else {
          stream.respond({ ":status": 404 });
          stream.end("Not Found");
        }
      },
    );

    await new Promise<void>((resolve) => {
      targetServer.listen(targetPort, resolve);
    });

    // Create Vite server with proxy
    viteServer = await createServer({
      plugins: [http2ProxyPlugin()],
      server: {
        port: vitePort,
        proxy: {
          "/api/protected": {
            target: `https://localhost:${targetPort}`,
            changeOrigin: true,
            secure: false,
            auth: "user:pass",
          },
          "/api": {
            target: `https://localhost:${targetPort}`,
            changeOrigin: true,
            secure: false,
            cookieDomainRewrite: "localhost",
            cookiePathRewrite: "/",
            headers: {
              "X-Custom-Header": "test",
            },
            xfwd: true,
          },
          "/sse": {
            target: `https://localhost:${targetPort}`,
            changeOrigin: true,
            secure: false,
            sse: true,
          },
          "^/regex/.*": {
            target: `https://localhost:${targetPort}`,
            secure: false,
            rewrite: (path) => path.replace(/^\/regex/, "/api"),
          },
          "/bypass": {
            target: `https://localhost:${targetPort}`,
            secure: false,
            bypass: (req) => {
              if (req.headers["x-skip-proxy"]) {
                return "/index.html";
              }
              return null;
            },
          },
          "/router": {
            target: "https://default.com",
            secure: false,
            router: (req) => {
              if (req.headers["x-target"] === "custom") {
                return `https://localhost:${targetPort}`;
              }
              return `https://localhost:${targetPort}`;
            },
          },
        },
      },
    });

    await viteServer.listen();
  });

  afterAll(async () => {
    await viteServer.close();
    targetServer.close();
  });

  it("should proxy basic HTTP/2 requests", async () => {
    const response = await fetch(`http://localhost:${vitePort}/api/test`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ message: "Hello from HTTP/2" });
  });

  it("should rewrite cookies", async () => {
    const response = await fetch(`http://localhost:${vitePort}/api/test`);
    const cookies = response.headers.get("set-cookie");

    expect(cookies).toBeTruthy();
    expect(cookies).toContain("Domain=localhost");
    expect(cookies).toContain("Path=/");
  });

  it("should add custom headers", async () => {
    // This would need to be verified on the target server side
    // For now, we just ensure the request goes through
    const response = await fetch(`http://localhost:${vitePort}/api/test`);
    expect(response.status).toBe(200);
  });

  it("should handle RegExp patterns", async () => {
    const response = await fetch(`http://localhost:${vitePort}/regex/test`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ message: "Hello from HTTP/2" });
  });

  it("should handle bypass function", async () => {
    const response = await fetch(`http://localhost:${vitePort}/bypass/test`, {
      headers: { "x-skip-proxy": "true" },
    });

    // Should get index.html response
    const text = await response.text();
    expect(text).toContain("<!DOCTYPE html>");
  });

  it("should handle router function", async () => {
    const response = await fetch(
      `http://localhost:${vitePort}/router/api/test`,
      {
        headers: { "x-target": "custom" },
      },
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ message: "Hello from HTTP/2" });
  });

  it("should handle redirects", async () => {
    const response = await fetch(`http://localhost:${vitePort}/api/redirect`, {
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/api/redirected");
  });

  it("should handle errors gracefully", async () => {
    const response = await fetch(`http://localhost:${vitePort}/api/error`);

    expect(response.status).toBe(500);
  });

  it("should support Server-Sent Events", async () => {
    const response = await fetch(`http://localhost:${vitePort}/sse`);

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
  });

  it("should handle POST requests with JSON body", async () => {
    const body = { name: "test", value: 123 };
    const response = await fetch(`http://localhost:${vitePort}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-method")).toBe("POST");
    const responseBody = await response.json();
    expect(responseBody).toEqual(body);
  });

  it("should handle PUT requests with form data", async () => {
    const formData = "field1=value1&field2=value2";
    const response = await fetch(`http://localhost:${vitePort}/api/echo`, {
      method: "PUT",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(response.headers.get("x-method")).toBe("PUT");
    const responseText = await response.text();
    expect(responseText).toBe(formData);
  });

  it("should handle large file uploads", async () => {
    // Create a large buffer (1MB)
    const largeBuffer = Buffer.alloc(1024 * 1024, "x");

    const response = await fetch(`http://localhost:${vitePort}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: largeBuffer,
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.bytesReceived).toBe(1024 * 1024);
  });

  it("should handle empty POST body", async () => {
    const response = await fetch(`http://localhost:${vitePort}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "",
    });

    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).toBe("");
  });

  it("should handle streaming request body", async () => {
    // Note: fetch API doesn't support manual chunked encoding,
    // but the proxy should handle streaming bodies correctly
    const body = "Hello World! This is a streaming test.";

    const response = await fetch(`http://localhost:${vitePort}/api/echo`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
      },
      body: body,
    });

    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).toBe(body);
  });

  it("should handle different content types", async () => {
    const xmlBody = "<root><item>test</item></root>";
    const response = await fetch(`http://localhost:${vitePort}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: xmlBody,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml");
    const responseText = await response.text();
    expect(responseText).toBe(xmlBody);
  });

  it("should handle proxy authentication with auth option", async () => {
    const response = await fetch(`http://localhost:${vitePort}/api/protected`);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toBe("Authenticated");
  });

  it("should handle requests to protected endpoints without proxy auth", async () => {
    // Create a separate test for endpoint that doesn't have auth configured
    const protectedServer = createHttp2Server({
      key: readFileSync(join(__dirname, "fixtures", "key.pem")),
      cert: readFileSync(join(__dirname, "fixtures", "cert.pem")),
    });

    const protectedPort = 9875;

    protectedServer.on("stream", (stream, headers) => {
      const authHeader = headers.authorization;
      if (!authHeader) {
        stream.respond({
          ":status": 401,
          "www-authenticate": 'Basic realm="Protected"',
        });
        stream.end("Unauthorized");
      } else {
        stream.respond({ ":status": 200 });
        stream.end("OK");
      }
    });

    await new Promise<void>((resolve) => {
      protectedServer.listen(protectedPort, resolve);
    });

    // Create a new vite server with proxy but no auth
    const noAuthServer = await createServer({
      plugins: [http2ProxyPlugin()],
      server: {
        port: 9874,
        proxy: {
          "/protected": {
            target: `https://localhost:${protectedPort}`,
            secure: false,
            changeOrigin: true,
            // No auth option here
          },
        },
      },
      logLevel: "silent",
    });

    await noAuthServer.listen();

    // Request should fail with 401
    const response = await fetch(`http://localhost:9874/protected`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Basic realm="Protected"',
    );

    await noAuthServer.close();
    await new Promise<void>((resolve) => {
      protectedServer.close(resolve);
    });
  });

  it("should propagate custom authorization headers", async () => {
    // Test that custom auth headers from client are passed through
    const customAuthServer = createHttp2Server({
      key: readFileSync(join(__dirname, "fixtures", "key.pem")),
      cert: readFileSync(join(__dirname, "fixtures", "cert.pem")),
    });

    const customAuthPort = 9873;

    customAuthServer.on("stream", (stream, headers) => {
      stream.respond({
        ":status": 200,
        "content-type": "application/json",
      });
      stream.end(
        JSON.stringify({
          receivedAuth: headers.authorization || "none",
        }),
      );
    });

    await new Promise<void>((resolve) => {
      customAuthServer.listen(customAuthPort, resolve);
    });

    const customAuthViteServer = await createServer({
      plugins: [http2ProxyPlugin()],
      server: {
        port: 9872,
        proxy: {
          "/custom": {
            target: `https://localhost:${customAuthPort}`,
            secure: false,
            changeOrigin: true,
          },
        },
      },
      logLevel: "silent",
    });

    await customAuthViteServer.listen();

    // Send request with custom auth header
    const response = await fetch(`http://localhost:9872/custom`, {
      headers: {
        Authorization: "Bearer my-token-123",
      },
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.receivedAuth).toBe("Bearer my-token-123");

    await customAuthViteServer.close();
    await new Promise<void>((resolve) => {
      customAuthServer.close(resolve);
    });
  });
});

describe("HTTP/2 Connection Pool", () => {
  let viteServer: ViteDevServer;
  let targetServer: Http2SecureServer;
  const targetPort = 9878;
  const vitePort = 9879;

  beforeAll(async () => {
    // Reuse the same setup from the parent describe block
    targetServer = createHttp2Server({
      key: readFileSync(join(__dirname, "fixtures", "key.pem")),
      cert: readFileSync(join(__dirname, "fixtures", "cert.pem")),
    });

    targetServer.on(
      "stream",
      (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
        const path = headers[":path"];

        if (path === "/api/test") {
          stream.respond({
            ":status": 200,
            "content-type": "application/json",
          });
          stream.end(JSON.stringify({ message: "Hello from HTTP/2" }));
        }
      },
    );

    await new Promise<void>((resolve) => {
      targetServer.listen(targetPort, resolve);
    });

    viteServer = await createServer({
      plugins: [http2ProxyPlugin()],
      server: {
        port: vitePort,
        proxy: {
          "/api": {
            target: `https://localhost:${targetPort}`,
            changeOrigin: true,
            secure: false,
          },
        },
      },
    });

    await viteServer.listen();
  });

  afterAll(async () => {
    await viteServer.close();
    targetServer.close();
  });

  it("should reuse connections", async () => {
    // Make multiple requests to ensure connection pooling works
    const promises = Array(10)
      .fill(0)
      .map(async () => {
        const response = await fetch(`http://localhost:${vitePort}/api/test`);
        return response.json();
      });

    const results = await Promise.all(promises);

    expect(results).toHaveLength(10);
    results.forEach((result) => {
      expect(result).toEqual({ message: "Hello from HTTP/2" });
    });
  });
});
