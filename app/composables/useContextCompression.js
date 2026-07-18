import {
  compressionStates,
  getCompressionState,
  dismissCompressionPrompt,
  compressConversation,
  isCompressionRunning,
  formatTokenCount,
} from "./contextCompressionPipeline";

/**
 * Shared accessor for context-compression UI state and actions.
 * Follows the same module-level shared-state pattern as
 * useGlobalIncognito: all components see the same reactive state.
 */
export function useContextCompression() {
  return {
    compressionStates,
    getCompressionState,
    dismissCompressionPrompt,
    compressConversation,
    isCompressionRunning,
    formatTokenCount,
  };
}
