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
export const availableModels = [
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
    category: "Google",
    logo: "/ai_logos/gemini.svg",
    models: [
      {
        id: "google/gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        description: "Low-latency, highly efficient model optimized for speed.",
        reasoning: true,
        extra_functions: [],
        extra_parameters: {
          reasoning_effort: [["low", "medium", "high"], "medium"],
        }
      },
      {
        id: "google/gemini-3-pro-preview",
        name: "Gemini 3 Pro Preview",
        description: "Early access to Google's next-gen, most capable multimodal model.",
        reasoning: true,
        extra_functions: [],
        extra_parameters: {}
      },
    ]
  },
  {
    category: "OpenAI",
    logo: "/ai_logos/openai.svg",
    models: [
      {
        id: "openai/gpt-5.1",
        name: "GPT-5.1",
        description: "The frontier flagship model delivering state-of-the-art general intelligence.",
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
    ],
  },
  {
    category: "DeepSeek",
    logo: "/ai_logos/deepseek.svg",
    models: [
      {
        id: "deepseek/deepseek-r1-0528",
        name: "DeepSeek R1 0528",
        description: "Reasoning-dense model optimized for complex logic and coding.",
        reasoning: true,
        extra_functions: [],
        extra_parameters: {}
      },
      {
        id: "deepseek/deepseek-v3.2-exp",
        name: "DeepSeek V3.2 Exp",
        description: "Experimental build offering optimized token usage.",
        reasoning: [true, false],
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
        id: "z-ai/glm-4.6",
        name: "GLM 4.6",
        description: "Advanced bilingual model with strong logical reasoning and tool use.",
        reasoning: [true, false], 
        extra_functions: [],
        extra_parameters: {}
      },
    ],
  }
];

export default availableModels;