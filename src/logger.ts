import { debuglog } from "util";
import type { ResolvedConfig } from "vite";

export interface Logger {
  debug: (msg: string, ...args: any[]) => void;
  info: (msg: string, ...args: any[]) => void;
  warn: (msg: string, ...args: any[]) => void;
  error: (msg: string, ...args: any[]) => void;
}

export function createLogger(
  namespace: string,
  viteConfig?: ResolvedConfig,
): Logger {
  const debug = debuglog(namespace);
  const viteLogger = viteConfig?.logger;

  return {
    debug: (msg: string, ...args: any[]) => {
      if (
        process.env.DEBUG?.includes(namespace) ||
        process.env.LOG_LEVEL === "debug"
      ) {
        debug(msg, ...args);
      }
    },
    info: (msg: string, ...args: any[]) => {
      if (viteLogger) {
        viteLogger.info(`[${namespace}] ${msg}`, { timestamp: true });
      } else {
        console.info(`[${namespace}] ${msg}`, ...args);
      }
    },
    warn: (msg: string, ...args: any[]) => {
      if (viteLogger) {
        viteLogger.warn(`[${namespace}] ${msg}`, { timestamp: true });
      } else {
        console.warn(`[${namespace}] ${msg}`, ...args);
      }
    },
    error: (msg: string, ...args: any[]) => {
      if (viteLogger) {
        viteLogger.error(`[${namespace}] ${msg}`, {
          timestamp: true,
          error: args[0],
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
