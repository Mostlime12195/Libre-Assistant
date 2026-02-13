<template>
  <div class="markdown-content streaming-message-wrapper">
    <!-- Static content (already complete blocks, append-only) -->
    <div ref="staticContainer" class="streaming-content-container"></div>

    <!-- Streaming content (current block being typed, driven by reactive ref) -->
    <div ref="streamingContainer" class="streaming-content-container" v-html="streamingHtml"></div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue';
import { md } from '../utils/markdown';
import { copyCode, downloadCode } from '../utils/codeBlockUtils';
import { highlightAllBlocks } from '../utils/lazyHighlight';

// Props
const props = defineProps({
  content: { type: String, default: '' },
  isComplete: { type: Boolean, default: false }
});

const emit = defineEmits(['complete', 'start']);

// DOM refs
const staticContainer = ref(null);
const streamingContainer = ref(null);

// Reactive HTML for the streaming container (Phase 3.1: Vue-idiomatic)
const streamingHtml = ref('');

// Internal state
let staticBlockCount = 0;
let tailMarkdown = '';
let prevContent = '';
let lastRenderKey = '';
let hasEmittedStart = false;
let lastCompleteBlockCount = 0;

// Make sure global functions are available
if (typeof window !== 'undefined') {
  window.copyCode = copyCode;
  window.downloadCode = downloadCode;
}

// --- Block Splitting ---

/**
 * Smart block splitting that respects fenced code blocks.
 * Prevents code blocks with blank lines from being prematurely split.
 */
function splitIntoBlocks(markdown) {
  if (!markdown) return [''];

  const lines = markdown.split('\n');
  const blocks = [];
  let currentBlock = [];
  let inCodeFence = false;
  let fenceChar = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check for fence start/end (``` or ~~~)
    const fenceMatch = trimmed.match(/^(```|~~~)/);
    if (fenceMatch) {
      if (!inCodeFence) {
        // Starting a code fence — finalize any current block first
        if (currentBlock.length > 0) {
          blocks.push(currentBlock.join('\n'));
          currentBlock = [];
        }
        inCodeFence = true;
        fenceChar = fenceMatch[1];
        currentBlock.push(line);
      } else if (trimmed.startsWith(fenceChar)) {
        // Ending a code fence
        currentBlock.push(line);
        blocks.push(currentBlock.join('\n'));
        currentBlock = [];
        inCodeFence = false;
        fenceChar = '';
      } else {
        currentBlock.push(line);
      }
    } else if (inCodeFence) {
      currentBlock.push(line);
    } else if (trimmed === '' && currentBlock.length > 0) {
      // Blank line outside code fence — potential block boundary
      const nextNonBlankIndex = lines.findIndex((l, idx) => idx > i && l.trim() !== '');
      const nextLine = nextNonBlankIndex !== -1 ? lines[nextNonBlankIndex] : null;

      // Patterns that typically start new blocks
      const blockStarters = /^#{1,6}\s|^>|^[-*+]\s|^\d+\.\s|^```|^~~~|^\|/;

      if (!nextLine || blockStarters.test(nextLine)) {
        blocks.push(currentBlock.join('\n'));
        currentBlock = [];
      } else {
        currentBlock.push(line);
      }
    } else {
      currentBlock.push(line);
    }
  }

  if (currentBlock.length > 0) {
    blocks.push(currentBlock.join('\n'));
  }

  return blocks.length ? blocks : [''];
}

// Render a block of markdown to HTML
function renderBlockHtml(mdText) {
  if (!mdText || mdText.trim().length === 0) return '';
  return md.render(mdText);
}

// --- Caret Management ---

/**
 * Find the deepest last element suitable for inline caret insertion.
 * Walks the DOM to find the actual text-containing element
 * (e.g., <p>, <li>, <code>, <h1>-<h6>, <td>, <span>) so the
 * caret appears inline with the text instead of on a new line.
 */
function findCaretInsertionPoint(container) {
  if (!container) return null;
  const children = container.children;
  if (children.length === 0) return container;

  const lastChild = children[children.length - 1];

  // Code blocks: insert inside the <code> element
  if (lastChild.classList?.contains('code-block-wrapper')) {
    const code = lastChild.querySelector('pre code');
    return code || lastChild;
  }

  // Lists: find the deepest content in the last <li>
  if (lastChild.tagName === 'UL' || lastChild.tagName === 'OL') {
    const lastLi = lastChild.querySelector('li:last-child');
    if (lastLi) {
      // If the li contains paragraphs, go into the last one
      const lastP = lastLi.querySelector('p:last-of-type');
      return lastP || lastLi;
    }
    return lastChild;
  }

  // Blockquotes: find the last paragraph inside
  if (lastChild.tagName === 'BLOCKQUOTE') {
    const lastP = lastChild.querySelector('p:last-of-type');
    return lastP || lastChild;
  }

  // Tables: find the last cell
  if (lastChild.tagName === 'TABLE') {
    const lastTd = lastChild.querySelector('tr:last-child td:last-child');
    return lastTd || lastChild;
  }

  // Paragraphs, headers, and other inline containers — return directly
  return lastChild;
}

/**
 * Add streaming caret inside the last content element of the streaming container.
 */
function addCaretToStreamingContainer() {
  if (!streamingContainer.value) return;

  // Remove any existing caret first
  removeCaretFromStreamingContainer();

  const insertionPoint = findCaretInsertionPoint(streamingContainer.value);
  if (!insertionPoint) return;

  const caret = document.createElement('span');
  caret.className = 'streaming-caret';
  insertionPoint.appendChild(caret);
}

/**
 * Remove streaming caret from the streaming container.
 */
function removeCaretFromStreamingContainer() {
  if (!streamingContainer.value) return;
  const existingCaret = streamingContainer.value.querySelector('.streaming-caret');
  if (existingCaret) {
    existingCaret.remove();
  }
}

// --- Spacing Stability ---

/**
 * Apply explicit margin classes to children.
 * Prevents margin flicker when :first-child/:last-child selectors shift
 * due to DOM node movement between containers.
 */
function applyMarginClasses(container) {
  if (!container) return;
  const children = container.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    child.classList.remove('first-block', 'last-block');
    if (i === 0) child.classList.add('first-block');
    if (i === children.length - 1) child.classList.add('last-block');
  }
}

// Move all DOM children from streaming to static container (append-only)
function flushToStatic() {
  if (!staticContainer.value || !streamingContainer.value) return;

  // Remove caret before flushing
  removeCaretFromStreamingContainer();

  while (streamingContainer.value.firstChild) {
    staticContainer.value.appendChild(streamingContainer.value.firstChild);
    staticBlockCount++;
  }

  nextTick(() => applyMarginClasses(staticContainer.value));
}

// Update the streaming reactive HTML (avoids redundant writes)
function setStreamingHtml(html, addCaret = false) {
  // If html hasn't changed and we're not adding/removing caret, skip
  if (lastRenderKey === html && !addCaret) return;
  
  lastRenderKey = html;
  streamingHtml.value = html || '';

  nextTick(() => {
    applyMarginClasses(streamingContainer.value);
    if (addCaret) {
      addCaretToStreamingContainer();
    } else {
      removeCaretFromStreamingContainer();
    }
  });
}

// Finalize: render full content into static container
function finalizeAll(fullText) {
  if (!staticContainer.value) return;

  // Remove caret since we're finalizing
  removeCaretFromStreamingContainer();

  // Clear everything
  staticContainer.value.innerHTML = '';
  staticBlockCount = 0;

  // Render full content via reactive binding, then flush to static
  const fullHtml = md.render(fullText || '');
  setStreamingHtml(fullHtml, false); // Don't add caret when finalizing

  // After Vue renders the streaming container, move nodes to static
  nextTick(() => {
    flushToStatic();

    // Reset state
    tailMarkdown = '';
    staticBlockCount = 0;
    lastCompleteBlockCount = 0;
    lastRenderKey = '';
    prevContent = fullText || '';
    streamingHtml.value = '';

    // Trigger immediate highlighting on completion
    nextTick(() => {
      if (staticContainer.value) {
        highlightAllBlocks(staticContainer.value);
      }
    });
  });
}

// --- Incremental Rendering ---

/**
 * Process appended suffix incrementally.
 * Only re-renders the current streaming block, not all accumulated blocks.
 */
function processAppendedSuffix(suffix) {
  if (!suffix || suffix.length === 0) {
    const blocks = splitIntoBlocks(tailMarkdown);
    const streamingBlock = blocks.length ? blocks[blocks.length - 1] : '';
    setStreamingHtml(renderBlockHtml(streamingBlock));
    return;
  }

  tailMarkdown = tailMarkdown ? (tailMarkdown + suffix) : suffix;

  const blocks = splitIntoBlocks(tailMarkdown);
  const completeBlocks = blocks.length > 1 ? blocks.slice(0, -1) : [];
  const streamingBlock = blocks.length ? blocks[blocks.length - 1] : '';

  // Only process newly-complete blocks
  if (completeBlocks.length > lastCompleteBlockCount) {
    const newBlocks = completeBlocks.slice(lastCompleteBlockCount);

    let accumulatedHtml = '';
    for (const block of newBlocks) {
      const html = renderBlockHtml(block);
      if (html) accumulatedHtml += html;
    }

    if (accumulatedHtml) {
      // Step 1: Set complete blocks and wait for flush
      setStreamingHtml(accumulatedHtml, false);
      nextTick(() => {
        flushToStatic();
        // Step 2: Set current streaming block after flush
        setStreamingHtml(renderBlockHtml(streamingBlock), true);
      });
    } else {
      setStreamingHtml(renderBlockHtml(streamingBlock), true);
    }

    lastCompleteBlockCount = completeBlocks.length;
  } else {
    // Regular update: just update the streaming block
    setStreamingHtml(renderBlockHtml(streamingBlock), true);
  }
}

// Handle non-prefix (rewind/replace) content changes
function handleNonPrefixReplace(newContent, isComplete) {
  if (isComplete) {
    finalizeAll(newContent);
    return;
  }

  // Conservative reset
  if (staticContainer.value) staticContainer.value.innerHTML = '';
  staticBlockCount = 0;
  lastCompleteBlockCount = 0;
  tailMarkdown = '';
  lastRenderKey = '';
  prevContent = '';

  const blocks = splitIntoBlocks(newContent || '');
  const completeBlocks = blocks.length > 1 ? blocks.slice(0, -1) : [];

  let accumulatedHtml = '';
  for (const block of completeBlocks) {
    const html = renderBlockHtml(block);
    if (html) accumulatedHtml += html;
  }

  if (accumulatedHtml) {
    setStreamingHtml(accumulatedHtml);
    nextTick(() => flushToStatic());
  }

  lastCompleteBlockCount = completeBlocks.length;
  tailMarkdown = blocks.length ? blocks[blocks.length - 1] : '';
  setStreamingHtml(renderBlockHtml(tailMarkdown), true);

  prevContent = newContent || '';
}

// Main processing function — called on every prop change
function processContentNow(newContent, isComplete) {
  newContent = newContent || '';

  // Fresh content — handle as initial render
  if (!prevContent) {
    if (!hasEmittedStart) {
      emit('start');
      hasEmittedStart = true;
    }
    handleNonPrefixReplace(newContent, false);
    prevContent = newContent;
    return;
  }

  // Complete — finalize
  if (isComplete) {
    finalizeAll(newContent);
    emit('complete');
    return;
  }

  // Fast path: simple append
  if (newContent.startsWith(prevContent)) {
    const suffix = newContent.slice(prevContent.length);
    processAppendedSuffix(suffix);
    prevContent = newContent;
    return;
  }

  // Rewind / replacement fallback
  const minLength = Math.min(prevContent.length, newContent.length);
  if (minLength === 0 || !newContent.startsWith(prevContent.substring(0, minLength))) {
    handleNonPrefixReplace(newContent, isComplete);
    return;
  }

  processAppendedSuffix('');
  prevContent = newContent;
}

// Watch props and process immediately
watch(
  () => [props.content, props.isComplete],
  ([newContent, isComplete]) => {
    if (!newContent || newContent.length < prevContent.length) {
      hasEmittedStart = false;
    }
    processContentNow(newContent || '', isComplete);
  },
  { immediate: true }
);
</script>

<style>
.streaming-message-wrapper {
  padding: 0;
}

/*
 * Use display:contents so children of these containers appear as direct children
 * of the .markdown-content wrapper for CSS selector purposes.
 * This makes :first-child/:last-child rules work across both containers.
 */
.streaming-content-container {
  display: contents;
}
</style>
