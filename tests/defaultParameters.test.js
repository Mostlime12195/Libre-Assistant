/**
 * Tests for app/composables/defaultParameters.js
 *
 * Trivial, but pins the default values so a careless refactor can't
 * silently change them.
 */

import { describe, it, expect } from "vitest";
import DEFAULT_PARAMETERS, { DEFAULT_PARAMETERS as namedExport } from "../app/composables/defaultParameters.js";

describe("DEFAULT_PARAMETERS", () => {
  it("has the documented default values", () => {
    expect(DEFAULT_PARAMETERS).toEqual({
      temperature: 1.0,
      top_p: 0.95,
      seed: null,
      max_tokens: 8192,
      grounding: false,
    });
  });

  it("default export and named export point to the same object", () => {
    expect(namedExport).toBe(DEFAULT_PARAMETERS);
  });
});
