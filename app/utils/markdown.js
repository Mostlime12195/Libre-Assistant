import MarkdownIt from "markdown-it";
import markdownItFootnote from "markdown-it-footnote";
import markdownItTaskLists from "markdown-it-task-lists";
import markdownItTexmath from "markdown-it-texmath";
import katex from "katex";
import hljs from "highlight.js";

// Shared fence renderer for code blocks
function addCodeBlockRenderer(md) {
  // Add custom fence rule for code blocks
  const defaultFence =
    md.renderer.rules.fence ||
    function (tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };

  md.renderer.rules.fence = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    const info = token.info ? md.utils.unescapeAll(token.info).trim() : "";
    const langName = info ? info.split(/\s+/g)[0] : "";

    // Handle code blocks
    const code = token.content;
    const lang = langName || "text";
    const langDisplay = lang;

    let highlightedCode;
    if (lang && hljs.getLanguage(lang)) {
      try {
        highlightedCode = hljs.highlight(code, {
          language: lang,
          ignoreIllegals: true,
        }).value;
      } catch (__) {
        highlightedCode = md.utils.escapeHtml(code);
      }
    } else {
      highlightedCode = md.utils.escapeHtml(code);
    }

    // Build HTML using template literals for better readability
    // For onclick handlers, we need to properly escape the language to prevent XSS and ensure proper execution
    const escapedLang = langDisplay.replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeLangClass = md.utils.escapeHtml(lang);

    return `<div class="code-block-wrapper">
  <div class="code-block-header">
    <span class="code-language">${langDisplay}</span>
    <div class="code-actions">
      <button class="code-action-button" onclick="window.downloadCode(event.currentTarget, '${escapedLang}')" title="Download file">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
          <path fill="currentColor" d="M12 15.575q-.2 0-.375-.062T11.3 15.3l-3.6-3.6q-.3-.3-.288-.7t.288-.7q.3-.3.713-.312t.712.287L11 12.15V5q0-.425.288-.712T12 4t.713.288T13 5v7.15l1.875-1.875q.3-.3.713-.288t.712.313q.275.3.288.7t-.288.7l-3.6 3.6q-.15.15-.325.213t-.375.062M6 20q-.825 0-1.412-.587T4 18v-2q0-.425.288-.712T5 15t.713.288T6 16v2h12v-2q0-.425.288-.712T19 15t.713.288T20 16v2q0 .825-.587 1.413T18 20z" stroke-width="0.1" stroke="currentColor" />
        </svg>
        <span>Download</span>
      </button>
      <button class="code-action-button" onclick="window.copyCode(event.currentTarget)" title="Copy code">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
          <path fill="currentColor" stroke-width="0.1" d="M9 18q-.825 0-1.412-.587T7 16V4q0-.825.588-1.412T9 2h9q.825 0 1.413.588T20 4v12q0 .825-.587 1.413T18 18zm0-2h9V4H9zm-4 6q-.825 0-1.412-.587T3 20V7q0-.425.288-.712T4 6t.713.288T5 7v13h10q.425 0 .713.288T16 21t-.288.713T15 22zm4-6V4z" />
        </svg>
        <span>Copy</span>
      </button>
    </div>
  </div>
  <pre><code class="hljs ${safeLangClass}">${highlightedCode}</code></pre>
</div>`;
  };
}


// Create a shared markdown-it instance
const createMarkdownInstance = () => {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    highlight: function (str, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(str, { language: lang }).value;
        } catch (__) {}
      }
      return "";
    },
  })
    .use(markdownItFootnote)
    .use(markdownItTaskLists, {
      enabled: false,
      label: true,
      bulletMarker: "-",
    });

  return md;
};

// Create instances for each component type
const chatPanelMd = createMarkdownInstance();
const streamingMessageMd = createMarkdownInstance();

// Add shared code block renderer to both instances
addCodeBlockRenderer(chatPanelMd);
addCodeBlockRenderer(streamingMessageMd);

// Add texmath only to chatPanel instance with support for both dollar signs and brackets
chatPanelMd.use(markdownItTexmath, {
  engine: katex,
  delimiters: ["dollars", "brackets"],
  katexOptions: {
    throwOnError: false,
    errorColor: " #cc0000",
  },
});

export { chatPanelMd, streamingMessageMd };