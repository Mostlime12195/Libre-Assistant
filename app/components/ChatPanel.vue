<script setup>
import { onMounted, onUnmounted, ref, watch, nextTick, computed, reactive } from "vue";
import { Icon } from "@iconify/vue";
import { chatPanelMd as md } from '../utils/markdown';
import { copyCode, downloadCode } from '../utils/codeBlockUtils';
import StreamingMessage from './StreamingMessage.vue';
import ChatWidget from './ChatWidget.vue';
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
  },
  branchInfo: {
    type: Map,
    default: () => new Map()
  }
});

const emit = defineEmits(["send-message", "set-message", "scroll", "edit-message", "regenerate-message", "navigate-branch"]);

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

// --- Branching Logic ---
const editingMessageId = ref(null);
const editContent = ref("");

function startEditing(message) {
  editingMessageId.value = message.id;
  editContent.value = message.content;
}

function cancelEditing() {
  editingMessageId.value = null;
  editContent.value = "";
}

function submitEdit(messageId) {
  if (editContent.value.trim() === "") return;
  emit("edit-message", messageId, editContent.value);
  editingMessageId.value = null;
}

function regenerateMessage(messageId) {
  emit("regenerate-message", messageId);
}

function navigateBranch(messageId, direction) {
  emit("navigate-branch", messageId, direction);
}

// Function to determine CSS classes for parts based on their position and adjacent parts
function getPartClass(partType, index, parts) {
  // Only apply special styling to reasoning and tool_group parts
  if (partType !== 'reasoning' && partType !== 'tool_group') {
    return '';
  }

  const partClasses = [];
  const previousPart = index > 0 ? parts[index - 1] : null;
  const nextPart = index < parts.length - 1 ? parts[index + 1] : null;

  // Add class if this is the first part or if the previous part is not reasoning/tool_group
  if (index === 0 || (previousPart && previousPart.type !== 'reasoning' && previousPart.type !== 'tool_group')) {
    partClasses.push('has-previous-content');
  }

  // Add class if this is the last part or if the next part is not reasoning/tool_group
  if (index === parts.length - 1 || (nextPart && nextPart.type !== 'reasoning' && nextPart.type !== 'tool_group')) {
    partClasses.push('has-next-content');
  }

  return partClasses.join(' ');
}

// Function to group adjacent reasoning and tool_group parts together
function getPartGroups(parts) {
  if (!parts || parts.length === 0) return [];

  const groups = [];
  let currentGroup = [];
  let currentGroupType = null; // 'mixed' for reasoning/tool_group, 'content' for content, 'image' for images

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    // Determine if this part should be grouped with the current group
    const isActionPart = (part.type === 'reasoning' || part.type === 'tool_group');
    const isContentPart = (part.type === 'content');
    const isImagePart = (part.type === 'image');

    // If this is an action part (reasoning/tool_group) and we're either starting or continuing an action group
    if (isActionPart) {
      if (currentGroupType !== 'mixed') {
        // Start a new mixed group if we were in a different type
        if (currentGroup.length > 0) {
          groups.push({ type: currentGroupType, parts: currentGroup });
        }
        currentGroup = [part];
        currentGroupType = 'mixed';
      } else {
        // Add to current mixed group
        currentGroup.push(part);
      }
    }
    // If this is a content part and we're either starting or continuing a content group
    else if (isContentPart) {
      if (currentGroupType !== 'content') {
        // Start a new content group if we were in a different type
        if (currentGroup.length > 0) {
          groups.push({ type: currentGroupType, parts: currentGroup });
        }
        currentGroup = [part];
        currentGroupType = 'content';
      } else {
        // Add to current content group
        currentGroup.push(part);
      }
    }
    // If this is an image part and we're either starting or continuing an image group
    else if (isImagePart) {
      if (currentGroupType !== 'image') {
        // Start a new image group if we were in a different type
        if (currentGroup.length > 0) {
          groups.push({ type: currentGroupType, parts: currentGroup });
        }
        currentGroup = [part];
        currentGroupType = 'image';
      } else {
        // Add to current image group
        currentGroup.push(part);
      }
    }
  }

  // Push the last group
  if (currentGroup.length > 0) {
    groups.push({ type: currentGroupType, parts: currentGroup });
  }

  return groups;
}

// Function to determine CSS classes for part groups based on their position and adjacent groups
function getPartGroupClass(group, index, groups) {
  const groupClasses = [];

  // Only apply special styling to mixed groups (reasoning/tool_group)
  if (group.type === 'mixed') {
    const previousGroup = index > 0 ? groups[index - 1] : null;
    const nextGroup = index < groups.length - 1 ? groups[index + 1] : null;

    // Add class if this is the first group or if the previous group is content
    if (index === 0 || (previousGroup && previousGroup.type === 'content')) {
      groupClasses.push('has-previous-content');
    }

    // Add class if this is the last group or if the next group is content
    if (index === groups.length - 1 || (nextGroup && nextGroup.type === 'content')) {
      groupClasses.push('has-next-content');
    }
  }

  return groupClasses.join(' ');
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
                  <!-- New Parts-Based Rendering -->
                  <div v-if="message.parts && message.parts.length > 0" class="message-parts-container">
                    <template v-for="(group, groupIndex) in getPartGroups(message.parts)" :key="`group-${groupIndex}`">
                      <div
                        v-if="group.type === 'mixed'"
                        :class="['part-group-container', getPartGroupClass(group, groupIndex, getPartGroups(message.parts))]"
                      >
                        <template v-for="(part, partIndex) in group.parts" :key="`part-${groupIndex}-${partIndex}`">
                          <!-- Reasoning Part inside group -->
                          <div v-if="part.type === 'reasoning'" class="part-reasoning inside-group">
                            <ChatWidget
                              type="reasoning"
                              :content="part.content"
                              status="Reasoning Process"
                            />
                          </div>

                          <!-- Tool Group Part inside group -->
                          <div v-else-if="part.type === 'tool_group'" class="part-tool-group inside-group">
                            <ChatWidget
                              type="tool"
                              :tool-calls="part.tools"
                            />
                          </div>
                        </template>
                      </div>

                      <!-- Individual content parts -->
                      <div
                        v-else-if="group.type === 'content'"
                        class="part-content"
                      >
                         <div v-if="message.complete || groupIndex < getPartGroups(message.parts).length - 1"
                              class="markdown-content"
                              v-html="renderMessageContent(group.parts[0].content, [])"></div>
                         <div v-else>
                            <StreamingMessage
                              :content="group.parts[0].content"
                              :is-complete="message.complete && groupIndex === getPartGroups(message.parts).length - 1"
                              @complete="onStreamingMessageComplete(message.id)"
                              @start="onStreamingMessageStart(message.id)"
                            />
                         </div>
                      </div>

                      <!-- Image parts -->
                      <div
                        v-else-if="group.type === 'image'"
                        class="part-image"
                      >
                        <div class="image-grid">
                          <template v-for="(part, partIndex) in group.parts" :key="`part-${partIndex}`">
                            <div
                              v-for="(image, imageIndex) in part.images"
                              :key="`image-${partIndex}-${imageIndex}`"
                              class="image-container"
                            >
                              <img
                                :src="image.url"
                                :alt="image.revised_prompt || 'Generated image'"
                                loading="lazy"
                                @load="console.log('Image loaded')"
                                @error="console.log('Image failed to load')"
                              />
                              <div v-if="image.revised_prompt" class="image-caption">
                                {{ image.revised_prompt }}
                              </div>
                            </div>
                          </template>
                        </div>
                      </div>
                    </template>
                  </div>

                  <!-- Legacy Rendering (Fallback) -->
                  <div v-else>
                      <!-- Tool Widgets (Legacy) -->
                      <div v-if="message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0" class="tool-widgets-container">
                        <ChatWidget
                          v-for="(tool, index) in message.tool_calls"
                          :key="index"
                          type="tool"
                          :tool-call="tool"
                          :result="null"
                        />
                      </div>
                      
                      <!-- Reasoning Card (Legacy) -->
                      <div v-if="message.role === 'assistant' && message.reasoning" class="reasoning-card">
                        <ChatWidget
                          type="reasoning"
                          :content="message.reasoning"
                          :status="liveReasoningTimers[message.id] || (message.reasoningDuration > 0 ? `Thought for ${formatDuration(message.reasoningDuration)}` : message.reasoningStartTime ? 'Thinking...' : 'Reasoning Process')"
                        />
                      </div>

                      <!-- Display notification if message has memory tool calls (Legacy style) -->
                      <div v-if="hasMemoryToolCalls(message)" class="memory-adjustment-notification">
                        Adjusted saved memories
                      </div>

                      <div class="bubble">
                        <div v-if="message.role == 'user'" class="user-message-content">
                          <!-- Display attached files -->
                          <div v-if="message.attachments?.length" class="message-attachments">
                            <div 
                              v-for="attachment in message.attachments" 
                              :key="attachment.id"
                              class="attachment-thumbnail"
                              :class="attachment.type"
                            >
                              <img 
                                v-if="attachment.type === 'image'"
                                :src="attachment.dataUrl" 
                                :alt="attachment.filename"
                                loading="lazy"
                              />
                              <div v-else class="pdf-attachment">
                                <Icon icon="material-symbols:picture-as-pdf" width="24" height="24" />
                                <span class="pdf-filename">{{ attachment.filename }}</span>
                              </div>
                            </div>
                          </div>
                          <!-- Message text -->
                          <div v-if="editingMessageId !== message.id" class="user-text">{{ message.content }}</div>
                          <div v-else class="edit-area">
                            <textarea 
                              v-model="editContent" 
                              class="edit-textarea" 
                              ref="editTextarea"
                              @keydown.enter.exact.prevent="submitEdit(message.id)"
                              @keydown.esc="cancelEditing"
                            ></textarea>
                            <div class="edit-actions">
                              <button class="edit-cancel" @click="cancelEditing">Cancel</button>
                              <button class="edit-save" @click="submitEdit(message.id)">Save & Submit</button>
                            </div>
                          </div>
                        </div>
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
                  </div>
              <div class="message-content-footer" :class="{ 'user-footer': message.role === 'user' }">
                <div class="footer-left-actions">
                  <button class="footer-action-btn copy-button" @click="copyMessage(message.content, $event)" :title="'Copy message'"
                    aria-label="Copy message">
                    <Icon icon="material-symbols:content-copy-outline-rounded" width="18px" height="18px" />
                  </button>
                  
                  <!-- Edit button for user messages -->
                  <button v-if="message.role === 'user'" class="footer-action-btn edit-button" 
                    @click="startEditing(message)" title="Edit message" aria-label="Edit message">
                    <Icon icon="material-symbols:edit-outline-rounded" width="18px" height="18px" />
                  </button>
                  
                  <!-- Regenerate button for assistant messages -->
                  <button v-if="message.role === 'assistant' && message.complete" class="footer-action-btn regenerate-button" 
                    @click="regenerateMessage(message.id)" title="Regenerate response" aria-label="Regenerate response">
                    <Icon icon="material-symbols:refresh-rounded" width="18px" height="18px" />
                  </button>
                </div>

                <!-- Branch Navigation -->
                <div v-if="branchInfo.has(message.id)" class="branch-navigation">
                  <button class="nav-prev" @click="navigateBranch(message.id, -1)" 
                    :disabled="branchInfo.get(message.id).current === 0">
                    <Icon icon="material-symbols:chevron-left-rounded" width="20px" height="20px" />
                  </button>
                  <span class="branch-counter">
                    {{ branchInfo.get(message.id).current + 1 }} / {{ branchInfo.get(message.id).total }}
                  </span>
                  <button class="nav-next" @click="navigateBranch(message.id, 1)" 
                    :disabled="branchInfo.get(message.id).current === branchInfo.get(message.id).total - 1">
                    <Icon icon="material-symbols:chevron-right-rounded" width="20px" height="20px" />
                  </button>
                </div>

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
  width: 32px;
  height: 32px;
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

.footer-left-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.footer-action-btn {
  background: transparent;
  border: none;
  border-radius: 8px;
  width: 28px;
  height: 28px;
  padding: 4px;
  cursor: pointer;
  transition: all 0.2s ease-in-out;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

.footer-action-btn:hover {
  background: var(--btn-hover);
  color: var(--text-primary);
}

.branch-navigation {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: 8px;
  background: var(--bg-secondary);
  border-radius: 14px;
  padding: 2px 4px;
  font-size: 0.75rem;
  color: var(--text-secondary);
  border: 1px solid var(--border);
}

.message.user .branch-navigation {
  margin: 0 8px
}

.branch-counter {
  min-width: 30px;
  text-align: center;
  font-weight: 500;
  user-select: none;
}

.branch-navigation button {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 50%;
  transition: all 0.2s;
}

.branch-navigation button:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--btn-hover);
}

.branch-navigation button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

/* Edit Area Styles */
.edit-area {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
}

.edit-textarea {
  width: 100%;
  min-height: 100px;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 1rem;
  line-height: 1.5;
  resize: vertical;
  outline: none;
}

.edit-textarea:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-20);
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.edit-actions button {
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.edit-cancel {
  color: var(--primary-foreground);
}

.edit-cancel:hover {
  background: var(--btn-hover);
}

.edit-save {
  color: var(--primary-foreground);
}

.edit-save:hover {
  background: var(--btn-hover);
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

/* --- MESSAGE ATTACHMENTS --- */
.user-message-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.user-text {
  white-space: pre-wrap;
}

.message-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.attachment-thumbnail {
  border-radius: 8px;
  overflow: hidden;
}

.attachment-thumbnail.image img {
  max-width: 250px;
  max-height: 250px;
  object-fit: contain;
  border-radius: 8px;
  display: block;
}

.attachment-thumbnail.pdf {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 8px;
}

.pdf-attachment {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pdf-attachment svg {
  flex-shrink: 0;
  opacity: 0.9;
}

.pdf-filename {
  font-size: 0.85rem;
  max-width: 150px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.9;
}

/* Tool Widgets Container */
.tool-widgets-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
  width: 100%;
  max-width: 800px;
}

/* Reasoning Card Styles */
.reasoning-card {
  margin-bottom: 12px;
  width: 100%;
  max-width: 800px;
}


/* Part Group Container Styling - for grouping adjacent reasoning and tool_group parts */
.part-group-container {
  border: 2px solid var(--border); /* Thick border for the container */
  border-radius: 12px; /* Keep border radius for the container */
  overflow: hidden; /* Contain the individual parts within the container */
  margin: 12px 0 0; /* Add some spacing between groups */
  position: relative;
}

/* Each inside-group needs position:relative for its ::after to position correctly */
.inside-group {
  position: relative;
}

/* Connection line segments between icons */
.inside-group:not(:last-child)::after {
  content: "";
  position: absolute;
  left: 21px; /* Nudged 1px left for perfect alignment */
  top: calc(100% - 6px); /* Start 6px before the bottom edge */
  height: 12px; /* 6px in this element + 6px into the next = centered */
  width: 0;
  border-left: 1px solid var(--border);
  z-index: 1;
  pointer-events: none;
  opacity: 1;
}

/* Remove border-radius from first element's bottom corners when inside a container */
.part-group-container > :first-child {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}

/* Remove border-radius from last element's top corners when inside a container */
.part-group-container > :last-child {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}

/* Remove border-radius from middle elements */
.part-group-container > :not(:first-child):not(:last-child) {
  border-radius: 0;
}

/* Remove border from the last item in the group */
.part-group-container > :last-child {
  border-bottom: none;
}

.part-content {
  margin-top: 12px;
  min-height: 20px;
}

.message-parts-container {
  display: flex;
  flex-direction: column;
  width: 100%;
}

/* Image part styles */
.part-image {
  margin: 12px 0;
}

.image-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  margin-top: 8px;
}

.image-container {
  position: relative;
  overflow: hidden;
}

.image-container img {
  height: auto;
  display: block;
  max-height: 300px;
  object-fit: contain;
}

.image-caption {
  padding: 8px;
  font-size: 0.85rem;
  color: var(--text-secondary);
  border-top: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
