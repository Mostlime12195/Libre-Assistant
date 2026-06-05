import { ref, watch } from 'vue';
import localforage from 'localforage';

const DRAFT_KEY_PREFIX = 'draft:';
const DEBOUNCE_MS = 300;

/**
 * Manages per-conversation draft prompt persistence in localForage.
 * Auto-saves with a 300ms debounce and loads on mount.
 *
 * @param {import('vue').Ref<string>} conversationIdRef - Reactive conversation ID (empty for new)
 * @param {import('vue').Ref<string>} inputRef - Reactive input string to sync
 * @returns {Object} Draft manager API
 */
export function useDraftPrompt(conversationIdRef, inputRef) {
  let saveTimeout = null;
  let isRestoring = false;

  /**
   * Build the storage key for a given conversation ID.
   */
  function getKey(id) {
    return `${DRAFT_KEY_PREFIX}${id || 'new'}`;
  }

  /**
   * Load draft for the current conversation into inputRef.
   */
  async function loadDraft() {
    isRestoring = true;
    try {
      const key = getKey(conversationIdRef.value);
      const saved = await localforage.getItem(key);
      inputRef.value = typeof saved === 'string' ? saved : '';
    } finally {
      // Clear flag on next tick so the watcher doesn't immediately re-save
      requestAnimationFrame(() => {
        isRestoring = false;
      });
    }
  }

  /**
   * Persist the current input to localForage.
   */
  async function saveDraft() {
    const key = getKey(conversationIdRef.value);
    await localforage.setItem(key, inputRef.value);
  }

  /**
   * Clear the draft for the current conversation.
   */
  async function clearDraft() {
    const key = getKey(conversationIdRef.value);
    await localforage.removeItem(key);
  }

  /**
   * Debounced save triggered by input changes.
   */
  function debouncedSave() {
    if (isRestoring) return;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      saveDraft();
    }, DEBOUNCE_MS);
  }

  // Watch input changes and auto-save
  watch(inputRef, debouncedSave);

  // Watch conversation changes: save old draft, load new one
  watch(conversationIdRef, async (newId, oldId) => {
    if (oldId !== undefined && !isRestoring) {
      // Save previous conversation's draft before switching
      const oldKey = getKey(oldId);
      await localforage.setItem(oldKey, inputRef.value);
    }
    await loadDraft();
  });

  return {
    loadDraft,
    saveDraft,
    clearDraft
  };
}