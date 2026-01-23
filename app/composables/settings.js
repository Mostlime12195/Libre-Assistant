import localforage from "localforage";
import { reactive } from "vue";
import { availableModels, findModelById, DEFAULT_MODEL_ID } from './availableModels';
import DEFAULT_PARAMETERS from './defaultParameters';

/**
 * Manages application settings for the Libre Assistant Interface.
 */
class Settings {
  constructor() {
    // Use a reactive reference for settings to improve reactivity
    const settings = reactive({
      // Version marker for future migrations
      version: 2,

      // --- User Profile Settings ---
      user_name: null, // User's name
      occupation: null, // User's occupation
      custom_instructions: null, // Custom instructions for Libre

      // --- Memory Settings ---
      global_memory_enabled: true, // Whether global memory is enabled

      // --- Model Settings ---
      selected_model_id: DEFAULT_MODEL_ID, // Default model ID

      // --- Search Settings ---
      search_enabled: false, // Whether search is enabled by default

      // --- Model-Specific Settings ---
      model_settings: {}, // Per-model settings storage

      // --- Parameter Config Settings ---
      parameter_config: { ...DEFAULT_PARAMETERS },

      // --- GPT-OSS Specific Settings ---
      gpt_oss_limit_tables: false, // Whether to limit table usage for GPT-OSS models

      // --- API Key Settings ---
      custom_api_key: '', // User's own Hack Club API key (bypasses rate limits)
    });

    // Add type information for better type safety
    this.settings = reactive(settings);

    // Create a non-reactive copy of default settings to avoid circular references
    this.defaultSettings = {
      version: 2,
      global_memory_enabled: true, // Add default value for global memory
      selected_model_id: DEFAULT_MODEL_ID, // Default model ID
      search_enabled: false, // Default value for search setting
      model_settings: {}, // Default value for model settings
      parameter_config: { ...DEFAULT_PARAMETERS },
      gpt_oss_limit_tables: false, // Default value for GPT-OSS table limiting
      custom_api_key: '', // Default empty API key
    };

    // Load settings asynchronously
    this.loadSettings();
  }

  /**
   * Helper to deep merge objects, ensuring reactivity is maintained where possible.
   * This version handles merging into an existing reactive object.
   * @param {object} target - The reactive object to merge into.
   * @param {object} source - The object to merge from.
   * @returns {object} The merged object.
   */
  _deepMergeReactive(target, source) {
    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        const sourceValue = source[key];
        const targetValue = target[key];

        if (
          typeof sourceValue === "object" &&
          sourceValue !== null &&
          !Array.isArray(sourceValue) &&
          !(sourceValue instanceof Date)
        ) {
          // Initialize as reactive if needed
          if (
            !targetValue ||
            typeof targetValue !== "object" ||
            Array.isArray(targetValue) ||
            targetValue instanceof Date
          ) {
            target[key] = reactive({});
          }

          // Recursively merge objects
          this._deepMergeReactive(target[key], sourceValue);
        } else {
          // Direct assignment for primitives
          target[key] = sourceValue;
        }
      }
    }
    return target;
  }

  /**
   * Asynchronously loads settings from localforage.
   * Merges saved settings with default settings to handle new fields in updates.
   */
  async loadSettings() {
    try {
      const savedSettings = await localforage.getItem("settings");
      if (savedSettings != null) {
        // Start with a fresh deep copy of default settings
        const mergedSettings = { ...this.defaultSettings };

        // Then deep merge saved settings over it to apply user's preferences
        this._deepMergeReactive(mergedSettings, savedSettings);

        if (mergedSettings.selected_model_id === "moonshotai/kimi-k2-instruct-0905" || !mergedSettings.selected_model_id) {
          mergedSettings.selected_model_id = DEFAULT_MODEL_ID;
        }

        // Migration: If search_enabled is true and grounding parameter doesn't exist yet,
        // set grounding to true to preserve user's previous search preference
        if (mergedSettings.search_enabled &&
          (!mergedSettings.parameter_config || mergedSettings.parameter_config.grounding === undefined)) {
          if (!mergedSettings.parameter_config) {
            mergedSettings.parameter_config = { ...DEFAULT_PARAMETERS };
          }
          mergedSettings.parameter_config.grounding = true;
        }

        // Directly assign to the reactive settings object
        // This will update the reactivity system
        Object.assign(this.settings, mergedSettings);

        // IMPORTANT: Save back any changes made during the load (e.g., new defaults applied, or migrations)
        // Store a deep copy of the settings object to prevent DataCloneError with reactive arrays.
        await localforage.setItem(
          "settings",
          JSON.parse(JSON.stringify(this.settings))
        );
      } else {
        // No saved settings found, persist the default settings
        // A fresh, deep reactive copy should already be in this.settings from constructor
        await localforage
          .setItem("settings", JSON.parse(JSON.stringify(this.settings)))
          .catch((err) => {
            console.error(`Error saving initial default settings: ${err}`);
          });
      }
    } catch (err) {
      console.error("Failed to load settings from localForage:", err);
    }
  }

  /**
   * Asynchronously saves the current settings to localforage.
   */
  async saveSettings() {
    try {
      // IMPORTANT: Store a deep copy of the settings object using JSON.parse(JSON.stringify())
      // This ensures no reactive proxies or non-clonable elements are passed to localforage.
      await localforage.setItem(
        "settings",
        JSON.parse(JSON.stringify(this.settings))
      );

      console.log("Settings saved to localForage.");
    } catch (err) {
      console.error("Failed to save settings to localForage:", err);
    }
  }

  /**
   * Retrieves a specific setting by key.
   * @param {string} key - The key of the setting to retrieve.
   * @returns {*} The value of the setting.
   */
  getSetting(key) {
    return this.settings[key];
  }

  /**
   * Sets a specific setting by key. Useful for UI bindings.
   * @param {string} key - The key of the setting to set.
   * @param {*} value - The new value for the setting.
   */
  setSetting(key, value) {
    this.settings[key] = value;
    // We don't save here automatically to avoid excessive writes.
    // saveSettings() should be called explicitly by the UI logic after changes,
    // or if the change necessitates immediate persistence.
  }

  /**
   * Gets a setting for a specific model.
   * @param {string} modelId - The model ID
   * @param {string} key - The setting key
   * @returns {*} The value of the setting for the model.
   */
  getModelSetting(modelId, key) {
    if (this.settings.model_settings && this.settings.model_settings[modelId]) {
      return this.settings.model_settings[modelId][key];
    }
    return undefined;
  }

  /**
   * Sets a setting for a specific model.
   * @param {string} modelId - The model ID
   * @param {string} key - The setting key
   * @param {*} value - The new value for the setting.
   */
  setModelSetting(modelId, key, value) {
    if (!this.settings.model_settings) {
      this.settings.model_settings = {};
    }
    if (!this.settings.model_settings[modelId]) {
      this.settings.model_settings[modelId] = {};
    }
    this.settings.model_settings[modelId][key] = value;
    // We don't save here automatically to avoid excessive writes.
    // saveSettings() should be called explicitly by the UI logic after changes,
    // or if the change necessitates immediate persistence.
  }

  /**
   * Resets all settings to their default values and persists them.
   */
  async resetSettings() {
    // Perform a deep copy of default settings to avoid reference issues
    // and assign it directly to the existing reactive settings object.
    const newDefaults = this._deepMergeReactive({}, this.defaultSettings);
    Object.assign(this.settings, newDefaults);

    console.log("Settings reset to default.");
    await this.saveSettings();
  }

  /**
   * Computed property to get the currently selected model object
   */
  get selectedModel() {
    return findModelById(availableModels, this.settings.selected_model_id);
  }

  /**
   * Computed property to get the name of the currently selected model
   */
  get selectedModelName() {
    return this.selectedModel ? this.selectedModel.name : 'Loading...';
  }
}

export default Settings;
