/**
 * Available models from Hack Club
 *
 * Model reasoning configuration:
 * - reasoning: true          -> Model has ONLY reasoning capabilities, no toggle shown
 * - reasoning: false         -> Model does NOT support reasoning, no toggle shown
 * - reasoning: [true, false] -> Model supports BOTH reasoning & non-reasoning, toggle shown
 * - reasoning: "model-id"    -> Routes reasoning to different model when enabled
 * - reasoning_effort: [["low", "medium", "high"], "medium"] -> Dropdown to select reasoning effort level, default is "medium"
 *
 * For models with [true, false], the API will receive reasoning: {enabled: true/false}
 * based on toggle state.
 */
export const DEFAULT_MODEL_ID = "moonshotai/kimi-k2-0905";

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
        reasoning: true,
        extra_functions: [],
        extra_parameters: {}
      },
      {
        id: "deepseek/deepseek-v3.2",
        name: "DeepSeek V3.2",
        description: "Advanced general-purpose model designed with efficiency in mind.",
        tool_use: false,
        reasoning: [true, false],
        extra_functions: [],
        extra_parameters: {}
      },
    ],
  },
  {
    category: "Google",
    logo: "/ai_logos/gemini.svg",
    models: [
      {
        id: "google/gemini-3-flash-preview",
        name: "Gemini 3 Flash Preview",
        description: "Preview of frontier-level fast model, distilled from Gemini 3 Pro and optimized for speed.",
        reasoning: true,
        vision: true,
        extra_functions: [],
        extra_parameters: {
          reasoning_effort: [["minimal", "low", "medium", "high"], "medium"],
        }
      },
      {
        id: "google/gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        description: "Low-latency, highly efficient model optimized for speed.",
        reasoning: true,
        vision: true,
        extra_functions: [],
        extra_parameters: {
          reasoning_effort: [["low", "medium", "high"], "medium"],
        }
      },
      {
        id: "google/gemini-2.5-flash-lite-preview-09-2025",
        name: "Gemini 2.5 Flash Lite Preview",
        description: "Lightweight variant of Gemini 2.5 Flash optimized for speed.",
        reasoning: true,
        vision: true,
        extra_functions: [],
        extra_parameters: {
          reasoning_effort: [["low", "medium", "high"], "medium"],
        }
      },
      {
        id: "google/gemini-2.5-flash-image",
        name: "Nano Banana (Image)",
        description: "Fast image generation model.",
        tool_use: false,
        reasoning: false,
        vision: true,
        extra_functions: [],
        extra_parameters: {}
      },
    ]
  },
  {
    category: "Moonshot AI",
    logo: "/ai_logos/moonshot.svg",
    models: [
      {
        id: "moonshotai/kimi-k2-0905",
        name: "Kimi K2",
        description: "SOTA open-weights model with exceptional EQ and coding abilities.",
        reasoning: "moonshotai/kimi-k2-thinking",
        extra_functions: [],
        extra_parameters: {}
      }
    ],
  },
  {
    category: "OpenAI",
    logo: "/ai_logos/openai.svg",
    models: [
      {
        id: "openai/gpt-5.1",
        name: "GPT-5.1",
        description: "The frontier flagship model delivering frontier general intelligence.",
        reasoning: true,
        vision: true,
        extra_functions: [],
        extra_parameters: {
          reasoning_effort: [["low", "medium", "high"], "medium"],
        }
      },
      {
        id: "openai/gpt-oss-120b",
        name: "GPT OSS 120B",
        description: "High-performance open-weights model with exceptional STEM capabilities.",
        reasoning: true,
        extra_functions: [],
        extra_parameters: {
          reasoning_effort: [["low", "medium", "high"], "medium"],
        }
      },
      {
        id: "openai/gpt-5-mini",
        name: "GPT-5 Mini",
        description: "Streamlined version of GPT-5 optimized for lightweight tasks.",
        reasoning: true,
        extra_functions: [],
        extra_parameters: {
          reasoning_effort: [["low", "medium", "high"], "medium"],
        }
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
        reasoning: false,
        extra_functions: [],
        extra_parameters: {},
      },
      {
        id: "qwen/qwen3-next-80b-a3b-instruct",
        name: "Qwen 3 Next 80B A3B Instruct",
        description: "Highly efficient experimental model that punches above its weight.",
        reasoning: false,
        extra_functions: [],
        extra_parameters: {}
      },
    ],
  },
  {
    category: "Z.ai",
    logo: "/ai_logos/zai.svg",
    models: [
      {
        id: "z-ai/glm-4.7",
        name: "GLM 4.7",
        description: "SOTA open-weight model excelling at coding and math",
        reasoning: [true, false],
        extra_functions: [],
        extra_parameters: {}
      },
      {
        id: "z-ai/glm-4.6",
        name: "GLM 4.6",
        description: "Reliable bilingual model for reasoning and tool use.",
        reasoning: [true, false],
        extra_functions: [],
        extra_parameters: {}
      },
    ],
  },
];

export default availableModels;
