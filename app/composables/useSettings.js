import { reactive } from 'vue';
import Settings from './settings';

// Create a single shared instance of Settings. The constructor of
// `Settings` already kicks off `loadSettings()` asynchronously, so we
// do NOT call it again here — doing so previously caused the load to
// fire twice and risked racing the second result over the first.
const settingsManagerInstance = reactive(new Settings());

/**
 * Composable to provide access to the shared settings instance.
 *
 * This ensures that all components in the application use the same
 * settings instance and react to changes consistently, avoiding
 * synchronization issues between different parts of the app.
 *
 * Consumers can check `settingsManagerInstance.isLoaded` to know
 * whether the persisted settings have finished hydrating.
 *
 * @returns {Object} The shared reactive settings manager instance
 */
export function useSettings() {
  return settingsManagerInstance;
}
