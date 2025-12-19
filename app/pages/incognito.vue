<template>
  <div class="chat-section">
    <div class="chat-column">
      <!-- Never show welcome in incognito mode -->
      <ChatPanel
        ref="chatPanelRef"
        :curr-convo="currConvo"
        :curr-messages="messages"
        :isLoading="isLoading"
        :conversationTitle="conversationTitle"
        :show-welcome="false"
        :is-dark="isDark"
        :is-incognito="isIncognito"
        @set-message="text => messageFormRef?.setMessage(text)"
        @scroll="handleChatScroll"
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
// This page is for incognito mode conversations
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

// Inject Vercel's analytics and performance insights
inject();
injectSpeedInsights();

const isDark = useDark();

// Use the shared settings instance
const settingsManager = useSettings();

// Initialize conversation state and methods
const {
  messages,
  isLoading,
  controller,
  currConvo,
  conversationTitle,
  isIncognito,
  isTyping,
  chatLoading,
  sendMessage,
  changeConversation,
  deleteConversation,
  newConversation,
  toggleIncognito,
  setChatPanel,
  chatPanel, // This is the chat panel ref from the composable
  createNewConversationWithMessage, // Added new function for creating conversation with first message
  sendInitialMessageToAI // Added function to send initial message and get AI response
} = useConversation();

// Get the route and router
const route = useRoute();
const router = useRouter();

const messageFormRef = ref(null); // Reference to the MessageForm component
const chatPanelRef = ref(null); // Reference to the ChatPanel component

// Use global scroll status instead of local ref
const { setIsScrolledTop } = useGlobalScrollStatus();

onMounted(async () => {
  await settingsManager.loadSettings();
  // No manual default setting needed here as Settings class handles it now


  // Set the chat panel reference (used by useConversation for scrollToEnd, etc.)
  setChatPanel(chatPanelRef.value);

  // Since this is incognito mode, we don't need to load specific conversation data
  // The conversation happens in memory only

  // Make sure incognito mode is enabled
  if (!isIncognito.value) {
    toggleIncognito();
  }

  // Check if there's an initial message in the route query
  if (route.query.initialMessage) {
    // Send the initial message in incognito mode
    const initialMessage = route.query.initialMessage;
    // Clear the query parameter to avoid resending on refresh
    await router.replace('/incognito');

    // Send the initial message to get AI response
    // This will handle adding both the user and assistant messages
    await sendInitialMessageToAI(initialMessage);
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
  title: 'Incognito Chat - Libre Assistant',
  meta: [
    { name: 'description', content: 'Private chat conversation with the AI assistant - no data stored' }
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