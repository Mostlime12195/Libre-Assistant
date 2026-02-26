/**
 * Centralized default model parameters for the application.
 * This ensures consistency across all components and files that use these defaults.
 */

export const DEFAULT_PARAMETERS = {
  temperature: 1.0,
  top_p: 0.95,
  seed: null,
  grounding: false,
  maxMode: false,
  maxModeModels: []
};

export default DEFAULT_PARAMETERS;