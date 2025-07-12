// Generate self-signed certificates for tests
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");

// Create fixtures directory if it doesn't exist
if (!fs.existsSync(fixturesDir)) {
  fs.mkdirSync(fixturesDir, { recursive: true });
}

const keyPath = path.join(fixturesDir, "key.pem");
const certPath = path.join(fixturesDir, "cert.pem");

// Check if certificates already exist
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  console.log("Test certificates already exist in test/fixtures/");
  process.exit(0);
}

console.log("Generating self-signed certificates for tests...");

try {
  // Generate private key
  execSync(`openssl genrsa -out ${keyPath} 2048`, { stdio: "pipe" });

  // Generate certificate
  execSync(
    `openssl req -new -x509 -key ${keyPath} -out ${certPath} -days 365 -subj "/C=US/ST=State/L=City/O=Test/CN=localhost"`,
    { stdio: "pipe" },
  );

  console.log("Test certificates generated successfully!");
  console.log(`  Private key: ${keyPath}`);
  console.log(`  Certificate: ${certPath}`);
} catch (error) {
  console.error("Failed to generate certificates:", error.message);
  console.error("Make sure OpenSSL is installed on your system.");
  process.exit(1);
}
