import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ClientHttp2Session,
  ClientHttp2Stream,
  IncomingHttpHeaders,
  OutgoingHttpHeaders,
} from "node:http2";
import { connect, constants } from "node:http2";
import * as net from "node:net";
import type { TLSSocket } from "node:tls";
import * as tls from "node:tls";
import type { Plugin, ProxyOptions, ResolvedConfig } from "vite";
import { Http2ConnectionPool } from "./connection-pool";
import { createLogger, type Logger, logProxyRequest } from "./logger";
import { RequestQueue } from "./request-queue";

let logger: Logger;

const {
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_AUTHORITY,
  HTTP2_HEADER_SCHEME,
  HTTP2_HEADER_STATUS,
  HTTP2_HEADER_LOCATION,
} = constants;

// Type guard to check if a socket is a TLSSocket
function isTLSSocket(socket: net.Socket | undefined): socket is TLSSocket {
  return (
    socket !== undefined &&
    "encrypted" in socket &&
    (socket as TLSSocket).encrypted === true
  );
}

// Extended proxy options to match Vite's full feature set
interface Http2ProxyOptions extends Omit<ProxyOptions, "configure" | "bypass"> {
  // Cookie rewriting
  cookieDomainRewrite?: string | { [domain: string]: string } | false;
  cookiePathRewrite?: string | { [path: string]: string } | false;

  // Headers
  headers?: Record<string, string>;
  xfwd?: boolean;
  preserveHeaderKeyCase?: boolean;

  // Security
  secure?: boolean;
  auth?: string;

  // Advanced routing
  router?: string | ((req: IncomingMessage) => string);

  // Timeouts
  timeout?: number;
  proxyTimeout?: number;

  // Override configure with HTTP/2 stream type
  configure?: (stream: ClientHttp2Stream, options: Http2ProxyOptions) => void;

  // Override bypass with our options type
  bypass?: (
    req: IncomingMessage,
    res: ServerResponse,
    options: Http2ProxyOptions,
    // biome-ignore lint/suspicious/noConfusingVoidType: Matching Vite's bypass API which includes void
  ) => null | undefined | false | string | void;

  // Response handling
  selfHandleResponse?: boolean;
  followRedirects?: boolean;

  // SSE support
  sse?: boolean;

  // Protocol options
  forceHttp1?: boolean; // Force HTTP/1.1 for this proxy
  autoDetectProtocol?: boolean; // Auto-detect server protocol support
}

interface NormalizedProxyOptions extends Http2ProxyOptions {
  target: string;
  changeOrigin: boolean;
}

let connectionPool: Http2ConnectionPool;
let requestQueue: RequestQueue;

// Map to track which origins support HTTP/2
const http2SupportMap = new Map<string, boolean>();

// Check if an origin supports HTTP/2
async function supportsHttp2(
  origin: string,
  secure: boolean,
): Promise<boolean> {
  // Check cache first
  if (http2SupportMap.has(origin)) {
    return http2SupportMap.get(origin) ?? false;
  }

  return new Promise((resolve) => {
    const testSession = connect(origin, {
      rejectUnauthorized: secure !== false,
    });

    const timeout = setTimeout(() => {
      testSession.close();
      // Timeout likely means HTTP/1.1 only
      http2SupportMap.set(origin, false);
      resolve(false);
    }, 2000);

    testSession.on("connect", () => {
      clearTimeout(timeout);
      testSession.close();
      // Successful connection means HTTP/2 is supported
      http2SupportMap.set(origin, true);
      resolve(true);
    });

    testSession.on("error", () => {
      clearTimeout(timeout);
      // Error likely means HTTP/1.1 only
      http2SupportMap.set(origin, false);
      resolve(false);
    });
  });
}

function normalizeProxyOptions(
  options: string | Http2ProxyOptions | ProxyOptions,
  globalDefaults?: {
    defaultTimeout?: number;
    defaultProxyTimeout?: number;
  },
): NormalizedProxyOptions {
  if (typeof options === "string") {
    return {
      target: options,
      changeOrigin: true,
      xfwd: true,
      timeout: globalDefaults?.defaultTimeout,
      proxyTimeout: globalDefaults?.defaultProxyTimeout,
    };
  }

  if (!options.target) {
    throw new Error("Proxy target is required");
  }

  // Handle different target types
  let targetUrl: string;
  if (typeof options.target === "string") {
    targetUrl = options.target;
  } else if ("href" in options.target && options.target.href) {
    targetUrl = options.target.href;
  } else if ("protocol" in options.target && "host" in options.target) {
    // ProxyTargetDetailed type
    const { protocol, host, port } = options.target;
    targetUrl = `${protocol}//${host}${port ? `:${port}` : ""}`;
  } else {
    throw new Error("Invalid proxy target");
  }

  // Create base normalized options
  const baseOptions = {
    changeOrigin: true,
    xfwd: true,
    secure: true,
    target: targetUrl,
    // Apply global defaults if not specified in proxy options
    timeout: options.timeout ?? globalDefaults?.defaultTimeout,
    proxyTimeout: options.proxyTimeout ?? globalDefaults?.defaultProxyTimeout,
  };

  // Handle ProxyOptions that need to be converted to Http2ProxyOptions
  const { configure, bypass, target: _, ...restOptions } = options;

  const normalizedOptions: NormalizedProxyOptions = {
    ...baseOptions,
    ...restOptions,
  };

  // Add configure and bypass with proper typing if they exist
  if (configure) {
    normalizedOptions.configure = configure as Http2ProxyOptions["configure"];
  }

  if (bypass) {
    normalizedOptions.bypass = bypass as Http2ProxyOptions["bypass"];
  }

  return normalizedOptions;
}

function rewriteCookie(
  cookie: string,
  domainRewrite: string | { [domain: string]: string } | false,
  pathRewrite: string | { [path: string]: string } | false,
): string {
  if (!domainRewrite && !pathRewrite) return cookie;

  let rewritten = cookie;

  // Domain rewriting
  if (domainRewrite) {
    const domainMatch = /domain=([^;]+)/i.exec(cookie);
    if (domainMatch) {
      const oldDomain = domainMatch[1];
      let newDomain: string | undefined;

      if (typeof domainRewrite === "string") {
        newDomain = domainRewrite;
      } else if (typeof domainRewrite === "object") {
        newDomain = domainRewrite[oldDomain];
      }

      if (newDomain !== undefined) {
        rewritten = rewritten.replace(domainMatch[0], `Domain=${newDomain}`);
      }
    }
  }

  // Path rewriting
  if (pathRewrite) {
    const pathMatch = /path=([^;]+)/i.exec(cookie);
    if (pathMatch) {
      const oldPath = pathMatch[1];
      let newPath: string | undefined;

      if (typeof pathRewrite === "string") {
        newPath = pathRewrite;
      } else if (typeof pathRewrite === "object") {
        newPath = pathRewrite[oldPath];
      }

      if (newPath !== undefined) {
        rewritten = rewritten.replace(pathMatch[0], `Path=${newPath}`);
      }
    }
  }

  return rewritten;
}

function createHttp2Headers(
  req: IncomingMessage,
  target: URL,
  options: NormalizedProxyOptions,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {
    [HTTP2_HEADER_METHOD]: req.method || "GET",
    [HTTP2_HEADER_SCHEME]: target.protocol.slice(0, -1),
    [HTTP2_HEADER_AUTHORITY]: target.host,
  };

  // HTTP/2 forbidden headers that must be filtered out
  const forbiddenHeaders = [
    "connection",
    "upgrade",
    "keep-alive",
    "transfer-encoding",
    "proxy-connection",
  ];

  // Copy headers from incoming request
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.startsWith(":")) continue; // Skip pseudo-headers
    if (key === "host" && options.changeOrigin) {
      continue; // Skip host header when changeOrigin is true
    }
    if (forbiddenHeaders.includes(key.toLowerCase())) {
      continue; // Skip forbidden HTTP/2 headers
    }
    if (options.preserveHeaderKeyCase) {
      // Find the original case-sensitive key
      const originalKey = Object.keys(req.headers).find(
        (k) => k.toLowerCase() === key,
      );
      headers[originalKey || key] = value;
    } else {
      headers[key] = value;
    }
  }

  // Set host header if changeOrigin is true
  if (options.changeOrigin) {
    headers.host = target.host;
  }

  // Add custom headers
  if (options.headers) {
    Object.assign(headers, options.headers);
  }

  // Add X-Forwarded headers if xfwd is true
  if (options.xfwd) {
    const forwarded = req.socket.remoteAddress;
    headers["x-forwarded-for"] = forwarded;
    // Check if socket is a TLSSocket (encrypted connection)
    headers["x-forwarded-proto"] = isTLSSocket(req.socket) ? "https" : "http";
    headers["x-forwarded-host"] = req.headers.host || "";
    headers["x-forwarded-port"] = String(req.socket.localPort);
  }

  // Add authentication header if auth option is provided
  if (options.auth && !headers.authorization) {
    const authString = Buffer.from(options.auth).toString("base64");
    headers.authorization = `Basic ${authString}`;
    logger?.debug(`Added auth header: Basic ${authString.substring(0, 10)}...`);
  }

  return headers;
}

async function getTargetUrl(
  req: IncomingMessage,
  options: NormalizedProxyOptions,
): Promise<string> {
  // Handle router function
  if (options.router) {
    if (typeof options.router === "function") {
      const target = await options.router(req);
      // Validate router returned URL
      try {
        new URL(target);
        return target;
      } catch (_err) {
        throw new Error(`Router returned invalid URL: ${target}`);
      }
    } else {
      return options.router;
    }
  }
  return options.target;
}

async function handleBypass(
  req: IncomingMessage,
  res: ServerResponse,
  options: NormalizedProxyOptions,
  next: () => void,
): Promise<boolean> {
  if (!options.bypass) return false;

  const result = await options.bypass(req, res, options);

  if (typeof result === "string") {
    // Rewrite the URL and pass to next middleware
    req.url = result;
    next();
    return true;
  }

  if (result === false) {
    // Continue with proxy
    return false;
  }

  // If result is truthy (but not a string), skip proxy
  if (result) {
    next();
    return true;
  }

  return false;
}

// HTTP/1.1 proxy handler for WebSocket and other HTTP/1.1 requests
async function proxyHttp1Request(
  req: IncomingMessage,
  res: ServerResponse,
  options: NormalizedProxyOptions,
  _next: () => void,
): Promise<void> {
  const startTime = Date.now();
  logger?.debug(`Starting HTTP/1.1 proxy for ${req.method} ${req.url}`);

  // Debug log headers for WebSocket
  if (options.ws && logger) {
    logger.debug(`HTTP/1.1 proxy headers for WebSocket request:`);
    logger.debug(`  Upgrade: ${req.headers.upgrade}`);
    logger.debug(`  Connection: ${req.headers.connection}`);
    logger.debug(`  Sec-WebSocket-Key: ${req.headers["sec-websocket-key"]}`);
    logger.debug(`  All headers: ${JSON.stringify(Object.keys(req.headers))}`);
  }

  // Get target URL
  let targetBase: string;
  try {
    targetBase = await getTargetUrl(req, options);
  } catch (err) {
    logger?.error("Failed to get target URL for HTTP/1.1 request", err);
    res.statusCode = 500;
    res.end("Internal Server Error: Invalid proxy target");
    return;
  }

  if (!req.url) {
    res.statusCode = 400;
    res.end("Bad Request: Missing URL");
    return;
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(req.url, targetBase);
  } catch (err) {
    logger?.error(
      `Invalid URL construction: ${req.url} with base ${targetBase}`,
      err,
    );
    res.statusCode = 400;
    res.end("Bad Request: Invalid URL");
    return;
  }

  // Apply path rewrite if provided
  if (options.rewrite) {
    const rewritten = options.rewrite(targetUrl.pathname);
    targetUrl.pathname = rewritten;
  }

  const isSecure = targetUrl.protocol === "https:";
  const port = targetUrl.port || (isSecure ? 443 : 80);

  // Create HTTP/1.1 connection
  const http = isSecure
    ? await import("node:https")
    : await import("node:http");

  // Filter out HTTP/2 pseudo-headers and connection-specific headers
  const filteredHeaders: Record<string, string | string[]> = {};
  const forbiddenHeaders = [
    "keep-alive",
    "transfer-encoding",
    "proxy-connection",
    "te",
    "trailer",
  ];

  // For WebSocket requests, preserve upgrade and connection headers
  const isWebSocketRequest =
    options.ws || req.headers.upgrade?.toLowerCase() === "websocket";

  if (!isWebSocketRequest) {
    forbiddenHeaders.push("connection", "upgrade");
  }

  for (const [key, value] of Object.entries(req.headers)) {
    // Skip HTTP/2 pseudo-headers (start with :)
    if (key.startsWith(":")) continue;
    // Skip forbidden headers
    if (forbiddenHeaders.includes(key.toLowerCase())) continue;

    if (value) {
      filteredHeaders[key] = value;
    }
  }

  const proxyReqOptions = {
    hostname: targetUrl.hostname,
    port: Number(port),
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers: filteredHeaders,
    rejectUnauthorized: options.secure !== false,
  };

  // Update headers
  if (options.changeOrigin) {
    proxyReqOptions.headers.host = targetUrl.host;
  }

  if (options.headers) {
    Object.assign(proxyReqOptions.headers, options.headers);
  }

  if (options.xfwd) {
    if (req.socket.remoteAddress) {
      proxyReqOptions.headers["x-forwarded-for"] = req.socket.remoteAddress;
    }
    proxyReqOptions.headers["x-forwarded-proto"] = isTLSSocket(req.socket)
      ? "https"
      : "http";
    proxyReqOptions.headers["x-forwarded-host"] = req.headers.host || "";
    proxyReqOptions.headers["x-forwarded-port"] = String(req.socket.localPort);
  }

  if (options.auth && !proxyReqOptions.headers.authorization) {
    const authString = Buffer.from(options.auth).toString("base64");
    proxyReqOptions.headers.authorization = `Basic ${authString}`;
  }

  const proxyReq = http.request(proxyReqOptions, (proxyRes) => {
    const endTime = Date.now();
    const duration = endTime - startTime;

    logProxyRequest(
      logger,
      req.method || "GET",
      req.url || "",
      targetUrl.href,
      proxyRes.statusCode || 0,
      duration,
    );

    // Handle cookie rewriting
    if (options.cookieDomainRewrite || options.cookiePathRewrite) {
      const setCookieHeader = proxyRes.headers["set-cookie"];
      if (setCookieHeader) {
        const cookies = Array.isArray(setCookieHeader)
          ? setCookieHeader
          : [setCookieHeader];
        proxyRes.headers["set-cookie"] = cookies.map((cookie) =>
          rewriteCookie(
            String(cookie),
            options.cookieDomainRewrite || false,
            options.cookiePathRewrite || false,
          ),
        );
      }
    }

    // Copy status and headers
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

    // Pipe the response
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    const endTime = Date.now();
    const duration = endTime - startTime;

    logger?.error(`HTTP/1.1 proxy error: ${err.message}`, err);
    logProxyRequest(
      logger,
      req.method || "GET",
      req.url || "",
      targetUrl.href,
      502,
      duration,
    );

    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Bad Gateway");
    }
  });

  // Handle timeout
  if (options.timeout || options.proxyTimeout) {
    const timeout = options.proxyTimeout || options.timeout || 120000;
    proxyReq.setTimeout(timeout, () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { "Content-Type": "text/plain" });
        res.end("Gateway Timeout");
      }
    });
  }

  // Forward request body if present
  if (req.method !== "GET" && req.method !== "HEAD") {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

async function proxyHttp2Request(
  req: IncomingMessage,
  res: ServerResponse,
  options: NormalizedProxyOptions,
  next: () => void,
): Promise<void> {
  const startTime = Date.now();

  // Check bypass
  if (await handleBypass(req, res, options, next)) {
    return;
  }

  // Debug log headers for WebSocket routes
  if (options.ws && logger) {
    logger.debug(`Request to WebSocket route ${req.url}:`);
    logger.debug(`  Method: ${req.method}`);
    logger.debug(`  Upgrade: ${req.headers.upgrade}`);
    logger.debug(`  Connection: ${req.headers.connection}`);
    logger.debug(`  Sec-WebSocket-Key: ${req.headers["sec-websocket-key"]}`);
    logger.debug(
      `  Sec-WebSocket-Version: ${req.headers["sec-websocket-version"]}`,
    );
  }

  // Check if this is a WebSocket upgrade request
  // Note: Some WebSocket clients first send a POST request before upgrading
  const isWebSocketRequest =
    req.headers.upgrade?.toLowerCase() === "websocket" ||
    (req.headers.connection?.toLowerCase().includes("upgrade") &&
      req.headers["sec-websocket-key"]) ||
    req.headers["sec-websocket-version"];

  // For WebSocket-enabled routes, always use HTTP/1.1 as WebSocket requires it
  if (options.ws) {
    logger?.info(`Using HTTP/1.1 for WebSocket-enabled route ${req.url}`);
    return proxyHttp1Request(req, res, options, next);
  }

  if (isWebSocketRequest) {
    // This shouldn't happen if ws:true is set, but handle it anyway
    logger?.warn(`WebSocket upgrade detected but ws:false for ${req.url}`);
    return proxyHttp1Request(req, res, options, next);
  }

  // Get target URL (may be dynamic via router)
  let targetBase: string;
  try {
    targetBase = await getTargetUrl(req, options);
  } catch (err) {
    logger?.error("Failed to get target URL", err);
    res.statusCode = 500;
    res.end("Internal Server Error: Invalid proxy target");
    return;
  }

  // Check if we should force HTTP/1.1 or auto-detect
  if (options.forceHttp1) {
    logger?.info(`Using HTTP/1.1 for ${req.url} (forceHttp1 enabled)`);
    return proxyHttp1Request(req, res, options, next);
  }

  if (options.autoDetectProtocol) {
    const targetUrl = new URL(targetBase);
    const origin = `${targetUrl.protocol}//${targetUrl.host}`;
    const useHttp2 = await supportsHttp2(origin, options.secure !== false);

    if (!useHttp2) {
      logger?.info(
        `Using HTTP/1.1 for ${req.url} - origin ${origin} does not support HTTP/2`,
      );
      return proxyHttp1Request(req, res, options, next);
    }
    logger?.debug(
      `Using HTTP/2 for ${req.url} - origin ${origin} supports HTTP/2`,
    );
  } else {
    logger?.debug(`Using HTTP/2 for ${req.url} (default protocol)`);
  }

  if (!req.url) {
    res.statusCode = 400;
    res.end("Bad Request: Missing URL");
    return;
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(req.url, targetBase);
  } catch (err) {
    logger?.error(
      `Invalid URL construction: ${req.url} with base ${targetBase}`,
      err,
    );
    res.statusCode = 400;
    res.end("Bad Request: Invalid URL");
    return;
  }

  // Apply path rewrite if provided
  if (options.rewrite) {
    const rewritten = options.rewrite(targetUrl.pathname);
    targetUrl.pathname = rewritten;
  }

  const origin = `${targetUrl.protocol}//${targetUrl.host}`;

  // Helper function to actually create and handle the stream
  const createAndHandleStream = () => {
    const session = connectionPool.getAvailableSession(origin, options);
    if (!session) {
      // No available session capacity, queue the request
      const queued = requestQueue.enqueue(origin, req, res, () => {
        processProxiedRequest(req, res, options, targetUrl, origin, startTime);
      });

      if (!queued) {
        res.statusCode = 503;
        res.end("Service Unavailable: Request queue full");
      }
      return;
    }

    processProxiedRequest(
      req,
      res,
      options,
      targetUrl,
      origin,
      startTime,
      session,
    );
  };

  createAndHandleStream();
}

// Separate function to process the proxied request
function processProxiedRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: NormalizedProxyOptions,
  targetUrl: URL,
  origin: string,
  startTime: number,
  session?: ClientHttp2Session,
): void {
  if (!session) {
    // Try to get a session again (for queued requests)
    try {
      session = connectionPool.getSession(origin, options);
    } catch (err) {
      logger?.error(`Failed to get HTTP/2 session for ${origin}`, err);
      res.statusCode = 502;
      res.end("Bad Gateway: Failed to establish HTTP/2 connection");
      return;
    }
  }

  const headers = createHttp2Headers(req, targetUrl, options);
  headers[HTTP2_HEADER_PATH] = targetUrl.pathname + targetUrl.search;

  // Set timeout if specified
  const timeout = options.proxyTimeout || options.timeout || 120000;

  // Track stream creation
  connectionPool.incrementActiveStreams(origin);

  let stream: ClientHttp2Stream;
  try {
    stream = session.request(headers, {
      endStream: req.method === "GET" || req.method === "HEAD",
    });
  } catch (err) {
    connectionPool.decrementActiveStreams(origin);

    // Check if this is a stream limit error
    if (
      err instanceof Error &&
      err.message?.includes("ERR_HTTP2_OUT_OF_STREAMS")
    ) {
      // Queue the request
      const queued = requestQueue.enqueue(origin, req, res, () => {
        processProxiedRequest(req, res, options, targetUrl, origin, startTime);
      });

      if (!queued) {
        res.statusCode = 503;
        res.end("Service Unavailable: Request queue full");
      }
      return;
    }

    logger?.error(`Failed to create HTTP/2 stream for ${origin}`, err);
    res.statusCode = 502;
    res.end("Bad Gateway: Failed to create HTTP/2 stream");
    return;
  }

  // Handle timeout
  const timeoutHandle = setTimeout(() => {
    stream.close(constants.NGHTTP2_CANCEL);
    if (!res.headersSent) {
      res.writeHead(504, { "Content-Type": "text/plain" });
      res.end("Gateway Timeout");
    }
  }, timeout);

  stream.on("error", (err) => {
    clearTimeout(timeoutHandle);
    const endTime = Date.now();
    const duration = endTime - startTime;
    logger.error(`HTTP/2 stream error: ${err.message}`, err);
    logProxyRequest(
      logger,
      req.method || "GET",
      req.url || "",
      targetUrl.href,
      502,
      duration,
    );
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Bad Gateway");
    }

    // Decrement active streams on error
    connectionPool.decrementActiveStreams(origin);

    // Process next queued request if any
    const nextRequest = requestQueue.dequeue(origin);
    if (nextRequest) {
      nextRequest.callback();
    }
  });

  stream.on("response", (responseHeaders: IncomingHttpHeaders) => {
    clearTimeout(timeoutHandle);
    const endTime = Date.now();
    const duration = endTime - startTime;

    const status = Number(responseHeaders[HTTP2_HEADER_STATUS]) || 200;
    logProxyRequest(
      logger,
      req.method || "GET",
      req.url || "",
      targetUrl.href,
      status,
      duration,
    );

    // Handle redirects
    if (options.followRedirects && status >= 300 && status < 400) {
      const location = responseHeaders[HTTP2_HEADER_LOCATION];
      if (location) {
        // Rewrite location header if needed
        const locationUrl = new URL(location as string, targetUrl);
        const rewrittenLocation = locationUrl.href.replace(
          targetUrl.origin,
          "",
        );
        responseHeaders[HTTP2_HEADER_LOCATION] = rewrittenLocation;
      }
    }

    // Filter out HTTP/2 pseudo-headers
    const cleanHeaders: OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(responseHeaders)) {
      if (!key.startsWith(":")) {
        // Handle cookie rewriting
        if (
          key === "set-cookie" &&
          (options.cookieDomainRewrite || options.cookiePathRewrite)
        ) {
          const cookies = Array.isArray(value) ? value : [value];
          cleanHeaders[key] = cookies.map((cookie) =>
            rewriteCookie(
              String(cookie),
              options.cookieDomainRewrite || false,
              options.cookiePathRewrite || false,
            ),
          );
        } else {
          cleanHeaders[key] = value;
        }
      }
    }

    // Handle Server-Sent Events
    if (
      options.sse &&
      cleanHeaders["content-type"]?.includes("text/event-stream")
    ) {
      cleanHeaders["cache-control"] = "no-cache";
      cleanHeaders.connection = "keep-alive";
      cleanHeaders["x-accel-buffering"] = "no"; // Disable Nginx buffering
    }

    // Custom response handling
    if (options.selfHandleResponse) {
      // Let the user handle the response
      if (options.configure) {
        options.configure(stream, options);
      }
      return;
    }

    res.writeHead(status, cleanHeaders);
    stream.pipe(res);
  });

  stream.on("close", () => {
    clearTimeout(timeoutHandle);

    // Decrement active streams and process queued requests
    connectionPool.decrementActiveStreams(origin);

    // Process next queued request if any
    const nextRequest = requestQueue.dequeue(origin);
    if (nextRequest) {
      // Process the queued request
      nextRequest.callback();
    }
  });

  // Forward request body if present
  if (req.method !== "GET" && req.method !== "HEAD") {
    req.pipe(stream);
  } else {
    stream.end();
  }
}

// WebSocket support
async function handleWebSocketUpgrade(
  req: IncomingMessage,
  socket: net.Socket,
  head: Buffer,
  options: NormalizedProxyOptions,
): Promise<void> {
  let targetBase: string;
  try {
    targetBase = await getTargetUrl(req, options);
  } catch (err) {
    logger?.error("Failed to get target URL for WebSocket", err);
    socket.end("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    return;
  }

  if (!req.url) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(req.url, targetBase);
  } catch (err) {
    logger?.error(
      `Invalid WebSocket URL: ${req.url} with base ${targetBase}`,
      err,
    );
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  const isSecure =
    targetUrl.protocol === "https:" || targetUrl.protocol === "wss:";
  const port = targetUrl.port || (isSecure ? 443 : 80);

  const proxySocket = isSecure
    ? tls.connect({
        port: Number(port),
        host: targetUrl.hostname,
        rejectUnauthorized: options.secure !== false,
      })
    : net.connect({
        port: Number(port),
        host: targetUrl.hostname,
      });

  // Build WebSocket upgrade request
  const headers = [
    `GET ${targetUrl.pathname}${targetUrl.search} HTTP/1.1`,
    `Host: ${targetUrl.host}`,
  ];

  // Forward original headers
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() !== "host") {
      headers.push(`${key}: ${value}`);
    }
  }

  headers.push("", ""); // Empty line to end headers

  proxySocket.on("connect", () => {
    proxySocket.write(headers.join("\r\n"));
    if (head?.length) proxySocket.write(head);
  });

  proxySocket.on("data", (data) => {
    socket.write(data);
  });

  socket.on("data", (data) => {
    proxySocket.write(data);
  });

  proxySocket.on("error", (err) => {
    logger?.error(`WebSocket proxy error: ${err.message}`, err);
    socket.destroy();
  });

  socket.on("error", () => {
    proxySocket.destroy();
  });

  proxySocket.on("close", () => {
    socket.end();
  });

  socket.on("close", () => {
    proxySocket.end();
  });
}

export interface Http2ProxyPluginOptions {
  proxy?: Record<string, string | ProxyOptions>;

  // Global connection pool settings
  maxSessions?: number; // Maximum number of HTTP/2 sessions (default: 100)
  sessionMaxAge?: number; // Session idle timeout in ms (default: 300000 - 5 minutes)
  connectionTimeout?: number; // Initial connection timeout in ms (default: 10000)

  // Global request queue settings
  maxQueueSize?: number; // Maximum queued requests across all origins (default: 100)
  queueTimeout?: number; // Queue timeout in ms (default: 30000)

  // Global timeout defaults
  defaultTimeout?: number; // Default timeout for all proxies in ms (default: 120000)
  defaultProxyTimeout?: number; // Default proxy-specific timeout in ms
}

export function http2ProxyPlugin(
  options: Http2ProxyPluginOptions = {},
): Plugin {
  let config: ResolvedConfig;
  let savedProxyConfig: Record<string, string | ProxyOptions> = {};

  // Extract global defaults for timeout settings
  const globalDefaults = {
    defaultTimeout: options.defaultTimeout,
    defaultProxyTimeout: options.defaultProxyTimeout,
  };

  // Use plugin options proxy config if provided
  if (options.proxy) {
    savedProxyConfig = { ...options.proxy };
    console.log(
      `[vite-plugin-http2-proxy] Using plugin proxy config for ${Object.keys(savedProxyConfig).length} routes`,
    );
  }

  return {
    name: "vite-plugin-http2-proxy",
    enforce: "pre", // Run before other plugins

    config(userConfig) {
      // Only intercept Vite proxy config if we don't have plugin-level config
      if (!options.proxy && userConfig.server?.proxy) {
        savedProxyConfig = { ...userConfig.server.proxy };
        userConfig.server.proxy = {};
        console.log(
          `[vite-plugin-http2-proxy] Intercepted Vite proxy config for ${Object.keys(savedProxyConfig).length} routes`,
        );
      } else if (userConfig.server?.proxy) {
        // Clear Vite's proxy config to prevent HTTP/1.1 downgrade
        userConfig.server.proxy = {};
        console.log(
          `[vite-plugin-http2-proxy] Cleared Vite proxy config to prevent HTTP/1.1 downgrade`,
        );
      }
    },

    configResolved(resolvedConfig) {
      config = resolvedConfig;
      logger = createLogger("vite:http2-proxy", config);

      // Initialize connection pool with global settings
      connectionPool = new Http2ConnectionPool(logger, {
        maxSessions: options.maxSessions,
        sessionMaxAge: options.sessionMaxAge,
        connectionTimeout: options.connectionTimeout,
      });

      // Initialize request queue with global settings
      requestQueue = new RequestQueue(logger, {
        maxQueueSize: options.maxQueueSize,
        queueTimeout: options.queueTimeout,
      });
    },

    configureServer(server) {
      if (Object.keys(savedProxyConfig).length === 0) {
        return;
      }

      logger?.info(
        `HTTP/2 proxy plugin setting up ${Object.keys(savedProxyConfig).length} proxy routes`,
      );
      logger?.debug(
        `Proxy routes: ${Object.keys(savedProxyConfig).join(", ")}`,
      );

      // Handle WebSocket upgrades
      server.httpServer?.on("upgrade", async (req, socket, head) => {
        for (const [context, proxyOptions] of Object.entries(
          savedProxyConfig,
        )) {
          const opts = normalizeProxyOptions(proxyOptions, globalDefaults);

          if (!opts.ws) continue;

          let shouldProxy = false;

          // Check if request matches the context
          if (context.startsWith("^")) {
            // RegExp pattern
            const pattern = new RegExp(context);
            shouldProxy = req.url ? pattern.test(req.url) : false;
          } else {
            // String prefix
            shouldProxy = req.url?.startsWith(context);
          }

          if (shouldProxy) {
            try {
              await handleWebSocketUpgrade(req, socket, head, opts);
            } catch (err) {
              config.logger.error(`WebSocket proxy error: ${err}`);
              socket.destroy();
            }
            break;
          }
        }
      });

      // Process each proxy configuration
      for (const [context, proxyOptions] of Object.entries(savedProxyConfig)) {
        const opts = normalizeProxyOptions(proxyOptions);

        // Create middleware for this proxy context
        server.middlewares.use(async (req, res, next) => {
          if (!req.url) return next();

          let shouldProxy = false;

          // Check if request matches the context
          if (context.startsWith("^")) {
            // RegExp pattern
            const pattern = new RegExp(context);
            shouldProxy = pattern.test(req.url);
          } else {
            // String prefix
            shouldProxy = req.url.startsWith(context);
          }

          if (!shouldProxy) {
            return next();
          }

          try {
            await proxyHttp2Request(req, res, opts, next);
          } catch (err) {
            config.logger.error(`HTTP/2 proxy error: ${err}`);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "text/plain" });
              res.end("Internal Server Error");
            }
          }
        });
      }

      // Clean up HTTP/2 sessions when dev server closes
      server.httpServer?.on("close", () => {
        logger?.info("Dev server closing, cleaning up HTTP/2 sessions");
        requestQueue.clear();
        connectionPool.close();
        http2SupportMap.clear();
      });

      // Also handle SIGINT/SIGTERM for graceful shutdown
      const cleanup = () => {
        logger?.info("Received shutdown signal, cleaning up HTTP/2 sessions");
        requestQueue.clear();
        connectionPool.close();
        http2SupportMap.clear();
      };

      process.once("SIGINT", cleanup);
      process.once("SIGTERM", cleanup);
    },

    buildEnd() {
      // Clean up HTTP/2 sessions and request queue
      requestQueue.clear();
      connectionPool.close();
      // Clear protocol detection cache
      http2SupportMap.clear();
    },
  };
}

export default http2ProxyPlugin;
