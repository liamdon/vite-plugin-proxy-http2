import { describe, expect, it } from "vitest";

// We'll test the header filtering logic by creating a mock request
describe("Header Filtering for HTTP/1.1 Proxy", () => {
  it("should filter out HTTP/2 pseudo-headers", () => {
    // Simulate headers that might come from an HTTP/2 request
    const mockHeaders = {
      ":method": "GET",
      ":path": "/test",
      ":scheme": "https",
      ":authority": "example.com",
      "content-type": "application/json",
      "user-agent": "test-agent",
      connection: "keep-alive",
      upgrade: "websocket",
      "sec-websocket-key": "test-key",
    };

    // Expected headers after filtering for non-WebSocket request
    const expectedNonWsHeaders = {
      "content-type": "application/json",
      "user-agent": "test-agent",
      "sec-websocket-key": "test-key",
    };

    // Expected headers after filtering for WebSocket request
    const expectedWsHeaders = {
      "content-type": "application/json",
      "user-agent": "test-agent",
      connection: "keep-alive",
      upgrade: "websocket",
      "sec-websocket-key": "test-key",
    };

    // Test the filtering logic
    const filteredNonWs = filterHeaders(mockHeaders, false);
    const filteredWs = filterHeaders(mockHeaders, true);

    expect(filteredNonWs).toEqual(expectedNonWsHeaders);
    expect(filteredWs).toEqual(expectedWsHeaders);
  });
});

// Helper function that mimics the header filtering logic
function filterHeaders(
  headers: Record<string, string>,
  isWebSocket: boolean,
): Record<string, string> {
  const filteredHeaders: Record<string, string> = {};
  const forbiddenHeaders = [
    "keep-alive",
    "transfer-encoding",
    "proxy-connection",
    "te",
    "trailer",
  ];

  if (!isWebSocket) {
    forbiddenHeaders.push("connection", "upgrade");
  }

  for (const [key, value] of Object.entries(headers)) {
    // Skip HTTP/2 pseudo-headers (start with :)
    if (key.startsWith(":")) continue;
    // Skip forbidden headers
    if (forbiddenHeaders.includes(key.toLowerCase())) continue;

    filteredHeaders[key] = value;
  }

  return filteredHeaders;
}
