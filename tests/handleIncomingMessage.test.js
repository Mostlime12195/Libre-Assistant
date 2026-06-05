/**
 * Tests for app/composables/message.js -> handleIncomingMessage
 *
 * Integration test of the streaming agent loop with mocked fetch:
 *   - Yields content chunks as they stream in
 *   - Yields reasoning chunks
 *   - Aborts surface a "STREAM CANCELED" yield
 *   - A "service down" health response yields the user-facing message
 *   - Missing required params are rejected immediately
 *   - Tool-call deltas are forwarded as tool_calls yields
 *
 * Approach:
 *   - vi.mock to stub upstream modules (systemPrompt, toolsManager, useSession)
 *   - vi.resetModules() in beforeEach so the module-level health cache
 *     starts cold for every test
 *   - Stub globalThis.fetch with a URL-based implementation
 *   - Drive the async generator and collect its yields
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

// --- Shared hoisted state (vi.mock factories are hoisted above imports) ---

const mocks = vi.hoisted(() => ({
  toolManager: {
    getSchemasByNames: vi.fn(() => []),
    getTool: vi.fn(),
  },
}));

// --- Module-level mocks ---

vi.mock("../app/composables/systemPrompt", () => ({
  generateSystemPrompt: vi.fn(async () => "You are a test assistant."),
}));

vi.mock("../app/composables/toolsManager", () => ({
  toolManager: mocks.toolManager,
  ToolManager: class {},
}));

vi.mock("../app/composables/useSession", () => ({
  getSessionToken: vi.fn(async () => "test-session-token"),
}));

// --- Helpers ---

function makeSseStream(chunks) {
  const encoder = new TextEncoder();
  const encoded = chunks.map((c) => encoder.encode(c));
  let i = 0;
  return {
    getReader() {
      return {
        read: async () => {
          if (i >= encoded.length) return { done: true, value: undefined };
          return { done: false, value: encoded[i++] };
        },
        releaseLock: () => {},
        cancel: async () => {},
      };
    },
  };
}

const HEALTH_OK = {
  ok: true,
  json: async () => ({
    status: "ok",
    dailyKeyUsageRemaining: 100,
    balanceRemaining: 100,
  }),
};

const HEALTH_DOWN = {
  ok: true,
  json: async () => ({
    status: "down",
    dailyKeyUsageRemaining: 0,
    balanceRemaining: 0,
  }),
};

const ABORT_ERROR = (() => {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
})();

/**
 * Install a fetch mock that routes by URL. `streamFn(callIndex)` returns
 * the SSE chunk array for each successive /api/ai call. The returned
 * value `"ABORT"` is a sentinel for an AbortError-throwing reader.
 */
function installRoutedFetch(streamFn, healthResponse = HEALTH_OK) {
  let streamCallIndex = 0;
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("api_health")) return healthResponse;
    const chunks = streamFn(streamCallIndex++);
    if (chunks === "ABORT") {
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn().mockRejectedValue(ABORT_ERROR),
            releaseLock: vi.fn(),
            cancel: vi.fn(),
          }),
        },
      };
    }
    return { ok: true, body: makeSseStream(chunks) };
  });
}

// --- Tests ---

describe("handleIncomingMessage", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.toolManager.getSchemasByNames.mockReturnValue([]);
    mocks.toolManager.getTool.mockReset();
  });

  afterEach(() => {
    delete globalThis.fetch;
    vi.clearAllMocks();
  });

  // Helper: only INCREMENTAL content yields (excludes the final complete yield)
  function incrementalContent(chunks) {
    return chunks
      .filter((c) => c.content !== undefined && c.content !== null && !c.complete)
      .map((c) => c.content);
  }

  it("rejects when required parameters are missing", async () => {
    const { handleIncomingMessage } = await import("../app/composables/message.js");
    const chunks = [];
    for await (const c of handleIncomingMessage(null, [], new AbortController())) {
      chunks.push(c);
    }

    const err = chunks.find((c) => c.error);
    expect(err).toBeDefined();
    expect(err.errorDetails.message).toMatch(/missing/i);
  });

  it("yields content chunks from a plain text stream", async () => {
    installRoutedFetch(() => [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const { handleIncomingMessage } = await import("../app/composables/message.js");
    const chunks = [];
    for await (const c of handleIncomingMessage("hi", [], new AbortController())) {
      chunks.push(c);
    }

    expect(incrementalContent(chunks)).toEqual(["Hello", " world"]);

    const final = chunks.find((c) => c.complete);
    expect(final.content).toBe("Hello world");
  });

  it("yields reasoning chunks when the API returns reasoning deltas", async () => {
    installRoutedFetch(() => [
      'data: {"choices":[{"delta":{"reasoning":"thinking..."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const { handleIncomingMessage } = await import("../app/composables/message.js");
    const chunks = [];
    for await (const c of handleIncomingMessage("q", [], new AbortController())) {
      chunks.push(c);
    }

    const reasoning = chunks
      .filter((c) => c.reasoning === "thinking...")
      .map((c) => c.reasoning);
    expect(reasoning.length).toBeGreaterThan(0);
    expect(incrementalContent(chunks)).toContain("answer");
  });

  it("surfaces a service-unavailable message when the health check is down", async () => {
    installRoutedFetch(() => [], HEALTH_DOWN);

    const { handleIncomingMessage } = await import("../app/composables/message.js");
    const chunks = [];
    for await (const c of handleIncomingMessage("q", [], new AbortController())) {
      chunks.push(c);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toMatch(/unavailable/i);
  });

  it("yields a STREAM CANCELED message when the controller is aborted", async () => {
    installRoutedFetch(() => "ABORT");

    const { handleIncomingMessage } = await import("../app/composables/message.js");
    const chunks = [];
    for await (const c of handleIncomingMessage("q", [], new AbortController())) {
      chunks.push(c);
    }

    const canceled = chunks.find(
      (c) => typeof c.content === "string" && c.content.includes("CANCELED")
    );
    expect(canceled).toBeDefined();
    expect(canceled.complete).toBe(true);
  });

  it("yields a tool_calls chunk when the stream contains a tool_call delta", async () => {
    // Just a single stream that yields a tool_call. We don't need to
    // exercise the full tool-execution branch here — that's a separate
    // concern covered by the per-tool unit tests in toolsManager.test.js.
    installRoutedFetch(() => [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search","arguments":"{\\"q\\":\\"hello\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const { handleIncomingMessage } = await import("../app/composables/message.js");
    const chunks = [];
    for await (const c of handleIncomingMessage("q", [], new AbortController())) {
      chunks.push(c);
    }

    // The function should yield at least one chunk with tool_calls set
    const toolCallChunks = chunks.filter((c) => c.tool_calls);
    expect(toolCallChunks.length).toBeGreaterThan(0);
    expect(toolCallChunks[0].tool_calls[0].id).toBe("call_1");
  });
});
