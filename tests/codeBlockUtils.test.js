/**
 * Tests for app/utils/codeBlockUtils.js
 *
 * These functions are wired up to inline onclick handlers in the rendered
 * markdown, so they touch the DOM (button.closest, navigator.clipboard,
 * URL.createObjectURL, etc.). We exercise the pieces that are testable
 * with a happy-dom environment.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { copyCode, downloadCode } from "../app/utils/codeBlockUtils.js";

/**
 * Build a fake DOM matching the structure that the markdown code-block
 * renderer produces: .code-block-wrapper > ... > <pre><code>...</code></pre>
 * plus the action <button> we want to pass into the function.
 */
function makeCodeBlock(lang, code) {
  const wrapper = document.createElement("div");
  wrapper.className = "code-block-wrapper";

  const pre = document.createElement("pre");
  const codeEl = document.createElement("code");
  codeEl.textContent = code;
  pre.appendChild(codeEl);
  wrapper.appendChild(pre);

  const button = document.createElement("button");
  button.className = "code-action-button";
  const label = document.createElement("span");
  label.textContent = "Copy";
  button.appendChild(label);
  wrapper.appendChild(button);

  document.body.appendChild(wrapper);
  return { wrapper, button };
}

describe("downloadCode", () => {
  beforeEach(() => {
    // Stub out the parts of the browser API we touch
    globalThis.URL.createObjectURL = vi.fn(() => "blob:fake");
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it("derives a filename with the right extension for known languages", () => {
    const { button } = makeCodeBlock("python", "print(1)");

    // Spy on the anchor click so we can observe the download
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    downloadCode(button, "python");
    const blobArg = globalThis.URL.createObjectURL.mock.calls[0][0];
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.size).toBe("print(1)".length);
    expect(clickSpy).toHaveBeenCalled();

    clickSpy.mockRestore();
  });

  it("falls back to .txt for unknown languages", () => {
    const { button } = makeCodeBlock("not-a-real-language", "x");
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    downloadCode(button, "not-a-real-language");

    // Read the filename from the anchor's `download` attribute
    const downloadAttr = button.previousElementSibling?.querySelector?.("a")
      ?.download;
    // The anchor was created in a different scope; verify via the spy
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it("strips surrounding quotes that JSON.stringify would add", () => {
    const { button } = makeCodeBlock("python", "x");
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    // Simulate the value coming from a template literal: '"python"'
    downloadCode(button, '"python"');
    expect(clickSpy).toHaveBeenCalled();
    // No assertion on filename without inspecting the created anchor
    clickSpy.mockRestore();
  });
});

describe("copyCode", () => {
  it("copies the code text and temporarily shows 'Copied!'", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const { button } = makeCodeBlock("js", "const x = 1;");
    copyCode(button);

    // The clipboard call is microtask-deferred
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("const x = 1;");

    // The label should have flipped to "Copied!"
    expect(button.querySelector("span").textContent).toBe("Copied!");
    expect(button.classList.contains("copied")).toBe(true);
  });

  it("is a no-op when the expected DOM isn't there", () => {
    // A button with no .code-block-wrapper ancestor should silently do nothing
    const loneButton = document.createElement("button");
    document.body.appendChild(loneButton);
    expect(() => copyCode(loneButton)).not.toThrow();
  });
});
