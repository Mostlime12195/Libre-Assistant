<template>
  <div class="chat-section">
    <div class="chat-column">
      <ChatPanel
        ref="chatPanelRef"
        :curr-convo="currConvo"
        :curr-messages="visibleMessages"
        :is-loading="isLoading"
        :conversation-title="conversationTitle"
        :branch-info="branchInfo"
        :show-welcome="!currConvo && !isTyping"
        :is-dark="isDark"
        :is-incognito="isIncognito"
        @set-message="text => messageFormRef?.setMessage(text)"
        @scroll="handleChatScroll"
        @edit-message="editUserMessage"
        @regenerate-message="regenerateAssistantMessage"
        @navigate-branch="navigateBranch"
      />
      <MessageForm
        ref="messageFormRef"
        :is-loading="isLoading"
        :selected-model-id="settingsManager.settings.selected_model_id"
        :available-models="availableModels"
        :selected-model-name="selectedModelName"
        :settings-manager="settingsManager"
        @typing="isTyping = true"
        @empty="isTyping = false"
        @send-message="sendMessage"
        @abort-controller="controller.abort()"
      />
    </div>
  </div>
</template>

<script setup>
// This page is for creating a new conversation (replaces the /new route)
import { ref, nextTick, onMounted, computed, watch, onBeforeUnmount } from 'vue';
import 'highlight.js/styles/github.css';
import 'highlight.js/styles/github-dark.css';
import { inject } from "@vercel/analytics"
import { injectSpeedInsights } from '@vercel/speed-insights';
import { useDark } from "@vueuse/core";
import { useRoute, useRouter } from '#app';
import { useHead } from '@unhead/vue';

import { availableModels } from '~/composables/availableModels';
import { useSettings } from '~/composables/useSettings';
import { useConversation } from '~/composables/useConversation';
import { useGlobalScrollStatus } from '~/composables/useGlobalScrollStatus';

import ChatPanel from '~/components/ChatPanel.vue';

// Get the route
const route = useRoute();
const router = useRouter();

// Inject Vercel's analytics and performance insights
inject();
injectSpeedInsights();

const isDark = useDark();

// Use the shared settings instance
const settingsManager = useSettings();

// Initialize conversation state and methods
const {
  messages,
  visibleMessages,
  branchPath,
  branchInfo,
  isLoading,
  controller,
  currConvo,
  conversationTitle,
  isIncognito,
  isTyping,
  chatLoading,
  sendMessage: originalSendMessage,
  editUserMessage,
  regenerateAssistantMessage,
  navigateBranch,
  changeConversation,
  deleteConversation,
  newConversation,
  toggleIncognito,
  setChatPanel,
  chatPanel, // This is the chat panel ref from the composable
  createNewConversationWithMessage // Function for creating conversation with first message
} = useConversation();

// Override sendMessage to create conversation and navigate immediately
async function sendMessage(message, originalMessage = null, attachments = []) {
  if ((!message.trim() && attachments.length === 0) || isLoading.value) return;

  if (isIncognito.value) {
    // If in incognito mode, navigate to the incognito route with the message
    // Note: Attachments in incognito mode are not supported for initial message
    // as we can't pass large base64 data via query params
    await router.push({ path: '/incognito', query: { initialMessage: message } });
  } else {
    // Create a new conversation with the initial message and attachments
    const conversationId = await createNewConversationWithMessage(message, attachments);

    // Navigate immediately to the new conversation
    // The [id].vue route will detect this is a new conversation and trigger the AI response
    await router.push(`/${conversationId}`);
  }
}

const messageFormRef = ref(null); // Reference to the MessageForm component
const chatPanelRef = ref(null); // Reference to the ChatPanel component

// Use global scroll status instead of local ref
const { setIsScrolledTop } = useGlobalScrollStatus();

onMounted(async () => {
  await settingsManager.loadSettings();
  // No manual default setting needed here as Settings class handles it now


  // Set the chat panel reference (used by useConversation for scrollToEnd, etc.)
  setChatPanel(chatPanelRef.value);

  // Handle initial prompt from URL query parameter (e.g. /?q=Hello)
  const initialPrompt = route.query.q;
  let initialModel = route.query.model;
  if (initialPrompt && typeof initialPrompt === 'string' && initialPrompt.trim()) {
    await nextTick();

    if (initialModel) {
      initialModel = initialModel.replace('-', '/');
      if (availableModels.value.find(m => m.name === initialModel)) {
        settingsManager.setSelectedModel(initialModel);
      }
    }

    await sendMessage(initialPrompt.trim());
  }
});

// Use selectedModelName from settingsManager
const selectedModelName = computed(() => settingsManager.selectedModelName);

/**
 * Handles scroll events from the ChatPanel component.
 * @param {Object} event - The scroll event object
 * @param {boolean} event.isAtTop - Whether the user is scrolled to the top
 */
function handleChatScroll(event) {
  setIsScrolledTop(event.isAtTop);
}

// Update page head dynamically
useHead({
  title: 'New Chat - Libre Assistant',
  meta: [
    { name: 'description', content: 'Start a new conversation with the AI assistant' }
  ]
});
</script>

<style scoped>
/* Full-width scroll container */
.chat-section {
  display: flex;
  flex: 1;
  width: 100%;
  position: relative;
  justify-content: center;
  overflow-y: scroll;
  padding: 0 16px
}

/* Centered content column, no own scroll */
.chat-column {
  display: flex;
  flex-direction: column;
  flex: 1;
  max-width: 700px;
  width: 100%;
  margin: 0 auto;
  overflow: visible;    /* or just omit overflow entirely */
}
</style>