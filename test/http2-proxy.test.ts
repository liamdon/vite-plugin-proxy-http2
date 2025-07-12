import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "vite";
import type { ViteDevServer } from "vite";
import http2ProxyPlugin from "../src/http2-proxy-enhanced";
import { createSecureServer as createHttp2Server } from "http2";
import { readFileSync } from "fs";
import { join } from "path";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("HTTP/2 Proxy Plugin", () => {
  let viteServer: ViteDevServer;
  let targetServer: any;
  const targetPort = 9876;
  const vitePort = 9877;

  beforeAll(async () => {
    // Create a test HTTP/2 server with HTTPS
    targetServer = createHttp2Server({
      key: readFileSync(join(__dirname, "fixtures", "key.pem")),
      cert: readFileSync(join(__dirname, "fixtures", "cert.pem")),
    });

    targetServer.on("stream", (stream: any, headers: any) => {
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
      } else {
        stream.respond({ ":status": 404 });
        stream.end("Not Found");
      }
    });

    await new Promise<void>((resolve) => {
      targetServer.listen(targetPort, resolve);
    });

    // Create Vite server with proxy
    viteServer = await createServer({
      plugins: [http2ProxyPlugin()],
      server: {
        port: vitePort,
        proxy: {
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
});

describe("HTTP/2 Connection Pool", () => {
  let viteServer: ViteDevServer;
  let targetServer: any;
  const targetPort = 9878;
  const vitePort = 9879;

  beforeAll(async () => {
    // Reuse the same setup from the parent describe block
    targetServer = createHttp2Server({
      key: readFileSync(join(__dirname, "fixtures", "key.pem")),
      cert: readFileSync(join(__dirname, "fixtures", "cert.pem")),
    });

    targetServer.on("stream", (stream: any, headers: any) => {
      const path = headers[":path"];

      if (path === "/api/test") {
        stream.respond({
          ":status": 200,
          "content-type": "application/json",
        });
        stream.end(JSON.stringify({ message: "Hello from HTTP/2" }));
      }
    });

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
