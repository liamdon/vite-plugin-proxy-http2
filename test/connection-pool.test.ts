import { readFileSync } from "node:fs";
import type { Http2SecureServer, ServerHttp2Stream } from "node:http2";
import { createSecureServer as createHttp2Server } from "node:http2";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Http2ConnectionPool } from "../src/connection-pool";
import type { createLogger } from "../src/logger";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Http2ConnectionPool", () => {
  let targetServer: Http2SecureServer;
  const targetPort = 9890;
  let mockLogger: ReturnType<typeof createLogger>;

  beforeAll(async () => {
    // Create a test HTTP/2 server
    targetServer = createHttp2Server({
      key: readFileSync(join(__dirname, "fixtures", "key.pem")),
      cert: readFileSync(join(__dirname, "fixtures", "cert.pem")),
    });

    targetServer.on("stream", (stream: ServerHttp2Stream, headers) => {
      const path = headers[":path"];

      if (path === "/test") {
        stream.respond({
          ":status": 200,
          "content-type": "text/plain",
        });
        stream.end("OK");
      } else if (path === "/delay") {
        // Simulate slow response
        setTimeout(() => {
          stream.respond({
            ":status": 200,
            "content-type": "text/plain",
          });
          stream.end("Delayed");
        }, 100);
      } else {
        stream.respond({
          ":status": 404,
        });
        stream.end();
      }
    });

    await new Promise<void>((resolve) => {
      targetServer.listen(targetPort, resolve);
    });

    // Create mock logger
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      hasWarned: false,
      warnedMessages: new Set(),
      hasErrored: false,
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      targetServer.close(resolve);
    });
  });

  it("should create new sessions for different origins", () => {
    const connectionPool = new Http2ConnectionPool(mockLogger);
    const origin1 = `https://localhost:${targetPort}`;
    const origin2 = `https://localhost:${targetPort + 1000}`;

    const session1 = connectionPool.getSession(origin1, { secure: false });
    const session2 = connectionPool.getSession(origin2, { secure: false });

    expect(session1).toBeDefined();
    expect(session2).toBeDefined();
    expect(session1).not.toBe(session2);
    expect(connectionPool.getSessionCount()).toBe(2);

    connectionPool.close();
  });

  it("should reuse existing sessions for the same origin", () => {
    const connectionPool = new Http2ConnectionPool(mockLogger);
    const origin = `https://localhost:${targetPort}`;

    const session1 = connectionPool.getSession(origin, { secure: false });
    const session2 = connectionPool.getSession(origin, { secure: false });

    expect(session1).toBe(session2);
    expect(connectionPool.getSessionCount()).toBe(1);

    connectionPool.close();
  });

  it("should handle authentication options", () => {
    const connectionPool = new Http2ConnectionPool(mockLogger);
    const origin = `https://localhost:${targetPort}`;

    expect(() => {
      connectionPool.getSession(origin, {
        secure: false,
        auth: "user:pass",
      });
    }).not.toThrow();

    connectionPool.close();
  });

  it("should validate auth format", () => {
    const connectionPool = new Http2ConnectionPool(mockLogger);
    const origin = `https://localhost:${targetPort}`;

    // Test invalid format
    try {
      connectionPool.getSession(origin, {
        secure: false,
        auth: "invalidformat",
      });
      throw new Error("Should have thrown");
    } catch (err) {
      expect((err as Error).message).toBe(
        'Invalid auth format. Expected "username:password", got "invalidformat"',
      );
    }

    // Test empty username
    try {
      connectionPool.getSession(origin, {
        secure: false,
        auth: ":password",
      });
      throw new Error("Should have thrown");
    } catch (err) {
      expect((err as Error).message).toBe(
        "Auth username and password cannot be empty",
      );
    }

    // Test empty password
    try {
      connectionPool.getSession(origin, {
        secure: false,
        auth: "username:",
      });
      throw new Error("Should have thrown");
    } catch (err) {
      expect((err as Error).message).toBe(
        "Auth username and password cannot be empty",
      );
    }

    connectionPool.close();
  });

  it("should close all sessions when close() is called", () => {
    const pool = new Http2ConnectionPool();
    const origin = `https://localhost:${targetPort}`;

    pool.getSession(origin, { secure: false });
    expect(pool.getSessionCount()).toBe(1);

    pool.close();
    expect(pool.getSessionCount()).toBe(0);
  });

  it("should detect session health correctly", async () => {
    const connectionPool = new Http2ConnectionPool(mockLogger);
    const origin = `https://localhost:${targetPort}`;

    const session = connectionPool.getSession(origin, { secure: false });
    expect(connectionPool.hasSession(origin)).toBe(true);

    // Wait for connection to establish
    await new Promise((resolve) => session.once("connect", resolve));

    // Close the session
    session.close();

    // Wait for close event to propagate
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(connectionPool.hasSession(origin)).toBe(false);

    connectionPool.close();
  });

  it("should handle session errors", async () => {
    const connectionPool = new Http2ConnectionPool(mockLogger);
    const origin = `https://invalid-host-that-does-not-exist:9999`;

    const session = connectionPool.getSession(origin, { secure: false });

    // Wait for error
    await new Promise<void>((resolve) => {
      session.once("error", () => {
        resolve();
      });
    });

    // Session should be removed from pool
    expect(connectionPool.hasSession(origin)).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("HTTP/2 session error"),
      expect.any(Error),
    );

    connectionPool.close();
  });

  it("should evict oldest session when limit is reached", () => {
    // Create a new pool with a small limit for testing
    const smallPool = new Http2ConnectionPool(mockLogger);

    // Access private field for testing (we'd normally expose this via a setter)
    (smallPool as any).maxSessions = 3;

    const origins = [
      `https://localhost:${targetPort}`,
      `https://localhost:${targetPort + 1}`,
      `https://localhost:${targetPort + 2}`,
      `https://localhost:${targetPort + 3}`,
    ];

    // Create sessions up to the limit
    origins.slice(0, 3).forEach((origin) => {
      smallPool.getSession(origin, { secure: false });
    });

    expect(smallPool.getSessionCount()).toBe(3);

    // Add one more session, should evict the oldest
    smallPool.getSession(origins[3], { secure: false });

    expect(smallPool.getSessionCount()).toBe(3);
    expect(smallPool.hasSession(origins[0])).toBe(false); // First one should be evicted
    expect(smallPool.hasSession(origins[3])).toBe(true); // New one should exist

    smallPool.close();
  });

  it("should clean up old sessions based on age", async () => {
    // Create a new pool with short max age for testing
    const agePool = new Http2ConnectionPool(mockLogger);
    (agePool as any).maxAge = 100; // 100ms for testing

    const origin = `https://localhost:${targetPort}`;
    const _session = agePool.getSession(origin, { secure: false });

    expect(agePool.hasSession(origin)).toBe(true);

    // Wait for session to age out
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Trigger cleanup by getting another session
    agePool.getSession(`https://localhost:${targetPort + 100}`, {
      secure: false,
    });

    // Old session should be cleaned up
    expect(agePool.hasSession(origin)).toBe(false);

    agePool.close();
  });

  it("should handle concurrent session requests", async () => {
    const connectionPool = new Http2ConnectionPool(mockLogger);
    const origin = `https://localhost:${targetPort}`;

    // Make multiple concurrent requests for the same origin
    const promises = Array(10)
      .fill(0)
      .map(() =>
        Promise.resolve(connectionPool.getSession(origin, { secure: false })),
      );

    const sessions = await Promise.all(promises);

    // All should be the same session
    const firstSession = sessions[0];
    expect(sessions.every((s) => s === firstSession)).toBe(true);
    expect(connectionPool.getSessionCount()).toBe(1);

    connectionPool.close();
  });

  it("should properly update lastUsed timestamp on reuse", async () => {
    const pool = new Http2ConnectionPool(mockLogger);
    const origin = `https://localhost:${targetPort}`;

    // Get initial session
    pool.getSession(origin, { secure: false });
    const initialLastUsed = (pool as any).sessions.get(origin).lastUsed;

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Get session again
    pool.getSession(origin, { secure: false });
    const updatedLastUsed = (pool as any).sessions.get(origin).lastUsed;

    expect(updatedLastUsed).toBeGreaterThan(initialLastUsed);

    pool.close();
  });

  it("should handle connection timeout gracefully", async () => {
    // This test requires mocking the connect function to simulate timeout
    // Since we can't easily mock node:http2 connect, we'll skip this for now
    // In a real scenario, you might use a proxy or network simulation
  });

  it("should log debug messages when logger is provided", async () => {
    const testLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      hasWarned: false,
      warnedMessages: new Set(),
      hasErrored: false,
    };
    const connectionPool = new Http2ConnectionPool(testLogger);
    const origin = `https://localhost:${targetPort}`;
    const session = connectionPool.getSession(origin, { secure: false });

    // Wait for connection with timeout
    await Promise.race([
      new Promise((resolve) => session.once("connect", resolve)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Connection timeout")), 5000),
      ),
    ]);

    expect(testLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining("HTTP/2 session connected to"),
    );

    session.close();

    // Wait for close
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(testLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining("HTTP/2 session closed for"),
    );

    connectionPool.close();
  });
});

