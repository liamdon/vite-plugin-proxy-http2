import { createServer as createHttpServer } from "node:http";
import type { ViteDevServer } from "vite";
import { createServer, type HttpServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import http2ProxyPlugin from "../src/index";

describe("WebSocket Proxy Simple", () => {
  let viteServer: ViteDevServer;
  let wsServer: WebSocketServer;
  let httpServer: HttpServer;
  const wsPort = 9879;
  const vitePort = 5178;

  beforeAll(async () => {
    // Create HTTP server with WebSocket server
    httpServer = createHttpServer();
    wsServer = new WebSocketServer({ server: httpServer });

    wsServer.on("connection", (ws) => {
      console.log("WebSocket connected on origin server");

      ws.on("message", (data) => {
        console.log(`Origin server received: ${data}`);
        // Echo the message back
        ws.send(`Echo: ${data}`);
      });

      // Send a welcome message
      ws.send("Connected");
    });

    // Start the HTTP/WebSocket server
    await new Promise<void>((resolve) => {
      httpServer.listen(wsPort, () => {
        console.log(`WebSocket server listening on port ${wsPort}`);
        resolve();
      });
    });

    // Create Vite dev server with WebSocket proxy
    viteServer = await createServer({
      plugins: [http2ProxyPlugin()],
      server: {
        port: vitePort,
        proxy: {
          "/ws": {
            target: `http://localhost:${wsPort}`,
            ws: true,
            changeOrigin: true,
          },
        },
      },
      logLevel: "info",
    });

    await viteServer.listen();
    console.log(`Vite server listening on port ${vitePort}`);
  });

  afterAll(async () => {
    if (wsServer) {
      await new Promise<void>((resolve) => {
        wsServer.close(() => {
          console.log("WebSocket server closed");
          resolve();
        });
      });
    }

    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer.close(() => {
          console.log("HTTP server closed");
          resolve();
        });
      });
    }

    if (viteServer) {
      await viteServer.close();
      console.log("Vite server closed");
    }
  });

  it("should proxy WebSocket connections through Vite", async () => {
    const messages: string[] = [];

    await new Promise<void>((resolve, reject) => {
      console.log(`Connecting to ws://localhost:${vitePort}/ws`);
      const ws = new WebSocket(`ws://localhost:${vitePort}/ws`);

      ws.on("open", () => {
        console.log("WebSocket connected through proxy");
        ws.send("Hello");
      });

      ws.on("message", (data) => {
        const message = data.toString();
        console.log(`Client received: ${message}`);
        messages.push(message);

        if (messages.length === 2) {
          ws.close();
        }
      });

      ws.on("close", () => {
        console.log("WebSocket closed");
        resolve();
      });

      ws.on("error", (err) => {
        console.error("WebSocket error:", err);
        reject(err);
      });

      // Set a timeout
      setTimeout(() => {
        ws.close();
        reject(new Error("WebSocket test timeout"));
      }, 5000);
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe("Connected");
    expect(messages[1]).toBe("Echo: Hello");
  });
});
