/**
 * @file message.js
 * @description Core logic for the Libre Assistant API Interface, handling Hack Club LLM endpoint configuration
 * and streaming responses using manual fetch() processing.
 */

import {
  availableModels,
  findModelById,
  DEFAULT_MODEL_ID,
  buildReasoningParams,
} from "~/composables/availableModels";
import { generateSystemPrompt } from "~/composables/systemPrompt";
import { findRelevantMemories } from "~/composables/memory";
import { toolManager } from "~/composables/toolsManager";

/**
 * Formats a message object for the API, handling multimodal content including:
 * - User attachments (images, PDFs)
 * - Assistant generated images
 * - Reasoning/thinking content
 * - Tool calls and results
 * 
 * @param {Object} msg - The message object from the messages array
 * @returns {Object} Formatted message for the API
 */
function formatMessageForAPI(msg) {
  const baseMessage = { role: msg.role };

  // Handle annotations for PDF reuse
  if (msg.annotations) {
    baseMessage.annotations = msg.annotations;
  }

  // User messages: handle attachments
  if (msg.role === "user") {
    if (msg.attachments && msg.attachments.length > 0) {
      const contentParts = [{ type: "text", text: msg.content || "" }];

      for (const attachment of msg.attachments) {
        if (attachment.type === "image") {
          contentParts.push({
            type: "image_url",
            image_url: { url: attachment.dataUrl }
          });
        } else if (attachment.type === "pdf") {
          contentParts.push({
            type: "file",
            file: {
              filename: attachment.filename,
              file_data: attachment.dataUrl
            }
          });
        }
      }

      baseMessage.content = contentParts;
    } else {
      baseMessage.content = msg.content || "";
    }
    return baseMessage;
  }

  // Assistant messages: handle parts (reasoning, content, images, tool_calls)
  if (msg.role === "assistant") {
    // If message has structured parts, build multimodal content
    if (msg.parts && msg.parts.length > 0) {
      const contentParts = [];

      for (const part of msg.parts) {
        switch (part.type) {
          case "reasoning":
            if (part.content && part.content.trim()) {
              contentParts.push({
                type: "text",
                text: `<thinking>\n${part.content}\n</thinking>`
              });
            }
            break;

          case "content":
            if (part.content && part.content.trim()) {
              contentParts.push({
                type: "text",
                text: part.content
              });
            }
            break;

          case "image":
            if (part.images && part.images.length > 0) {
              for (const img of part.images) {
                if (img.url) {
                  contentParts.push({
                    type: "image_url",
                    image_url: { url: img.url }
                  });
                }
              }
            }
            break;
        }
      }

      if (contentParts.length > 0) {
        const hasNonText = contentParts.some(p => p.type !== "text");
        if (hasNonText) {
          baseMessage.content = contentParts;
        } else {
          baseMessage.content = contentParts.map(p => p.text).join("\n\n");
        }
      } else {
        baseMessage.content = msg.content || "";
      }
    } else {
      let content = msg.content || "";
      if (msg.reasoning && msg.reasoning.trim()) {
        content = `<thinking>\n${msg.reasoning}\n</thinking>\n\n${content}`;
      }
      baseMessage.content = content;
    }

    // CRITICAL: Include tool calls in assistant messages for history
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      baseMessage.tool_calls = JSON.parse(JSON.stringify(msg.tool_calls));
    }

    // Allow message even if content is empty but it has tool calls
    const hasContent = (baseMessage.content && (
      (Array.isArray(baseMessage.content) && baseMessage.content.length > 0) ||
      (typeof baseMessage.content === 'string' && baseMessage.content.trim().length > 0)
    ));

    const hasToolCalls = baseMessage.tool_calls && baseMessage.tool_calls.length > 0;

    if (!hasContent && !hasToolCalls) {
      return null;
    }

    return baseMessage;
  }

  // Tool messages (for tool results in conversation)
  if (msg.role === "tool") {
    return {
      role: "tool",
      tool_call_id: msg.tool_call_id,
      name: msg.name,
      content: msg.content || ""
    };
  }

  // Fallback for any other role
  baseMessage.content = msg.content || "";
  return baseMessage;
}

/**
 * Main entry point for processing all incoming user messages for the API interface.
 * It determines the correct API configuration and streams the LLM response.
 *
 * MESSAGE ASSEMBLY CONTRACT:
 * - `plainMessages` should contain conversation history WITHOUT the current user message
 * - This function ADDS the current user message to the API request
 * - This ensures no duplication between history and the current turn
 *
 * The final messages array sent to the API is:
 *   [systemPrompt, ...plainMessages (history), { role: "user", content: query }]
 *
 * @param {string} query - The user's message (current turn)
 * @param {Array} plainMessages - Conversation history WITHOUT the current user message
 * @param {AbortController} controller - AbortController instance for cancelling API requests
 * @param {string} selectedModel - The model chosen by the user
 * @param {object} modelParameters - Object containing all configurable model parameters (temperature, top_p, seed, reasoning)
 * @param {object} settings - User settings object containing user_name, user_occupation, and custom_instructions
 * @param {string[]} toolNames - Array of available tool names
 * @param {boolean} isSearchEnabled - Whether the browser search tool is enabled
 * @param {boolean} isIncognito - Whether incognito mode is enabled
 * @param {Array} attachments - Array of file attachments [{ type: 'image'|'pdf', filename, dataUrl, mimeType }]
 * @yields {Object} A chunk object with content and/or reasoning
 * @property {string|null} content - The main content of the response chunk
 * @property {string|null} reasoning - Any reasoning information included in the response chunk
 **/
export async function* handleIncomingMessage(
  query,
  plainMessages,
  controller,
  selectedModel = DEFAULT_MODEL_ID,
  modelParameters = {},
  settings = {},
  toolNames = [],
  isSearchEnabled = false,
  isIncognito = false,
  attachments = []
) {
  try {
    // Validate required parameters
    if (!query || !plainMessages || !controller) {
      throw new Error("Missing required parameters for handleIncomingMessage");
    }

    // Check if API is up and has available quota
    try {
      const healthResponse = await fetch("/api/api_health");
      const health = await healthResponse.json();

      // Check for various unavailability conditions
      if (health.status === "down" || health.dailyKeyUsageRemaining <= 0 || health.balanceRemaining <= 0) {
        let message = "⚠️ **Service Unavailable**\n\n";

        if (health.dailyKeyUsageRemaining !== undefined && health.dailyKeyUsageRemaining <= 0) {
          message += "Daily API budget exhausted. Try again tomorrow or add your own API key in Settings → General.";
        } else if (health.balanceRemaining !== undefined && health.balanceRemaining <= 0) {
          message += "API balance depleted. Service temporarily unavailable.";
        } else {
          message += "Service temporarily unavailable. Please try again later.";
        }

        yield { content: message, reasoning: null };
        return;
      }
    } catch (error) {
      console.error("Health check failed:", error);
      // We'll continue anyway, in case it was just the health check endpoint failing
    }

    // Find the selected model info
    const selectedModelInfo = findModelById(availableModels, selectedModel);

    // Load memory facts if memory is enabled and not in incognito mode
    let memoryFacts = [];
    if (settings.global_memory_enabled && !isIncognito) {
      // Use semantic search to find relevant memories based on the user's query
      // This retrieves all global memories + local memories above similarity threshold
      // Pass message history for better contextual embeddings
      memoryFacts = await findRelevantMemories(
        query,
        settings.memory_similarity_threshold || 0.65,
        plainMessages
      );
    }

    // Determine which tools are actually being used
    // First, check if the selected model supports tool use (defaults to true if not specified)
    const modelHasToolUse = selectedModelInfo?.tool_use !== false; // Default to true unless explicitly false

    const enabledToolNames = [];
    if (modelHasToolUse && settings.global_memory_enabled && !isIncognito) {
      enabledToolNames.push(
        "listMemory",
        "addMemory",
        "modifyMemory",
        "deleteMemory"
      );
    }

    // Enable search tool if enabled in settings/params
    if (modelHasToolUse && isSearchEnabled) {
      enabledToolNames.push("search");
    }

    // Generate system prompt based on settings and used tools
    // In incognito mode, use empty settings to avoid customization
    const systemPrompt = await generateSystemPrompt(
      enabledToolNames,
      isIncognito ? {} : settings,
      memoryFacts,
      isIncognito, // Pass incognito mode state
      modelHasToolUse // Pass tool use capability
    );

    // Build user message content based on attachments
    let userMessageContent;

    if (attachments && attachments.length > 0) {
      // Multimodal message format with content parts
      const contentParts = [{ type: "text", text: query }];

      for (const attachment of attachments) {
        if (attachment.type === "image") {
          // Image format for vision models
          contentParts.push({
            type: "image_url",
            image_url: {
              url: attachment.dataUrl,
            },
          });
        } else if (attachment.type === "pdf") {
          // PDF format - uses file-parser plugin with mistral-ocr
          contentParts.push({
            type: "file",
            file: {
              filename: attachment.filename,
              file_data: attachment.dataUrl,
            },
          });
        }
      }

      userMessageContent = contentParts;
    } else {
      // Simple text message
      userMessageContent = query;
    }

    // Build base messages for this user turn
    // History messages are formatted with full multimodal support (images, reasoning, tool calls)
    const baseMessages = [
      { role: "system", content: systemPrompt },
      ...plainMessages.map(formatMessageForAPI).filter(m => m !== null),
      { role: "user", content: userMessageContent },
    ];

    // Used only inside this turn for tool rounds
    let intermediateMessages = []; // assistant(tool_calls) + tool messages from this turn

    // Tools
    const enabledToolSchemas = enabledToolNames.length
      ? toolManager.getSchemasByNames(enabledToolNames)
      : [];

    // Agent loop config
    // Model supports tools only if it has tool_use enabled AND there are tools available
    const modelSupportsTools = modelHasToolUse && enabledToolSchemas.length > 0;
    // No default limit - let models iterate as needed. User can set limit in settings if desired.
    const maxToolIterations = settings.tool_max_iterations ?? Infinity;
    let iteration = 0;

    while (true) {
      // Build messages for this call
      const messagesForThisCall = [...baseMessages, ...intermediateMessages];

      // Build request body for this call
      const plugins = [];

      const requestBody = {
        model: selectedModel,
        messages: messagesForThisCall,
        stream: true,
        ...(plugins.length > 0 && { plugins }),
        ...(modelSupportsTools && {
          tools: enabledToolSchemas,
          tool_choice: "auto",
        }),
        // Add model parameters, but filter out invalid ones
        ...(modelParameters && {
          temperature: modelParameters.temperature,
          top_p: modelParameters.top_p,
          seed: modelParameters.seed,
        }),
        // Pass custom API key if set
        ...(settings.custom_api_key && { customApiKey: settings.custom_api_key }),
      };

      // Add reasoning parameters using the new buildReasoningParams helper
      if (selectedModelInfo) {
        const userSettings = {
          reasoning_effort: modelParameters?.reasoning?.effort
        };
        
        const { reasoningParams, alternateModel } = buildReasoningParams(selectedModelInfo, userSettings);
        
        // If there's an alternate model, use it
        if (alternateModel) {
          requestBody.model = alternateModel;
        }
        
        // Add reasoning parameters if any
        if (reasoningParams) {
          requestBody.reasoning = reasoningParams;
        }
      }

      // Perform ONE streaming completion and inspect for tool_calls
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error?.message || "Unknown error";

        throw new Error(
          `API request failed with status ${response.status}: ${errorMessage}`
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Tool call accumulation
      const toolCallAccumulator = {};
      let hadToolCalls = false;
      let finishedReason = null;

      // Reasoning tracking if needed
      let reasoningStarted = false;
      let reasoningStartTime = null;

      // Stream timeout configuration (60 seconds of inactivity)
      const STREAM_TIMEOUT_MS = 60000;
      let streamTimeoutId = null;

      const resetStreamTimeout = () => {
        if (streamTimeoutId) clearTimeout(streamTimeoutId);
        streamTimeoutId = setTimeout(() => {
          reader.cancel("Stream timeout: no data received for 60 seconds");
        }, STREAM_TIMEOUT_MS);
      };

      const clearStreamTimeout = () => {
        if (streamTimeoutId) clearTimeout(streamTimeoutId);
      };

      try {
        resetStreamTimeout(); // Start the timeout
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          resetStreamTimeout(); // Reset timeout on each chunk received

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;

            const data = line.slice(6);
            if (data === "[DONE]") {
              break;
            }

            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch (error) {
              continue;
            }

            if (parsed.error) {
              yield {
                content: `\n\n[ERROR: ${parsed.error.message}]`,
                reasoning: null,
                error: true,
                errorDetails: {
                  name: parsed.error.type || "APIError",
                  message: parsed.error.message,
                },
              };
              throw new Error(parsed.error.message || "API error");
            }

            if (parsed.choices && parsed.choices[0]) {
              const choice = parsed.choices[0];

              // 1) Accumulate tool_calls
              if (choice.delta?.tool_calls) {
                hadToolCalls = true;
                for (const toolCallDelta of choice.delta.tool_calls) {
                  const index = toolCallDelta.index;
                  const existing = toolCallAccumulator[index] || {
                    id: toolCallDelta.id,
                    type: toolCallDelta.type || "function",
                    function: {
                      name: "",
                      arguments: "",
                    },
                  };

                  if (toolCallDelta.id) existing.id = toolCallDelta.id;
                  if (toolCallDelta.function?.name) {
                    existing.function.name = toolCallDelta.function.name;
                  }
                  if (toolCallDelta.function?.arguments) {
                    existing.function.arguments +=
                      toolCallDelta.function.arguments;
                  }

                  toolCallAccumulator[index] = existing;
                }
              }

              // 2) Detect finish_reason
              if (choice.finish_reason) {
                finishedReason = choice.finish_reason;
              }

              // 3) Yield content
              if (choice.delta?.content) {
                // If we have reasoning enabled and we're getting text content,
                // this means the reasoning phase is complete
                if (
                  modelParameters.reasoning?.enabled &&
                  !reasoningStarted &&
                  choice.delta.content
                ) {
                  reasoningStarted = true;
                }

                yield {
                  content: choice.delta.content,
                  reasoning: null,
                  tool_calls: choice.delta?.tool_calls || [],
                };
              }

              // 4) Yield reasoning
              if (choice.delta?.reasoning) {
                // Track when reasoning starts
                if (!reasoningStartTime) {
                  reasoningStartTime = new Date();
                }

                yield {
                  content: null,
                  reasoning: choice.delta.reasoning,
                  tool_calls: choice.delta?.tool_calls || [],
                };
              }

              // 5) Yield tool calls delta if present
              if (choice.delta?.tool_calls) {
                yield {
                  content: null,
                  reasoning: null,
                  tool_calls: choice.delta.tool_calls,
                };
              }

              // 6) Yield usage if present
              if (parsed.usage) {
                yield {
                  content: null,
                  reasoning: null,
                  tool_calls: [],
                  usage: parsed.usage,
                };
              }

              // 7) Capture annotations (for PDF reuse)
              const annotations =
                choice.message?.annotations ||
                choice.delta?.annotations ||
                parsed.annotations;
              if (annotations) {
                yield {
                  content: null,
                  reasoning: null,
                  tool_calls: [],
                  annotations: annotations,
                };
              }

              // First check delta (for streaming image chunks)
              const images =
                choice.delta?.images;

              if (images && images.length > 0) {
                yield {
                  content:
                    choice.delta?.content !== undefined
                      ? choice.delta.content
                      : choice.message?.content !== undefined
                        ? choice.message.content
                        : null,
                  reasoning: null,
                  tool_calls: [],
                  images: images,
                };
              }
            }

            // If finish_reason is "tool_calls", we can stop consuming more
            if (finishedReason === "tool_calls") {
              break;
            }
          }
        }
      } finally {
        clearStreamTimeout();
        reader.releaseLock();
      }

      const completedToolCalls = Object.values(toolCallAccumulator);

      if (!hadToolCalls || !modelSupportsTools) {
        // This call ended with a normal answer ("stop", "length", etc.)
        break;
      }

      // If we hit here, this call finished with tool_calls
      iteration++;
      if (iteration >= maxToolIterations) {
        // Avoid infinite loops
        break;
      }

      // Execute tools locally and append tool messages
      const toolResultMessages = await executeToolCallsLocally(
        completedToolCalls,
        plainMessages
      );

      // Yield tool results so the UI can update the widgets
      for (const toolMsg of toolResultMessages) {
        yield {
          tool_result: {
            id: toolMsg.tool_call_id,
            result: toolMsg.content,
          },
        };
      }

      // Keep these for next iteration
      intermediateMessages.push(
        {
          role: "assistant",
          content: "", // Empty string instead of null to satisfy OpenRouter validation
          tool_calls: completedToolCalls.map((tc) => ({
            id: tc.id,
            type: tc.type,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        },
        ...toolResultMessages
      );

      // Loop again: next iteration will call the model with updated messages
    }
  } catch (error) {
    // Handle abort errors specifically
    if (error.name === "AbortError") {
      yield { content: "\n\n[STREAM CANCELED]", reasoning: null };
      return;
    }

    const errorMessage = error.message || "No detailed information";
    yield {
      content: `\n\n[CRITICAL ERROR: Libre Assistant failed to dispatch request. ${errorMessage}]`,
      reasoning: null,
      error: true,
      errorDetails: {
        name: error.name || "UnknownError",
        message: errorMessage,
        rawError: error.toString(),
      },
    };
  }
}

// Helper function to execute tool calls locally with toolManager
async function executeToolCallsLocally(
  completedToolCalls,
  messageHistory = []
) {
  const toolResultMessages = [];

  for (const toolCall of completedToolCalls) {
    const name = toolCall.function.name;
    let args = {};

    try {
      args = JSON.parse(toolCall.function.arguments || "{}");
    } catch (err) {
      console.error(
        "Failed to parse tool arguments:",
        toolCall.function.arguments,
        err
      );
      // Return error to model instead of executing with empty/malformed args
      toolResultMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name,
        content: JSON.stringify({ error: `Invalid JSON in tool arguments: ${err.message}` }),
      });
      continue;
    }

    const tool = toolManager.getTool(name);
    if (!tool) {
      console.warn(`Tool not found: ${name}`);
      toolResultMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name,
        content: `{"error": "Unknown tool '${name}'"}`,
      });
      continue;
    }

    try {
      // Pass message history to tool executor for context
      const result = await tool.executor(args, messageHistory);
      toolResultMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name,
        content: JSON.stringify(result ?? null),
      });
    } catch (err) {
      console.error(`Error executing tool "${name}"`, err);
      toolResultMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name,
        content: JSON.stringify({
          error: `Tool execution failed: ${err.message || String(err)}`,
        }),
      });
    }
  }

  return toolResultMessages;
}
