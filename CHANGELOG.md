# Changelog

## [2.0.0] - 2025-01-11

### Added
- Complete rewrite using Node's native `http2` module
- WebSocket support with proper HTTP/2 upgrade handling
- Advanced cookie management (cookieDomainRewrite, cookiePathRewrite)
- Security features (SSL validation, auth, X-Forwarded headers)
- Server-Sent Events (SSE) support with buffering control
- Dynamic routing with router function
- Conditional bypass functionality
- Custom headers and preserveHeaderKeyCase option
- Comprehensive logging with timing information
- Connection pooling with automatic cleanup
- Timeout configuration
- Test suite with Vitest

### Fixed
- `net::ERR_HTTP2_PROTOCOL_ERROR` issues from improper type casting
- Missing error responses that left streams in inconsistent states
- Proper HTTP/2 pseudo-header handling
- Connection management and stream lifecycle

### Changed
- Complete API compatibility with Vite's built-in proxy configuration
- Improved error handling and reporting
- Better performance through connection pooling

## [1.0.0] - Initial Release

- Basic HTTP/2 proxy functionality using http2-proxy library