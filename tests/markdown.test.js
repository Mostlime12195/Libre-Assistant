/**
 * Tests for app/utils/markdown.js
 */

import { describe, it, expect } from "vitest";
import { createMarkdownInstance, md } from "../app/utils/markdown.js";

describe("createMarkdownInstance", () => {
  it("returns a working markdown-it instance", () => {
    const instance = createMarkdownInstance();
    const html = instance.render("# Hello");
    expect(html).toContain("<h1>");
    expect(html).toContain("Hello");
  });

  it("renders paragraphs and emphasis", () => {
    const instance = createMarkdownInstance();
    const html = instance.render("Hello *world* and **everyone**.");
    expect(html).toContain("<em>world</em>");
    expect(html).toContain("<strong>everyone</strong>");
  });

  it("autolinks URLs (linkify enabled)", () => {
    const instance = createMarkdownInstance();
    const html = instance.render("Visit https://example.com today.");
    expect(html).toContain('href="https://example.com"');
  });

  it("renders unordered lists", () => {
    const instance = createMarkdownInstance();
    const html = instance.render("- a\n- b\n- c");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>a</li>");
    expect(html).toContain("<li>c</li>");
  });

  it("renders code blocks with the project's custom wrapper", () => {
    const instance = createMarkdownInstance();
    const html = instance.render("```js\nconst x = 1;\n```");
    expect(html).toContain("code-block-wrapper");
    expect(html).toContain("data-needs-highlight");
    expect(html).toContain("code-action-button");
  });

  it("escapes HTML in code blocks (XSS protection)", () => {
    const instance = createMarkdownInstance();
    // A <script> tag inside a fenced code block must NOT survive as live HTML
    const html = instance.render("```\n<script>alert(1)</script>\n```");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("honors disabling KaTeX", () => {
    const instance = createMarkdownInstance({ enableKatex: false });
    const html = instance.render("Inline $x=1$ math");
    expect(html).not.toMatch(/class="katex"/);
  });

  it("honors disabling footnotes", () => {
    const instance = createMarkdownInstance({ enableFootnotes: false });
    expect(() => instance.render("text[^1]\n\n[^1]: note")).not.toThrow();
  });
});

describe("default md singleton", () => {
  it("is a usable markdown-it instance", () => {
    expect(md).toBeDefined();
    expect(typeof md.render).toBe("function");
    const html = md.render("# title");
    expect(html).toContain("<h1>title</h1>");
  });
});
