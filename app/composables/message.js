/**
 * @file message.js
 * @description Core logic for the Libre Assistant API Interface, handling Hack Club LLM endpoint configuration
 * and streaming responses using manual fetch() processing.
 * 
 * Tool Calling Architecture (Industry Standard):
 * - One assistant message per turn contains ALL parts (content, tool_calls, tool_results)
 * - Agent loop: Stream → Detect Tool Calls → Execute → Continue Stream
 * - Clean separation between streaming accumulation and message formatting
 */

import {
  availableModels,
  findModelById,
  DEFAULT_MODEL_ID,
  buildReasoningParams,
} from "~/composables/availableModels";
import { generateSystemPrompt } from "~/composables/systemPrompt";
import { toolManager } from "~/composables/toolsManager";
import { getSessionToken } from "~/composables/useSession";

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
            image_url: { url: attachment.dataUrl },
          });
        } else if (attachment.type === "pdf") {
          contentParts.push({
            type: "file",
            file: {
              filename: attachment.filename,
              file_data: attachment.dataUrl,
            },
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
                text: `<thinking>\n${part.content}\n</thinking>`,
              });
            }
            break;

          case "content":
            if (part.content && part.content.trim()) {
              contentParts.push({
                type: "text",
                text: part.content,
              });
            }
            break;

          case "image":
            if (part.images && part.images.length > 0) {
              for (const img of part.images) {
                if (img.url) {
                  contentParts.push({
                    type: "image_url",
                    image_url: { url: img.url },
                  });
                }
              }
            }
            break;
        }
      }

      if (contentParts.length > 0) {
        const hasNonText = contentParts.some((p) => p.type !== "text");
        if (hasNonText) {
          baseMessage.content = contentParts;
        } else {
          baseMessage.content = contentParts.map((p) => p.text).join("\n\n");
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
    const hasContent =
      baseMessage.content &&
      ((Array.isArray(baseMessage.content) && baseMessage.content.length > 0) ||
        (typeof baseMessage.content === "string" &&
          baseMessage.content.trim().length > 0));

    const hasToolCalls =
      baseMessage.tool_calls && baseMessage.tool_calls.length > 0;

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
      content: msg.content || "",
    };
  }

  // Fallback for any other role
  baseMessage.content = msg.content || "";
  return baseMessage;
}

/**
 * Accumulates streaming chunks and tracks tool calls
 */
class StreamAccumulator {
  constructor() {
    this.content = "";
    this.reasoning = "";
    this.toolCalls = new Map(); // index -> toolCall
    this.hasToolCalls = false;
    this.usage = null;
    this.annotations = null;
    this.images = [];
    this.finished = false;
    this.finishReason = null;
  }

  /**
   * Process a streaming chunk from the API
   */
  processChunk(chunk) {
    // Track finish reason
    if (chunk.choices?.[0]?.finish_reason) {
      this.finishReason = chunk.choices[0].finish_reason;
    }

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;

    // Accumulate content
    if (delta.content) {
      this.content += delta.content;
    }

    // Accumulate reasoning
    if (delta.reasoning && delta.reasoning.trim() !== "None") {
      this.reasoning += delta.reasoning;
    }

    // Accumulate tool calls
    if (delta.tool_calls) {
      this.hasToolCalls = true;
      for (const toolDelta of delta.tool_calls) {
        const index = toolDelta.index;
        const existing = this.toolCalls.get(index) || {
          id: toolDelta.id,
          type: toolDelta.type || "function",
          function: { name: "", arguments: "" },
        };

        if (toolDelta.id) existing.id = toolDelta.id;
        if (toolDelta.function?.name) {
          existing.function.name = toolDelta.function.name;
        }
        if (toolDelta.function?.arguments) {
          existing.function.arguments += toolDelta.function.arguments;
        }

        this.toolCalls.set(index, existing);
      }
    }

    // Capture usage
    if (chunk.usage) {
      this.usage = chunk.usage;
    }

    // Capture annotations
    if (chunk.annotations || chunk.choices?.[0]?.message?.annotations || chunk.choices?.[0]?.delta?.annotations) {
      this.annotations = chunk.annotations || 
                        chunk.choices?.[0]?.message?.annotations || 
                        chunk.choices?.[0]?.delta?.annotations;
    }

    // Capture images
    if (delta.images) {
      this.images.push(...delta.images);
    }
  }

  /**
   * Get completed tool calls as an array
   */
  getCompletedToolCalls() {
    const calls = [];
    const indices = Array.from(this.toolCalls.keys()).sort((a, b) => a - b);
    for (const index of indices) {
      calls.push(this.toolCalls.get(index));
    }
    return calls;
  }

  /**
   * Check if stream has meaningful content
   */
  hasContent() {
    return (
      this.content.trim().length > 0 ||
      this.reasoning.trim().length > 0 ||
      this.toolCalls.size > 0 ||
      this.images.length > 0
    );
  }

  /**
   * Reset for next iteration
   */
  reset() {
    this.content = "";
    this.reasoning = "";
    this.toolCalls.clear();
    this.hasToolCalls = false;
    this.usage = null;
    this.annotations = null;
    this.images = [];
    this.finished = false;
    this.finishReason = null;
  }
}

/**
 * Main entry point for processing all incoming user messages for the API interface.
 * Uses an industry-standard agent loop: stream, detect tools, execute, continue.
 * 
 * MESSAGE ASSEMBLY CONTRACT:
 * - `plainMessages` should contain conversation history WITHOUT the current user message
 * - This function ADDS the current user message to the API request
 * - This ensures no duplication between history and the current turn
 * 
 * The final messages array sent to the API is:
 *   [systemPrompt, ...plainMessages (history), { role: "user", content: query }, ...intermediateMessages]
 *
 * @param {string} query - The user's message (current turn)
 * @param {Array} plainMessages - Conversation history WITHOUT the current user message
 * @param {AbortController} controller - AbortController instance for cancelling API requests
 * @param {string} selectedModel - The model chosen by the user
 * @param {object} modelParameters - Object containing all configurable model parameters (temperature, top_p, seed, reasoning)
 * @param {object} settings - User settings object containing user_name, user_occupation, and custom_instructions
 * @param {string[]} toolNames - Array of available tool names
 * @param {boolean} isSearchEnabled - Whether the Exa search tools are enabled
 * @param {boolean} isIncognito - Whether incognito mode is enabled
 * @param {Array} attachments - Array of file attachments [{ type: 'image'|'pdf', filename, dataUrl, mimeType }]
 * @yields {Object} A chunk object with content and/or reasoning
 * @property {string|null} content - The main content of the response chunk
 * @property {string|null} reasoning - Any reasoning information included in the response chunk
 * @property {Array} tool_calls - Tool call deltas for UI updates
 * @property {Object} tool_result - Tool execution result for UI updates
 * @property {Object} usage - Token usage information
 * @property {Array} annotations - PDF annotations for reuse
 * @property {Array} images - Generated images
 * @property {boolean} iterationComplete - Signals end of one agent iteration
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
  attachments = [],
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
      if (
        health.status === "down" ||
        health.dailyKeyUsageRemaining <= 0 ||
        health.balanceRemaining <= 0
      ) {
        let message = "⚠️ **Service Unavailable**\n\n";

        if (
          health.dailyKeyUsageRemaining !== undefined &&
          health.dailyKeyUsageRemaining <= 0
        ) {
          message +=
            "Daily API budget exhausted. Try again tomorrow or add your own API key in Settings → General.";
        } else if (
          health.balanceRemaining !== undefined &&
          health.balanceRemaining <= 0
        ) {
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

    // Determine which tools are actually being used
    const modelHasToolUse = selectedModelInfo?.tool_use !== false;

    const enabledToolNames = [];

    // Enable Exa search tools if search is enabled
    if (modelHasToolUse && isSearchEnabled) {
      enabledToolNames.push("search", "getPageContents");
    }

    // Generate system prompt based on settings and used tools
    const systemPrompt = await generateSystemPrompt(
      enabledToolNames,
      isIncognito ? {} : settings,
      isIncognito,
      modelHasToolUse,
    );

    // Build user message content based on attachments
    let userMessageContent;
    if (attachments && attachments.length > 0) {
      const contentParts = [{ type: "text", text: query }];
      for (const attachment of attachments) {
        if (attachment.type === "image") {
          contentParts.push({
            type: "image_url",
            image_url: { url: attachment.dataUrl },
          });
        } else if (attachment.type === "pdf") {
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
      userMessageContent = query;
    }

    // Build base messages for this user turn
    const baseMessages = [
      { role: "system", content: systemPrompt },
      ...plainMessages.map(formatMessageForAPI).filter((m) => m !== null),
      { role: "user", content: userMessageContent },
    ];

    // Tools configuration
    const enabledToolSchemas = enabledToolNames.length
      ? toolManager.getSchemasByNames(enabledToolNames)
      : [];
    const modelSupportsTools = modelHasToolUse && enabledToolSchemas.length > 0;

    // Agent loop configuration
    const maxToolIterations = settings.tool_max_iterations ?? 10; // Reasonable default
    let iteration = 0;

    // Accumulator for this assistant turn
    const accumulator = new StreamAccumulator();
    
    // Track if we've yielded initial content
    let hasYieldedContent = false;

    while (iteration < maxToolIterations) {
      iteration++;

      // Build messages for this call including any previous tool results
      const intermediateMessages = [];
      
      // Add previous assistant message with tool calls if this is iteration > 1
      if (iteration > 1 && accumulator.hasToolCalls) {
        const previousToolCalls = accumulator.getCompletedToolCalls();
        if (previousToolCalls.length > 0) {
          intermediateMessages.push({
            role: "assistant",
            content: accumulator.content || "",
            tool_calls: previousToolCalls.map((tc) => ({
              id: tc.id,
              type: tc.type,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            })),
          });
        }
      }

      const messagesForThisCall = [...baseMessages, ...intermediateMessages];

      // Build request body
      const requestBody = {
        model: selectedModel,
        messages: messagesForThisCall,
        stream: true,
        ...(modelSupportsTools && {
          tools: enabledToolSchemas,
          tool_choice: "auto",
        }),
        ...(modelParameters && {
          temperature: modelParameters.temperature,
          top_p: modelParameters.top_p,
          seed: modelParameters.seed,
          max_tokens: modelParameters.max_tokens,
        }),
        ...(settings.custom_api_key && {
          customApiKey: settings.custom_api_key,
        }),
      };

      // Add reasoning parameters
      if (selectedModelInfo) {
        const userSettings = {
          reasoning_effort: modelParameters?.reasoning?.effort,
        };

        const { reasoningParams, alternateModel } = buildReasoningParams(
          selectedModelInfo,
          userSettings,
        );

        if (alternateModel) {
          requestBody.model = alternateModel;
        }

        if (reasoningParams) {
          requestBody.reasoning = reasoningParams;
        }

        if (selectedModelInfo.providers && selectedModelInfo.providers.length > 0) {
          requestBody.provider = {
            order: selectedModelInfo.providers,
          };
        }
      }

      const sessionToken = await getSessionToken();

      // Make the API request
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-session-token": sessionToken,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error?.message || "Unknown error";
        throw new Error(
          `API request failed with status ${response.status}: ${errorMessage}`,
        );
      }

      // Process the stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      
      // Reset accumulator for this iteration
      accumulator.reset();
      
      // Stream timeout configuration
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
        resetStreamTimeout();
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          resetStreamTimeout();

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;

            const data = line.slice(6);
            if (data === "[DONE]") {
              accumulator.finished = true;
              break;
            }

            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch (error) {
              continue;
            }

            // Handle errors
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

            // Process the chunk
            if (parsed.choices && parsed.choices[0]) {
              accumulator.processChunk(parsed);

              const delta = parsed.choices[0].delta;

              // Yield content updates
              if (delta?.content) {
                hasYieldedContent = true;
                yield {
                  content: delta.content,
                  reasoning: null,
                };
              }

              // Yield reasoning updates
              if (delta?.reasoning && delta.reasoning.trim() !== "None") {
                yield {
                  content: null,
                  reasoning: delta.reasoning,
                };
              }

              // Yield tool call updates for UI
              if (delta?.tool_calls) {
                yield {
                  content: null,
                  reasoning: null,
                  tool_calls: delta.tool_calls,
                };
              }

              // Yield usage
              if (parsed.usage) {
                yield {
                  content: null,
                  reasoning: null,
                  usage: parsed.usage,
                };
              }

              // Yield images
              if (delta?.images) {
                yield {
                  content: delta.content !== undefined ? delta.content : null,
                  reasoning: null,
                  images: delta.images,
                };
              }

              // Yield annotations
              const annotations = delta?.annotations || parsed.annotations;
              if (annotations) {
                yield {
                  content: null,
                  reasoning: null,
                  annotations: annotations,
                };
              }
            }

            if (accumulator.finished) break;
          }

          if (accumulator.finished) break;
        }
      } finally {
        clearStreamTimeout();
        reader.releaseLock();
      }

      // Check if we need to execute tools
      const completedToolCalls = accumulator.getCompletedToolCalls();

      if (!accumulator.hasToolCalls || !modelSupportsTools || completedToolCalls.length === 0) {
        // No tool calls - we're done
        break;
      }

      // Execute tools and get results
      const toolResults = await executeTools(completedToolCalls, plainMessages);

      // Yield tool results for UI updates
      for (const result of toolResults) {
        yield {
          content: null,
          reasoning: null,
          tool_result: {
            id: result.tool_call_id,
            name: result.name,
            result: result.content,
          },
        };
      }

      // Add tool results to intermediate messages for next iteration
      for (const result of toolResults) {
        baseMessages.push({
          role: "tool",
          tool_call_id: result.tool_call_id,
          name: result.name,
          content: result.content,
        });
      }

      // Signal iteration complete
      yield {
        iterationComplete: true,
        toolCallsExecuted: completedToolCalls.length,
      };
    }

    // Final yield with complete content
    yield {
      content: accumulator.content,
      reasoning: accumulator.reasoning,
      complete: true,
      finalToolCalls: accumulator.getCompletedToolCalls(),
      usage: accumulator.usage,
      annotations: accumulator.annotations,
    };

  } catch (error) {
    // Handle abort errors specifically
    if (error.name === "AbortError") {
      yield { content: "\n\n[STREAM CANCELED]", reasoning: null, complete: true };
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
      complete: true,
    };
  }
}

/**
 * Execute tools and return results
 */
async function executeTools(toolCalls, messageHistory = []) {
  const results = [];

  for (const toolCall of toolCalls) {
    const name = toolCall.function.name;
    let args = {};

    try {
      args = JSON.parse(toolCall.function.arguments || "{}");
    } catch (err) {
      console.error("Failed to parse tool arguments:", toolCall.function.arguments, err);
      results.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name,
        content: JSON.stringify({
          error: `Invalid JSON in tool arguments: ${err.message}`,
        }),
      });
      continue;
    }

    const tool = toolManager.getTool(name);
    if (!tool) {
      console.warn(`Tool not found: ${name}`);
      results.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name,
        content: JSON.stringify({ error: `Unknown tool '${name}'` }),
      });
      continue;
    }

    try {
      const result = await tool.executor(args, messageHistory);
      results.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name,
        content: JSON.stringify(result ?? null),
      });
    } catch (err) {
      console.error(`Error executing tool "${name}"`, err);
      results.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name,
        content: JSON.stringify({
          error: `Tool execution failed: ${err.message || String(err)}`,
        }),
      });
    }
  }

  return results;
}

// Re-export for backward compatibility
export { formatMessageForAPI };