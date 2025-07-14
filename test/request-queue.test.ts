import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { RequestQueue } from "../src/request-queue";

// Mock logger
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// Helper to create mock request/response objects
function createMockRequest(): IncomingMessage {
  const req = {
    url: "/test",
    method: "GET",
    headers: {},
  } as unknown as IncomingMessage;
  return req;
}

function createMockResponse(): ServerResponse {
  const res = {
    headersSent: false,
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
  return res;
}

describe("RequestQueue", () => {
  it("should enqueue and dequeue requests", () => {
    const queue = new RequestQueue(mockLogger);
    const req = createMockRequest();
    const res = createMockResponse();
    const callback = vi.fn();

    // Enqueue request
    const enqueued = queue.enqueue("https://example.com", req, res, callback);
    expect(enqueued).toBe(true);
    expect(queue.getQueueDepth()).toBe(1);
    expect(queue.getQueueDepth("https://example.com")).toBe(1);

    // Dequeue request
    const dequeued = queue.dequeue("https://example.com");
    expect(dequeued).toBeTruthy();
    expect(dequeued?.callback).toBe(callback);
    expect(queue.getQueueDepth()).toBe(0);
  });

  it("should handle multiple origins separately", () => {
    const queue = new RequestQueue(mockLogger);

    // Enqueue for different origins
    queue.enqueue(
      "https://example1.com",
      createMockRequest(),
      createMockResponse(),
      vi.fn(),
    );
    queue.enqueue(
      "https://example2.com",
      createMockRequest(),
      createMockResponse(),
      vi.fn(),
    );
    queue.enqueue(
      "https://example1.com",
      createMockRequest(),
      createMockResponse(),
      vi.fn(),
    );

    expect(queue.getQueueDepth()).toBe(3);
    expect(queue.getQueueDepth("https://example1.com")).toBe(2);
    expect(queue.getQueueDepth("https://example2.com")).toBe(1);

    // Dequeue from first origin
    queue.dequeue("https://example1.com");
    expect(queue.getQueueDepth("https://example1.com")).toBe(1);
    expect(queue.getQueueDepth()).toBe(2);
  });

  it("should respect max queue size", () => {
    const queue = new RequestQueue(mockLogger, { maxQueueSize: 2 });

    // Fill the queue
    expect(
      queue.enqueue(
        "https://example.com",
        createMockRequest(),
        createMockResponse(),
        vi.fn(),
      ),
    ).toBe(true);
    expect(
      queue.enqueue(
        "https://example.com",
        createMockRequest(),
        createMockResponse(),
        vi.fn(),
      ),
    ).toBe(true);

    // Try to exceed limit
    expect(
      queue.enqueue(
        "https://example.com",
        createMockRequest(),
        createMockResponse(),
        vi.fn(),
      ),
    ).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Request queue full"),
    );
  });

  it("should timeout queued requests", async () => {
    const queue = new RequestQueue(mockLogger, { queueTimeout: 100 });
    const res = createMockResponse();

    queue.enqueue("https://example.com", createMockRequest(), res, vi.fn());

    // Wait for timeout
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(res.writeHead).toHaveBeenCalledWith(503, {
      "Content-Type": "text/plain",
    });
    expect(res.end).toHaveBeenCalledWith(
      "Service Unavailable: Request queue timeout",
    );
    expect(queue.getQueueDepth()).toBe(0);
  });

  it("should clear all requests on shutdown", () => {
    const queue = new RequestQueue(mockLogger);
    const res1 = createMockResponse();
    const res2 = createMockResponse();

    queue.enqueue("https://example1.com", createMockRequest(), res1, vi.fn());
    queue.enqueue("https://example2.com", createMockRequest(), res2, vi.fn());

    queue.clear();

    expect(res1.writeHead).toHaveBeenCalledWith(503, {
      "Content-Type": "text/plain",
    });
    expect(res1.end).toHaveBeenCalledWith(
      "Service Unavailable: Server shutting down",
    );
    expect(res2.writeHead).toHaveBeenCalledWith(503, {
      "Content-Type": "text/plain",
    });
    expect(res2.end).toHaveBeenCalledWith(
      "Service Unavailable: Server shutting down",
    );
    expect(queue.getQueueDepth()).toBe(0);
  });

  it("should return null when dequeueing from empty queue", () => {
    const queue = new RequestQueue(mockLogger);
    expect(queue.dequeue("https://example.com")).toBeNull();
  });

  it("should maintain FIFO order", () => {
    const queue = new RequestQueue(mockLogger);
    const callbacks = [vi.fn(), vi.fn(), vi.fn()];

    callbacks.forEach((cb) => {
      queue.enqueue(
        "https://example.com",
        createMockRequest(),
        createMockResponse(),
        cb,
      );
    });

    // Dequeue in order
    expect(queue.dequeue("https://example.com")?.callback).toBe(callbacks[0]);
    expect(queue.dequeue("https://example.com")?.callback).toBe(callbacks[1]);
    expect(queue.dequeue("https://example.com")?.callback).toBe(callbacks[2]);
  });

  it("should track queue wait time in logs", () => {
    const queue = new RequestQueue(mockLogger);
    const callback = vi.fn();

    queue.enqueue(
      "https://example.com",
      createMockRequest(),
      createMockResponse(),
      callback,
    );

    // Small delay to ensure measurable wait time
    setTimeout(() => {
      queue.dequeue("https://example.com");
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringMatching(/Dequeued request for .* after \d+ms/),
      );
    }, 10);
  });
});
