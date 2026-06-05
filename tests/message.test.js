/**
 * Tests for app/composables/message.js
 *
 * The message composable is the biggest file in the project and most of it
 * is coupled to fetch, Nuxt, and global state. The pure, side-effect-free
 * function we can safely test in isolation is `formatMessageForAPI`, which
 * is re-exported at the bottom of the file.
 *
 * These tests pin down the contract that the OpenAI/Hack Club API relies on:
 *   - User messages: string content, or a parts array when there are attachments
 *   - Assistant messages: one API message per logical "segment"
 *   - Tool messages: tool_call_id + content (no name field, per OpenAI spec)
 */

import { describe, it, expect } from "vitest";
import { formatMessageForAPI } from "../app/composables/message.js";

describe("formatMessageForAPI - user messages", () => {
  it("formats a plain user message with string content", () => {
    const result = formatMessageForAPI({
      role: "user",
      content: "hi",
    });

    expect(result).toEqual({
      role: "user",
      content: "hi",
      annotations: undefined,
    });
  });

  it("preserves annotations when present", () => {
    const annotations = [{ type: "file_citation" }];
    const result = formatMessageForAPI({
      role: "user",
      content: "see this",
      annotations,
    });
    expect(result.annotations).toBe(annotations);
  });

  it("builds a content-parts array when images are attached", () => {
    const result = formatMessageForAPI({
      role: "user",
      content: "what is this?",
      attachments: [
        { type: "image", dataUrl: "data:image/png;base64,AAA" },
      ],
    });

    expect(result.role).toBe("user");
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "what is this?" });
    expect(result.content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAA" },
    });
  });

  it("builds a content-parts array when PDFs are attached", () => {
    const result = formatMessageForAPI({
      role: "user",
      content: "summarize",
      attachments: [
        { type: "pdf", filename: "doc.pdf", dataUrl: "data:application/pdf;base64,XYZ" },
      ],
    });

    expect(result.content[0]).toEqual({ type: "text", text: "summarize" });
    expect(result.content[1]).toEqual({
      type: "file",
      file: {
        filename: "doc.pdf",
        file_data: "data:application/pdf;base64,XYZ",
      },
    });
  });
});

describe("formatMessageForAPI - tool messages", () => {
  it("emits the OpenAI tool-result shape (role, tool_call_id, content)", () => {
    const result = formatMessageForAPI({
      role: "tool",
      tool_call_id: "call_abc",
      content: "result data",
    });

    // Per the comment in source: OpenAI tool messages have NO name field
    expect(result).toEqual({
      role: "tool",
      tool_call_id: "call_abc",
      content: "result data",
    });
    expect(result).not.toHaveProperty("name");
  });

  it("coerces null content to empty string", () => {
    const result = formatMessageForAPI({
      role: "tool",
      tool_call_id: "call_abc",
      content: null,
    });
    expect(result.content).toBe("");
  });
});

describe("formatMessageForAPI - assistant messages", () => {
  it("returns an empty array for an assistant message with no parts and no content", () => {
    const result = formatMessageForAPI({
      role: "assistant",
    });
    expect(result).toEqual([]);
  });

  it("wraps plain text content in an assistant message", () => {
    const result = formatMessageForAPI({
      role: "assistant",
      content: "hello there",
    });

    expect(result).toEqual([
      { role: "assistant", content: "hello there" },
    ]);
  });

  it("wraps reasoning into <thinking> tags and prepends it", () => {
    const result = formatMessageForAPI({
      role: "assistant",
      content: "answer",
      reasoning: "step 1, step 2",
    });

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toContain("<thinking>");
    expect(result[0].content).toContain("step 1, step 2");
    expect(result[0].content).toContain("answer");
  });

  it("interleaves tool calls with their results in order", () => {
    const result = formatMessageForAPI({
      role: "assistant",
      parts: [
        {
          type: "content",
          content: "let me check",
        },
        {
          type: "tool_group",
          toolType: "search",
          tools: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search", arguments: '{"q":"x"}' },
              result: { hits: 3 },
            },
          ],
        },
        {
          type: "content",
          content: "done",
        },
      ],
    });

    // Expected: [content, assistant(tool_call), tool(result), content]
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({
      role: "assistant",
      content: "let me check",
    });
    expect(result[1].role).toBe("assistant");
    expect(result[1].tool_calls[0].id).toBe("call_1");
    expect(result[2].role).toBe("tool");
    expect(result[2].tool_call_id).toBe("call_1");
    expect(result[3]).toEqual({
      role: "assistant",
      content: "done",
    });
  });

  it("serializes non-string tool results as JSON", () => {
    const result = formatMessageForAPI({
      role: "assistant",
      parts: [
        {
          type: "tool_group",
          toolType: "search",
          tools: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search", arguments: "{}" },
              result: { ok: true, count: 42 },
            },
          ],
        },
      ],
    });

    const toolMsg = result.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(JSON.parse(toolMsg.content)).toEqual({ ok: true, count: 42 });
  });
});

describe("formatMessageForAPI - unknown roles", () => {
  it("falls back to a generic role+content message", () => {
    const result = formatMessageForAPI({
      role: "weird",
      content: "hi",
    });
    expect(result).toEqual({ role: "weird", content: "hi" });
  });
});
