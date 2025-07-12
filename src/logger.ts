import { debuglog } from "node:util";
import type { ResolvedConfig } from "vite";

export interface Logger {
  debug: (msg: string, ...args: unknown[]) => void;
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export function createLogger(
  namespace: string,
  viteConfig?: ResolvedConfig,
): Logger {
  const debug = debuglog(namespace);
  const viteLogger = viteConfig?.logger;

  return {
    debug: (msg: string, ...args: unknown[]) => {
      if (
        process.env.DEBUG?.includes(namespace) ||
        process.env.LOG_LEVEL === "debug"
      ) {
        debug(msg, ...args);
      }
    },
    info: (msg: string, ...args: unknown[]) => {
      if (viteLogger) {
        viteLogger.info(`[${namespace}] ${msg}`, { timestamp: true });
      } else {
        console.info(`[${namespace}] ${msg}`, ...args);
      }
    },
    warn: (msg: string, ...args: unknown[]) => {
      if (viteLogger) {
        viteLogger.warn(`[${namespace}] ${msg}`, { timestamp: true });
      } else {
        console.warn(`[${namespace}] ${msg}`, ...args);
      }
    },
    error: (msg: string, ...args: unknown[]) => {
      if (viteLogger) {
        // Type guard to check if first arg is an Error
        const error = args[0] instanceof Error ? args[0] : undefined;
        viteLogger.error(`[${namespace}] ${msg}`, {
          timestamp: true,
          error,
        });
      } else {
        console.error(`[${namespace}] ${msg}`, ...args);
      }
    },
  };
}

export function logProxyRequest(
  logger: Logger,
  method: string,
  url: string,
  target: string,
  status?: number,
  duration?: number,
): void {
  const parts = [
    `${method} ${url}`,
    `-> ${target}`,
    status && `[${status}]`,
    duration && `(${duration}ms)`,
  ]
    .filter(Boolean)
    .join(" ");

  if (status && status >= 500) {
    logger.error(parts);
  } else if (status && status >= 400) {
    logger.warn(parts);
  } else {
    logger.info(parts);
  }
}
