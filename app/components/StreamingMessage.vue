<template>
  <div class="markdown-content streaming-message-wrapper">
    <!-- Static container for completed elements - uses display:contents so children appear as direct children of wrapper -->
    <div ref="staticContainer" class="streaming-content-container"></div>

    <!-- Streaming container for current element being rendered -->
    <div ref="streamingContainer" class="streaming-content-container"></div>
  </div>
</template>

<script setup>
import { ref, watch, onBeforeUnmount, nextTick } from 'vue';
import { streamingMessageMd as md } from '../utils/markdown';
import { copyCode, downloadCode } from '../utils/codeBlockUtils';
import hljs from 'highlight.js';

// props
const props = defineProps({
  content: { type: String, default: '' },
  isComplete: { type: Boolean, default: false },
  executedTools: { type: Array, default: () => [] }
});

const emit = defineEmits(['complete', 'start']);

// DOM refs (match your template)
const staticContainer = ref(null);
const streamingContainer = ref(null);


// markdown-it instance + plugins with highlighting
// Using shared instance from utils/markdown.js

// Internal state
let appendedBlockCount = 0;   // how many complete blocks we've appended to static container
let tailMarkdown = '';        // the current tail (not-yet-moved text)
let prevContent = '';         // last seen prop content string
let lastRenderKey = '';       // avoid redundant streaming innerHTML writes
let hasEmittedStart = false;  // track if we've emitted the start event

// Make sure global functions are available
window.copyCode = copyCode;
window.downloadCode = downloadCode;

// --- Utilities ---

// Simple block split on blank lines (original approach)
function splitIntoBlocks(markdown) {
  if (!markdown) return [''];
  return markdown.split(/\n{2,}/).map(s => s === undefined ? '' : s);
}

// Render block to HTML
function renderBlockHtml(mdText) {
  if (!mdText || mdText.trim().length === 0) return '';

  // Render markdown normally during streaming
  const html = md.render(mdText || '');

  // Create a temporary div to hold the HTML
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;

  // Return the processed HTML
  return tempDiv.innerHTML;
}

// Append DOM element directly to static container
function appendElementToStatic() {
  if (!staticContainer.value || !streamingContainer.value) {
    return;
  }

  // Move all children from streaming container to static container
  while (streamingContainer.value.firstChild) {
    staticContainer.value.appendChild(streamingContainer.value.firstChild);
  }
}

// Replace streaming container content (avoid churn when identical)
function setStreamingHtml(html) {
  if (!streamingContainer.value) return;
  if (lastRenderKey === html) {
    return;
  }
  lastRenderKey = html;

  // Set the streaming container with the HTML
  streamingContainer.value.innerHTML = html || '';
}

// Flush entire message into static container (used on complete)
function finalizeAll(fullText) {
  if (!staticContainer.value) return;

  // Clear containers to prevent duplication
  staticContainer.value.innerHTML = '';
  if (streamingContainer.value) {
    streamingContainer.value.innerHTML = '';
  }

  // Render the full content
  const fullHtml = md.render(fullText || '');

  // Set the streaming container with the full HTML
  setStreamingHtml(fullHtml);
  appendElementToStatic();

  tailMarkdown = '';
  appendedBlockCount = 0;
  lastRenderKey = '';
  prevContent = fullText || '';
}

// Process appended suffix only (keeps streaming live)
function processAppendedSuffix(suffix) {
  if (!suffix || suffix.length === 0) {
    // no-op but still keep streaming block rendered
    const blocks = splitIntoBlocks(tailMarkdown);
    const streamingBlock = blocks.length ? blocks[blocks.length - 1] : '';
    setStreamingHtml(renderBlockHtml(streamingBlock));
    return;
  }

  // Append suffix to tail buffer
  const previousTail = tailMarkdown;
  tailMarkdown = tailMarkdown ? (tailMarkdown + suffix) : suffix;

  // Split blocks in tail; any block except last is "complete"
  const blocks = splitIntoBlocks(tailMarkdown);
  const completeBlocks = blocks.length > 1 ? blocks.slice(0, blocks.length - 1) : [];

  // Only append complete blocks that are actually new
  // Compare with what we had before to avoid duplication
  const previousBlocks = splitIntoBlocks(previousTail);
  const previousCompleteCount = previousBlocks.length > 1 ? previousBlocks.length - 1 : 0;

  // Append any newly-complete blocks (only the actually new ones)
  if (completeBlocks.length > previousCompleteCount) {
    // Accumulate all newly-complete blocks in the streaming container
    let accumulatedHtml = '';
    for (let i = previousCompleteCount; i < completeBlocks.length; i++) {
      const html = renderBlockHtml(completeBlocks[i]);
      if (html) {
        accumulatedHtml += html;
      }
    }

    // Set the streaming container with all accumulated HTML and then move it to static container
    if (accumulatedHtml) {
      setStreamingHtml(accumulatedHtml);
      appendElementToStatic();
    }

    appendedBlockCount = completeBlocks.length;
  }

  // streaming block is last block in tail (or empty)
  const streamingBlock = blocks.length ? blocks[blocks.length - 1] : '';
  const streamingHtml = renderBlockHtml(streamingBlock);
  setStreamingHtml(streamingHtml);
}

// Fallback when new content is not a simple append (replace/rewind)
function handleNonPrefixReplace(newContent, isComplete) {
  if (isComplete) {
    finalizeAll(newContent);
    prevContent = newContent || '';
    return;
  }

  // Non-prefix change: conservative reset & re-render
  if (staticContainer.value) staticContainer.value.innerHTML = '';
  appendedBlockCount = 0;
  tailMarkdown = '';
  lastRenderKey = '';  // Reset lastRenderKey as well
  prevContent = '';    // Reset prevContent to avoid confusion

  const blocks = splitIntoBlocks(newContent || '');
  const completeBlocks = blocks.length > 1 ? blocks.slice(0, blocks.length - 1) : [];

  // Accumulate all complete blocks
  let accumulatedHtml = '';
  for (let i = 0; i < completeBlocks.length; i++) {
    const html = renderBlockHtml(completeBlocks[i]);
    if (html) {
      accumulatedHtml += html;
    }
    appendedBlockCount++;
  }

  // Set the streaming container with all accumulated HTML and then move it to static container
  if (accumulatedHtml) {
    setStreamingHtml(accumulatedHtml);
    appendElementToStatic();
  }
  tailMarkdown = blocks.length ? blocks[blocks.length - 1] : '';
  setStreamingHtml(renderBlockHtml(tailMarkdown));

  // Update prevContent to current content
  prevContent = newContent || '';
}

// Main logic executed immediately on prop change (no debounce)
function processContentNow(newContent, isComplete) {
  newContent = newContent || '';

  // If there was no previous content, treat as fresh and reset message instance
  if (!prevContent) {
    // Emit start event when streaming begins
    if (!hasEmittedStart) {
      emit('start');
      hasEmittedStart = true;
    }

    // Init: split into blocks and render
    handleNonPrefixReplace(newContent, false);
    prevContent = newContent;
    return;
  }

  // If marked complete, finalize entire content
  if (isComplete) {
    finalizeAll(newContent);
    prevContent = newContent;

    // Emit event to notify parent that message is complete
    emit('complete');

    return;
  }

  // Fast check: is this an append (prevContent is prefix of newContent)?
  if (newContent.startsWith(prevContent)) {
    const suffix = newContent.slice(prevContent.length);
    processAppendedSuffix(suffix);
    prevContent = newContent;
    return;
  }

  // Check if this is actually a rewind/replacement case
  // Only do full replacement if content is significantly different
  if (!newContent.startsWith(prevContent.substring(0, Math.min(prevContent.length, newContent.length)))) {
    // Otherwise, fallback to conservative replace handling
    handleNonPrefixReplace(newContent, isComplete);
    return;
  }

  // For minor changes that aren't simple appends, still treat as append with empty suffix
  // This handles cases where whitespace or formatting might have changed
  processAppendedSuffix('');
  prevContent = newContent;
}

// Watch props and run immediately (no debounce)
watch(
  () => [props.content, props.isComplete],
  ([newContent, isComplete]) => {
    // Reset the start flag when content is cleared or reset
    if (!newContent || newContent.length < prevContent.length) {
      hasEmittedStart = false;
    }

    processContentNow(newContent || '', isComplete);
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  // nothing to clean up here
});
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

/* Note: .markdown-content styles are in code-blocks.css */
</style>