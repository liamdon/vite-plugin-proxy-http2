import type { ViteDevServer } from "vite";
import { createServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import http2ProxyPlugin from "../src/index";

describe("WebSocket Proxy", () => {
  let server: ViteDevServer;
  let wss: WebSocketServer;
  const wsPort = 9878;
  const vitePort = 5177;

  beforeAll(async () => {
    // Create a WebSocket server
    wss = new WebSocketServer({ port: wsPort });

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        // Echo the message back
        ws.send(`Echo: ${data}`);
      });

      // Send a welcome message
      ws.send("Connected to WebSocket server");
    });

    // Create Vite dev server with WebSocket proxy
    server = await createServer({
      plugins: [http2ProxyPlugin()],
      server: {
        port: vitePort,
        proxy: {
          "/ws": {
            target: `ws://localhost:${wsPort}`,
            ws: true,
            changeOrigin: true,
          },
        },
      },
    });

    await server.listen();
  });

  afterAll(async () => {
    if (wss) {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    }
    if (server) {
      await server.close();
    }
  });

  it("should proxy WebSocket connections", async () => {
    const messages: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${vitePort}/ws`);

      ws.on("open", () => {
        ws.send("Hello WebSocket");
      });

      ws.on("message", (data) => {
        messages.push(data.toString());
        if (messages.length === 2) {
          ws.close();
        }
      });

      ws.on("close", () => {
        resolve();
      });

      ws.on("error", (err) => {
        reject(err);
      });

      // Set a timeout
      setTimeout(() => {
        ws.close();
        reject(new Error("WebSocket test timeout"));
      }, 5000);
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe("Connected to WebSocket server");
    expect(messages[1]).toBe("Echo: Hello WebSocket");
  });

  it("should handle WebSocket with forceHttp1 option", async () => {
    // Create a new Vite server with forceHttp1
    const server2 = await createServer({
      plugins: [http2ProxyPlugin()],
      server: {
        port: vitePort + 1,
        proxy: {
          "/ws": {
            target: `ws://localhost:${wsPort}`,
            ws: true,
            changeOrigin: true,
            forceHttp1: true,
          },
        },
      },
    });

    await server2.listen();

    try {
      const messages: string[] = [];

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${vitePort + 1}/ws`);

        ws.on("open", () => {
          ws.send("Test forceHttp1");
        });

        ws.on("message", (data) => {
          messages.push(data.toString());
          if (messages.length === 2) {
            ws.close();
          }
        });

        ws.on("close", () => {
          resolve();
        });

        ws.on("error", (err) => {
          reject(err);
        });

        setTimeout(() => {
          ws.close();
          reject(new Error("WebSocket forceHttp1 test timeout"));
        }, 5000);
      });

      expect(messages).toHaveLength(2);
      expect(messages[0]).toBe("Connected to WebSocket server");
      expect(messages[1]).toBe("Echo: Test forceHttp1");
    } finally {
      await server2.close();
    }
  });
});
