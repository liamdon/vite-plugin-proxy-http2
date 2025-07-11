import { defineConfig } from 'vite'
import http2ProxyPlugin from '../src/index'

export default defineConfig({
  plugins: [http2ProxyPlugin()],
  server: {
    proxy: {
      // String shorthand
      '/api': 'https://api.example.com',
      
      // With options
      '/v2': {
        target: 'https://api-v2.example.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/v2/, '')
      },
      
      // RegExp pattern
      '^/external/.*': {
        target: 'https://external-service.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/external/, '/api')
      }
    }
  }
})