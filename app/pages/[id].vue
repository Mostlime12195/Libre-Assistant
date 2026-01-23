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
// This page is for displaying a specific conversation by ID
import { ref, nextTick, onMounted, computed, watch, onBeforeUnmount } from 'vue';
import 'highlight.js/styles/github.css';
import 'highlight.js/styles/github-dark.css';
import { inject } from "@vercel/analytics"
import { injectSpeedInsights } from '@vercel/speed-insights';
import { useDark } from "@vueuse/core";
import { useRoute, navigateTo } from '#app';
import { useHead } from '@unhead/vue';

import { availableModels } from '~/composables/availableModels';
import { useSettings } from '~/composables/useSettings';
import { useConversation } from '~/composables/useConversation';
import { useGlobalScrollStatus } from '~/composables/useGlobalScrollStatus';

import ChatPanel from '~/components/ChatPanel.vue';

// Get the route and conversation ID
const route = useRoute();
const conversationId = route.params.id;

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
  sendMessage,
  editUserMessage,
  regenerateAssistantMessage,
  navigateBranch,
  changeConversation,
  deleteConversation,
  newConversation,
  toggleIncognito,
  setChatPanel,
  chatPanel // This is the chat panel ref from the composable
} = useConversation();

const messageFormRef = ref(null); // Reference to the MessageForm component
const chatPanelRef = ref(null); // Reference to the ChatPanel component

// Use global scroll status instead of local ref
const { setIsScrolledTop } = useGlobalScrollStatus();

onMounted(async () => {
  await settingsManager.loadSettings();
  // No manual default setting needed here as Settings class handles it now


  // Set the chat panel reference (used by useConversation for scrollToEnd, etc.)
  setChatPanel(chatPanelRef.value);

  // The conversation loading is now handled by the useConversation composable
  
  // Check if this is a newly created conversation that needs an AI response
  // (i.e., it has a user message but no assistant response yet)
  await nextTick();
  if (messages.value.length === 1 && messages.value[0].role === 'user') {
    // This is a new conversation with only the initial user message
    // Automatically trigger the AI response using sendMessage with skipUserMessage
    // since the user message was already added by createNewConversationWithMessage
    const userMessage = messages.value[0].content;
    const userAttachments = messages.value[0].attachments || [];
    await sendMessage(userMessage, null, userAttachments, { skipUserMessage: true });
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
  title: () => `${conversationTitle.value || 'Conversation'} - Libre Assistant`,
  meta: [
    { name: 'description', content: 'Chat conversation with the AI assistant' }
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
  padding: 0 16px;
}

/* Centered content column, no own scroll */
.chat-column {
  display: flex;
  flex-direction: column;
  flex: 1;
  max-width: 700px;
  width: 100%;
  margin-bottom: 90px;
  margin: 0 auto;
  overflow: visible;    /* or just omit overflow entirely */
}
</style>