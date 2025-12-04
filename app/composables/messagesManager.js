import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import localforage from 'localforage';
import { createConversation as createNewConversation, storeMessages, deleteConversation as deleteConv } from './storeConversations';
import { handleIncomingMessage } from './message';
import { availableModels } from './availableModels';
import { addMemory, modifyMemory, deleteMemory, listMemory } from './memory';
import DEFAULT_PARAMETERS from './defaultParameters';
import { useSettings } from './useSettings';
import { useGlobalIncognito } from './useGlobalIncognito';
import { emitter } from './emitter';

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
  const isLoading = ref(false);
  const controller = ref(new AbortController());
  const currConvo = ref('');
  const conversationTitle = ref('');
  const isTyping = ref(false);
  const chatLoading = ref(false);

  // Make availableModels accessible
  settingsManager.availableModels = availableModels;

  // Computed properties
  const hasMessages = computed(() => messages.value.length > 0);
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
   */
  function addUserMessage(content) {
    if (!content.trim()) return;

    const userMessage = {
      id: generateId(),
      role: "user",
      content: content,
      timestamp: new Date(),
      complete: true,
    };

    messages.value.push(userMessage);
  }

  /**
   * Creates a new assistant message and adds it to the messages array
   * @returns {Object} The created assistant message object
   */
  function createAssistantMessage() {
    const assistantMsg = {
      id: generateId(),
      role: "assistant",
      reasoning: "",
      content: "",
      tool_calls: [],
      timestamp: new Date(),
      complete: false,
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
      errorDetails: null
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
      // Use Vue's array mutation method to ensure reactivity
      messages.value.splice(index, 1, { ...messages.value[index], ...updates });
    }
  }

  /**
   * Sends a message to the AI and handles the response
   * @param {string} message - The user's message
   * @param {string} originalMessage - The original user message (before any reasoning prepends)
   */
  async function sendMessage(message, originalMessage = null) {
    if (!message.trim() || isLoading.value) return;

    controller.value = new AbortController();
    isLoading.value = true;
    isTyping.value = false;

    // Add user message using the original message (without /no_think prepended)
    const messageToStore = originalMessage !== null ? originalMessage : message;
    addUserMessage(messageToStore);

    // Create assistant message
    const assistantMsg = createAssistantMessage();

    // Create conversation if needed
    if (!currConvo.value && !isIncognito.value) {
      currConvo.value = await createNewConversation(messages.value, new Date());
      if (currConvo.value) {
        const convData = await localforage.getItem(`conversation_${currConvo.value}`);
        conversationTitle.value = convData?.title || "";
      }
    }

    await nextTick();
    // Use requestAnimationFrame for more reliable scrolling
    requestAnimationFrame(() => {
      chatPanel?.value?.scrollToEnd("smooth");
    });

    // Get current model details
    const selectedModelDetails = findModelById(settingsManager.availableModels, settingsManager.settings.selected_model_id);

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
    const savedReasoningEffort = settingsManager.getModelSetting(selectedModelDetails.id, "reasoning_effort") ||
      (selectedModelDetails.extra_parameters?.reasoning_effort?.[1] || "default");

    const parameterConfig = settingsManager.settings.parameter_config || { ...DEFAULT_PARAMETERS };

    // Check if this model has toggleable reasoning [true, false]
    const hasToggleableReasoning = Array.isArray(selectedModelDetails.reasoning) &&
      selectedModelDetails.reasoning.length === 2 &&
      selectedModelDetails.reasoning[0] === true &&
      selectedModelDetails.reasoning[1] === false;

    const model_parameters = {
      ...parameterConfig,
      ...selectedModelDetails.extra_parameters,
      reasoning: hasToggleableReasoning
        ? {
          effort: savedReasoningEffort,
          enabled: savedReasoningEffort !== 'none'
        }
        : { effort: savedReasoningEffort }
    };

    try {
      // Pass only the conversation history BEFORE the current user message
      // handleIncomingMessage will add the current user message itself via the query parameter
      // This prevents the user message from being duplicated in the request
      const streamGenerator = handleIncomingMessage(
        message,
        messages.value.filter(msg => msg.complete && msg.content !== messageToStore).map(msg => ({
          role: msg.role,
          content: msg.content
        })),
        controller.value,
        settingsManager.settings.selected_model_id,
        model_parameters,
        settingsManager.settings,
        selectedModelDetails.extra_functions || [],
        settingsManager.settings.parameter_config?.grounding ?? DEFAULT_PARAMETERS.grounding,
        isIncognito.value
      );

      // Track if we've received the first token
      let firstTokenReceived = false;

      for await (const chunk of streamGenerator) {
        // Process content
        if (chunk.content !== null && chunk.content !== undefined) {
          assistantMsg.content += chunk.content;

          // Track first token time
          if (!firstTokenReceived) {
            assistantMsg.firstTokenTime = new Date();
            firstTokenReceived = true;
          }

          // Token counting is now handled by the usage object from OpenRouter API

          if (
            chunk.content &&
            assistantMsg.reasoningStartTime !== null &&
            assistantMsg.reasoningEndTime === null
          ) {
            assistantMsg.reasoningEndTime = new Date();
          }
        }

        // Process reasoning
        if (chunk.reasoning !== null && chunk.reasoning !== undefined) {
          // Check if the accumulated reasoning is currently only whitespace, and if so, clear it before adding new content
          if (assistantMsg.reasoning.trim() === '') {
            // If the new chunk is not whitespace, replace the entire reasoning content
            if (chunk.reasoning.trim() !== '') {
              assistantMsg.reasoning = chunk.reasoning;
            } else {
              // If both the accumulated reasoning and new chunk are whitespace, append them normally
              assistantMsg.reasoning += chunk.reasoning;
            }
          } else {
            // If the accumulated reasoning already has non-whitespace content, append normally
            assistantMsg.reasoning += chunk.reasoning;
          }

          // Track first token time for reasoning
          if (!firstTokenReceived) {
            assistantMsg.firstTokenTime = new Date();
            firstTokenReceived = true;
          }

          // Token counting is now handled by the usage object from OpenRouter API

          if (assistantMsg.reasoningStartTime === null) {
            assistantMsg.reasoningStartTime = new Date();
          }
        }


        // Process tool calls that come in through the streaming
        if (chunk.tool_calls && chunk.tool_calls.length > 0) {
          for (const tool of chunk.tool_calls) {
            // Accumulate tool call information as it comes in through streaming
            const existingToolIndex = assistantMsg.tool_calls.findIndex(t => t.index === tool.index);
            if (existingToolIndex >= 0) {
              // Merge new information with existing tool call
              const existingTool = assistantMsg.tool_calls[existingToolIndex];

              // Update function name if provided
              if (tool.function?.name) {
                existingTool.function.name = tool.function.name;
              }

              // Accumulate function arguments if provided
              if (tool.function?.arguments) {
                if (!existingTool.function.arguments) {
                  existingTool.function.arguments = tool.function.arguments;
                } else {
                  existingTool.function.arguments += tool.function.arguments;
                }
              }

              // Update id and type if provided
              if (tool.id) {
                existingTool.id = tool.id;
              }
              if (tool.type) {
                existingTool.type = tool.type;
              }
            } else {
              // Add new tool call with initial data
              assistantMsg.tool_calls.push({
                index: tool.index,
                id: tool.id || null,
                type: tool.type || 'function',
                function: {
                  name: tool.function?.name || '',
                  arguments: tool.function?.arguments || ''
                }
              });
            }
          }
        }

        // Process usage information from OpenRouter
        if (chunk.usage) {
          // Update token count using the actual completion tokens from OpenRouter
          if (chunk.usage.completion_tokens !== undefined) {
            // Set the actual token count from API instead of accumulating
            assistantMsg.tokenCount = chunk.usage.completion_tokens;
          }
          // Also handle other token counts if available
          if (chunk.usage.total_tokens !== undefined) {
            assistantMsg.totalTokens = chunk.usage.total_tokens;
          }
          if (chunk.usage.prompt_tokens !== undefined) {
            assistantMsg.promptTokens = chunk.usage.prompt_tokens;
          }
        }

        // Update the messages array with a new object to trigger reactivity
        // Create a new object with a copy of the assistantMsg to ensure reactivity
        const updatedMsg = {
          ...assistantMsg,
          tool_calls: [...assistantMsg.tool_calls], // Create a new array to ensure reactivity
          tokenCount: assistantMsg.tokenCount,
          totalTokens: assistantMsg.totalTokens,
          promptTokens: assistantMsg.promptTokens
        };
        // Use Vue's array mutation method to ensure reactivity
        messages.value.splice(messages.value.length - 1, 1, updatedMsg);

        // Allow Vue to render updates before scrolling
        await new Promise(resolve => setTimeout(resolve, 0));

        if (chatPanel?.value?.isAtBottom) {
          chatPanel.value.scrollToEnd("smooth");
        }
      }

    } catch (error) {
      console.error('Error in stream processing:', error);
    } finally {
      // Discard reasoning that is entirely whitespace
      if (assistantMsg.reasoning && assistantMsg.reasoning.trim() === '') {
        assistantMsg.reasoning = '';
      }

      // Mark message as complete and set completion time
      updateAssistantMessage(assistantMsg, {
        complete: true,
        completionTime: new Date(),
        reasoningDuration: assistantMsg.reasoningStartTime !== null ?
          (assistantMsg.reasoningEndTime !== null ?
            assistantMsg.reasoningEndTime.getTime() - assistantMsg.reasoningStartTime.getTime() :
            new Date().getTime() - assistantMsg.reasoningStartTime.getTime()) :
          null
      });

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

      // Handle error display
      if (assistantMsg.complete && !assistantMsg.content && assistantMsg.errorDetails) {
        updateAssistantMessage(assistantMsg, {
          content: `\n[ERROR: ${assistantMsg.errorDetails.message}]` +
            (assistantMsg.errorDetails.status ? ` HTTP ${assistantMsg.errorDetails.status}` : '')
        });
      }

      isLoading.value = false;

      // Store messages if not in incognito mode
      if (!isIncognito.value) {
        await storeMessages(currConvo.value, messages.value, new Date());
      }
    }
  }

  /**
   * Helper function to find a model by ID
   * @param {Array} models - Array of models to search
   * @param {string} id - Model ID to find
   * @returns {Object|null} Found model or null
   */
  function findModelById(models, id) {
    for (const model of models) {
      if (model.id === id) {
        return model;
      }
      if (model.models && Array.isArray(model.models)) {
        const found = findModelById(model.models, id);
        if (found) {
          return found;
        }
      }
    }
    return null;
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
    currConvo.value = id;

    const conv = await localforage.getItem(`conversation_${currConvo.value}`);
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
    } else {
      messages.value = [];
    }

    conversationTitle.value = conv?.title || '';
    chatLoading.value = false;
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
    // Reactive state
    messages,
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
    setChatPanel
  };
}