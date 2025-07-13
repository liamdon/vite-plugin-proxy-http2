import type { ClientHttp2Session } from "node:http2";
import { connect } from "node:http2";
import type * as tls from "node:tls";
import type { Logger } from "./logger";

export interface ConnectionPoolOptions {
  secure?: boolean;
  auth?: string;
}

export interface Http2Session {
  session: ClientHttp2Session;
  origin: string;
  lastUsed: number;
}

export class Http2ConnectionPool {
  private sessions: Map<string, Http2Session> = new Map();
  private maxAge = 5 * 60 * 1000; // 5 minutes
  private maxSessions = 100;
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  getSession(
    origin: string,
    options: ConnectionPoolOptions,
  ): ClientHttp2Session {
    const existing = this.sessions.get(origin);

    if (existing && !existing.session.closed && !existing.session.destroyed) {
      existing.lastUsed = Date.now();
      return existing.session;
    }

    // Connection options
    const connectOptions: tls.ConnectionOptions & { auth?: string } = {
      rejectUnauthorized: options.secure !== false,
    };

    // Add authentication if provided
    if (options.auth) {
      const authParts = options.auth.split(":");
      if (authParts.length !== 2) {
        throw new Error(
          `Invalid auth format. Expected "username:password", got "${options.auth}"`,
        );
      }
      const [username, password] = authParts;
      if (!username || !password) {
        throw new Error("Auth username and password cannot be empty");
      }
      connectOptions.auth = `${username}:${password}`;
    }

    const session = connect(origin, connectOptions);

    // Set up connection timeout
    const connectionTimeout = setTimeout(() => {
      session.close();
      throw new Error(`HTTP/2 connection timeout for ${origin}`);
    }, 10000); // 10 second timeout for connection

    // Wait for connection to be established
    session.once("connect", () => {
      clearTimeout(connectionTimeout);
      this.logger?.debug(`HTTP/2 session connected to ${origin}`);
    });

    session.on("error", (err) => {
      clearTimeout(connectionTimeout);
      this.logger?.error(`HTTP/2 session error for ${origin}`, err);
      this.sessions.delete(origin);
    });

    session.on("close", () => {
      clearTimeout(connectionTimeout);
      this.logger?.debug(`HTTP/2 session closed for ${origin}`);
      this.sessions.delete(origin);
    });

    // Implement connection limit
    if (this.sessions.size >= this.maxSessions) {
      this.evictOldest();
    }

    this.sessions.set(origin, {
      session,
      origin,
      lastUsed: Date.now(),
    });

    // Cleanup old sessions periodically
    this.cleanup();

    return session;
  }

  private evictOldest() {
    let oldest: [string, Http2Session] | null = null;
    for (const entry of this.sessions.entries()) {
      if (!oldest || entry[1].lastUsed < oldest[1].lastUsed) {
        oldest = entry;
      }
    }
    if (oldest) {
      oldest[1].session.close();
      this.sessions.delete(oldest[0]);
    }
  }

  private cleanup() {
    const now = Date.now();
    for (const [origin, sess] of this.sessions) {
      if (now - sess.lastUsed > this.maxAge) {
        sess.session.close();
        this.sessions.delete(origin);
      }
    }
  }

  close() {
    for (const sess of this.sessions.values()) {
      sess.session.close();
    }
    this.sessions.clear();
  }

  // Exposed for testing
  getSessionCount(): number {
    return this.sessions.size;
  }

  // Exposed for testing
  hasSession(origin: string): boolean {
    const session = this.sessions.get(origin);
    return !!(session && !session.session.closed && !session.session.destroyed);
  }
}
