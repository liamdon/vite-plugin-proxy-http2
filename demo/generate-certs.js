// Generate self-signed certificates for the demo server
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const certDir = path.join(__dirname, 'certs')

// Create certs directory if it doesn't exist
if (!fs.existsSync(certDir)) {
  fs.mkdirSync(certDir, { recursive: true })
}

const keyPath = path.join(certDir, 'server.key')
const certPath = path.join(certDir, 'server.crt')

// Check if certificates already exist
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  console.log('Certificates already exist in demo/certs/')
  process.exit(0)
}

console.log('Generating self-signed certificates for demo...')

try {
  // Generate private key
  execSync(`openssl genrsa -out ${keyPath} 2048`, { stdio: 'pipe' })
  
  // Generate certificate
  execSync(
    `openssl req -new -x509 -key ${keyPath} -out ${certPath} -days 365 -subj "/C=US/ST=State/L=City/O=Demo/CN=localhost"`,
    { stdio: 'pipe' }
  )
  
  console.log('Certificates generated successfully!')
  console.log(`  Private key: ${keyPath}`)
  console.log(`  Certificate: ${certPath}`)
} catch (error) {
  console.error('Failed to generate certificates:', error.message)
  console.error('Make sure OpenSSL is installed on your system.')
  process.exit(1)
}