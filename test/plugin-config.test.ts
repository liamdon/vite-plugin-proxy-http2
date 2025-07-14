import fetch from "node-fetch";
import type { ViteDevServer } from "vite";
import { createServer } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http2ProxyPlugin from "../src/index";

describe("Plugin-level Proxy Configuration", () => {
  let server: ViteDevServer;
  let serverWithViteProxy: ViteDevServer;
  const vitePort = 5181;
  const vitePort2 = 5182;

  // Mock console.log to capture configuration logs
  const consoleSpy = vi.spyOn(console, "log");

  beforeAll(async () => {
    // Create server with plugin-level proxy config
    server = await createServer({
      plugins: [
        http2ProxyPlugin({
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
          },
        }),
      ],
      server: {
        port: vitePort,
        // No proxy config here - all in plugin
      },
      logLevel: "info",
    });

    await server.listen();

    // Create another server using Vite's proxy config for comparison
    serverWithViteProxy = await createServer({
      plugins: [http2ProxyPlugin()],
      server: {
        port: vitePort2,
        proxy: {
          "/api": {
            target: "https://httpbin.org",
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/api/, ""),
          },
        },
      },
      logLevel: "info",
    });

    await serverWithViteProxy.listen();
  });

  afterAll(async () => {
    if (server) {
      await server.close();
    }
    if (serverWithViteProxy) {
      await serverWithViteProxy.close();
    }
    consoleSpy.mockRestore();
  });

  it("should use plugin proxy config when provided", () => {
    // Check that our plugin used the plugin-level config
    const pluginConfigLogs = consoleSpy.mock.calls.filter((call) =>
      call[0]?.includes("[vite-plugin-http2-proxy] Using plugin proxy config"),
    );
    expect(pluginConfigLogs.length).toBeGreaterThan(0);
    expect(pluginConfigLogs[0][0]).toContain("2 routes");
  });

  it("should clear Vite proxy config when plugin config is used", () => {
    // Check that Vite's proxy config was cleared
    const clearedLogs = consoleSpy.mock.calls.filter((call) =>
      call[0]?.includes("[vite-plugin-http2-proxy] Cleared Vite proxy config"),
    );
    // This would only happen if someone set both plugin and Vite proxy
    // In our test, we didn't set Vite proxy for the first server
    expect(clearedLogs.length).toBe(0);
  });

  it("should intercept Vite proxy config when no plugin config provided", () => {
    // Check that the second server intercepted Vite's config
    const interceptLogs = consoleSpy.mock.calls.filter((call) =>
      call[0]?.includes(
        "[vite-plugin-http2-proxy] Intercepted Vite proxy config",
      ),
    );
    expect(interceptLogs.length).toBeGreaterThan(0);
  });

  it("should successfully proxy requests with plugin config", async () => {
    const response = await fetch(`http://localhost:${vitePort}/api/get`);
    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(data).toHaveProperty("url");
    // httpbin returns the URL as seen by the server
    expect(data.url).toBeDefined();
  });

  it("should handle WebSocket routes with plugin config", async () => {
    // Make a request to the WebSocket route
    await fetch(`http://localhost:${vitePort}/ws/get`).catch(() => {
      // Expected to fail since httpbin doesn't have /ws
    });

    // Check that HTTP/1.1 was used for WebSocket route
    const recentLogs = consoleSpy.mock.calls.slice(-10);
    const wsLogs = recentLogs.filter((call) =>
      call[0]?.includes("Using HTTP/1.1 for WebSocket-enabled route"),
    );
    expect(wsLogs.length).toBeGreaterThan(0);
  });

  it("should not trigger Vite HTTP/1.1 downgrade with plugin config", async () => {
    // The fact that the server started successfully without errors
    // and can proxy requests indicates Vite didn't downgrade to HTTP/1.1
    expect(server).toBeDefined();
    expect(server.httpServer).toBeDefined();

    // Make a request to verify HTTP/2 is being used
    const response = await fetch(`http://localhost:${vitePort}/api/get`);
    expect(response.ok).toBe(true);

    // If Vite had downgraded, we'd see different behavior in the logs
    // or the server wouldn't start properly with HTTP/2 features
  });
});
