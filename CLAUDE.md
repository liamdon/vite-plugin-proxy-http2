# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Essential Commands

### Development
- `pnpm install` - Install dependencies (requires pnpm v10.11.0)
- `pnpm dev` - Build in watch mode for development
- `pnpm dev:demo` - Run the demo application with the plugin
- `pnpm build` - Build the plugin for production

### Testing
- `pnpm test` - Run all Vitest tests once
- `pnpm test:watch` - Run Vitest tests in watch mode
- `pnpm test <pattern>` - Run specific test files (e.g., `pnpm test connection-pool`)

The test runner is Vitest, and the config is in `./vitest.config.ts`.
You can find all the tests in `./test/*.test.ts`

### Code Quality
- `pnpm lint` - Check code with Biome linter
- `pnpm lint:fix` - Auto-fix linting issues
- `pnpm format` - Format code with Biome
- `pnpm typecheck` - Run TypeScript type checking
- `pnpm check` - Run lint, build, and test (full validation)

### Publishing
- `pnpm verify` - Run pre-publish verification script

## Architecture Overview

This is a Vite plugin that provides HTTP/2 proxy support. The key architectural components:

### Core Components

1. **Plugin Entry Point** (`src/index.ts`)
   - Exports the main plugin function that integrates with Vite
   - Intercepts Vite's proxy configuration and replaces with HTTP/2 implementation

2. **HTTP/2 Proxy Implementation** (`src/http2-proxy-enhanced.ts`)
   - Main proxy class that handles all HTTP/2 connections
   - Manages request/response lifecycle, headers, cookies, and streams
   - Implements WebSocket upgrades, SSE handling, and dynamic routing
   - Key methods: `createProxyMiddleware()`, `handleHttp2Request()`, `handleWebSocketUpgrade()`

3. **Connection Pool** (`src/connection-pool.ts`)
   - Manages HTTP/2 client sessions for connection reuse
   - Implements automatic cleanup of idle connections (5-minute timeout)
   - Limits concurrent sessions to prevent resource exhaustion (max 100)
   - Key methods: `getSession()`, `cleanup()`, `closeAll()`

4. **Logger** (`src/logger.ts`)
   - Provides structured logging with multiple levels
   - Integrates with Vite's debug system and environment variables
   - Supports `DEBUG=vite:http2-proxy` and `LOG_LEVEL` configuration

### Configuration Flow

1. User configures proxy in `vite.config.ts` using standard Vite proxy syntax
2. Plugin intercepts the configuration during Vite's `configureServer` hook
3. For each proxy rule, creates an HTTP/2 proxy instance with the specified options
4. Proxy middleware handles incoming requests, forwarding them via HTTP/2

### Key Design Decisions

- **Native HTTP/2**: Uses Node.js built-in `http2` module instead of third-party libraries
- **Connection Pooling**: Reuses HTTP/2 connections for performance
- **Vite Compatibility**: Maintains full API compatibility with Vite's built-in proxy
- **TypeScript Strict Mode**: Ensures type safety throughout the codebase

## Code Style

- **Formatter**: Biome with space indentation and double quotes
- **TypeScript**: Strict mode enabled, target ES2020
- **Imports**: Organized and auto-sorted by Biome
- **Testing**: Vitest with globals enabled, 30-second timeout

## Important Notes

- SSL certificates for testing are in `test/fixtures/` and `demo/ssl/`
- The demo application demonstrates real-world usage patterns
- GitHub Actions CI runs on all pull requests (lint, build, test)
- The plugin supports all standard Vite proxy options plus HTTP/2-specific features