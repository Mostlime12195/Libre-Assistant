/**
 * Tests for app/composables/toolsManager.js
 *
 * The ToolManager class registers executors and schemas for AI tool calls.
 * We test:
 *   - Pure registration / lookup behavior with custom tools
 *   - The executeTool happy path
 *   - The default `search` tool, using vi.mock to stub `useSettings` and
 *     `globalThis.fetch` (introduces the mocking pattern in this codebase)
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

// Mock useSettings BEFORE the toolsManager module loads so that the
// singleton's `registerDefaultTools` -> `getApiKey` path has a stubbed
// settings object to read from.
vi.mock("../app/composables/useSettings", () => ({
  useSettings: () => ({ settings: { custom_api_key: "test-key-123" } }),
}));

import { ToolManager, toolManager } from "../app/composables/toolsManager.js";

describe("ToolManager (custom-registered tool, no defaults)", () => {
  // Build a fresh manager without the default tools so each test is isolated
  // and we can exercise the basic registration API cleanly.
  function freshManager() {
    const tm = new ToolManager();
    tm.unregisterTool("search");
    tm.unregisterTool("getPageContents");
    return tm;
  }

  it("registers a tool and looks it up by name", () => {
    const tm = freshManager();
    const executor = vi.fn();
    const schema = { type: "function", function: { name: "ping" } };

    tm.registerTool("ping", executor, schema);

    const tool = tm.getTool("ping");
    expect(tool).toBeDefined();
    expect(tool.executor).toBe(executor);
    expect(tool.schema).toBe(schema);
  });

  it("unregisters a tool", () => {
    const tm = freshManager();
    tm.registerTool("ping", vi.fn(), { type: "function" });
    tm.unregisterTool("ping");
    expect(tm.getTool("ping")).toBeUndefined();
  });

  it("getToolNames lists all registered tools", () => {
    const tm = freshManager();
    tm.registerTool("a", vi.fn(), {});
    tm.registerTool("b", vi.fn(), {});
    expect(tm.getToolNames().sort()).toEqual(["a", "b"]);
  });

  it("getToolSchemas returns an array of schemas", () => {
    const tm = freshManager();
    tm.registerTool("a", vi.fn(), { type: "function", function: { name: "a" } });
    tm.registerTool("b", vi.fn(), { type: "function", function: { name: "b" } });
    const schemas = tm.getToolSchemas();
    expect(schemas).toHaveLength(2);
    expect(schemas.map((s) => s.function.name).sort()).toEqual(["a", "b"]);
  });

  it("getSchemasByNames returns only the requested ones (and ignores unknowns)", () => {
    const tm = freshManager();
    tm.registerTool("a", vi.fn(), { type: "function", function: { name: "a" } });
    tm.registerTool("b", vi.fn(), { type: "function", function: { name: "b" } });

    const schemas = tm.getSchemasByNames(["a", "ghost"]);
    expect(schemas).toHaveLength(1);
    expect(schemas[0].function.name).toBe("a");
  });

  it("getSchemasByNames returns [] for an empty list", () => {
    const tm = freshManager();
    tm.registerTool("a", vi.fn(), { type: "function" });
    expect(tm.getSchemasByNames([])).toEqual([]);
  });
});

describe("ToolManager.executeTool", () => {
  function freshManager() {
    const tm = new ToolManager();
    tm.unregisterTool("search");
    tm.unregisterTool("getPageContents");
    return tm;
  }

  it("invokes the registered executor with the given args", async () => {
    const tm = freshManager();
    const executor = vi.fn(async (args) => `echo:${args.x}`);
    tm.registerTool("echo", executor, {});

    const result = await tm.executeTool("echo", { x: 42 });
    expect(executor).toHaveBeenCalledWith({ x: 42 });
    expect(result).toBe("echo:42");
  });

  it("throws when the tool is not registered", async () => {
    const tm = freshManager();
    await expect(tm.executeTool("ghost", {})).rejects.toThrow(/not found/);
  });
});

describe("default `search` tool (with mocked fetch)", () => {
  // Mocked at the test-file level so all tests in this block share it.
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    delete globalThis.fetch;
  });

  it("calls /api/search with the right query string and auth header", async () => {
    // The mocked fetch stands in for /api/search (the server route), so the
    // response shape here mirrors what search.get.js returns: `date`, not
    // `publishedDate`; arrays guaranteed; etc.
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{
          title: "x",
          url: "u",
          highlights: ["a key excerpt"],
          author: "Alice",
          date: "2024-01-15",
          subpages: []
        }]
      }),
    });

    const result = await toolManager.executeTool("search", { q: "hello", numResults: 3 });

    // Verify the request
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain("/api/search?");
    expect(url).toContain("q=hello");
    expect(url).toContain("numResults=3");
    expect(init.headers["X-API-Key"]).toBe("test-key-123");

    // Verify the result is reformatted with the new field set
    expect(result.results).toHaveLength(1);
    expect(result.results[0].title).toBe("x");
    expect(result.results[0].url).toBe("u");
    expect(result.results[0].highlights).toEqual(["a key excerpt"]);
    expect(result.results[0].author).toBe("Alice");
    expect(result.results[0].date).toBe("2024-01-15");
    expect(result.results[0].subpages).toEqual([]);
    expect(result.query).toBe("hello");
  });

  it("returns an empty list with a message when the API finds nothing", async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });

    const result = await toolManager.executeTool("search", { q: "nothing" });
    expect(result.results).toEqual([]);
    expect(result.message).toMatch(/no results/i);
  });

  it("throws when called without a query", async () => {
    await expect(toolManager.executeTool("search", {})).rejects.toThrow(/query/);
  });
});
