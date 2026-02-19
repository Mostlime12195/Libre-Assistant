/**
 * Available models from Hack Club
 *
 * ================================================
 * REASONING CONFIGURATION SCHEMA
 * ================================================
 * 
 * reasoning: {
 *   supported: true/false,       // Does this model support reasoning at all?
 *   
 *   toggleable: true/false,      // Can user toggle reasoning on/off?
 *   defaultEnabled: true/false,  // Initial state (if toggleable)
 *   
 *   effort: {                    // Optional - effort level configuration
 *     levels: ['low', 'medium', 'high'],
 *     default: 'medium'
 *   },
 *   
 *   alternateModel: "model-id"   // Optional - route to different model when reasoning enabled
 * }
 * 
 * ================================================
 * API PARAMETER MAPPING
 * ================================================
 * 
 * | Model Type              | User Setting | API Output                      |
 * |-------------------------|--------------|--------------------------------|
 * | supported: false        | -            | {} (nothing)                    |
 * | Always-on, no effort    | -            | {} (nothing)                    |
 * | Always-on + effort      | effort       | { effort: "..." }               |
 * | Toggleable              | enabled      | { enabled: true }               |
 * | Toggleable              | disabled     | { enabled: false }              |
 * | Model routing           | enabled      | model: "alt-model-id"           |
 * | Model routing           | disabled     | {} (original model)             |
 */

export const DEFAULT_MODEL_ID = "moonshotai/kimi-k2.5";

/**
 * Normalizes legacy reasoning formats to the new schema
 * @param {Object} model - The model object
 * @returns {Object} Normalized reasoning configuration
 */
export function normalizeReasoningConfig(model) {
  const r = model.reasoning;
  
  // Already new format
  if (typeof r === 'object' && r !== null && 'supported' in r) {
    return r;
  }
  
  // Legacy: reasoning: false
  if (r === false) {
    return { supported: false };
  }
  
  // Legacy: reasoning: true
  if (r === true) {
    const hasEffort = model.extra_parameters?.reasoning_effort;
    return {
      supported: true,
      toggleable: false,
      effort: hasEffort ? {
        levels: hasEffort[0],
        default: hasEffort[1]
      } : undefined
    };
  }
  
  // Legacy: reasoning: [true, false]
  if (Array.isArray(r) && r.length === 2 && r[0] === true && r[1] === false) {
    return { supported: true, toggleable: true, defaultEnabled: true };
  }
  
  // Legacy: reasoning: "model-id"
  if (typeof r === 'string') {
    return { supported: true, toggleable: true, defaultEnabled: false, alternateModel: r };
  }
  
  // Fallback: no reasoning support
  return { supported: false };
}

/**
 * Should show on/off toggle in UI?
 * @param {Object} model - The model object
 * @returns {boolean}
 */
export function showReasoningToggle(model) {
  const config = normalizeReasoningConfig(model);
  return config.supported && config.toggleable === true;
}

/**
 * Should show effort dropdown in UI?
 * @param {Object} model - The model object
 * @returns {boolean}
 */
export function showReasoningEffortSelector(model) {
  const config = normalizeReasoningConfig(model);
  return config.supported && config.effort && Array.isArray(config.effort.levels) && config.effort.levels.length > 0;
}

/**
 * Get the default reasoning effort for a model
 * @param {Object} model - The model object
 * @returns {string} Default effort level
 */
export function getDefaultReasoningEffort(model) {
  const config = normalizeReasoningConfig(model);
  return config.effort?.default || 'default';
}

/**
 * Check if reasoning is enabled based on user settings
 * @param {Object} model - The model object
 * @param {string} userEffort - The user's selected effort setting
 * @returns {boolean}
 */
export function isReasoningEnabled(model, userEffort) {
  const config = normalizeReasoningConfig(model);
  
  if (!config.supported) return false;
  
  // Non-toggleable models always have reasoning enabled
  if (!config.toggleable) return true;
  
  // Toggleable models: check if effort is 'none'
  return userEffort !== 'none';
}

/**
 * Build API request parameters for reasoning
 * @param {Object} model - The model object
 * @param {Object} userSettings - User settings object with reasoning_effort
 * @returns {Object} { reasoningParams, alternateModel }
 */
export function buildReasoningParams(model, userSettings) {
  const config = normalizeReasoningConfig(model);
  
  if (!config.supported) {
    return { reasoningParams: null, alternateModel: null };
  }
  
  const effort = userSettings?.reasoning_effort || config.effort?.default || 'default';
  const isEnabled = effort !== 'none';
  
  // Model routing: return alternate model when enabled
  if (config.alternateModel && isEnabled) {
    return { 
      reasoningParams: null,
      alternateModel: config.alternateModel 
    };
  }
  
  // Toggleable: send enabled flag
  if (config.toggleable) {
    return {
      reasoningParams: { enabled: isEnabled },
      alternateModel: null
    };
  }
  
  // Always-on + effort: only send effort, NOT enabled
  if (config.effort && effort !== 'default') {
    return {
      reasoningParams: { effort: effort },
      alternateModel: null
    };
  }
  
  // Always-on without effort: send nothing (API handles automatically)
  return { reasoningParams: null, alternateModel: null };
}

/**
 * Finds a model by its ID in the available models list, including nested categories.
 * @param {Array} models - The list of models to search.
 * @param {string} id - The ID of the model to find.
 * @returns {Object|null} The found model object or null.
 */
export function findModelById(models, id) {
  if (!models || !Array.isArray(models)) return null;
  for (const item of models) {
    if (item.id === id) {
      return item;
    }
    if (item.models && Array.isArray(item.models)) {
      const found = findModelById(item.models, id);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

export const availableModels = [
  {
    category: "DeepSeek",
    logo: "/ai_logos/deepseek.svg",
    models: [
      {
        id: "deepseek/deepseek-v3.2-speciale",
        name: "DeepSeek V3.2 Speciale",
        description: "High-compute SOTA variant designed for complex math & STEM tasks.",
        tool_use: false,
        reasoning: {
          supported: true,
          toggleable: false
        },
        extra_functions: [],
        extra_parameters: {}
      },
      {
        id: "deepseek/deepseek-v3.2",
        name: "DeepSeek V3.2",
        description: "Advanced general-purpose model designed with efficiency in mind.",
        tool_use: true,
        reasoning: {
          supported: true,
          toggleable: true,
          defaultEnabled: true
        },
      },
    ],
  },
  {
    category: "Google",
    logo: "/ai_logos/gemini.svg",
    models: [
      {
        id: "google/gemini-3-pro-preview",
        name: "Gemini 3 Pro Preview",
        description: "Preview of frontier-level fast model, distilled from Gemini 3 Pro and optimized for speed.",
        reasoning: {
          supported: true,
          toggleable: false,
          effort: {
            levels: ['low', 'high'],
            default: 'high'
          }
        },
        vision: true,
      },
      {
        id: "google/gemini-3-flash-preview",
        name: "Gemini 3 Flash Preview",
        description: "Preview of frontier-level fast model, distilled from Gemini 3 Pro and optimized for speed.",
        reasoning: {
          supported: true,
          toggleable: false,
          effort: {
            levels: ['minimal', 'low', 'medium', 'high'],
            default: 'medium'
          }
        },
        vision: true,
      },
      {
        id: "google/gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        description: "Low-latency, highly efficient model optimized for speed.",
        reasoning: {
          supported: true,
          toggleable: false,
          effort: {
            levels: ['low', 'medium', 'high'],
            default: 'medium'
          }
        },
        vision: true,
      },
      {
        id: "google/gemini-2.5-flash-lite-preview-09-2025",
        name: "Gemini 2.5 Flash Lite Preview",
        description: "Lightweight variant of Gemini 2.5 Flash optimized for speed.",
        reasoning: {
          supported: true,
          toggleable: false,
          effort: {
            levels: ['low', 'medium', 'high'],
            default: 'medium'
          }
        },
        vision: true,
      },
      {
        id: "google/gemini-2.5-flash-image",
        name: "Nano Banana (Image)",
        description: "Fast image generation model.",
        tool_use: false,
        reasoning: {
          supported: false
        },
        vision: true,
      },
    ]
  },
  {
    category: "Moonshot AI",
    logo: "/ai_logos/moonshot.svg",
    models: [
      {
        id: "moonshotai/kimi-k2.5",
        name: "Kimi K2.5",
        description: "SOTA open-weights model with exceptional EQ, coding, and agentic abilities.",
        vision: true,
        reasoning: {
          supported: true,
          toggleable: true,
          defaultEnabled: true
        },
      },
      {
        id: "moonshotai/kimi-k2-0905",
        name: "Kimi K2",
        description: "Older open-weights model with great EQ and coding abilities.",
        reasoning: {
          supported: true,
          toggleable: true,
          defaultEnabled: false,
          alternateModel: "moonshotai/kimi-k2-thinking"
        },
      },
    ],
  },
  {
    category: "MiniMax",
    logo: "/ai_logos/minimax.svg",
    models: [
      {
        id: "minimax/minimax-m2.5",
        name: "MiniMax M2.5",
        description: "Frontier open-weights coding model",
        reasoning: {
          supported: true,
          toggleable: false,
        },
      },
      {
        id: "minimax/minimax-m2.1",
        name: "MiniMax M2.1",
        description: "High-quality open-weights coding model",
        reasoning: {
          supported: true,
          toggleable: false,
        },
      },
    ],
  },
  {
    category: "OpenAI",
    logo: "/ai_logos/openai.svg",
    models: [
      {
        id: "openai/gpt-5.2",
        name: "GPT-5.2",
        description: "The frontier flagship model delivering frontier general and STEM knowledge.",
        reasoning: {
          supported: true,
          toggleable: false,
          effort: {
            levels: ['low', 'medium', 'high', 'xhigh'],
            default: 'medium'
          }
        },
        vision: true,
      },
      {
        id: "openai/gpt-5.1",
        name: "GPT-5.1",
        description: "The flagship model delivering strong general and emotional intelligence.",
        reasoning: {
          supported: true,
          toggleable: false,
          effort: {
            levels: ['low', 'medium', 'high'],
            default: 'medium'
          }
        },
        vision: true,
      },
      {
        id: "openai/gpt-oss-120b",
        name: "GPT OSS 120B",
        description: "High-performance open-weights model with exceptional STEM capabilities.",
        reasoning: {
          supported: true,
          toggleable: false,
          effort: {
            levels: ['low', 'medium', 'high'],
            default: 'medium'
          }
        },
      },
      {
        id: "openai/gpt-5-mini",
        name: "GPT-5 Mini",
        description: "Streamlined version of GPT-5 optimized for lightweight tasks.",
        reasoning: {
          supported: true,
          toggleable: false,
          effort: {
            levels: ['low', 'medium', 'high'],
            default: 'medium'
          }
        },
      },
    ],
  },
  {
    category: "Perplexity",
    logo: "/ai_logos/perplexity.svg",
    models: [
      {
        id: "perplexity/sonar-deep-research",
        name: "Sonar Deep Research",
        description: "Searches and reasons across sources to generate comprehensive reports.",
        tool_use: true,
        reasoning: {
          supported: true,
          toggleable: true,
          defaultEnabled: true
        },
      },
    ],
  },
  {
    category: "Qwen",
    logo: "/ai_logos/qwen.svg",
    models: [
      {
        id: "qwen/qwen3-vl-235b-a22b-instruct",
        name: "Qwen 3 VL 235B A22B Instruct",
        description: "Open-weight vision-language model excelling at document understanding and visual reasoning.",
        vision: true,
        reasoning: {
          supported: false
        },
      },
      {
        id: "qwen/qwen3-next-80b-a3b-instruct",
        name: "Qwen 3 Next 80B A3B Instruct",
        description: "Highly efficient experimental model that punches above its weight.",
        reasoning: {
          supported: false
        },
      },
    ],
  },
  {
    category: "XAI",
    logo: "/ai_logos/xai.svg",
    models: [
      {
        id: "x-ai/grok-4.1-fast",
        name: "Grok 4.1 Fast",
        description: "Fast model with great agentic capabilities and limited censorship.",
        reasoning: {
          supported: true,
          toggleable: true,
          defaultEnabled: true
        },
      }
    ],
  },
  {
    category: "Z.ai",
    logo: "/ai_logos/zai.svg",
    models: [
      {
        id: "z-ai/glm-5",
        name: "GLM 5",
        description: "Frontier open-weight model excelling at coding and math",
        reasoning: {
          supported: true,
          toggleable: true,
          defaultEnabled: true
        },
      },
      {
        id: "z-ai/glm-4.7",
        name: "GLM 4.7",
        description: "High-quality open-weight model excelling at coding and math",
        reasoning: {
          supported: true,
          toggleable: true,
          defaultEnabled: true
        },
      },
      {
        id: "z-ai/glm-4.7-flash",
        name: "GLM 4.7 Flash",
        description: "SOTA 30B-class model with excelent agentic capabilities",
        reasoning: {
          supported: true,
          toggleable: true,
          defaultEnabled: true
        },
      },
      {
        id: "z-ai/glm-4.6",
        name: "GLM 4.6",
        description: "Reliable bilingual model for reasoning and tool use.",
        reasoning: {
          supported: true,
          toggleable: true,
          defaultEnabled: true
        },
      },
    ],
  },
];

export default availableModels;