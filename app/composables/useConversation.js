import { ref, computed, onMounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useHead } from '@unhead/vue';
import localforage from 'localforage';
import { createConversation as storeCreateConversation, storeMessages, deleteConversation as deleteConv } from './storeConversations';
import { handleIncomingMessage } from './message';
import { availableModels, findModelById } from './availableModels';
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
    // Set loading state and create new abort controller
    controller.value = new AbortController();
    isLoading.value = true;

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
    const selectedModelDetails = findModelById(availableModels, settingsManager.settings.selected_model_id);

    if (!selectedModelDetails) {
      console.error("No model selected or model details not found.");
      updateAssistantMessage(assistantMsg, {
        content: (assistantMsg.content ? assistantMsg.content + "\n\n" : "") + "Error: No AI model selected.",
        complete: true
      });
      isLoading.value = false;
      return;
    }

    // Construct model parameters with proper reasoning handling
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

    // Get attachments from the existing user message (if any)
    const userMessageAttachments = lastMessage?.attachments || [];

    try {
      // Pass only the conversation history BEFORE the current user message
      // handleIncomingMessage will add the current user message itself via the query parameter
      // This prevents the user message from being duplicated in the request
      const streamGenerator = handleIncomingMessage(
        messageContent,
        messages.value.filter(msg => msg.complete && msg.content !== messageContent).map(msg => ({
          role: msg.role,
          content: msg.content,
          annotations: msg.annotations  // Pass annotations for PDF reuse
        })),
        controller.value,
        settingsManager.settings.selected_model_id,
        model_parameters,
        settingsManager.settings,
        selectedModelDetails.extra_functions || [],
        settingsManager.settings.parameter_config?.grounding ?? DEFAULT_PARAMETERS.grounding,
        isIncognito.value, // Use current incognito state
        userMessageAttachments  // Pass attachments to API
      );

      // Initialize parts array if not exists
      if (!assistantMsg.parts) {
        assistantMsg.parts = [];
      }

      // Helper to get or create current part based on type
      // Tool groups should only include tools of the SAME TYPE that occurred CONSECUTIVELY
      const ensurePart = (type, toolType = null) => {
        let lastPart = assistantMsg.parts[assistantMsg.parts.length - 1];

        // For tool groups, we need to check both type and toolType to ensure consecutive same-type tools
        if (type === 'tool_group') {
          // Create a new tool group if:
          // 1. No last part exists, OR
          // 2. Last part is not a tool_group, OR
          // 3. Last part is a tool_group but has a different toolType
          if (!lastPart || lastPart.type !== 'tool_group' || lastPart.toolType !== toolType) {
            lastPart = {
              type: 'tool_group',
              toolType: toolType,  // Store the tool type for this group
              tools: []
            };
            assistantMsg.parts.push(lastPart);
          }
        } else {
          // For other types (content, reasoning), create a new part if type differs
          if (!lastPart || lastPart.type !== type) {
            lastPart = { type, content: '' };
            if (type === 'tool_group') {
              lastPart.tools = [];
              delete lastPart.content;
            }
            assistantMsg.parts.push(lastPart);
          }
        }

        return lastPart;
      };

      // Track if we've received the first token
      let firstTokenReceived = false;

      for await (const chunk of streamGenerator) {
        // Process content - only create part if there's actual content to add
        if (chunk.content !== null && chunk.content !== undefined && chunk.content !== '') {
          const part = ensurePart('content');
          part.content += chunk.content;

          assistantMsg.content = (assistantMsg.content || '') + chunk.content;

          // Track first token time
          if (!firstTokenReceived) {
            assistantMsg.firstTokenTime = new Date();
            firstTokenReceived = true;
          }

          if (
            assistantMsg.reasoningStartTime !== null &&
            assistantMsg.reasoningEndTime === null
          ) {
            assistantMsg.reasoningEndTime = new Date();
          }
        }

        // Process reasoning - only create part if there's actual reasoning to add
        if (chunk.reasoning !== null && chunk.reasoning !== undefined && chunk.reasoning !== '' && chunk.reasoning.trim() !== 'None') {
          const part = ensurePart('reasoning');
          part.content += chunk.reasoning;

          assistantMsg.reasoning = (assistantMsg.reasoning || '') + chunk.reasoning;

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
            // Use the tool's type to determine if it should go in the same group
            const toolType = tool.type || 'function';
            const groupPart = ensurePart('tool_group', toolType);

            // Find existing tool in the current group
            let existingTool = groupPart.tools.find(t => t.index === tool.index);

            if (!existingTool) {
              existingTool = {
                index: tool.index,
                id: tool.id || null,
                type: tool.type || 'function',
                function: {
                  name: tool.function?.name || '',
                  arguments: tool.function?.arguments || ''
                }
              };
              groupPart.tools.push(existingTool);

              // Also add to main tool_calls array for backward compatibility
              assistantMsg.tool_calls.push(existingTool);
            } else {
              // Update existing
              if (tool.function?.name) existingTool.function.name = tool.function.name;
              if (tool.function?.arguments) existingTool.function.arguments += tool.function.arguments;
              if (tool.id) existingTool.id = tool.id;
            }
          }
        }

        // Process tool results (custom event from our message.js)
        if (chunk.tool_result) {
          const { id, result } = chunk.tool_result;
          // Find the tool in any part and update it
          for (const part of assistantMsg.parts) {
            if (part.type === 'tool_group') {
              const tool = part.tools.find(t => t.id === id);
              if (tool) {
                tool.result = result;
              }
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
          parts: assistantMsg.parts ? [...assistantMsg.parts.map(part => {
            // For tool groups, copy the tools array
            if (part.type === 'tool_group') {
              return { ...part, tools: [...part.tools] };
            }
            // For other parts, just copy the part
            return { ...part };
          })] : null,
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

      // Reset loading state
      isLoading.value = false;

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