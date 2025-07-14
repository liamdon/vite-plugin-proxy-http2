import { readFileSync } from "node:fs";
import type { Http2SecureServer, ServerHttp2Stream } from "node:http2";
import { createSecureServer as createHttp2Server } from "node:http2";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Http2ConnectionPool, type Http2Session } from "../src/connection-pool";
import type { createLogger } from "../src/logger";

// Type for accessing internal connection pool structure in tests
interface TestableConnectionPool extends Http2ConnectionPool {
  sessions: Map<string, Http2Session>;
  cleanup(): void;
}

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
    targetServer.close();
    // Give OS time to release the port
    await new Promise((resolve) => setTimeout(resolve, 100));
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

    // Use test-only method to set max sessions
    smallPool._setMaxSessions(3);

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
    agePool._setMaxAge(100); // 100ms for testing

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

  it("should evict oldest session when reaching maxSessions limit", async () => {
    const pool = new Http2ConnectionPool(mockLogger);
    pool._setMaxSessions(3); // Set low limit for testing

    // Create 3 sessions to the same working server with different paths
    // This ensures sessions are actually created
    const baseOrigin = `https://localhost:${targetPort}`;
    const _origin1 = `${baseOrigin}/path1`;
    const _origin2 = `${baseOrigin}/path2`;
    const _origin3 = `${baseOrigin}/path3`;
    const _origin4 = `${baseOrigin}/path4`;

    // Note: HTTP/2 connection pool is per origin (host:port), not path
    // So we need to use the actual test server for all connections
    pool.getSession(baseOrigin, { secure: false });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Since these are all the same origin, we should still have 1 session
    expect(pool.getSessionCount()).toBe(1);

    // To properly test eviction, we need different origins
    // Let's adjust to test the behavior we can actually test
    const testPool = new Http2ConnectionPool(mockLogger);
    testPool._setMaxSessions(2); // Even lower limit

    // First session
    const session1 = testPool.getSession(baseOrigin, { secure: false });
    expect(testPool.getSessionCount()).toBe(1);

    // Mock a second origin by manually adding to the pool
    // This is a workaround since we can't easily create multiple test servers
    const mockOrigin2 = "https://example.com:443";
    const mockSession2 = {
      session: session1, // Reuse session object for testing
      origin: mockOrigin2,
      lastUsed: Date.now() - 1000, // Make it older
    };

    // Access internal map for testing (not ideal but necessary)
    const testablePool = testPool as TestableConnectionPool;
    testablePool.sessions.set(mockOrigin2, mockSession2);
    expect(testPool.getSessionCount()).toBe(2);

    // Now getting a new session for a third origin should evict the oldest
    const _session3 = testPool.getSession(`https://localhost:8443`, {
      secure: false,
    });

    // The mock origin2 should have been evicted as it was oldest
    expect(testPool.getSessionCount()).toBe(2);
    expect(testPool.hasSession(mockOrigin2)).toBe(false);

    testPool.close();
  });

  it("should clean up multiple expired sessions", async () => {
    const pool = new Http2ConnectionPool(mockLogger);
    pool._setMaxAge(50); // 50ms for testing

    // Create a session to the actual test server
    const baseOrigin = `https://localhost:${targetPort}`;
    pool.getSession(baseOrigin, { secure: false });

    // Manually add mock sessions for testing cleanup
    const testablePool = pool as TestableConnectionPool;
    const mockOrigins = ["https://example1.com", "https://example2.com"];

    mockOrigins.forEach((origin) => {
      testablePool.sessions.set(origin, {
        session: {
          closed: false,
          destroyed: false,
          close: vi.fn(),
        },
        origin,
        lastUsed: Date.now() - 1000, // Old timestamp
      });
    });

    expect(pool.getSessionCount()).toBe(3);

    // Wait for all to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Manually trigger cleanup
    const testablePool2 = pool as TestableConnectionPool;
    testablePool2.cleanup();

    // All old sessions should be cleaned up
    expect(pool.hasSession(baseOrigin)).toBe(false); // Real session expired
    mockOrigins.forEach((origin) => {
      expect(pool.hasSession(origin)).toBe(false);
    });
    expect(pool.getSessionCount()).toBe(0);

    pool.close();
  });

  it("should handle cleanup when sessions are actively used", async () => {
    const pool = new Http2ConnectionPool(mockLogger);
    pool._setMaxAge(100); // 100ms for testing

    const activeOrigin = `https://localhost:${targetPort}`;

    // Create active session
    pool.getSession(activeOrigin, { secure: false });

    // Add a mock inactive session
    const testablePool = pool as TestableConnectionPool;
    const inactiveOrigin = "https://inactive.example.com";
    testablePool.sessions.set(inactiveOrigin, {
      session: {
        closed: false,
        destroyed: false,
        close: vi.fn(),
      },
      origin: inactiveOrigin,
      lastUsed: Date.now(), // Will become old
    });

    // Keep using the active session
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      pool.getSession(activeOrigin, { secure: false }); // Refresh lastUsed
    }

    // Manually trigger cleanup
    testablePool.cleanup();

    // Active session should still exist, inactive should be cleaned
    expect(pool.hasSession(activeOrigin)).toBe(true);
    expect(pool.hasSession(inactiveOrigin)).toBe(false);

    pool.close();
  });

  it("should properly close all sessions on cleanup", async () => {
    const pool = new Http2ConnectionPool(mockLogger);

    // Create one real session
    const realSession = pool.getSession(`https://localhost:${targetPort}`, {
      secure: false,
    });

    // Add mock sessions
    const testablePool = pool as TestableConnectionPool;
    const mockSessions = [];

    for (let i = 1; i <= 2; i++) {
      const mockSession = {
        closed: false,
        destroyed: false,
        close: vi.fn(function () {
          this.closed = true;
        }),
      };
      const mockOrigin = `https://example${i}.com`;
      testablePool.sessions.set(mockOrigin, {
        session: mockSession,
        origin: mockOrigin,
        lastUsed: Date.now(),
      });
      mockSessions.push(mockSession);
    }

    expect(pool.getSessionCount()).toBe(3);

    // Close all sessions
    pool.close();

    // Verify all sessions are closed
    expect(pool.getSessionCount()).toBe(0);
    expect(realSession.closed || realSession.destroyed).toBe(true);
    mockSessions.forEach((session) => {
      expect(session.close).toHaveBeenCalled();
    });
  });

  it("should properly update lastUsed timestamp on reuse", async () => {
    const pool = new Http2ConnectionPool(mockLogger);
    const origin = `https://localhost:${targetPort}`;

    // Get initial session
    pool.getSession(origin, { secure: false });
    const initialLastUsed = pool._getSessionLastUsed(origin);
    expect(initialLastUsed).toBeDefined();

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Get session again
    pool.getSession(origin, { secure: false });
    const updatedLastUsed = pool._getSessionLastUsed(origin);
    expect(updatedLastUsed).toBeDefined();

    // Type guards ensure these are defined
    if (updatedLastUsed === undefined || initialLastUsed === undefined) {
      throw new Error("Expected timestamps to be defined");
    }
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
