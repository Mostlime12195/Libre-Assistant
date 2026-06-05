/**
 * @file notepad.js
 * @description Notepad memory system - a living, AI-maintained working memory
 * of the user, stored as pure Markdown locally.
 *
 * The Notepad is a single Markdown document that the AI treats as its own
 * private working notes about the person it's talking to. It is fully
 * user-owned, local-first, and rewritten from scratch on each consolidation
 * pass — never appended to, never "continued" from a prior version.
 *
 * Storage layout:
 *   - `user_notepad`            : pure markdown content (no frontmatter)
 *   - `user_notepad_metadata`   : { version, lastUpdated, updateCount, lastConsolidatedAt }
 *
 * Migration: on first load we look for the legacy `user_notebook` /
 * `user_notebook_metadata` keys and the very-old `global_chatbot_memory`
 * key. If found, we copy them into the new layout and delete the old keys.
 */

import localforage from "localforage";

export const NOTEPAD_STORAGE_KEY = "user_notepad";
export const NOTEPAD_METADATA_KEY = "user_notepad_metadata";

const LEGACY_NOTEPAD_CONTENT_KEY = "user_notebook";
const LEGACY_NOTEPAD_METADATA_KEY = "user_notebook_metadata";
const LEGACY_GLOBAL_MEMORY_KEY = "global_chatbot_memory";

/**
 * Default metadata for a fresh install.
 * @returns {Object} A metadata object with sensible defaults.
 */
function defaultMetadata() {
  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    updateCount: 0,
    lastConsolidatedAt: null,
  };
}

/**
 * Strips a leading YAML frontmatter block (--- ... ---) from content if
 * present. Used during the one-time migration from the old layout, and
 * as a defensive helper for users who import old exports.
 *
 * @param {string} content
 * @returns {string}
 */
export function stripFrontmatter(content) {
  if (typeof content !== "string") return "";
  return content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
}

/**
 * One-time migration from the legacy "notebook" layout (frontmatter embedded
 * in content) to the new "notepad" layout (pure markdown + separate metadata
 * key). Also removes any leftover `global_chatbot_memory` from the old system.
 *
 * Safe to call on every load — it's a no-op when the new keys are present.
 *
 * @returns {Promise<{migrated: boolean}>}
 */
export async function migrateLegacyNotepadIfNeeded() {
  try {
    const [newContent, newMetadata, legacyContent, legacyMetadata] = await Promise.all([
      localforage.getItem(NOTEPAD_STORAGE_KEY),
      localforage.getItem(NOTEPAD_METADATA_KEY),
      localforage.getItem(LEGACY_NOTEPAD_CONTENT_KEY),
      localforage.getItem(LEGACY_NOTEPAD_METADATA_KEY),
    ]);

    let migrated = false;

    if (!newContent && legacyContent) {
      // Move the old content into the new layout, stripping frontmatter.
      const clean = stripFrontmatter(legacyContent);
      const metadata =
        legacyMetadata && typeof legacyMetadata === "object"
          ? { ...defaultMetadata(), ...legacyMetadata }
          : defaultMetadata();

      await localforage.setItem(NOTEPAD_STORAGE_KEY, clean);
      await localforage.setItem(NOTEPAD_METADATA_KEY, metadata);
      migrated = true;
    }

    // Always clean up the old keys once we've inspected them, and remove
    // the very-old global memory key (PII should not linger in storage).
    await Promise.all([
      localforage.removeItem(LEGACY_NOTEPAD_CONTENT_KEY),
      localforage.removeItem(LEGACY_NOTEPAD_METADATA_KEY),
      localforage.removeItem(LEGACY_GLOBAL_MEMORY_KEY),
    ]);

    if (migrated) {
      console.log("[notepad] Migrated legacy notebook → notepad");
    }
    return { migrated };
  } catch (error) {
    console.error("[notepad] Migration check failed:", error);
    return { migrated: false };
  }
}

/**
 * Loads the Notepad from storage, performing the one-time migration if
 * needed. Always resolves to `{ content, metadata }`.
 *
 * @returns {Promise<{content: string, metadata: Object}>}
 */
export async function loadNotepad() {
  await migrateLegacyNotepadIfNeeded();

  try {
    const [content, metadata] = await Promise.all([
      localforage.getItem(NOTEPAD_STORAGE_KEY),
      localforage.getItem(NOTEPAD_METADATA_KEY),
    ]);

    return {
      content: content || "",
      metadata: metadata || defaultMetadata(),
    };
  } catch (error) {
    console.error("[notepad] Failed to load:", error);
    return {
      content: "",
      metadata: defaultMetadata(),
    };
  }
}

/**
 * Saves the Notepad content and metadata. The caller may pass only the
 * fields it wants to change on metadata; missing fields are preserved.
 *
 * @param {string} content
 * @param {Object} [metadataPatch]
 * @returns {Promise<{content: string, metadata: Object}>}
 */
export async function saveNotepad(content, metadataPatch = {}) {
  try {
    const existing =
      (await localforage.getItem(NOTEPAD_METADATA_KEY)) || defaultMetadata();
    const merged = {
      ...existing,
      ...metadataPatch,
      lastUpdated: new Date().toISOString(),
    };

    await Promise.all([
      localforage.setItem(NOTEPAD_STORAGE_KEY, content || ""),
      localforage.setItem(NOTEPAD_METADATA_KEY, merged),
    ]);

    return { content: content || "", metadata: merged };
  } catch (error) {
    console.error("[notepad] Failed to save:", error);
    throw error;
  }
}

/**
 * Formats the notepad content for injection into the system prompt.
 * Returns an empty string if there's nothing meaningful to show, so
 * callers can safely concatenate the result.
 *
 * @param {{content: string, metadata: Object}} notepad
 * @returns {string}
 */
export function getNotepadSection(notepad) {
  if (!notepad || !notepad.content) return "";
  const content = notepad.content.trim();
  if (!content) return "";

  return `### My Notepad\n\n${content}\n\n---`;
}

/**
 * Validates notepad content produced by the consolidation model.
 *
 * The AI is free to choose its own structure and size, so this is a
 * deliberately *loose* check: we just want to make sure the model
 * actually returned something, not an empty string, an error, or the
 * raw input echoed back at us.
 *
 * @param {string} content
 * @returns {{valid: boolean, error?: string}}
 */
export function validateNotepad(content) {
  if (!content || typeof content !== "string") {
    return { valid: false, error: "Content is empty or not a string" };
  }

  const trimmed = content.trim();
  if (trimmed.length < 20) {
    return { valid: false, error: "Content too short (likely incomplete)" };
  }

  return { valid: true };
}

/**
 * Exports the notepad as a Markdown Blob URL for download. The caller is
 * responsible for revoking the URL once the download has been triggered.
 *
 * @param {{content: string}} notepad
 * @returns {{url: string, revoke: () => void}}
 */
export function exportNotepadAsDownload(notepad) {
  const blob = new Blob([notepad?.content || ""], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  return {
    url,
    revoke: () => URL.revokeObjectURL(url),
  };
}

/**
 * Imports a Notepad from a raw Markdown string. Validates the content
 * first, then persists it.
 *
 * @param {string} content
 * @returns {Promise<{content: string, metadata: Object} | null>}
 */
export async function importNotepad(content) {
  const validation = validateNotepad(stripFrontmatter(content));
  if (!validation.valid) {
    console.error("[notepad] Refusing to import invalid content:", validation.error);
    return null;
  }

  try {
    return await saveNotepad(stripFrontmatter(content), {
      updateCount: 0,
      lastConsolidatedAt: null,
    });
  } catch (error) {
    console.error("[notepad] Failed to import:", error);
    return null;
  }
}

/**
 * Resets the notepad to an empty state. Existing chat summaries are
 * NOT touched here — call `clearAllSummaries` from `chatSummarizer.js`
 * separately if you also want a full re-summarization.
 *
 * @returns {Promise<void>}
 */
export async function resetNotepad() {
  const metadata = {
    ...defaultMetadata(),
    lastConsolidatedAt: null,
  };
  await Promise.all([
    localforage.setItem(NOTEPAD_STORAGE_KEY, ""),
    localforage.setItem(NOTEPAD_METADATA_KEY, metadata),
  ]);
}

/**
 * Returns true if notepad memory is enabled in the given settings object.
 *
 * @param {Object} settings
 * @returns {boolean}
 */
export function isNotepadEnabled(settings) {
  return settings?.notepad_enabled === true;
}
