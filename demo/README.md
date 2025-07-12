# Vite HTTP/2 Proxy Plugin Demo

This demo shows the HTTP/2 proxy plugin in action with a real HTTP/2 server.

## How to Run

Simply run:
```bash
npm run dev:demo
```

That's it! The demo will automatically:
- Generate SSL certificates (first time only)
- Start the HTTP/2 test server on https://localhost:9443
- Start the Vite dev server on http://localhost:5173
- Open your browser to the demo page

## What Happens Behind the Scenes

The demo uses a custom Vite plugin that:
1. Checks for SSL certificates in `demo/certs/`
2. Generates them automatically if missing
3. Starts the HTTP/2 server as a child process
4. Manages the server lifecycle (stops it when Vite stops)

## What's Included

- **HTTP/2 Test Server** (`server.js`): A Node.js HTTP/2 server with test endpoints
- **Demo Page** (`index.html`): Interactive UI to test proxy functionality
- **Vite Config** (`vite.config.ts`): Shows how to configure the HTTP/2 proxy plugin
- **Certificate Generator** (`generate-certs.js`): Creates self-signed certificates

## Available Endpoints

The demo proxies `/api/*` requests to the HTTP/2 server:
- `/api/hello` - Returns a greeting with timestamp
- `/api/users` - Returns a list of users
- `/api/echo/*` - Echoes back request information
- Any other `/api/*` path returns 404

All requests are proxied through Vite to the HTTP/2 server, demonstrating the plugin's functionality.

## Troubleshooting

If you encounter issues:
1. Make sure OpenSSL is installed (for certificate generation)
2. Check that ports 9443 and 5173 are available
3. Delete `demo/certs/` and restart to regenerate certificates