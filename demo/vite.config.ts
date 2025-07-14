import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import http2ProxyPlugin from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Custom plugin to handle demo setup automatically
function demoSetupPlugin() {
  let serverProcess = null;
  let isShuttingDown = false;
  const serverPath = join(__dirname, "server.js");
  const certDir = join(__dirname, "certs");
  const keyPath = join(certDir, "server.key");
  const certPath = join(certDir, "server.crt");

  // Check if port is available
  async function isPortAvailable(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close();
        resolve(true);
      });
      server.listen(port);
    });
  }

  // Cleanup function
  const cleanup = () => {
    if (isShuttingDown || !serverProcess) return;
    isShuttingDown = true;

    console.log("🛑 Stopping HTTP/2 demo server...");

    // Try graceful shutdown first
    serverProcess.kill("SIGTERM");

    // Force kill after timeout
    setTimeout(() => {
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill("SIGKILL");
      }
    }, 5000);
  };

  return {
    name: "demo-setup",

    async configureServer(server) {
      // Check if certificates exist
      if (!existsSync(keyPath) || !existsSync(certPath)) {
        console.log("📜 Generating SSL certificates for demo...");

        // Run certificate generation script
        await new Promise((resolve, reject) => {
          const certProcess = spawn(
            "node",
            [join(__dirname, "generate-certs.js")],
            {
              stdio: "inherit",
            },
          );

          certProcess.on("close", (code) => {
            if (code === 0) {
              console.log("✅ Certificates generated successfully!");
              resolve(undefined);
            } else {
              reject(
                new Error(`Certificate generation failed with code ${code}`),
              );
            }
          });

          certProcess.on("error", reject);
        });
      }

      // Check if port is available
      const portAvailable = await isPortAvailable(9443);
      if (!portAvailable) {
        console.error(
          "❌ Port 9443 is already in use. Please stop any process using that port.",
        );
        process.exit(1);
      }

      // Start HTTP/2 demo server
      console.log("🚀 Starting HTTP/2 demo server...");

      // Use spawn instead of fork to avoid module issues
      serverProcess = spawn("node", [serverPath], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      // Handle server output
      serverProcess.stdout?.on("data", (data) => {
        const output = data.toString().trim();
        if (output) {
          console.log(`[HTTP/2 Server] ${output}`);
        }
      });

      serverProcess.stderr?.on("data", (data) => {
        const output = data.toString().trim();
        if (output) {
          console.error(`[HTTP/2 Server] ${output}`);
        }
      });

      // Handle server exit
      serverProcess.on("exit", (code, signal) => {
        if (!isShuttingDown) {
          console.error(
            `[HTTP/2 Server] Exited unexpectedly with code ${code} and signal ${signal}`,
          );
        }
        serverProcess = null;
      });

      // Wait for server to start
      await new Promise((resolve) => setTimeout(resolve, 1500));

      console.log("✨ Demo server is ready!");

      // Handle cleanup when Vite server closes
      server.httpServer?.once("close", cleanup);

      // Set up signal handlers only once
      const signalHandler = () => {
        cleanup();
        process.exit(0);
      };

      // Remove any existing listeners first
      process.removeAllListeners("SIGINT");
      process.removeAllListeners("SIGTERM");

      // Add our handlers
      process.once("SIGINT", signalHandler);
      process.once("SIGTERM", signalHandler);
    },
  };
}

export default defineConfig({
  plugins: [
    demoSetupPlugin(),
    http2ProxyPlugin({
      // Global settings that apply to all proxies
      maxSessions: 50, // Limit HTTP/2 sessions
      sessionMaxAge: 2 * 60 * 1000, // 2 minute session timeout
      connectionTimeout: 5000, // 5 second connection timeout
      maxQueueSize: 200, // Allow up to 200 queued requests
      queueTimeout: 15000, // 15 second queue timeout
      defaultTimeout: 30000, // 30 second default timeout for all proxies

      // Proxy configuration can be here or in server.proxy
      proxy: {
        // Proxy all /api requests to our HTTP/2 test server
        "/api": {
          target: "https://localhost:9443",
          changeOrigin: true,
          secure: false, // Allow self-signed certificates for demo
          rewrite: (path) => path, // Keep the path as-is
          // This specific proxy can override global timeout
          timeout: 60000, // 60 seconds for this specific route
        },
      },
    }),
  ],
  root: __dirname,
  server: {
    port: 5173,
    open: true,
  },
});
