# Vite HTTP/2 Proxy Plugin

Vite plugin that provides HTTP/2 proxy support with full feature parity to Vite's built-in proxy.

## Features

- 🚀 **Native HTTP/2 Support** - Uses Node's native `http2` module, no intermediate proxy module.
- 🔄 **Connection Pooling** - Efficient HTTP/2 connection reuse with automatic cleanup.
- 🔌 **WebSocket Support** - Full WebSocket proxying with HTTP/2 upgrade handling.
- 🍪 **Cookie Management** - Advanced cookie rewriting with domain and path support.
- 🔒 **Security Features** - SSL validation, authentication, and X-Forwarded headers.
- 📡 **SSE Support** - Server-Sent Events with buffering control.
- 🛣️ **Advanced Routing** - Dynamic routing with function support.
- 📊 **Comprehensive Logging** - Detailed request logging with timing information.
- 🎯 **Full Vite Compatibility** - Supports Vite standard proxy configuration options.

## Installation

```bash
npm install vite-plugin-proxy-http2
# or
yarn add vite-plugin-proxy-http2
# or
pnpm add vite-plugin-proxy-http2
```

## Quick Start

```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import http2ProxyPlugin from 'vite-plugin-proxy-http2'

export default defineConfig({
  plugins: [http2ProxyPlugin()],
  server: {
    proxy: {
      '/api': 'https://api.example.com'
    }
  }
})
```

## Configuration

### Basic Examples

```typescript
export default defineConfig({
  plugins: [http2ProxyPlugin()],
  server: {
    proxy: {
      // String shorthand
      '/api': 'https://api.example.com',
      
      // With options
      '/api': {
        target: 'https://api.example.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        headers: {
          'X-Custom-Header': 'value'
        }
      },
      
      // RegExp pattern
      '^/api/.*': {
        target: 'https://api.example.com',
        changeOrigin: true
      }
    }
  }
})
```

### Advanced Features

#### WebSocket Support
```typescript
'/socket.io': {
  target: 'https://socket-server.com',
  ws: true,
  changeOrigin: true
}
```

#### Cookie Rewriting
```typescript
'/api': {
  target: 'https://api.example.com',
  cookieDomainRewrite: 'localhost',
  cookiePathRewrite: {
    '/api': '/',
    '/api/v2': '/v2'
  }
}
```

#### Dynamic Routing
```typescript
'/api': {
  target: 'https://default-api.com',
  router: (req) => {
    // Route based on headers, query params, etc.
    if (req.headers['x-api-version'] === 'v2') {
      return 'https://api-v2.example.com'
    }
    return 'https://api-v1.example.com'
  }
}
```

#### Conditional Bypass
```typescript
'/api': {
  target: 'https://api.example.com',
  bypass: (req, res, options) => {
    // Skip proxy for certain conditions
    if (req.headers.accept?.includes('text/html')) {
      return '/index.html'
    }
  }
}
```

#### Security Options
```typescript
'/api': {
  target: 'https://api.example.com',
  secure: true, // Verify SSL certificates
  auth: 'username:password', // Basic authentication
  xfwd: true, // Add X-Forwarded-* headers
  headers: {
    'Authorization': 'Bearer token'
  }
}
```

#### Server-Sent Events
```typescript
'/events': {
  target: 'https://sse-server.com',
  sse: true, // Optimizes for SSE streams
  changeOrigin: true
}
```

#### Custom Response Handling
```typescript
'/api': {
  target: 'https://api.example.com',
  selfHandleResponse: true,
  configure: (proxyReq, options) => {
    // Custom request/response handling
    proxyReq.on('response', (headers) => {
      console.log('Response headers:', headers)
    })
  }
}
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `target` | `string \| object` | required | Backend server URL |
| `changeOrigin` | `boolean` | `true` | Changes the origin header to match the target |
| `ws` | `boolean` | `false` | Enable WebSocket proxy |
| `rewrite` | `function` | - | Rewrite request paths |
| `configure` | `function` | - | Custom proxy configuration callback |
| `bypass` | `function` | - | Conditionally bypass the proxy |
| `secure` | `boolean` | `true` | Verify SSL certificates |
| `auth` | `string` | - | Basic authentication credentials |
| `headers` | `object` | - | Custom headers to add to requests |
| `xfwd` | `boolean` | `true` | Add X-Forwarded-* headers |
| `preserveHeaderKeyCase` | `boolean` | `false` | Preserve original header key casing |
| `cookieDomainRewrite` | `string \| object` | - | Rewrite cookie domains |
| `cookiePathRewrite` | `string \| object` | - | Rewrite cookie paths |
| `router` | `string \| function` | - | Dynamic target routing |
| `timeout` | `number` | `120000` | Proxy timeout in milliseconds |
| `proxyTimeout` | `number` | `120000` | Proxy timeout in milliseconds |
| `selfHandleResponse` | `boolean` | `false` | Handle response manually |
| `followRedirects` | `boolean` | `false` | Follow HTTP redirects |
| `sse` | `boolean` | `false` | Optimize for Server-Sent Events |

## Debugging

Enable debug logging by setting the `DEBUG` environment variable:

```bash
DEBUG=vite:http2-proxy npm run dev
```

Or set `LOG_LEVEL` for more detailed logging:

```bash
LOG_LEVEL=debug npm run dev
```

## Performance

The plugin implements several performance optimizations:

- **Connection Pooling**: Reuses HTTP/2 connections across requests
- **Automatic Cleanup**: Removes idle connections after 5 minutes
- **Connection Limits**: Prevents resource exhaustion with a maximum of 100 concurrent sessions
- **Stream Management**: Proper HTTP/2 stream lifecycle handling
- **Timeout Handling**: Configurable timeouts prevent hanging requests

## Migration from http-proxy

This plugin maintains API compatibility with Vite's built-in proxy (which uses `http-proxy`). Simply install and add the plugin to migrate:

```diff
// vite.config.ts
import { defineConfig } from 'vite'
+import http2ProxyPlugin from 'vite-http2-proxy'

export default defineConfig({
+  plugins: [http2ProxyPlugin()],
  server: {
    proxy: {
      // Your existing proxy config works as-is
      '/api': 'https://api.example.com'
    }
  }
})
```

## Troubleshooting

### Common Issues

1. **SSL Certificate Errors**
   ```typescript
   // Disable SSL verification for development
   '/api': {
     target: 'https://self-signed.example.com',
     secure: false
   }
   ```

2. **Cookie Issues**
   ```typescript
   // Ensure cookies work on localhost
   '/api': {
     target: 'https://api.example.com',
     cookieDomainRewrite: 'localhost',
     cookiePathRewrite: '/'
   }
   ```

3. **Timeout Errors**
   ```typescript
   // Increase timeout for slow endpoints
   '/api': {
     target: 'https://slow-api.example.com',
     timeout: 300000 // 5 minutes
   }
   ```

## License

MIT
