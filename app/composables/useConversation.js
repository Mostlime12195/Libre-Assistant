import { ref, computed, onMounted, watch, toRaw } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useHead } from '@unhead/vue';
import { createConversation as storeCreateConversation } from './storeConversations';
import { useSettings } from './useSettings';
import { useMessagesManager } from './messagesManager';

/**
 * Custom composable to manage conversations in a page-based structure
 * Uses the shared settings instance for consistency across the app
 * @returns {Object} Conversation manager with reactive state and methods
 */
export function useConversation() {
  // Use the shared settings instance
  const settingsManager = useSettings();
  const router = useRouter();
  const route = useRoute();

  // Create a new messages manager for this page
  const chatPanel = ref(null);
  const messagesManager = useMessagesManager(settingsManager, chatPanel);

  // Destructure commonly used properties from messagesManager
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
    toggleIncognito
  } = messagesManager;

  // Set up dynamic page title based on conversation
  const title = computed(() => {
    if (conversationTitle.value) {
      return `${conversationTitle.value} - Libre Assistant`;
    }
    return 'Libre Assistant';
  });

  // Update page head dynamically
  useHead({
    title: title,
    meta: [
      { name: 'description', content: 'AI conversation in Libre Assistant' }
    ]
  });

  // Initialize the conversation based on route parameters
  onMounted(async () => {
    if (route.params.id) {
      // Load specific conversation
      await changeConversation(route.params.id);
    } else if (route.path === '/' || route.path === '/new') {
      // Create new conversation (for both root and new routes)
      await newConversation();
    }
  });

  // Watch for route changes to handle conversation loading when component is kept alive
  watch(
    () => [route.path, route.params.id],
    async ([newPath, newId], [oldPath, oldId]) => {
      if ((newPath === '/' || newPath === '/new') && !(oldPath === '/' || oldPath === '/new')) {
        // Navigating to new conversation
        await newConversation();
      } else if (newId && newId !== oldId) {
        // Navigating to a different conversation ID
        await changeConversation(newId);
      }
    }
  );

  // Function to create a new conversation with an initial message and trigger AI response
  async function createNewConversationWithMessage(initialMessage, attachments = []) {
    // First, add the initial user message to the current messages array
    const initialUserMessage = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
      role: "user",
      content: initialMessage,
      attachments: attachments.map(a => ({
        id: a.id,
        type: a.type,
        filename: a.filename,
        dataUrl: a.dataUrl,
        mimeType: a.mimeType
      })),
      timestamp: new Date(),
      complete: true,
      parentId: null,
      branchIndex: 0
    };

    // Add the message to the current messages
    messages.value.push(initialUserMessage);

    // Create the conversation in storage with this message - using the storeConversations function
    // Use toRaw to ensure we're not sending a Proxy to IndexedDB
    const conversationId = await storeCreateConversation(toRaw(messages.value), new Date());

    // Update current conversation to point to the new one
    currConvo.value = conversationId;

    return conversationId;
  }



  return {
    // State
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

    // Chat panel reference
    chatPanel,

    // Methods
    sendMessage,
    editUserMessage,
    regenerateAssistantMessage,
    navigateBranch,
    changeConversation,
    deleteConversation,
    newConversation,
    toggleIncognito,
    setChatPanel: messagesManager.setChatPanel, // Add the method from messages manager
    createNewConversationWithMessage, // Added new function for creating conversation with first message

    // Additional utilities
    router,
    route
  };
}