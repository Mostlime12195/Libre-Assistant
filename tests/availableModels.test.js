/**
 * Tests for app/composables/availableModels.js
 *
 * Covers the model catalog and all the pure functions that derive UI/API
 * behavior from it: findModelById, normalizeReasoningConfig,
 * showReasoningToggle/Effort, getDefaultReasoningEffort, isReasoningEnabled,
 * and buildReasoningParams.
 */

import { describe, it, expect } from "vitest";
import {
  findModelById,
  normalizeReasoningConfig,
  showReasoningToggle,
  showReasoningEffortSelector,
  getDefaultReasoningEffort,
  getReasoningEffortOptions,
  formatReasoningLabel,
  isReasoningEnabled,
  buildReasoningParams,
  supportsToolUse,
  availableModels,
  DEFAULT_MODEL_ID,
} from "../app/composables/availableModels.js";

describe("DEFAULT_MODEL_ID", () => {
  it("points to a real model in the catalog", () => {
    const found = findModelById(availableModels, DEFAULT_MODEL_ID);
    expect(found).not.toBeNull();
    expect(found.id).toBe(DEFAULT_MODEL_ID);
  });
});

describe("findModelById", () => {
  it("finds a model at the top level", () => {
    const models = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
    expect(findModelById(models, "b").name).toBe("B");
  });

  it("recurses into nested category arrays", () => {
    const models = [
      { category: "X", models: [{ id: "x-1" }, { id: "x-2" }] },
      { category: "Y", models: [{ id: "y-1" }] },
    ];
    expect(findModelById(models, "x-2").id).toBe("x-2");
    expect(findModelById(models, "y-1").id).toBe("y-1");
  });

  it("returns null when the id is not found", () => {
    const models = [{ id: "a" }];
    expect(findModelById(models, "ghost")).toBeNull();
  });

  it("returns null for non-array input", () => {
    expect(findModelById(null, "a")).toBeNull();
    expect(findModelById(undefined, "a")).toBeNull();
    expect(findModelById("not-an-array", "a")).toBeNull();
  });

  it("finds real catalog models (spot checks)", () => {
    expect(findModelById(availableModels, "anthropic/claude-sonnet-4.6").name).toBe("Claude Sonnet 4.6");
    expect(findModelById(availableModels, "openai/gpt-oss-120b").name).toBe("GPT OSS 120B");
  });
});

describe("normalizeReasoningConfig", () => {
  it("returns the config as-is when already in the new schema", () => {
    const cfg = { supported: true, toggleable: true };
    expect(normalizeReasoningConfig({ reasoning: cfg })).toBe(cfg);
  });

  it("maps legacy false to { supported: false }", () => {
    expect(normalizeReasoningConfig({ reasoning: false })).toEqual({
      supported: false,
    });
  });

  it("maps legacy true to { supported: true, toggleable: false }", () => {
    const result = normalizeReasoningConfig({ reasoning: true });
    expect(result.supported).toBe(true);
    expect(result.toggleable).toBe(false);
    expect(result.effort).toBeUndefined();
  });

  it("maps legacy true + extra_parameters.reasoning_effort to an effort config", () => {
    const result = normalizeReasoningConfig({
      reasoning: true,
      extra_parameters: {
        reasoning_effort: [["low", "high"], "high"],
      },
    });
    expect(result.effort).toEqual({
      levels: ["low", "high"],
      default: "high",
    });
  });

  it("maps legacy [true, false] to a toggleable config with defaultEnabled true", () => {
    expect(normalizeReasoningConfig({ reasoning: [true, false] })).toEqual({
      supported: true,
      toggleable: true,
      defaultEnabled: true,
    });
  });

  it("maps legacy 'model-id' string to a toggleable + alternateModel config", () => {
    expect(
      normalizeReasoningConfig({ reasoning: "openai/o3-mini" })
    ).toEqual({
      supported: true,
      toggleable: true,
      defaultEnabled: false,
      alternateModel: "openai/o3-mini",
    });
  });

  it("falls back to { supported: false } for unknown shapes", () => {
    expect(normalizeReasoningConfig({ reasoning: 42 })).toEqual({
      supported: false,
    });
    expect(normalizeReasoningConfig({})).toEqual({ supported: false });
  });
});

describe("showReasoningToggle", () => {
  it("is true only for supported + toggleable models", () => {
    expect(showReasoningToggle({ reasoning: { supported: true, toggleable: true } })).toBe(true);
    expect(showReasoningToggle({ reasoning: { supported: true, toggleable: false } })).toBe(false);
    expect(showReasoningToggle({ reasoning: { supported: false, toggleable: true } })).toBe(false);
  });
});

describe("showReasoningEffortSelector", () => {
  it("is true when effort.levels is a non-empty array", () => {
    expect(
      showReasoningEffortSelector({
        reasoning: { supported: true, effort: { levels: ["low", "high"], default: "low" } },
      })
    ).toBe(true);
  });

  it("is falsy when effort is missing", () => {
    // Missing effort: the `&&` chain short-circuits to undefined
    expect(showReasoningEffortSelector({ reasoning: { supported: true } })).toBeFalsy();
  });

  it("is falsy when levels is an empty array", () => {
    expect(
      showReasoningEffortSelector({
        reasoning: { supported: true, effort: { levels: [], default: "low" } },
      })
    ).toBeFalsy();
  });

  it("is false for unsupported models regardless of effort", () => {
    expect(
      showReasoningEffortSelector({
        reasoning: { supported: false, effort: { levels: ["low"], default: "low" } },
      })
    ).toBe(false);
  });
});

describe("getDefaultReasoningEffort", () => {
  it("returns the configured default", () => {
    expect(
      getDefaultReasoningEffort({
        reasoning: { supported: true, effort: { levels: ["low", "high"], default: "high" } },
      })
    ).toBe("high");
  });

  it("falls back to 'default' when no effort config exists", () => {
    expect(
      getDefaultReasoningEffort({ reasoning: { supported: true } })
    ).toBe("default");
  });

  it("returns 'none' for toggleable models with defaultEnabled: false", () => {
    expect(
      getDefaultReasoningEffort({
        reasoning: { supported: true, toggleable: true, defaultEnabled: false, effort: { levels: ["low", "high"], default: "high" } },
      })
    ).toBe("none");
  });

  it("returns 'default' for toggleable models without effort config", () => {
    expect(
      getDefaultReasoningEffort({
        reasoning: { supported: true, toggleable: true, defaultEnabled: true },
      })
    ).toBe("default");
  });

  it("returns 'none' for toggleable models without effort config and defaultEnabled: false", () => {
    expect(
      getDefaultReasoningEffort({
        reasoning: { supported: true, toggleable: true, defaultEnabled: false },
      })
    ).toBe("none");
  });
});

describe("getReasoningEffortOptions", () => {
  it("returns effort levels for always-on models", () => {
    expect(
      getReasoningEffortOptions({
        reasoning: { supported: true, toggleable: false, effort: { levels: ["low", "medium", "high"], default: "medium" } },
      })
    ).toEqual(["low", "medium", "high"]);
  });

  it("prepends 'none' for toggleable models with effort levels", () => {
    expect(
      getReasoningEffortOptions({
        reasoning: { supported: true, toggleable: true, effort: { levels: ["low", "medium", "high"], default: "medium" } },
      })
    ).toEqual(["none", "low", "medium", "high"]);
  });

  it("returns an empty array for models without effort config", () => {
    expect(
      getReasoningEffortOptions({
        reasoning: { supported: true, toggleable: true },
      })
    ).toEqual([]);
  });
});

describe("formatReasoningLabel", () => {
  it("formats known effort values", () => {
    expect(formatReasoningLabel("none")).toBe("Off");
    expect(formatReasoningLabel("default")).toBe("Default");
    expect(formatReasoningLabel("low")).toBe("Low");
    expect(formatReasoningLabel("medium")).toBe("Medium");
    expect(formatReasoningLabel("high")).toBe("High");
    expect(formatReasoningLabel("xhigh")).toBe("XHigh");
  });

  it("handles empty values", () => {
    expect(formatReasoningLabel("")).toBe("");
    expect(formatReasoningLabel(null)).toBe("");
    expect(formatReasoningLabel(undefined)).toBe("");
  });
});

describe("isReasoningEnabled", () => {
  it("returns false for unsupported models", () => {
    expect(
      isReasoningEnabled({ reasoning: { supported: false } }, "high")
    ).toBe(false);
  });

  it("returns true for non-toggleable models regardless of userEffort", () => {
    expect(
      isReasoningEnabled(
        { reasoning: { supported: true, toggleable: false } },
        "none"
      )
    ).toBe(true);
  });

  it("returns false for toggleable models when userEffort is 'none'", () => {
    expect(
      isReasoningEnabled(
        { reasoning: { supported: true, toggleable: true, defaultEnabled: true } },
        "none"
      )
    ).toBe(false);
  });

  it("returns true for toggleable models when userEffort is anything else", () => {
    expect(
      isReasoningEnabled(
        { reasoning: { supported: true, toggleable: true } },
        "low"
      )
    ).toBe(true);
  });
});

describe("buildReasoningParams", () => {
  it("returns nulls for unsupported models", () => {
    expect(
      buildReasoningParams({ reasoning: { supported: false } }, {})
    ).toEqual({ reasoningParams: null, alternateModel: null });
  });

  it("routes to alternateModel when toggleable model is enabled", () => {
    const result = buildReasoningParams(
      {
        reasoning: {
          supported: true,
          toggleable: true,
          defaultEnabled: false,
          alternateModel: "openai/o3-mini",
        },
      },
      { reasoning_effort: "high" }
    );
    expect(result).toEqual({
      reasoningParams: null,
      alternateModel: "openai/o3-mini",
    });
  });

  it("does NOT route when toggleable model is disabled (effort = 'none')", () => {
    const result = buildReasoningParams(
      {
        reasoning: {
          supported: true,
          toggleable: true,
          defaultEnabled: false,
          alternateModel: "openai/o3-mini",
        },
      },
      { reasoning_effort: "none" }
    );
    expect(result).toEqual({
      reasoningParams: { enabled: false },
      alternateModel: null,
    });
  });

  it("sends { enabled: true } for toggleable models (no alternateModel, no effort)", () => {
    const result = buildReasoningParams(
      { reasoning: { supported: true, toggleable: true, defaultEnabled: true } },
      { reasoning_effort: "medium" }
    );
    expect(result).toEqual({
      reasoningParams: { enabled: true },
      alternateModel: null,
    });
  });

  it("sends { enabled: true, effort } for toggleable models with effort config", () => {
    const result = buildReasoningParams(
      {
        reasoning: {
          supported: true,
          toggleable: true,
          effort: { levels: ["low", "medium", "high"], default: "medium" },
        },
      },
      { reasoning_effort: "high" }
    );
    expect(result).toEqual({
      reasoningParams: { enabled: true, effort: "high" },
      alternateModel: null,
    });
  });

  it("sends { enabled: false } for toggleable models with effort config when effort is 'none'", () => {
    const result = buildReasoningParams(
      {
        reasoning: {
          supported: true,
          toggleable: true,
          effort: { levels: ["low", "medium", "high"], default: "medium" },
        },
      },
      { reasoning_effort: "none" }
    );
    expect(result).toEqual({
      reasoningParams: { enabled: false },
      alternateModel: null,
    });
  });

  it("sends { effort: <value> } for always-on models with effort config (no 'enabled')", () => {
    const result = buildReasoningParams(
      {
        reasoning: {
          supported: true,
          toggleable: false,
          effort: { levels: ["low", "medium", "high"], default: "medium" },
        },
      },
      { reasoning_effort: "high" }
    );
    expect(result).toEqual({
      reasoningParams: { effort: "high" },
      alternateModel: null,
    });
  });

  it("sends nothing for always-on models with no effort override (API default)", () => {
    const result = buildReasoningParams(
      {
        reasoning: {
          supported: true,
          toggleable: false,
          effort: { levels: ["low", "medium", "high"], default: "medium" },
        },
      },
      { reasoning_effort: "default" }
    );
    expect(result).toEqual({ reasoningParams: null, alternateModel: null });
  });

  it("sends nothing for always-on models without effort config", () => {
    const result = buildReasoningParams(
      { reasoning: { supported: true, toggleable: false } },
      { reasoning_effort: "high" }
    );
    expect(result).toEqual({ reasoningParams: null, alternateModel: null });
  });
});

describe("supportsToolUse", () => {
  it("returns true when tool_use is explicitly true", () => {
    expect(supportsToolUse({ tool_use: true })).toBe(true);
  });

  it("returns false when tool_use is explicitly false", () => {
    expect(supportsToolUse({ tool_use: false })).toBe(false);
  });

  it("returns true when tool_use is undefined (default behavior, matches message.js)", () => {
    expect(supportsToolUse({})).toBe(true);
    expect(supportsToolUse({ tool_use: undefined })).toBe(true);
  });

  it("matches the server-side check in message.js for null / undefined model", () => {
    // Mirrors the exact behavior of `selectedModelInfo?.tool_use !== false`
    // in message.js: when no model is provided, treat it as tool-capable.
    // The MessageForm.vue computed already guards against a missing model
    // with `if (!selectedModel.value) return false;`, so this default-to-true
    // behavior is safe at the call site.
    expect(supportsToolUse(null)).toBe(true);
    expect(supportsToolUse(undefined)).toBe(true);
  });

  it("ignores other properties on the model", () => {
    expect(
      supportsToolUse({
        id: "anthropic/claude-sonnet-4.6",
        tool_use: false,
        vision: true,
        reasoning: { supported: true, toggleable: true },
      })
    ).toBe(false);
    expect(
      supportsToolUse({
        id: "openai/gpt-5.5",
        vision: false,
        reasoning: { supported: true },
      })
    ).toBe(true);
  });

  it("matches the catalog's tool_use: false models", () => {
    // Spot-check the four catalog models explicitly marked as not supporting tool use
    expect(supportsToolUse(findModelById(availableModels, "deepseek/deepseek-v3.2-speciale"))).toBe(false);
    expect(supportsToolUse(findModelById(availableModels, "google/gemini-3.1-flash-image-preview"))).toBe(false);
    expect(supportsToolUse(findModelById(availableModels, "google/gemini-2.5-flash-image"))).toBe(false);
    expect(supportsToolUse(findModelById(availableModels, "liquid/lfm-2-24b-a2b"))).toBe(false);
  });

  it("matches the catalog's tool_use: true models", () => {
    expect(supportsToolUse(findModelById(availableModels, "deepseek/deepseek-v4-pro"))).toBe(true);
    expect(supportsToolUse(findModelById(availableModels, "perplexity/sonar-deep-research"))).toBe(true);
  });

  it("treats catalog models without a tool_use field as tool-capable (default)", () => {
    // Most catalog models don't declare tool_use at all and are still considered tool-capable
    expect(supportsToolUse(findModelById(availableModels, "anthropic/claude-sonnet-4.6"))).toBe(true);
    expect(supportsToolUse(findModelById(availableModels, "openai/gpt-5.5"))).toBe(true);
  });
});
