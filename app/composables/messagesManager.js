import { ref, computed, nextTick, onMounted, onUnmounted, toRaw } from 'vue';
import { useRouter } from 'vue-router';
import localforage from 'localforage';
import { createConversation as createNewConversation, storeMessages, deleteConversation as deleteConv, updateBranchPath, loadConversation } from './storeConversations';
import { handleIncomingMessage } from './message';
import { availableModels, findModelById, normalizeReasoningConfig, getDefaultReasoningEffort } from './availableModels';
import DEFAULT_PARAMETERS from './defaultParameters';
import { useSettings } from './useSettings';
import { useGlobalIncognito } from './useGlobalIncognito';
import { emitter } from './emitter';
import { PartsBuilder, TimingTracker } from './partsBuilder';
import {
  getMessagesForBranchPath,
  createBranch,
  switchBranch,
  buildSiblingInfoMap,
  calculateBranchPath
} from './branchManager';

/**
 * Creates a centralized message manager for handling all chat message operations
 * Uses the shared settings instance for consistency across the app
 * @param {Object} chatPanel - Reference to the ChatPanel component
 * @returns {Object} Messages manager with reactive state and methods
 */
export function useMessagesManager(chatPanel) {
  // Use the shared settings instance
  const settingsManager = useSettings();

  // Use global incognito state
  const { isIncognito, toggleIncognito: globalToggleIncognito } = useGlobalIncognito();

  // Initialize router for navigation
  const router = useRouter();

  // Reactive state for messages
  const messages = ref([]);
  const branchPath = ref([]);
  const isLoading = ref(false);
  const controller = ref(new AbortController());
  const currConvo = ref('');
  const conversationTitle = ref('');
  const isTyping = ref(false);
  const chatLoading = ref(false);

  // Computed properties
  const visibleMessages = computed(() => {
    if (isIncognito.value) return messages.value;
    return getMessagesForBranchPath(messages.value, branchPath.value);
  });

  const branchInfo = computed(() => {
    return buildSiblingInfoMap(messages.value, visibleMessages.value);
  });

  const hasMessages = computed(() => visibleMessages.value.length > 0);
  const isEmptyConversation = computed(() => !currConvo.value && messages.value.length === 0);

  // Set up event listener for title updates
  const handleTitleUpdate = ({ conversationId, title }) => {
    if (currConvo.value === conversationId) {
      conversationTitle.value = title;
    }
  };

  // Handle conversation deletion
  const handleConversationDeleted = ({ conversationId }) => {
    if (currConvo.value === conversationId && !isIncognito.value) {
      currConvo.value = '';
      messages.value = [];
      conversationTitle.value = '';
      branchPath.value = [];
      router.push('/');
    }
  };

  onMounted(() => {
    emitter.on('conversationTitleUpdated', handleTitleUpdate);
    emitter.on('conversationDeleted', handleConversationDeleted);
  });

  onUnmounted(() => {
    emitter.off('conversationTitleUpdated', handleTitleUpdate);
    emitter.off('conversationDeleted', handleConversationDeleted);
  });

  // Method to update chat panel reference
  function setChatPanel(newChatPanel) {
    chatPanel.value = newChatPanel;
  }

  /**
   * Generates a unique ID for messages
   */
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Adds a user message to the messages array
   */
  function addUserMessage(content, attachments = []) {
    if (!content.trim() && attachments.length === 0) return;

    const parentId = visibleMessages.value.length > 0
      ? visibleMessages.value[visibleMessages.value.length - 1].id
      : null;

    const userMessage = {
      id: generateId(),
      role: "user",
      content: content,
      attachments: attachments.map(a => ({
        id: a.id,
        type: a.type,
        filename: a.filename,
        dataUrl: a.dataUrl,
        mimeType: a.mimeType
      })),
      timestamp: new Date(),
      complete: true,
      parentId: parentId,
      branchIndex: 0
    };

    messages.value.push(userMessage);

    if (!isIncognito.value) {
      branchPath.value = calculateBranchPath(messages.value, userMessage.id);
    }
  }

  /**
   * Creates a new assistant message and adds it to the messages array
   */
  function createAssistantMessage() {
    const parentId = visibleMessages.value.length > 0
      ? visibleMessages.value[visibleMessages.value.length - 1].id
      : null;

    const assistantMsg = {
      id: generateId(),
      role: "assistant",
      reasoning: "",
      content: "",
      tool_calls: [],
      parts: [], // Structured parts: reasoning, content, tool_group, image
      timestamp: new Date(),
      complete: false,
      parentId: parentId,
      branchIndex: 0,
      apiCallTime: new Date(),
      firstTokenTime: null,
      completionTime: null,
      tokenCount: 0,
      totalTokens: 0,
      promptTokens: 0,
      reasoningStartTime: null,
      reasoningEndTime: null,
      reasoningDuration: null,
      error: false,
      errorDetails: null,
      annotations: null
    };

    messages.value.push(assistantMsg);
    return assistantMsg;
  }

  /**
   * Updates an assistant message with new content
   */
  function updateAssistantMessage(message, updates) {
    const index = messages.value.findIndex(m => m.id === message.id);
    if (index !== -1) {
      Object.assign(message, updates);
      messages.value.splice(index, 1, { ...messages.value[index], ...updates });
    }
  }

  /**
   * Sends a message to the AI and handles the response
   */
  async function sendMessage(message, originalMessage = null, attachments = [], searchEnabled = false, options = {}) {
    const { skipUserMessage = false, parentId: explicitParentId = null } = options;

    if ((!message.trim() && attachments.length === 0) || isLoading.value) return;

    // Check if API key is provided
    if (!settingsManager.settings.custom_api_key) {
      const tempAssistantMsg = createAssistantMessage();
      updateAssistantMessage(tempAssistantMsg, {
        content: `⚠️ **API Key Required**\n\nPlease add your own API key in Settings → General to use models.`,
        complete: true,
        error: true,
        errorDetails: { name: 'APIKeyRequired', message: 'API key is required to use models' }
      });
      return;
    }

    controller.value = new AbortController();
    isLoading.value = true;
    isTyping.value = false;

    const messageToStore = originalMessage !== null ? originalMessage : message;
    if (!skipUserMessage) {
      addUserMessage(messageToStore, attachments);
    }

    const assistantMsg = createAssistantMessage();
    if (explicitParentId) {
      assistantMsg.parentId = explicitParentId;
    }

    // Create conversation if needed
    if (!currConvo.value && !isIncognito.value) {
      currConvo.value = await createNewConversation(messages.value, new Date());
      if (currConvo.value) {
        const convData = await loadConversation(currConvo.value);
        conversationTitle.value = convData?.title || "";
      }
    }

    await nextTick();
    requestAnimationFrame(() => {
      chatPanel?.value?.scrollToEnd("smooth");
    });

    // Get current model details
    const selectedModelDetails = findModelById(availableModels, settingsManager.settings.selected_model_id);

    if (!selectedModelDetails) {
      console.error("No model selected or model details not found. Aborting message send.");
      updateAssistantMessage(assistantMsg, {
        content: (assistantMsg.content ? assistantMsg.content + "\n\n" : "") + "Error: No AI model selected.",
        complete: true
      });
      isLoading.value = false;
      return;
    }

    // Construct model parameters
    const reasoningConfig = normalizeReasoningConfig(selectedModelDetails);
    const savedReasoningEffort = settingsManager.getModelSetting(selectedModelDetails.id, "reasoning_effort") ||
      getDefaultReasoningEffort(selectedModelDetails);

    const parameterConfig = settingsManager.settings.parameter_config || { ...DEFAULT_PARAMETERS };

    const model_parameters = {
      ...parameterConfig,
      ...selectedModelDetails.extra_parameters,
      reasoning: {
        effort: savedReasoningEffort,
        enabled: reasoningConfig.toggleable ? savedReasoningEffort !== 'none' : true
      }
    };

    // Initialize parts builder and timing tracker
    const partsBuilder = new PartsBuilder();
    const timing = new TimingTracker(assistantMsg);

    // Track tool calls and their results
    let currentToolCalls = [];
    let hasExecutedTools = false;

    try {
      // Build conversation history for the API
      const historyForAPI = visibleMessages.value.filter(msg => {
        if (!msg.complete) return false;
        if (msg.role === 'user') {
          const lastUserMsg = [...visibleMessages.value].reverse().find(m => m.role === 'user');
          if (lastUserMsg && msg.id === lastUserMsg.id) return false;
        }
        return true;
      });

      const streamGenerator = handleIncomingMessage(
        message,
        historyForAPI,
        controller.value,
        settingsManager.settings.selected_model_id,
        model_parameters,
        settingsManager.settings,
        selectedModelDetails.extra_functions || [],
        searchEnabled,
        isIncognito.value,
        attachments
      );

      // RAF batching for UI updates
      let rafScheduled = false;
      const scheduleUIUpdate = () => {
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(() => {
            syncAssistantMessage(assistantMsg, partsBuilder);
            if (chatPanel?.value?.isAtBottom) {
              chatPanel.value.scrollToEnd("smooth");
            }
            rafScheduled = false;
          });
        }
      };

      for await (const chunk of streamGenerator) {
        // Process content - skip if this is the final complete chunk (content already accumulated)
        if (chunk.content && !chunk.complete) {
          partsBuilder.appendContent(chunk.content);
          assistantMsg.content = (assistantMsg.content || '') + chunk.content;
          timing.markFirstToken();
          timing.endReasoning();
        }

        // Process images
        if (chunk.images && chunk.images.length > 0) {
          for (const image of chunk.images) {
            partsBuilder.processImage(image);
          }
        }

        // Process reasoning - skip if this is the final complete chunk (reasoning already accumulated)
        if (chunk.reasoning && chunk.reasoning.trim() !== 'None' && !chunk.complete) {
          partsBuilder.appendReasoning(chunk.reasoning);
          if (assistantMsg.reasoning.trim() === '' && chunk.reasoning.trim() !== '') {
            assistantMsg.reasoning = chunk.reasoning;
          } else {
            assistantMsg.reasoning += chunk.reasoning;
          }
          timing.markFirstToken();
          timing.startReasoning();
        }

        // Process tool calls
        if (chunk.tool_calls && chunk.tool_calls.length > 0) {
          for (const tool of chunk.tool_calls) {
            const toolType = tool.type || 'function';
            partsBuilder.addOrUpdateTool(toolType, tool);
            
            // Track tool calls
            if (tool.id && !currentToolCalls.find(tc => tc.id === tool.id)) {
              currentToolCalls.push({
                id: tool.id,
                type: toolType,
                function: {
                  name: tool.function?.name || '',
                  arguments: tool.function?.arguments || ''
                }
              });
            }
          }
        }

        // Process tool results
        if (chunk.tool_result) {
          partsBuilder.setToolResult(chunk.tool_result.id, chunk.tool_result.result);
          hasExecutedTools = true;
          
          // Update currentToolCalls with results
          const toolCall = currentToolCalls.find(tc => tc.id === chunk.tool_result.id);
          if (toolCall) {
            toolCall.result = chunk.tool_result.result;
          }
        }

        // Process usage
        if (chunk.usage) {
          if (chunk.usage.completion_tokens !== undefined) {
            assistantMsg.tokenCount = chunk.usage.completion_tokens;
          }
          if (chunk.usage.total_tokens !== undefined) {
            assistantMsg.totalTokens = chunk.usage.total_tokens;
          }
          if (chunk.usage.prompt_tokens !== undefined) {
            assistantMsg.promptTokens = chunk.usage.prompt_tokens;
          }
        }

        // Process annotations
        if (chunk.annotations) {
          assistantMsg.annotations = chunk.annotations;
        }

        // Process errors
        if (chunk.error && chunk.errorDetails) {
          assistantMsg.error = true;
          assistantMsg.errorDetails = chunk.errorDetails;
        }

        // Schedule UI update
        scheduleUIUpdate();
      }

      // Final sync
      syncAssistantMessage(assistantMsg, partsBuilder, true);

    } catch (error) {
      console.error('Error in stream processing:', error);
      assistantMsg.error = true;
      assistantMsg.errorDetails = {
        name: error.name || 'Error',
        message: error.message || 'An unexpected error occurred'
      };
    } finally {
      // Ensure parts are stored from partsBuilder
      syncAssistantMessage(assistantMsg, partsBuilder, true);

      // Discard empty reasoning
      if (assistantMsg.reasoning?.trim() === '') {
        assistantMsg.reasoning = '';
      }

      // Mark message as complete
      const finalUpdates = {
        complete: true,
        completionTime: new Date(),
        reasoningDuration: timing.calculateReasoningDuration(),
        tool_calls: currentToolCalls
      };

      Object.assign(assistantMsg, finalUpdates);
      updateAssistantMessage(assistantMsg, finalUpdates);

      // Handle error display
      if (assistantMsg.error && assistantMsg.errorDetails) {
        const errorSuffix = `\n\n---\n⚠️ **Error:** ${assistantMsg.errorDetails.message}` +
          (assistantMsg.errorDetails.status ? ` (HTTP ${assistantMsg.errorDetails.status})` : '');
        
        partsBuilder.appendContent(errorSuffix);
        
        const errorUpdates = {
          content: assistantMsg.content + errorSuffix,
          parts: partsBuilder.getParts(),
          error: true,
          errorDetails: assistantMsg.errorDetails
        };

        Object.assign(assistantMsg, errorUpdates);
        updateAssistantMessage(assistantMsg, errorUpdates);
      }

      isLoading.value = false;

      // Store messages if not in incognito mode
      if (!isIncognito.value) {
        await storeMessages(currConvo.value, toRaw(messages.value), new Date());
      }
    }
  }

  /**
   * Sync assistant message with parts builder state
   */
  function syncAssistantMessage(message, partsBuilder, finalize = false) {
    if (finalize) {
      partsBuilder.finalizeContent();
      partsBuilder.finalizeReasoning();
    }
    
    const newParts = partsBuilder.getParts();
    const newTools = partsBuilder.getAllTools();
    
    message.parts = newParts;
    message.tool_calls = newTools;
    
    // Update the message in the array
    const index = messages.value.findIndex(m => m.id === message.id);
    if (index !== -1) {
      messages.value.splice(index, 1, { ...messages.value[index], parts: newParts, tool_calls: newTools });
    }
  }

  /**
   * Changes the current conversation
   */
  async function changeConversation(id) {
    if (isIncognito.value) return;

    chatLoading.value = true;
    messages.value = [];
    branchPath.value = [];
    currConvo.value = id;

    const conv = await loadConversation(id);
    if (conv?.messages) {
      messages.value = conv.messages.map(msg => {
        if (msg.role === 'assistant') {
          return {
            ...msg,
            apiCallTime: msg.apiCallTime ? new Date(msg.apiCallTime) : null,
            firstTokenTime: msg.firstTokenTime ? new Date(msg.firstTokenTime) : null,
            completionTime: msg.completionTime ? new Date(msg.completionTime) : null,
            reasoningStartTime: msg.reasoningStartTime ? new Date(msg.reasoningStartTime) : null,
            reasoningEndTime: msg.reasoningEndTime ? new Date(msg.reasoningEndTime) : null,
            tool_calls: msg.tool_calls || [],
            parts: msg.parts || [],
            tokenCount: msg.tokenCount || 0,
            totalTokens: msg.totalTokens || 0,
            promptTokens: msg.promptTokens || 0
          };
        }
        return msg;
      });
      branchPath.value = conv.branchPath || [];
    }

    conversationTitle.value = conv?.title || '';
    chatLoading.value = false;
  }

  /**
   * Edits a user message and creates a new branch
   */
  async function editUserMessage(messageId, newContent, newAttachments = null) {
    const existingMsg = messages.value.find(m => m.id === messageId);
    if (!existingMsg) return;

    const attachments = newAttachments !== null ? newAttachments : (existingMsg.attachments || []);

    const branchResult = createBranch(messages.value, messageId, {
      role: "user",
      content: newContent,
      attachments: attachments,
      complete: true
    });

    messages.value = branchResult.messages;
    branchPath.value = branchResult.branchPath;

    if (!isIncognito.value) {
      await storeMessages(currConvo.value, toRaw(messages.value), new Date());
      await updateBranchPath(currConvo.value, [...toRaw(branchPath.value)]);
    }

    const searchEnabled = settingsManager.settings?.search_enabled ?? false;
    await sendMessage(newContent, null, attachments, searchEnabled, { skipUserMessage: true });
  }

  /**
   * Regenerates an assistant message and creates a new branch
   */
  async function regenerateAssistantMessage(messageId) {
    const assistantMsg = messages.value.find(m => m.id === messageId);
    if (!assistantMsg || assistantMsg.role !== 'assistant') return;

    const userMsg = messages.value.find(m => m.id === assistantMsg.parentId);
    if (!userMsg) return;

    const visibleChain = getMessagesForBranchPath(messages.value, branchPath.value);

    const branchResult = createBranch(messages.value, assistantMsg.id, {
      role: "assistant",
      content: "",
      complete: false,
      timestamp: new Date()
    });

    const tempMsgId = branchResult.newMessage.id;
    messages.value = branchResult.messages.filter(m => m.id !== tempMsgId);
    branchPath.value = branchResult.branchPath;

    if (!isIncognito.value) {
      await updateBranchPath(currConvo.value, [...toRaw(branchPath.value)]);
    }

    const searchEnabled = settingsManager.settings?.search_enabled ?? false;
    await sendMessage(userMsg.content, null, userMsg.attachments || [], searchEnabled, {
      skipUserMessage: true,
      parentId: userMsg.id
    });
  }

  /**
   * Navigates to a different branch
   */
  async function navigateBranch(messageId, direction) {
    const info = branchInfo.value.get(messageId);
    if (!info) return;

    const newIndex = (info.current + direction + info.total) % info.total;
    branchPath.value = switchBranch(branchPath.value, info.forkIndex, newIndex);

    if (!isIncognito.value) {
      await updateBranchPath(currConvo.value, [...toRaw(branchPath.value)]);
    }
  }

  /**
   * Deletes a conversation
   */
  async function deleteConversation(id) {
    if (isIncognito.value) return;

    await deleteConv(id);
    if (currConvo.value === id) {
      currConvo.value = '';
      messages.value = [];
      conversationTitle.value = '';
    }
  }

  /**
   * Starts a new conversation
   */
  async function newConversation() {
    currConvo.value = '';
    messages.value = [];
    conversationTitle.value = '';
    isIncognito.value = false;
  }

  /**
   * Toggles incognito mode
   */
  function toggleIncognito() {
    globalToggleIncognito();
  }

  // Return the reactive state and methods
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

    // Computed properties
    hasMessages,
    isEmptyConversation,

    // Methods
    sendMessage,
    changeConversation,
    deleteConversation,
    newConversation,
    toggleIncognito,
    generateId,
    setChatPanel,
    editUserMessage,
    regenerateAssistantMessage,
    navigateBranch
  };
}