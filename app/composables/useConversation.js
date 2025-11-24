import { ref, computed, onMounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useHead } from '@unhead/vue';
import localforage from 'localforage';
import { createConversation as storeCreateConversation, storeMessages, deleteConversation as deleteConv } from './storeConversations';
import { handleIncomingMessage } from './message';
import { availableModels } from './availableModels';
import { addMemory, modifyMemory, deleteMemory, listMemory } from './memory';
import DEFAULT_PARAMETERS from './defaultParameters';
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
  async function createNewConversationWithMessage(initialMessage) {
    // First, add the initial user message to the current messages array
    const initialUserMessage = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
      role: "user",
      content: initialMessage,
      timestamp: new Date(),
      complete: true,
    };

    // Add the message to the current messages
    messages.value.push(initialUserMessage);

    // Create the conversation in storage with this message - using the storeConversations function
    const conversationId = await storeCreateConversation(messages.value, new Date());

    // Update current conversation to point to the new one
    currConvo.value = conversationId;

    return conversationId;
  }

  // Function to send a message to the AI and get a response (for initial messages)
  async function sendInitialMessageToAI(messageContent) {
    // Check if the last message is already the user's message with the same content
    // This prevents duplication when called from index.vue after createNewConversationWithMessage
    let lastMessage = messages.value.length > 0 ? messages.value[messages.value.length - 1] : null;
    let userMessageAlreadyExists = lastMessage &&
                                   lastMessage.role === "user" &&
                                   lastMessage.content === messageContent;

    // Add the user's message to the messages array if it doesn't already exist
    if (!userMessageAlreadyExists) {
      const userMessage = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
        role: "user",
        content: messageContent,
        timestamp: new Date(),
        complete: true,
      };

      messages.value.push(userMessage);
    }

    // Create an assistant message placeholder
    const assistantMsg = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
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

    // Get current model details
    const selectedModelDetails = findModelById(settingsManager.availableModels, settingsManager.settings.selected_model_id);

    if (!selectedModelDetails) {
      console.error("No model selected or model details not found.");
      updateAssistantMessage(assistantMsg, {
        content: (assistantMsg.content ? assistantMsg.content + "\n\n" : "") + "Error: No AI model selected.",
        complete: true
      });
      return;
    }

    // Construct model parameters (simplified for this function)
    const parameterConfig = settingsManager.settings.parameter_config || { ...DEFAULT_PARAMETERS };

    const model_parameters = {
      ...parameterConfig,
      ...selectedModelDetails.extra_parameters
    };

    try {
      const streamGenerator = handleIncomingMessage(
        messageContent,
        messages.value.filter(msg => msg.complete).map(msg => ({
          role: msg.role,
          content: msg.content
        })),
        controller.value,
        settingsManager.settings.selected_model_id,
        model_parameters,
        settingsManager.settings,
        selectedModelDetails.extra_functions || [],
        settingsManager.settings.parameter_config?.grounding ?? DEFAULT_PARAMETERS.grounding,
        isIncognito.value // Use current incognito state
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

          if (chunk.content &&
              assistantMsg.reasoningStartTime !== null &&
              assistantMsg.reasoningEndTime === null) {
            assistantMsg.reasoningEndTime = new Date();
          }
        }

        // Process reasoning
        if (chunk.reasoning !== null && chunk.reasoning !== undefined) {
          assistantMsg.reasoning += chunk.reasoning;

          // Track first token time for reasoning
          if (!firstTokenReceived) {
            assistantMsg.firstTokenTime = new Date();
            firstTokenReceived = true;
          }

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
        const index = messages.value.findIndex(m => m.id === assistantMsg.id);
        if (index !== -1) {
          messages.value.splice(index, 1, updatedMsg);
        }

        // Allow Vue to render updates
        await new Promise(resolve => setTimeout(resolve, 0));
      }

    } catch (error) {
      console.error('Error in stream processing:', error);
    } finally {
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

      // Handle error display
      if (assistantMsg.complete && !assistantMsg.content && assistantMsg.errorDetails) {
        updateAssistantMessage(assistantMsg, {
          content: `\n[ERROR: ${assistantMsg.errorDetails.message}]` +
            (assistantMsg.errorDetails.status ? ` HTTP ${assistantMsg.errorDetails.status}` : '')
        });
      }

      // Store messages if not in incognito mode
      if (!isIncognito.value) {
        await storeMessages(currConvo.value, messages.value, new Date());
      }
    }
  }

  // Helper function to update assistant message
  function updateAssistantMessage(message, updates) {
    const index = messages.value.findIndex(m => m.id === message.id);
    if (index !== -1) {
      // Use Vue's array mutation method to ensure reactivity
      messages.value.splice(index, 1, { ...messages.value[index], ...updates });
    }
  }

  // Helper function to find a model by ID
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

  return {
    // State
    messages,
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
    changeConversation,
    deleteConversation,
    newConversation,
    toggleIncognito,
    setChatPanel: messagesManager.setChatPanel, // Add the method from messages manager
    createNewConversationWithMessage, // Added new function for creating conversation with first message
    sendInitialMessageToAI, // Added function to send initial message and get AI response

    // Additional utilities
    router,
    route
  };
}