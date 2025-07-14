import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "./logger";

export interface QueuedRequest {
  req: IncomingMessage;
  res: ServerResponse;
  origin: string;
  callback: () => void;
  timeoutHandle?: NodeJS.Timeout;
  queuedAt: number;
}

export interface RequestQueueOptions {
  maxQueueSize?: number;
  queueTimeout?: number;
}

export class RequestQueue {
  private queue: Map<string, QueuedRequest[]> = new Map();
  private maxQueueSize: number;
  private queueTimeout: number;
  private logger?: Logger;
  private totalQueued = 0;

  constructor(logger?: Logger, options: RequestQueueOptions = {}) {
    this.logger = logger;
    this.maxQueueSize = options.maxQueueSize || 512;
    this.queueTimeout = options.queueTimeout || 30000; // 30 seconds default
  }

  enqueue(
    origin: string,
    req: IncomingMessage,
    res: ServerResponse,
    callback: () => void,
  ): boolean {
    if (this.totalQueued >= this.maxQueueSize) {
      this.logger?.warn(
        `Request queue full (${this.totalQueued}/${this.maxQueueSize}), rejecting request`,
      );
      return false;
    }

    const queuedRequest: QueuedRequest = {
      req,
      res,
      origin,
      callback,
      queuedAt: Date.now(),
    };

    // Set timeout for queued request
    queuedRequest.timeoutHandle = setTimeout(() => {
      this.removeRequest(origin, queuedRequest);
      if (!res.headersSent) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("Service Unavailable: Request queue timeout");
      }
      this.logger?.warn(
        `Request timed out in queue after ${this.queueTimeout}ms for ${origin}`,
      );
    }, this.queueTimeout);

    // Add to queue for this origin
    const originQueue = this.queue.get(origin) || [];
    originQueue.push(queuedRequest);
    this.queue.set(origin, originQueue);
    this.totalQueued++;

    this.logger?.debug(
      `Queued request for ${origin}. Queue depth: ${originQueue.length}, Total queued: ${this.totalQueued}`,
    );

    return true;
  }

  dequeue(origin: string): QueuedRequest | null {
    const originQueue = this.queue.get(origin);
    if (!originQueue || originQueue.length === 0) {
      return null;
    }

    const request = originQueue.shift();
    if (request) {
      // Clear timeout
      if (request.timeoutHandle) {
        clearTimeout(request.timeoutHandle);
      }

      // Clean up empty queues
      if (originQueue.length === 0) {
        this.queue.delete(origin);
      }

      this.totalQueued--;
      const waitTime = Date.now() - request.queuedAt;
      this.logger?.debug(
        `Dequeued request for ${origin} after ${waitTime}ms. Remaining in queue: ${originQueue.length}`,
      );
    }

    return request || null;
  }

  private removeRequest(origin: string, request: QueuedRequest): void {
    const originQueue = this.queue.get(origin);
    if (!originQueue) return;

    const index = originQueue.indexOf(request);
    if (index > -1) {
      originQueue.splice(index, 1);
      this.totalQueued--;

      if (originQueue.length === 0) {
        this.queue.delete(origin);
      }
    }
  }

  getQueueDepth(origin?: string): number {
    if (origin) {
      return this.queue.get(origin)?.length || 0;
    }
    return this.totalQueued;
  }

  clear(): void {
    // Clear all timeouts and respond with 503
    for (const [, requests] of this.queue) {
      for (const request of requests) {
        if (request.timeoutHandle) {
          clearTimeout(request.timeoutHandle);
        }
        if (!request.res.headersSent) {
          request.res.writeHead(503, { "Content-Type": "text/plain" });
          request.res.end("Service Unavailable: Server shutting down");
        }
      }
    }
    this.queue.clear();
    this.totalQueued = 0;
  }
}
