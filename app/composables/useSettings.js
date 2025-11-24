import { reactive, readonly } from 'vue';
import Settings from './settings';

// Create a single shared instance of Settings
const settingsManagerInstance = reactive(new Settings());

// Make sure settings are loaded initially
if (typeof window !== 'undefined') {
  // Load settings when the composable is first used, if not already loaded
  if (!settingsManagerInstance.isLoaded) {
    settingsManagerInstance.loadSettings().catch(error => {
      console.error('Failed to load settings in composable:', error);
    });
  }
}

/**
 * Composable to provide access to the shared settings instance
 * 
 * This ensures that all components in the application use the same
 * settings instance and react to changes consistently, avoiding
 * synchronization issues between different parts of the app.
 * 
 * @returns {Object} The shared reactive settings manager instance
 */
export function useSettings() {
  return settingsManagerInstance;
}

/**
 * Provides a readonly version of the settings for components that only need to read
 * 
 * @returns {Object} The readonly shared settings manager instance
 */
export function useSettingsReadonly() {
  return readonly(settingsManagerInstance);
}