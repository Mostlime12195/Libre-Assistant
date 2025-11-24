/**
 * @file message.js
 * @description Core logic for the Libre Assistant API Interface, handling Hack Club LLM endpoint configuration
 * and streaming responses using manual fetch() processing.
 */

import { availableModels } from '~/composables/availableModels';
import { generateSystemPrompt } from '~/composables/systemPrompt';
import { listMemory, addMemory, modifyMemory, deleteMemory } from '~/composables/memory';
import { toolManager } from '~/composables/toolsManager';

// Helper function to find a model by ID, including nested models in categories
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
 * Main entry point for processing all incoming user messages for the API interface.
 * It determines the correct API configuration and streams the LLM response.
 *
 * @param {string} query - The user's message
 * @param {Array} plainMessages - Conversation history (e.g., [{ role: "user", content: "..."}, { role: "assistant", content: "..."}])
 * @param {AbortController} controller - AbortController instance for cancelling API requests
 * @param {string} selectedModel - The model chosen by the user
 * @param {object} modelParameters - Object containing all configurable model parameters (temperature, top_p, seed, reasoning)
 * @param {object} settings - User settings object containing user_name, user_occupation, and custom_instructions
 * @param {string[]} toolNames - Array of available tool names
 * @param {boolean} isSearchEnabled - Whether the browser search tool is enabled
 * @param {boolean} isIncognito - Whether incognito mode is enabled
 * @yields {Object} A chunk object with content and/or reasoning
 * @property {string|null} content - The main content of the response chunk
 * @property {string|null} reasoning - Any reasoning information included in the response chunk
 **/
export async function* handleIncomingMessage(
  query,
  plainMessages,
  controller,
  selectedModel = "moonshotai/kimi-k2-0905",
  modelParameters = {},
  settings = {},
  toolNames = [],
  isSearchEnabled = false,
  isIncognito = false
) {
  try {
    // Validate required parameters
    if (!query || !plainMessages || !controller) {
      throw new Error("Missing required parameters for handleIncomingMessage");
    }

    // Append current date and time to the user's query for awareness.
    // We don't use the system prompt for the time to allow cached input tokens.
    const queryWithDateTime = `<context>\n  <!-- CURRENT TIME ADDED AUTOMATICALLY; ONLY USE THE CURRENT TIME WHEN REQUIRED OR EXPLICITLY TOLD TO USE. -->\n  Current Time: ${new Date()}\n</context>\n\n${query}`;

    // Load memory facts if memory is enabled and not in incognito mode
    let memoryFacts = [];
    if (settings.global_memory_enabled && !isIncognito) {
      memoryFacts = await listMemory();
    }

    // Determine which tools are actually being used
    const enabledToolNames = [];
    if (settings.global_memory_enabled && !isIncognito) {
      enabledToolNames.push(
        'listMemory',
        'addMemory',
        'modifyMemory',
        'deleteMemory'
      );
    }

    // Generate system prompt based on settings and used tools
    // In incognito mode, use empty settings to avoid customization
    const systemPrompt = await generateSystemPrompt(
      enabledToolNames,
      isIncognito ? {} : settings,
      memoryFacts,
      isIncognito // Pass incognito mode state
    );

    // Build base messages for this user turn
    const baseMessages = [
      { role: "system", content: systemPrompt },
      ...plainMessages.map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: queryWithDateTime },
    ];

    // Used only inside this turn for tool rounds
    let intermediateMessages = []; // assistant(tool_calls) + tool messages from this turn

    // Tools
    const enabledToolSchemas = enabledToolNames.length
      ? toolManager.getSchemasByNames(enabledToolNames)
      : [];

    // Agent loop config
    const selectedModelInfo = findModelById(availableModels, selectedModel);
    const modelSupportsTools = enabledToolSchemas.length > 0 && selectedModelInfo?.supports_tools !== false; // assume true unless explicitly false
    const maxToolIterations = settings.tool_max_iterations ?? 4;
    let iteration = 0;

    while (true) {
      // Build messages for this call
      const messagesForThisCall = [
        ...baseMessages,
        ...intermediateMessages,
      ];

      // Build request body for this call
      const requestBody = {
        model: selectedModel,
        messages: messagesForThisCall,
        stream: true,
        plugins: isSearchEnabled ? [{
          "id": "web",
          "search_prompt": "Here are some web search results that might be relevant: "
        }] : [],
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
      };

      // Add reasoning parameters only if the model supports reasoning
      if (selectedModelInfo) {
        // Handle models with reasoning: string (route requests to another model when reasoning is enabled)
        if (typeof selectedModelInfo.reasoning === 'string') {
          // Use the reasoning model when reasoning is enabled (effort is not 'none' or not specified)
          if (!modelParameters?.reasoning?.effort || modelParameters.reasoning.effort !== 'none') {
            requestBody.model = selectedModelInfo.reasoning;
          }
          // Otherwise, use the original selected model
        }
        // Handle models with reasoning: [true, false] (toggleable reasoning)
        else if (Array.isArray(selectedModelInfo.reasoning) &&
                 selectedModelInfo.reasoning.length === 2 &&
                 selectedModelInfo.reasoning[0] === true &&
                 selectedModelInfo.reasoning[1] === false) {
            // Add reasoning with enabled flag based on model parameters for other models
            requestBody.reasoning = {
              enabled: modelParameters?.reasoning?.effort !== 'none'
            };
        }
        // Handle models with reasoning: true - these have reasoning capabilities but no toggle
        else if (selectedModelInfo.reasoning === true) {
          // Add reasoning_effort if specified in model parameters
          if (modelParameters?.reasoning?.effort) {
            requestBody.reasoning = {effort: modelParameters.reasoning.effort};
          }
        }
        // For models with reasoning: false, don't add any reasoning parameters
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

        throw new Error(`API request failed with status ${response.status}: ${errorMessage}`);
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

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

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
                    existing.function.arguments += toolCallDelta.function.arguments;
                  }

                  toolCallAccumulator[index] = existing;
                }
              }

              // 2) Detect finish_reason
              if (choice.finish_reason) {
                finishedReason = choice.finish_reason;
              }

              // 3) Yield content & reasoning like before
              let contentYielded = false;

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
                contentYielded = true;
              }

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
                contentYielded = true;
              }

              if (!contentYielded && choice.delta?.tool_calls) {
                yield {
                  content: null,
                  reasoning: null,
                  tool_calls: choice.delta.tool_calls,
                };
              }

              if (parsed.usage) {
                yield {
                  content: null,
                  reasoning: null,
                  tool_calls: [],
                  usage: parsed.usage,
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
      const toolResultMessages = await executeToolCallsLocally(completedToolCalls);

      // Keep these for next iteration
      intermediateMessages.push(
        {
          role: "assistant",
          content: "", // Empty string instead of null to satisfy OpenRouter validation
          tool_calls: completedToolCalls.map(tc => ({
            id: tc.id,
            type: tc.type,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        },
        ...toolResultMessages,
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
async function executeToolCallsLocally(completedToolCalls) {
  const toolResultMessages = [];

  for (const toolCall of completedToolCalls) {
    const name = toolCall.function.name;
    let args = {};

    try {
      args = JSON.parse(toolCall.function.arguments || "{}");
    } catch (err) {
      console.error("Failed to parse tool arguments:", toolCall.function.arguments, err);
    }

    const tool = toolManager.getTool(name);
    if (!tool) {
      console.warn(`Tool not found: ${name}`);
      toolResultMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name,
        content: `{"error": "Unknown tool '${name}'"}`
      });
      continue;
    }

    try {
      const result = await tool.executor(args);
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
          error: `Tool execution failed: ${err.message || String(err)}`
        }),
      });
    }
  }

  return toolResultMessages;
}