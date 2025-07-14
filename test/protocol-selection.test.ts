import fetch from "node-fetch";
import type { ViteDevServer } from "vite";
import { createServer } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http2ProxyPlugin from "../src/index";

describe("Protocol Selection", () => {
  let server: ViteDevServer;
  const vitePort = 5180;

  // Mock console.log to capture protocol selection logs
  const consoleSpy = vi.spyOn(console, "log");

  beforeAll(async () => {
    // Create Vite dev server with various proxy configs
    server = await createServer({
      plugins: [http2ProxyPlugin()],
      server: {
        port: vitePort,
        proxy: {
          "/api": {
            target: "https://httpbin.org",
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/api/, ""),
          },
          "/ws": {
            target: "https://httpbin.org",
            ws: true,
            changeOrigin: true,
          },
          "/force-http1": {
            target: "https://httpbin.org",
            forceHttp1: true,
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/force-http1/, ""),
          },
          "/auto-detect": {
            target: "https://httpbin.org",
            autoDetectProtocol: true,
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/auto-detect/, ""),
          },
        },
      },
      logLevel: "info",
    });

    await server.listen();
  });

  afterAll(async () => {
    if (server) {
      await server.close();
    }
    consoleSpy.mockRestore();
  });

  it("should intercept proxy config early", () => {
    // Check that our plugin intercepted the proxy config
    const interceptLogs = consoleSpy.mock.calls.filter((call) =>
      call[0]?.includes("[vite-plugin-http2-proxy] Intercepted proxy config"),
    );
    expect(interceptLogs.length).toBeGreaterThan(0);
    expect(interceptLogs[0][0]).toContain("4 routes");
  });

  it("should use HTTP/2 by default for regular routes", async () => {
    const response = await fetch(`http://localhost:${vitePort}/api/get`);
    expect(response.ok).toBe(true);

    // Check logs to verify HTTP/2 was used (by absence of HTTP/1.1 logs)
    const recentLogs = consoleSpy.mock.calls.slice(-10);
    const http1Logs = recentLogs.filter(
      (call) =>
        call[0]?.includes("Using HTTP/1.1") && call[0]?.includes("/api/get"),
    );
    expect(http1Logs.length).toBe(0);
  });

  it("should use HTTP/1.1 for WebSocket routes", async () => {
    const response = await fetch(`http://localhost:${vitePort}/ws/get`);
    expect(response.ok).toBe(true);

    // Check logs to verify HTTP/1.1 was used for WebSocket route
    const recentLogs = consoleSpy.mock.calls.slice(-10);
    const wsLogs = recentLogs.filter((call) =>
      call[0]?.includes("Using HTTP/1.1 for WebSocket-enabled route"),
    );
    expect(wsLogs.length).toBeGreaterThan(0);
  });

  it("should use HTTP/1.1 when forceHttp1 is set", async () => {
    const response = await fetch(
      `http://localhost:${vitePort}/force-http1/get`,
    );
    expect(response.ok).toBe(true);

    // Check logs to verify HTTP/1.1 was forced
    const recentLogs = consoleSpy.mock.calls.slice(-10);
    const forcedLogs = recentLogs.filter(
      (call) =>
        call[0]?.includes("Using HTTP/1.1") &&
        call[0]?.includes("forceHttp1 enabled"),
    );
    expect(forcedLogs.length).toBeGreaterThan(0);
  });

  it("should auto-detect protocol support", async () => {
    const response = await fetch(
      `http://localhost:${vitePort}/auto-detect/get`,
    );
    expect(response.ok).toBe(true);

    // Check logs for protocol detection
    const recentLogs = consoleSpy.mock.calls.slice(-20);
    const detectionLogs = recentLogs.filter(
      (call) =>
        call[0]?.includes("Using HTTP/") && call[0]?.includes("/auto-detect"),
    );
    expect(detectionLogs.length).toBeGreaterThan(0);
  });
});
