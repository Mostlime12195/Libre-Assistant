import { ref, computed, nextTick, onMounted, onUnmounted, toRaw } from 'vue';
import localforage from 'localforage';
import { createConversation as createNewConversation, storeMessages, deleteConversation as deleteConv, updateBranchPath, loadConversation } from './storeConversations';
import { handleIncomingMessage } from './message';
import { availableModels, findModelById, normalizeReasoningConfig, getDefaultReasoningEffort } from './availableModels';
import { addMemory, modifyMemory, deleteMemory } from './memory';
import DEFAULT_PARAMETERS from './defaultParameters';
import { useSettings } from './useSettings';
import { useGlobalIncognito } from './useGlobalIncognito';
import { emitter } from './emitter';
import { PartsBuilder, TimingTracker } from './partsBuilder';
import { useRateLimiter } from './rateLimiter';
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

  onMounted(() => {
    emitter.on('conversationTitleUpdated', handleTitleUpdate);
  });

  onUnmounted(() => {
    emitter.off('conversationTitleUpdated', handleTitleUpdate);
  });

  // Method to update chat panel reference (for dynamic pages)
  function setChatPanel(newChatPanel) {
    chatPanel.value = newChatPanel;
  }

  /**
   * Generates a unique ID for messages
   * @returns {string} Unique ID
   */
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Adds a user message to the messages array
   * @param {string} content - The user's message content
   * @param {Array} attachments - Optional array of file attachments
   */
  function addUserMessage(content, attachments = []) {
    if (!content.trim() && attachments.length === 0) return;

    // Determine parent message (the last message in the currently visible branch)
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
      branchIndex: 0 // Default to first branch when adding a new message
    };

    messages.value.push(userMessage);

    // If not in incognito, update branch path to include this new message if needed
    if (!isIncognito.value) {
      branchPath.value = calculateBranchPath(messages.value, userMessage.id);
    }
  }

  /**
   * Creates a new assistant message and adds it to the messages array
   * @returns {Object} The created assistant message object
   */
  function createAssistantMessage() {
    // Determine parent message (the last message in the currently visible branch)
    const parentId = visibleMessages.value.length > 0
      ? visibleMessages.value[visibleMessages.value.length - 1].id
      : null;

    const assistantMsg = {
      id: generateId(),
      role: "assistant",
      reasoning: "",
      content: "",
      tool_calls: [],
      timestamp: new Date(),
      complete: false,
      parentId: parentId,
      branchIndex: 0,
      // New timing properties
      apiCallTime: new Date(), // Time when the API was called
      firstTokenTime: null,    // Time when the first token was received
      completionTime: null,    // Time when the message was completed
      // Token counting - now using actual counts from OpenRouter API
      tokenCount: 0,           // Completion tokens (generated tokens)
      totalTokens: 0,          // Total tokens (prompt + completion)
      promptTokens: 0,         // Prompt tokens (input tokens)
      reasoningStartTime: null,
      reasoningEndTime: null,
      reasoningDuration: null,
      error: false,
      errorDetails: null,
      annotations: null  // For PDF parsing reuse
    };

    messages.value.push(assistantMsg);
    return assistantMsg;
  }

  /**
   * Updates an assistant message with new content
   * @param {Object} message - The message to update
   * @param {Object} updates - The updates to apply
   */
  function updateAssistantMessage(message, updates) {
    const index = messages.value.findIndex(m => m.id === message.id);
    if (index !== -1) {
      // Update the local object too, to keep it in sync with the array
      Object.assign(message, updates);
      // Use Vue's array mutation method to ensure reactivity
      messages.value.splice(index, 1, { ...messages.value[index], ...updates });
    }
  }

  /**
   * Sends a message to the AI and handles the response
   * @param {string} message - The user's message
   * @param {string} originalMessage - The original user message (before any reasoning prepends)
   * @param {Array} attachments - Optional array of file attachments
   * @param {Object} options - Optional settings
   * @param {boolean} options.skipUserMessage - If true, don't add user message (already exists in messages array)
   * @param {string} options.parentId - Optional explicit parent ID for the assistant message
   */
  async function sendMessage(message, originalMessage = null, attachments = [], options = {}) {
    const { skipUserMessage = false, parentId: explicitParentId = null } = options;

    if ((!message.trim() && attachments.length === 0) || isLoading.value) return;

    // Check rate limit (only if not using custom API key)
    if (!settingsManager.settings.custom_api_key) {
      const rateLimiter = useRateLimiter();
      const selectedModelId = settingsManager.settings.selected_model_id;
      const limitCheck = rateLimiter.checkLimit(selectedModelId);

      if (!limitCheck.canSend) {
        // Create a temporary message to show the rate limit error
        const tempAssistantMsg = createAssistantMessage();
        updateAssistantMessage(tempAssistantMsg, {
          content: `⚠️ **Rate Limit Reached**\n\n${limitCheck.error}\n\nYou can add your own Hack Club API key in Settings → General to bypass rate limits.`,
          complete: true,
          error: true,
          errorDetails: { name: 'RateLimitError', message: limitCheck.error }
        });
        return;
      }

      // Record the request
      rateLimiter.recordRequest(selectedModelId);
    }

    controller.value = new AbortController();
    isLoading.value = true;
    isTyping.value = false;

    // Add user message using the original message (without /no_think prepended)
    // Skip if the message was already added (e.g., for initial messages from createNewConversationWithMessage)
    const messageToStore = originalMessage !== null ? originalMessage : message;
    if (!skipUserMessage) {
      addUserMessage(messageToStore, attachments);
    }

    // Create assistant message
    const assistantMsg = createAssistantMessage();

    // If explicit parent was provided, override the default parent
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
    // Use requestAnimationFrame for more reliable scrolling
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

    // Initialize parts builder and timing tracker (outside try so they're accessible in finally)
    const partsBuilder = new PartsBuilder();
    const timing = new TimingTracker(assistantMsg);

    try {
      // Build conversation history for the API.
      // CRITICAL: History must NOT include the current user message - handleIncomingMessage adds it.
      // 
      // For normal messages: visibleMessages = [...history, userMsg we just added, assistantMsg]
      // For edits/regenerates: visibleMessages = [...history, existing userMsg, assistantMsg]
      //
      // In both cases, we need history WITHOUT the user message for this turn
      // because handleIncomingMessage will add the user message from the `message` param.
      
      const historyForAPI = visibleMessages.value.filter(msg => {
        // Exclude incomplete messages (the assistant placeholder we just created)
        if (!msg.complete) return false;
        // Exclude the current user message - it's always the last user message in visibleMessages
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
        settingsManager.settings.parameter_config?.grounding ?? DEFAULT_PARAMETERS.grounding,
        isIncognito.value,
        attachments
      );

      // Helper to update message with Vue reactivity
      const updateMessageReactivity = () => {
        const updatedMsg = {
          ...assistantMsg,
          parts: partsBuilder.toReactiveArray(),
          tool_calls: partsBuilder.getAllTools(),
        };
        messages.value.splice(messages.value.length - 1, 1, updatedMsg);
      };

      // RAF batching: schedule ONE UI update per frame instead of per chunk
      let rafScheduled = false;
      const scheduleUIUpdate = () => {
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(() => {
            updateMessageReactivity();
            if (chatPanel?.value?.isAtBottom) {
              chatPanel.value.scrollToEnd("smooth");
            }
            rafScheduled = false;
          });
        }
      };

      for await (const chunk of streamGenerator) {
        // Process content (fast accumulation, no Vue updates)
        if (chunk.content) {
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

        // Process reasoning
        if (chunk.reasoning && chunk.reasoning.trim() !== 'None') {
          partsBuilder.appendReasoning(chunk.reasoning);

          // Update legacy reasoning field
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
          }
        }

        // Process tool results
        if (chunk.tool_result) {
          partsBuilder.setToolResult(chunk.tool_result.id, chunk.tool_result.result);
        }

        // Process usage information from OpenRouter
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

        // Process annotations from OpenRouter (for PDF reuse)
        if (chunk.annotations) {
          assistantMsg.annotations = chunk.annotations;
        }

        // Process errors from the stream
        if (chunk.error && chunk.errorDetails) {
          assistantMsg.error = true;
          assistantMsg.errorDetails = chunk.errorDetails;
        }

        // Schedule batched UI update (will run once per frame, not per chunk)
        scheduleUIUpdate();
      }

      // Store final parts on assistantMsg for persistence (BEFORE final UI update)
      assistantMsg.parts = partsBuilder.toArray();
      assistantMsg.tool_calls = partsBuilder.getAllTools();

      // Final flush after stream completes to ensure all content is rendered
      updateMessageReactivity();

    } catch (error) {
      console.error('Error in stream processing:', error);
      // Capture error details for UI display
      assistantMsg.error = true;
      assistantMsg.errorDetails = {
        name: error.name || 'Error',
        message: error.message || 'An unexpected error occurred'
      };
    } finally {

      // Ensure parts are stored from partsBuilder (in case of early error)
      if (!assistantMsg.parts || assistantMsg.parts.length === 0) {
        assistantMsg.parts = partsBuilder.toArray();
        assistantMsg.tool_calls = partsBuilder.getAllTools();
      }

      // Discard reasoning that is entirely whitespace
      if (assistantMsg.reasoning?.trim() === '') {
        assistantMsg.reasoning = '';
      }

      // If there are images but no content part, add content part at the beginning
      if (partsBuilder.hasImagePart() && !partsBuilder.hasContentPart() && assistantMsg.content) {
        partsBuilder.ensureContentPartFirst(assistantMsg.content);
        assistantMsg.parts = partsBuilder.toArray();
      } else {
        // Final sync of parts to assistantMsg before completing
        assistantMsg.parts = partsBuilder.toArray();
        assistantMsg.tool_calls = partsBuilder.getAllTools();
      }

      // Mark message as complete and set completion time
      const finalUpdates = {
        complete: true,
        completionTime: new Date(),
        reasoningDuration: timing.calculateReasoningDuration()
      };

      // Update local object so RAF doesn't overwrite with stale 'complete: false'
      Object.assign(assistantMsg, finalUpdates);
      updateAssistantMessage(assistantMsg, finalUpdates);

      // Process any memory commands from the completed message content
      if (assistantMsg.content) {
        // Look for memory command patterns in the content
        const memoryCommandPattern = /\{[^}]*"memory_action"[^}]*\}/g;
        const matches = assistantMsg.content.match(memoryCommandPattern);

        if (matches) {
          for (const match of matches) {
            try {
              const command = JSON.parse(match);
              if (command.memory_action) {
                switch (command.memory_action) {
                  case 'add':
                    if (command.fact) {
                      await addMemory(command.fact);
                    }
                    break;
                  case 'modify':
                    if (command.old_fact && command.new_fact) {
                      await modifyMemory(command.old_fact, command.new_fact);
                    }
                    break;
                  case 'delete':
                    if (command.fact) {
                      await deleteMemory(command.fact);
                    }
                    break;
                  case 'list':
                    // list action doesn't require processing here,
                    // since the facts are already available in context
                    break;
                  default:
                    console.log(`Unknown memory action: ${command.memory_action}`);
                }
              }
            } catch (error) {
              console.error(`Error parsing memory command: ${match}`, error);
            }
          }
        }
      }

      // Handle error display - show errors even if there's partial content
      if (assistantMsg.error && assistantMsg.errorDetails) {
        const errorSuffix = `\n\n---\n⚠️ **Error:** ${assistantMsg.errorDetails.message}` +
          (assistantMsg.errorDetails.status ? ` (HTTP ${assistantMsg.errorDetails.status})` : '');

        // IMPORTANT: Also update partsBuilder so the UI/parts array stays in sync with content string
        partsBuilder.appendContent(errorSuffix);

        const errorUpdates = {
          content: assistantMsg.content + errorSuffix,
          parts: partsBuilder.toArray(),
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
   * Changes the current conversation
   * @param {string} id - Conversation ID to load
   */
  async function changeConversation(id) {
    if (isIncognito.value) {
      return;
    }

    chatLoading.value = true;
    messages.value = [];
    branchPath.value = []; // Reset branch path
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
            // Initialize new token fields if they don't exist (for backward compatibility)
            tokenCount: msg.tokenCount || 0,
            totalTokens: msg.totalTokens || 0,
            promptTokens: msg.promptTokens || 0
          };
        }
        return msg;
      });
      branchPath.value = conv.branchPath || [];
    } else {
      messages.value = [];
      branchPath.value = [];
    }

    conversationTitle.value = conv?.title || '';
    chatLoading.value = false;
  }

  /**
   * Edits a user message and creates a new branch
   * @param {string} messageId - The ID of the message to edit
   * @param {string} newContent - The new content for the message
   * @param {Array} attachments - Optional new attachments
   */
  async function editUserMessage(messageId, newContent, attachments = []) {
    const existingMsg = messages.value.find(m => m.id === messageId);
    if (!existingMsg) return;

    // Create a branch from this message with new content
    const branchResult = createBranch(messages.value, messageId, {
      role: "user",
      content: newContent,
      attachments: attachments,
      complete: true
    });

    messages.value = branchResult.messages;
    branchPath.value = branchResult.branchPath;

    // Persist changes
    if (!isIncognito.value) {
      await storeMessages(currConvo.value, toRaw(messages.value), new Date());
      await updateBranchPath(currConvo.value, [...toRaw(branchPath.value)]);
    }

    // Trigger AI response for the new branch
    await sendMessage(newContent, null, attachments, { skipUserMessage: true });
  }

  /**
   * Regenerates an assistant message and creates a new branch
   * @param {string} messageId - The assistant message to regenerate
   */
  async function regenerateAssistantMessage(messageId) {
    const assistantMsg = messages.value.find(m => m.id === messageId);
    if (!assistantMsg || assistantMsg.role !== 'assistant') return;

    // Find the parent user message to get the prompt
    const userMsg = messages.value.find(m => m.id === assistantMsg.parentId);
    if (!userMsg) return;

    // First, let's update the branch path to fork at this point
    const visibleChain = getMessagesForBranchPath(messages.value, branchPath.value);

    // CreateBranch logic for the assistant message
    const branchResult = createBranch(messages.value, assistantMsg.id, {
      role: "assistant",
      content: "",
      complete: false,
      timestamp: new Date()
    });

    // Remove the placeholder message createBranch added, sendMessage will create its own
    const tempMsgId = branchResult.newMessage.id;
    messages.value = branchResult.messages.filter(m => m.id !== tempMsgId);
    branchPath.value = branchResult.branchPath;

    if (!isIncognito.value) {
      await updateBranchPath(currConvo.value, [...toRaw(branchPath.value)]);
    }

    // Send the message using the parent user message's content
    await sendMessage(userMsg.content, null, userMsg.attachments || [], {
      skipUserMessage: true,
      parentId: userMsg.id
    });
  }

  /**
   * Navigates to a different branch
   * @param {string} messageId - The message ID at the fork
   * @param {number} direction - -1 for previous, 1 for next
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
   * @param {string} id - Conversation ID to delete
   */
  async function deleteConversation(id) {
    if (isIncognito.value) {
      return;
    }

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