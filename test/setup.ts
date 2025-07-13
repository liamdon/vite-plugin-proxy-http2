// Test setup file - runs before all tests
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Generate test certificates if they don't exist
execSync(`node ${join(__dirname, "generate-test-certs.js")}`, {
  stdio: "inherit",
});
