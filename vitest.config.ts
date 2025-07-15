import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 30000,
    setupFiles: ["./test/setup.ts"],
    // Run tests sequentially to avoid port conflicts with WebSocket servers
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
