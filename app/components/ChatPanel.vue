<script setup>
import { onMounted, onUnmounted, ref, watch, nextTick, computed, reactive } from "vue";
import { Icon } from "@iconify/vue";
import { chatPanelMd as md } from '../utils/markdown';
import { copyCode, downloadCode } from '../utils/codeBlockUtils';
import StreamingMessage from './StreamingMessage.vue';
import LoadingSpinner from './LoadingSpinner.vue';
import { getFormattedStatsFromExecutedTools } from '../composables/searchViewStats';

// Initialize markdown-it with plugins (without markdown-it-katex)
// Using shared instance from utils/markdown.js

const props = defineProps({
  currConvo: {
    type: [String, Number, Object],
    default: null
  },
  currMessages: {
    type: Array,
    default: () => []
  },
  isLoading: {
    type: Boolean,
    default: false
  },
  conversationTitle: {
    type: String,
    default: ''
  },
  showWelcome: {
    type: Boolean,
    default: false
  },
  isDark: {
    type: Boolean,
    default: false
  },
  isIncognito: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(["send-message", "set-message", "scroll"]);

// Helper function to calculate message stats
function calculateMessageStats(message) {
  const stats = {};
  
  // Calculate delay (time from API call to first token)
  if (message.apiCallTime && message.firstTokenTime) {
    stats.delay = message.firstTokenTime.getTime() - message.apiCallTime.getTime();
  }
  
  // Token count
  if (message.tokenCount !== undefined) {
    stats.tokenCount = message.tokenCount;
  }
  
  // Calculate tokens per second
  if (message.tokenCount > 0 && message.firstTokenTime && message.completionTime) {
    const generationTimeMs = message.completionTime.getTime() - message.firstTokenTime.getTime();
    if (generationTimeMs > 0) {
      stats.tokensPerSecond = (message.tokenCount / generationTimeMs) * 1000;
    }
  }
  
  // Calculate total generation time (from first token to completion)
  if (message.firstTokenTime && message.completionTime) {
    stats.generationTime = message.completionTime.getTime() - message.firstTokenTime.getTime();
  }
  
  return stats;
}

// Format stats for display
function formatStatValue(value, type) {
  if (value === undefined || value === null) return null;
  
  switch (type) {
    case 'delay':
      // Format time in ms or seconds with 'wait' suffix
      return value < 1000 ? `${Math.round(value)}ms wait` : `${(value / 1000).toFixed(2)}s wait`;
    case 'generationTime':
      // Format time in ms or seconds with 'gen' suffix
      return value < 1000 ? `${Math.round(value)}ms gen` : `${(value / 1000).toFixed(2)}s gen`;
    case 'tokenCount':
      return `${Math.round(value)} tok`;
    case 'tokensPerSecond':
      return `${Math.round(value)} tok/s`;
    default:
      return value;
  }
}

const liveReasoningTimers = reactive({});
const timerIntervals = {};
const messageLoadingStates = reactive({});

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const isAtBottom = ref(true);
const chatWrapper = ref(null);

const messages = computed(() => {
  if (!props.currMessages) return [];
  return props.currMessages;
});

// Function to get formatted message stats
function getMessageStats(message) {
  if (message.role !== 'assistant') return [];

  const stats = calculateMessageStats(message);
  const formattedStats = [];

  // Add delay if available
  if (stats.delay !== undefined) {
    formattedStats.push({
      value: formatStatValue(stats.delay, 'delay')
    });
  }

  // Add token count if available
  if (stats.tokenCount !== undefined) {
    formattedStats.push({
      value: formatStatValue(stats.tokenCount, 'tokenCount')
    });
  }

  // Add tokens per second if available
  if (stats.tokensPerSecond !== undefined) {
    formattedStats.push({
      value: formatStatValue(stats.tokensPerSecond, 'tokensPerSecond')
    });
  }

  // Add generation time if available
  if (stats.generationTime !== undefined) {
    formattedStats.push({
      value: formatStatValue(stats.generationTime, 'generationTime')
    });
  }

  return formattedStats;
}

const scrollToEnd = (behavior = "instant") => {
  // With the new layout, scrolling happens at the parent chat-column level
  // Need to find the correct scroll container by looking for overflow-y: auto
  let currentElement = chatWrapper.value?.parentElement;

  // Traverse up the DOM to find the actual scroll container
  while (currentElement && currentElement !== document.body) {
    const computedStyle = window.getComputedStyle(currentElement);
    if (computedStyle.overflowY === 'auto' || computedStyle.overflowY === 'scroll') {
      // Found the scroll container
      currentElement.scrollTo({
        top: currentElement.scrollHeight,
        behavior,
      });
      return;
    }
    currentElement = currentElement.parentElement;
  }

  // Fallback to local scroll if no scroll container found
  if (chatWrapper.value) {
    chatWrapper.value.scrollTo({
      top: chatWrapper.value.scrollHeight,
      behavior,
    });
  }
};

const handleScroll = () => {
  // With new layout structure, the main scrolling container could be higher up
  let currentElement = chatWrapper.value?.parentElement;

  // Traverse up the DOM to find the actual scroll container
  while (currentElement && currentElement !== document.body) {
    const computedStyle = window.getComputedStyle(currentElement);
    if (computedStyle.overflowY === 'auto' || computedStyle.overflowY === 'scroll') {
      // Found the scroll container, use its state
      const atBottom = Math.abs(
        currentElement.scrollHeight -
        currentElement.scrollTop -
        currentElement.clientHeight
      ) < 10;

      isAtBottom.value = atBottom;

      const isAtTop = currentElement.scrollTop === 0;
      emit('scroll', { isAtTop });
      return; // Exit after handling the correct container
    }
    currentElement = currentElement.parentElement;
  }

  // Fallback for local scroll if no scroll container found
  if (chatWrapper.value) {
    const atBottom = Math.abs(
      chatWrapper.value.scrollHeight -
      chatWrapper.value.scrollTop -
      chatWrapper.value.clientHeight
    ) < 10;
    isAtBottom.value = atBottom;

    const isAtTop = chatWrapper.value.scrollTop === 0;
    emit('scroll', { isAtTop });
  }
};

watch(
  messages,
  (newMessages) => {
    if (isAtBottom.value) {
      nextTick(() => scrollToEnd("instant"));
    }

    newMessages.forEach((msg) => {
      if (timerIntervals[msg.id]) {
        clearInterval(timerIntervals[msg.id]);
        delete timerIntervals[msg.id];
      }

      // Handle loading states for assistant messages
      if (msg.role === 'assistant') {
        // Show loading spinner for new messages that are not complete and have no content
        if (!msg.complete && (!msg.content || msg.content.length === 0)) {
          if (messageLoadingStates[msg.id] !== true) {
            messageLoadingStates[msg.id] = true;
          }
        }
        // Hide loading spinner as soon as the message has content (streaming started) or is complete
        else if ((msg.content && msg.content.length > 0) || msg.complete) {
          if (messageLoadingStates[msg.id] !== false) {
            messageLoadingStates[msg.id] = false;
          }
        }
      }

      if (msg.role === "assistant" && msg.reasoning) {
        if (msg.complete) {
          if (msg.reasoningDuration) {
            liveReasoningTimers[msg.id] =
              `Thought for ${formatDuration(msg.reasoningDuration)}`;
          }
          else if (msg.reasoningStartTime && msg.reasoningEndTime) {
            const duration =
              msg.reasoningEndTime.getTime() - msg.reasoningStartTime.getTime();
            liveReasoningTimers[msg.id] =
              `Thought for ${formatDuration(duration)}`;
          }
          else if (msg.reasoningStartTime) {
            liveReasoningTimers[msg.id] = "Thought for a moment";
          }
          return;
        }

        if (!timerIntervals[msg.id]) {
          const startTime = msg.reasoningStartTime || new Date();
          timerIntervals[msg.id] = setInterval(() => {
            const elapsed = new Date().getTime() - startTime.getTime();
            liveReasoningTimers[msg.id] =
              `Thinking for ${formatDuration(elapsed)}...`;
          }, 100);
        }
      }
    });

    const currentMessageIds = newMessages.map((msg) => msg.id);
    Object.keys(timerIntervals).forEach((timerId) => {
      if (!currentMessageIds.includes(timerId)) {
        clearInterval(timerIntervals[timerId]);
        delete timerIntervals[timerId];
        delete liveReasoningTimers[timerId];
      }
    });

    // Clean up loading states for removed messages
    Object.keys(messageLoadingStates).forEach((msgId) => {
      if (!currentMessageIds.includes(msgId)) {
        delete messageLoadingStates[msgId];
      }
    });
  },
  { deep: true, immediate: true },
);

watch(
  () => props.currConvo,
  (newConvo, oldConvo) => {
    if (newConvo && newConvo !== oldConvo) {
      nextTick(() => {
        requestAnimationFrame(() => {
          scrollToEnd("instant");
        });
      });
    }
  }
);

let mainScrollContainer = null;
let scrollListener = null;
let attachedToDocument = false; // Track if we attached to document
let attachedToWindow = false;   // Track if we attached to window

onMounted(() => {
  nextTick(() => scrollToEnd("instant"));

  // Find the main scroll container and attach a scroll listener
  // According to your feedback, the actual scrolling container has class 'chat-section'
  // which should be the parent of the 'chat-column' that is the parent of chatWrapper
  let currentElement = chatWrapper.value?.parentElement; // This is 'chat-column'
  if (currentElement) {
    currentElement = currentElement.parentElement; // This should be 'chat-section'
  }

  if (currentElement && currentElement.classList.contains('chat-section')) {
    mainScrollContainer = currentElement;
    scrollListener = () => {
      handleScroll();
    };
    mainScrollContainer.addEventListener('scroll', scrollListener, { passive: true });
    // Trigger initial scroll check
    handleScroll();
    attachedToDocument = false; // Not attached to document
    attachedToWindow = false; // Not attached to window
  } else {
    // Fallback: find by overflow style, starting from the chat-column
    let searchElement = chatWrapper.value?.parentElement?.parentElement; // Start from chat-section level
    let level = 0;
    let foundScrollContainer = false;

    while (searchElement && searchElement !== document.body && level < 10) {
      const computedStyle = window.getComputedStyle(searchElement);

      if (computedStyle.overflowY === 'auto' || computedStyle.overflowY === 'scroll') {
        mainScrollContainer = searchElement;
        scrollListener = () => {
          handleScroll();
        };
        mainScrollContainer.addEventListener('scroll', scrollListener, { passive: true });
        // Trigger initial scroll check
        handleScroll();
        attachedToDocument = false; // Not attached to document
        attachedToWindow = false; // Not attached to window
        foundScrollContainer = true;
        break;
      }
      searchElement = searchElement.parentElement;
      level++;
    }

    if (!foundScrollContainer) {
      // Last resort: listen to document scroll
      scrollListener = () => handleScroll();
      document.addEventListener('scroll', scrollListener, { passive: true });
      attachedToDocument = true; // Mark that we attached to document
      attachedToWindow = false; // Not attached to window
    }
  }

  // Make functions available globally (only in browser)
  if (typeof window !== 'undefined') {
    window.copyCode = copyCode;
    window.downloadCode = downloadCode;
  }
});

onUnmounted(() => {
  // Clean up scroll listener based on where it was attached
  if (mainScrollContainer && scrollListener && !attachedToDocument && !attachedToWindow) {
    mainScrollContainer.removeEventListener('scroll', scrollListener);
  } else if (attachedToDocument && scrollListener) {
    document.removeEventListener('scroll', scrollListener);
  } else if (attachedToWindow && scrollListener) {
    window.removeEventListener('scroll', scrollListener);
  }

  // Clean up all timers
  Object.values(timerIntervals).forEach(timer => {
    clearInterval(timer);
  });
});

// Render message content with markdown
function renderMessageContent(content, executedTools) {
  // Render Markdown
  return md.render(content || '');
}



const renderReasoningContent = (content) => {
  // First render Markdown
  let html = md.render(content || '');

  // For reasoning content, we need to handle processing in a controlled way
  // This will be handled by the watch function that monitors message updates

  return html;
};

// Function to handle when streaming message starts
function onStreamingMessageStart(messageId) {
  // We don't need to change the loading state here since it's already handled by the watcher
}

// Function to handle when a streaming message is complete
function onStreamingMessageComplete(messageId) {
  // Set loading state to false when streaming is complete
  if (messageLoadingStates[messageId] !== false) {
    messageLoadingStates[messageId] = false;
  }
}

// Function to get formatted search/view statistics string for display
function getFormattedStatsForDisplay(messageId) {
  const message = messages.value.find(m => m.id === messageId);
  if (!message) {
    return '';
  }

  return getFormattedStatsFromExecutedTools(message.executed_tools || []);
}

// Function to check if message has memory tool calls
function hasMemoryToolCalls(message) {
  if (!message.tool_calls || !Array.isArray(message.tool_calls)) {
    return false;
  }

  // Check if any of the tool calls are memory-related
  return message.tool_calls.some(toolCall => {
    const functionName = toolCall.function?.name;
    return functionName === 'addMemory' || functionName === 'modifyMemory' || functionName === 'deleteMemory';
  });
}

// Function to copy message content
function copyMessage(content, event) {
  const button = event.currentTarget;

  navigator.clipboard.writeText(content).then(() => {
    // Visual feedback - temporarily change button to success state
    button.classList.add('copied');

    setTimeout(() => {
      button.classList.remove('copied');
    }, 2000);
  }).catch(err => {
    console.error('Failed to copy message:', err);
    // Visual feedback for error - could add error styling here
  });
}

defineExpose({ scrollToEnd, isAtBottom, chatWrapper });
</script>

<template>
  <div class="chat-wrapper" ref="chatWrapper">
    <div class="chat-container">
      <div v-if="messages.length < 1 && showWelcome" class="welcome-container">
        <h1 v-if="!isIncognito" class="welcome-message">What do you need help with?</h1>
        <div v-else class="incognito-welcome">
          <h1 class="incognito-title">Incognito Mode</h1>
          <p class="incognito-description">
            This chat won't be stored and will not use Libre's memory or personalization features.
          </p>
        </div>
      </div>
      <div class="messages-layer">
        <template v-for="message in messages" :key="message.id">
          <div class="message" :class="message.role" :data-message-id="message.id">
            <div class="message-content">
              <!-- Search and view statistics display -->
              <div v-if="message.role === 'assistant' && getFormattedStatsForDisplay(message.id)" 
                   class="search-view-stats">
                {{ getFormattedStatsForDisplay(message.id) }}
              </div>
              
              <!-- Display notification if message has memory tool calls -->
              <div v-if="hasMemoryToolCalls(message)" class="memory-adjustment-notification">
                Adjusted saved memories
              </div>

              <details v-if="message.role === 'assistant' && message.reasoning" class="reasoning-details">
                <summary class="reasoning-summary">
                  <span class="reasoning-toggle-icon">
                    <Icon icon="material-symbols:keyboard-arrow-down-rounded" width="24" height="24" />
                  </span>
                  <span class="reasoning-text">
                    <span v-if="liveReasoningTimers[message.id]">{{
                      liveReasoningTimers[message.id]
                      }}</span>
                    <span v-else-if="message.reasoningDuration > 0">Thought for
                      {{ formatDuration(message.reasoningDuration) }}</span>
                    <span v-else-if="
                      message.reasoningStartTime && message.reasoningEndTime
                    ">Thought for a moment</span>
                    <span v-else-if="message.reasoning && message.complete">Thought for a moment</span>
                    <span v-else>Reasoning</span>
                  </span>
                </summary>
                <div class="reasoning-content-wrapper">
                  <div class="reasoning-content markdown-content" v-html="renderReasoningContent(message.reasoning)">
                  </div>
                </div>
              </details>

              <div class="bubble">
                <div v-if="message.role == 'user'">{{ message.content }}</div>
                <div v-else-if="message.complete" class="markdown-content"
                  v-html="renderMessageContent(message.content, message.executed_tools || [])"></div>
                <div v-else>
                  <div v-if="messageLoadingStates[message.id]" class="loading-animation">
                    <LoadingSpinner />
                  </div>
                  <StreamingMessage :content="message.content" :is-complete="message.complete"
                    :executed-tools="message.executed_tools || []" @complete="onStreamingMessageComplete(message.id)"
                    @start="onStreamingMessageStart(message.id)" />
                </div>
              </div>
              <div class="message-content-footer" :class="{ 'user-footer': message.role === 'user' }">
                <button class="copy-button" @click="copyMessage(message.content, $event)" :title="'Copy message'"
                  aria-label="Copy message">
                  <Icon icon="material-symbols:content-copy-outline-rounded" width="32px" height="32px" />
                </button>
                <div v-if="message.role === 'assistant'" class="message-stats-row">
                  <span v-for="(stat, index) in getMessageStats(message)" :key="index" class="stat-item">
                    <span v-if="stat.value" class="stat-value">{{ stat.value }}</span>
                    <span v-if="stat.value && index < getMessageStats(message).length - 1" class="stat-separator"> • </span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style>
.chat-wrapper {
  --bubble-user-bg: var(--primary);
  --bubble-user-text: var(--primary-foreground);
  --text-primary-light: var(--text-primary);
  --text-secondary-light: var(--text-secondary);
  --text-primary-dark: var(--text-primary);
  --text-secondary-dark: var(--text-secondary);
  --reasoning-border-light: var(--border);
  --reasoning-border-dark: var(--border);
  flex: 1;
  position: relative;
  width: 100%;
  box-sizing: border-box;
}

.chat-container {
  width: 100%;
  max-width: 800px;
  margin: 0 auto;
  padding: 12px;
  box-sizing: border-box;
  position: relative;
  transition: all 0.3s cubic-bezier(.4, 1, .6, 1);
  padding-bottom: 100px;
}

.welcome-container {
  text-align: center;
  margin: calc(1rem + 10vh) 0;
  width: 100%;
  max-width: 800px;
  margin-left: auto;
  margin-right: auto;
}

.welcome-message {
  font-size: 2.5rem;
  font-weight: 700;
  color: var(--text-primary-light);
  margin: 0;
}

.dark .welcome-message {
  color: var(--text-primary-dark);
}

.incognito-title {
  font-size: 2.5rem;
  font-weight: 700;
  color: var(--text-primary-light);
  margin: 0 0 1rem 0;
}

.dark .incognito-title {
  color: var(--text-primary-dark);
}

.incognito-description {
  font-size: 1.1rem;
  color: var(--text-secondary-light);
  margin: 0;
  line-height: 1.6;
}

.dark .incognito-description {
  color: var(--text-secondary-dark);
}

.message {
  display: block;
  width: 100%;
  max-width: 800px;
  margin: 0 auto;
  position: relative;
  transition: all 0.3s cubic-bezier(.4, 1, .6, 1);
}

.message.user {
  justify-content: flex-end;
  display: flex;
  width: 100%;
}

.message-content {
  max-width: 100%;
  display: flex;
  flex-direction: column;
  width: 100%;
  transition: all 0.3s cubic-bezier(.4, 1, .6, 1);
}

.message.user .message-content {
  align-items: flex-end;
  max-width: 85%;
  width: 100%;
  display: flex;
  flex-direction: column;
}

.bubble {
  display: block;
  padding: 12px 16px;
  border-radius: 18px;
  line-height: 1.5;
  font-size: 1rem;
  width: 100%;
  transition: all 0.3s cubic-bezier(.4, 1, .6, 1);
}

.message.user .bubble {
  background: var(--bubble-user-bg);
  color: var(--bubble-user-text);
  white-space: pre-wrap;
  border-bottom-right-radius: 4px;
  margin-left: auto;
  max-width: calc(800px * 0.85);
  width: fit-content;
  transition: all 0.3s cubic-bezier(.4, 1, .6, 1);
  text-align: left;
  /* Ensure text alignment within the bubble */
}

.message.assistant .bubble {
  padding: 0;
  color: var(--text-primary-light);
  width: 100%;
  max-width: 800px;
  margin: 0 auto;
  transition: all 0.3s cubic-bezier(.4, 1, .6, 1);
}

.dark .message.assistant .bubble {
  color: var(--text-primary-dark);
}

.reasoning-details {
  background: none;
  border: none;
  padding: 0;
  margin-bottom: 0.75rem;
  order: -1;
  width: 100%;
  max-width: 800px;
  margin: 0 auto 0.75rem auto;
  transition: all 0.3s cubic-bezier(.4, 1, .6, 1);
}

.reasoning-summary {
  list-style: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--text-secondary-light);
  font-size: 0.9em;
  font-weight: 500;
  margin-bottom: 0.5rem;
  user-select: none;
}

.dark .reasoning-summary {
  color: var(--text-secondary-dark);
}

.reasoning-summary::-webkit-details-marker {
  display: none;
}

.reasoning-toggle-icon {
  transition: transform 0.2s ease-in-out;
  display: flex;
  align-items: center;
  margin-left: -10px;
  transform: rotate(-90deg);
}

.reasoning-details[open] .reasoning-toggle-icon {
  transform: rotate(0deg);
}

.reasoning-content-wrapper {
  padding-left: 1.25rem;
  border-left: 2px solid var(--reasoning-border-light);
}

.dark .reasoning-content-wrapper {
  border-left-color: var(--reasoning-border-dark);
}

.reasoning-content {
  color: var(--text-secondary-light);
}

.dark .reasoning-content {
  color: var(--text-secondary-dark);
}

.reasoning-details:not([open]) .reasoning-content-wrapper {
  display: none;
}

/* Note: .markdown-content base styles are now in code-blocks.css */

.copy-button-container {
  margin-top: 8px;
  opacity: 0;
  transition: opacity 0.2s ease-in-out;
}

.message:hover .copy-button-container {
  opacity: 1;
}

.copy-button-container.user-copy-container {
  display: flex;
  justify-content: flex-end;
}

.copy-button {
  background: transparent;
  border: none;
  border-radius: 8px;
  width: 36px;
  height: 36px;
  padding: 6px;
  cursor: pointer;
  transition: all 0.2s ease-in-out;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

.copy-button:hover {
  background: var(--btn-hover);
  color: var(--text-primary);
}

.copy-button.copied {
  color: var(--success) !important;
}

.message-content-footer {
  display: flex;
  align-items: center;
  margin-top: 8px;
  opacity: 0;
  transition: opacity 0.2s ease-in-out;
}

.message:hover .message-content-footer {
  opacity: 0.7;
}

.message-content-footer:hover {
  opacity: 1 !important;
}

.user-footer {
  justify-content: flex-end;
}

.message-stats-row {
  display: flex;
  align-items: center;
  font-size: 0.75rem;
  color: var(--text-secondary-light);
  margin-left: 8px;
  user-select: none;
}

.dark .message-stats-row {
  color: var(--text-secondary-dark);
}

.stat-item {
  display: flex;
  align-items: center;
}

.stat-value {
  white-space: nowrap;
}

.stat-separator {
  margin: 0 4px;
  color: var(--text-secondary-light);
}

.dark .stat-separator {
  color: var(--text-secondary-dark);
}

.search-view-stats {
  display: inline-block;
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--text-secondary-light);
  background: linear-gradient(135deg, var(--bg-secondary), var(--bg-tertiary));
  padding: 6px 12px;
  border-radius: 20px;
  margin-bottom: 12px;
  margin-left: 0; /* Reset left margin to align with container */
  user-select: none; /* Prevent text selection */
  -webkit-user-select: none; /* Safari/Chrome */
  -moz-user-select: none; /* Firefox */
  -ms-user-select: none; /* IE/Edge */
  order: -2; /* Ensure it appears above reasoning details which has order: -1 */
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  border: 1px solid var(--border);
  width: fit-content;
}

.dark .search-view-stats {
  color: var(--text-secondary-dark);
  background: linear-gradient(135deg, var(--bg-secondary), var(--code-header-bg));
  border-color: var(--border);
}

.memory-adjustment-notification {
  display: inline-block;
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--text-secondary-light);
  padding: 6px 12px;
  border-radius: 20px;
  margin-bottom: 12px;
  margin-left: 0; /* Reset left margin to align with container */
  user-select: none; /* Prevent text selection */
  -webkit-user-select: none; /* Safari/Chrome */
  -moz-user-select: none; /* Firefox */
  -ms-user-select: none; /* IE/Edge */
  order: -3; /* Ensure it appears above other elements like reasoning details */
  border: 1px solid var(--border);
  width: fit-content;
  align-self: flex-start;
}

.loading-animation {
  display: flex;
  padding: 12px 16px;
  width: 100%;
  box-sizing: border-box;
  align-items: center;
}
</style>
