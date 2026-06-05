/**
 * Tests for app/composables/partsBuilder.js
 *
 * PartsBuilder is the core class that accumulates assistant message parts
 * (text, reasoning, tool calls, images) as they stream in from the API.
 * These tests exercise the documented behavior:
 *   - append-only structure
 *   - immutability (getParts returns a deep clone)
 *   - content/reasoning finalization at tool boundaries
 *   - tool tracking by ID and API index
 */

import { describe, it, expect } from "vitest";
import { PartsBuilder, TimingTracker } from "../app/composables/partsBuilder.js";

describe("PartsBuilder", () => {
  describe("initial state", () => {
    it("starts with no parts", () => {
      const pb = new PartsBuilder();
      expect(pb.getParts()).toEqual([]);
      expect(pb.hasParts()).toBe(false);
      expect(pb.hasContentPart()).toBe(false);
      expect(pb.hasImagePart()).toBe(false);
    });
  });

  describe("appendContent", () => {
    it("creates a new content part on first append", () => {
      const pb = new PartsBuilder();
      pb.appendContent("Hello");

      const parts = pb.getParts();
      expect(parts).toHaveLength(1);
      expect(parts[0].type).toBe("content");
      expect(parts[0].content).toBe("Hello");
      expect(parts[0]._finalized).toBe(false);
    });

    it("concatenates to an existing open content part", () => {
      const pb = new PartsBuilder();
      pb.appendContent("Hello");
      pb.appendContent(" ");
      pb.appendContent("world");

      const parts = pb.getParts();
      expect(parts).toHaveLength(1);
      expect(parts[0].content).toBe("Hello world");
    });

    it("ignores empty/null content", () => {
      const pb = new PartsBuilder();
      pb.appendContent("");
      pb.appendContent(null);
      pb.appendContent(undefined);

      expect(pb.getParts()).toEqual([]);
    });
  });

  describe("finalizeContent", () => {
    it("marks the open content part as finalized", () => {
      const pb = new PartsBuilder();
      pb.appendContent("Before tool");
      pb.finalizeContent();

      expect(pb.getParts()[0]._finalized).toBe(true);
    });

    it("is a no-op when there is no open content part", () => {
      const pb = new PartsBuilder();
      pb.appendContent("Done");
      pb.finalizeContent();
      // Second call should not throw or duplicate
      pb.finalizeContent();

      expect(pb.getParts()).toHaveLength(1);
      expect(pb.getParts()[0]._finalized).toBe(true);
    });
  });

  describe("appendReasoning", () => {
    it("creates a reasoning part", () => {
      const pb = new PartsBuilder();
      pb.appendReasoning("thinking...");

      const parts = pb.getParts();
      expect(parts).toHaveLength(1);
      expect(parts[0].type).toBe("reasoning");
      expect(parts[0].content).toBe("thinking...");
    });

    it("ignores the literal string 'None' (API quirk)", () => {
      const pb = new PartsBuilder();
      pb.appendReasoning("None");
      expect(pb.getParts()).toEqual([]);
    });

    it("ignores empty/whitespace strings", () => {
      const pb = new PartsBuilder();
      pb.appendReasoning("");
      pb.appendReasoning("   ");
      expect(pb.getParts()).toEqual([]);
    });

    it("concatenates to an existing open reasoning part", () => {
      const pb = new PartsBuilder();
      pb.appendReasoning("step 1 ");
      pb.appendReasoning("step 2");

      expect(pb.getParts()[0].content).toBe("step 1 step 2");
    });
  });

  describe("addOrUpdateTool", () => {
    it("creates a tool_group part for a new tool", () => {
      const pb = new PartsBuilder();
      pb.addOrUpdateTool("search", {
        index: 0,
        id: "tool_abc",
        function: { name: "search", arguments: '{"q":"hi"}' },
      });

      const parts = pb.getParts();
      expect(parts).toHaveLength(1);
      expect(parts[0].type).toBe("tool_group");
      expect(parts[0].toolType).toBe("search");
      expect(parts[0].tools).toHaveLength(1);
      expect(parts[0].tools[0].id).toBe("tool_abc");
      expect(parts[0].tools[0].function.name).toBe("search");
      expect(parts[0].tools[0].function.arguments).toBe('{"q":"hi"}');
    });

    it("finalizes an open content part before adding a tool", () => {
      const pb = new PartsBuilder();
      pb.appendContent("Reasoning before tool");
      pb.addOrUpdateTool("search", {
        index: 0,
        function: { name: "search", arguments: "{}" },
      });

      const parts = pb.getParts();
      expect(parts).toHaveLength(2);
      expect(parts[0].type).toBe("content");
      expect(parts[0]._finalized).toBe(true);
      expect(parts[1].type).toBe("tool_group");
    });

    it("updates an existing tool when called with the same id", () => {
      const pb = new PartsBuilder();
      pb.addOrUpdateTool("search", {
        index: 0,
        id: "tool_abc",
        function: { name: "search", arguments: '{"q":' },
      });
      pb.addOrUpdateTool("search", {
        index: 0,
        id: "tool_abc",
        function: { name: "search", arguments: '"hi"}' },
      });

      const parts = pb.getParts();
      expect(parts).toHaveLength(1);
      expect(parts[0].tools[0].function.arguments).toBe('{"q":"hi"}');
    });

    it("creates a new tool part when index reappears after completion", () => {
      const pb = new PartsBuilder();
      pb.addOrUpdateTool("search", {
        index: 0,
        id: "tool_1",
        function: { name: "search", arguments: "{}" },
      });
      pb.markToolCompleted("tool_1");
      pb.addOrUpdateTool("search", {
        index: 0,
        id: "tool_2",
        function: { name: "search", arguments: "{}" },
      });

      const parts = pb.getParts();
      expect(parts.filter((p) => p.type === "tool_group")).toHaveLength(2);
    });
  });

  describe("setToolResult", () => {
    it("sets the result on a known tool id and marks it complete", () => {
      const pb = new PartsBuilder();
      pb.addOrUpdateTool("search", {
        index: 0,
        id: "tool_1",
        function: { name: "search", arguments: "{}" },
      });

      const ok = pb.setToolResult("tool_1", { output: "ok" });

      expect(ok).toBe(true);
      const tools = pb.getAllTools();
      expect(tools[0].result).toEqual({ output: "ok" });
      expect(pb.isToolCompleted("tool_1")).toBe(true);
    });

    it("returns false for an unknown tool id", () => {
      const pb = new PartsBuilder();
      expect(pb.setToolResult("nope", "x")).toBe(false);
    });
  });

  describe("markToolCompleted / isToolCompleted", () => {
    it("tracks tool completion by id", () => {
      const pb = new PartsBuilder();
      expect(pb.isToolCompleted("tool_1")).toBe(false);
      pb.markToolCompleted("tool_1");
      expect(pb.isToolCompleted("tool_1")).toBe(true);
    });

    it("is safe with empty/null toolId", () => {
      const pb = new PartsBuilder();
      expect(pb.isToolCompleted(null)).toBe(false);
      pb.markToolCompleted(null); // should not throw
      pb.markToolCompleted("");   // should not throw
      expect(pb.isToolCompleted("")).toBe(false);
    });
  });

  describe("addImage / processImage", () => {
    it("creates an image part", () => {
      const pb = new PartsBuilder();
      pb.addImage("https://example.com/cat.png", "a cat");

      const parts = pb.getParts();
      expect(parts).toHaveLength(1);
      expect(parts[0].type).toBe("image");
      expect(parts[0].images).toEqual([
        { url: "https://example.com/cat.png", revised_prompt: "a cat" },
      ]);
      expect(pb.hasImagePart()).toBe(true);
    });

    it("appends to an existing image part instead of creating a new one", () => {
      const pb = new PartsBuilder();
      pb.addImage("https://example.com/1.png");
      pb.addImage("https://example.com/2.png", "second");

      const parts = pb.getParts();
      expect(parts).toHaveLength(1);
      expect(parts[0].images).toHaveLength(2);
    });

    it("processImage handles the { image_url: { url } } shape", () => {
      const pb = new PartsBuilder();
      pb.processImage({ image_url: { url: "https://example.com/x.png" } });

      expect(pb.getParts()[0].images[0].url).toBe("https://example.com/x.png");
    });
  });

  describe("ensureContentPartFirst", () => {
    it("prepends a content part if none exists", () => {
      const pb = new PartsBuilder();
      pb.addOrUpdateTool("search", {
        index: 0,
        function: { name: "search", arguments: "{}" },
      });
      pb.ensureContentPartFirst("Hello!");

      const parts = pb.getParts();
      expect(parts[0].type).toBe("content");
      expect(parts[0].content).toBe("Hello!");
      expect(parts[1].type).toBe("tool_group");
    });

    it("is a no-op if a content part already exists", () => {
      const pb = new PartsBuilder();
      pb.appendContent("Existing");
      pb.ensureContentPartFirst("Should not appear");

      expect(pb.getParts()).toHaveLength(1);
      expect(pb.getParts()[0].content).toBe("Existing");
    });
  });

  describe("immutability", () => {
    it("getParts returns a deep clone (mutating it does not affect the builder)", () => {
      const pb = new PartsBuilder();
      pb.appendContent("hi");

      const snapshot = pb.getParts();
      snapshot[0].content = "MUTATED";
      snapshot.push({ type: "image" });

      const fresh = pb.getParts();
      expect(fresh).toHaveLength(1);
      expect(fresh[0].content).toBe("hi");
    });
  });
});

describe("TimingTracker", () => {
  it("marks first token only once", () => {
    const msg = {};
    const t = new TimingTracker(msg);

    t.markFirstToken();
    const first = msg.firstTokenTime;
    t.markFirstToken();
    const second = msg.firstTokenTime;

    expect(first).toBe(second);
    expect(first).toBeInstanceOf(Date);
  });

  it("tracks reasoning start and end", () => {
    const msg = { reasoningStartTime: null, reasoningEndTime: null };
    const t = new TimingTracker(msg);

    t.startReasoning();
    t.endReasoning();

    expect(msg.reasoningStartTime).toBeInstanceOf(Date);
    expect(msg.reasoningEndTime).toBeInstanceOf(Date);
  });

  it("calculateReasoningDuration returns null when reasoning never started", () => {
    const t = new TimingTracker({});
    expect(t.calculateReasoningDuration()).toBe(null);
  });

  it("calculateReasoningDuration returns elapsed ms when reasoning is open", async () => {
    const msg = { reasoningStartTime: new Date(Date.now() - 100), reasoningEndTime: null };
    const t = new TimingTracker(msg);
    const duration = t.calculateReasoningDuration();
    expect(typeof duration).toBe("number");
    expect(duration).toBeGreaterThanOrEqual(100);
  });
});
