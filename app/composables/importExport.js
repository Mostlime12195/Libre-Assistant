/**
 * @file importExport.js
 * @description Import/export system for Libre Assistant. Exports conversations,
 * settings, and the notepad as a versioned zip archive using the native chat
 * format (with branching, reasoning, tool calls, and inline attachments).
 * Also supports importing OpenWebUI chat exports as a lossy interop format.
 */

import localforage from "localforage";
import { zipSync, unzipSync, strFromU8, strToU8 } from "fflate";
import { emitter } from "~/composables/emitter";
import { loadNotepad, saveNotepad } from "~/composables/notepad";
import packageJson from "../../package.json";

export const EXPORT_FORMAT = "libre-assistant-export";
export const EXPORT_FORMAT_VERSION = 1;
export const APP_VERSION = packageJson?.version ?? "unknown";
export const SETTINGS_VERSION = 5;

export const CHATS_DIR = "chats";
export const MANIFEST_FILE = "manifest.json";
export const SETTINGS_FILE = "settings.json";
export const MEMORY_FILE = "memory.md";
export const MEMORY_METADATA_FILE = "memory.metadata.json";
export const SINGLE_CHAT_FILE = "chat.json";

function generateId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {}
  }
  return (
    Date.now().toString(36) + Math.random().toString(36).substring(2, 11)
  );
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isDefaultNotepadMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return true;
  return (
    (metadata.updateCount ?? 0) === 0 &&
    metadata.lastConsolidatedAt == null
  );
}

export function isDefaultNotepad(content, metadata, notepadEnabled) {
  const trimmed = typeof content === "string" ? content.trim() : "";
  if (!trimmed) return true;
  if (!notepadEnabled) return true;
  if (isDefaultNotepadMetadata(metadata) && !trimmed) return true;
  return false;
}

export function stripSecrets(settings) {
  if (!settings || typeof settings !== "object") return settings;
  const copy = JSON.parse(JSON.stringify(settings));
  copy.custom_api_key = "";
  return copy;
}

export function buildManifest({ includes, counts = {} }) {
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    appVersion: APP_VERSION,
    settingsVersion: SETTINGS_VERSION,
    exportedAt: new Date().toISOString(),
    includes: {
      chats: !!includes.chats,
      memory: !!includes.memory,
      settings: !!includes.settings,
      attachments: !!includes.attachments,
    },
    counts: {
      chats: counts.chats ?? 0,
      attachments: counts.attachments ?? 0,
    },
  };
}

export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function recordsToZipInput(records) {
  const input = {};
  for (const [name, value] of Object.entries(records)) {
    if (typeof value === "string") {
      input[name] = strToU8(value);
    } else if (value instanceof Uint8Array) {
      input[name] = value;
    }
  }
  return input;
}

/**
 * Exports all local data to a zip Blob.
 */
export async function exportAllToZip({
  includeChats = true,
  includeNotepad = true,
  includeSettings = true,
  includeApiKey = false,
} = {}) {
  const records = {};
  let chatCount = 0;
  let attachmentCount = 0;
  const includes = { chats: false, memory: false, settings: false, attachments: false };

  // Settings
  let exportedSettings = null;
  if (includeSettings) {
    const settings = await localforage.getItem("settings");
    if (settings && typeof settings === "object") {
      const settingsModule = await import("./settings.js").catch(() => null);
      const defaults = settingsModule ? new settingsModule.default().defaultSettings : null;
      const isDefault = defaults ? deepEqual(settings, defaults) : false;
      if (!isDefault) {
        exportedSettings = includeApiKey ? JSON.parse(JSON.stringify(settings)) : stripSecrets(settings);
        records[SETTINGS_FILE] = JSON.stringify(exportedSettings, null, 2);
        includes.settings = true;
      }
    }
  }

  // Notepad
  let notepadEnabled = false;
  if (includeNotepad) {
    const settings = await localforage.getItem("settings");
    notepadEnabled = settings?.notepad_enabled === true;
    const notepad = await loadNotepad();
    if (!isDefaultNotepad(notepad.content, notepad.metadata, notepadEnabled)) {
      records[MEMORY_FILE] = notepad.content || "";
      records[MEMORY_METADATA_FILE] = JSON.stringify(notepad.metadata, null, 2);
      includes.memory = true;
    }
  }

  // Chats
  if (includeChats) {
    const metadata = (await localforage.getItem("conversations_metadata")) || [];
    for (const item of metadata) {
      if (!item?.id) continue;
      const conv = await localforage.getItem(`conversation_${item.id}`);
      if (!conv || !Array.isArray(conv.messages)) continue;
      if (conv.messages.length === 0) continue;
      const fileName = `${CHATS_DIR}/${item.id}.json`;
      records[fileName] = JSON.stringify(conv, null, 2);
      chatCount++;
      for (const msg of conv.messages) {
        if (msg.attachments && Array.isArray(msg.attachments)) {
          attachmentCount += msg.attachments.length;
        }
      }
    }
    if (chatCount > 0) {
      includes.chats = true;
      includes.attachments = true;
    }
  }

  const manifest = buildManifest({ includes, counts: { chats: chatCount, attachments: attachmentCount } });
  records[MANIFEST_FILE] = JSON.stringify(manifest, null, 2);

  const zipBuffer = zipSync(recordsToZipInput(records), { level: 6 });
  return new Blob([zipBuffer], { type: "application/zip" });
}

/**
 * Exports a single conversation to a zip Blob.
 */
export async function exportSingleChatToZip(conversationId, { includeApiKey = false } = {}) {
  if (!conversationId) throw new Error("conversationId is required");

  const records = {};
  const conv = await localforage.getItem(`conversation_${conversationId}`);
  if (!conv || !Array.isArray(conv.messages)) {
    throw new Error("Conversation not found or has no messages");
  }

  let attachmentCount = 0;
  for (const msg of conv.messages) {
    if (msg.attachments && Array.isArray(msg.attachments)) {
      attachmentCount += msg.attachments.length;
    }
  }

  records[SINGLE_CHAT_FILE] = JSON.stringify(conv, null, 2);

  const includes = { chats: true, memory: false, settings: false, attachments: attachmentCount > 0 };
  const manifest = buildManifest({
    includes,
    counts: { chats: 1, attachments: attachmentCount },
  });
  manifest.singleChat = true;
  manifest.conversationId = conversationId;
  records[MANIFEST_FILE] = JSON.stringify(manifest, null, 2);

  const zipBuffer = zipSync(recordsToZipInput(records), { level: 6 });
  return new Blob([zipBuffer], { type: "application/zip" });
}

/**
 * Decodes a Uint8Array to a UTF-8 string.
 */
export function decodeTextFile(bytes) {
  return strFromU8(bytes);
}

/**
 * Unzips a buffer into a map of filename -> string content.
 */
export function unzipToRecordMap(buffer) {
  const entries = unzipSync(buffer);
  const records = {};
  for (const [name, bytes] of Object.entries(entries)) {
    records[name] = decodeTextFile(bytes);
  }
  return records;
}

/**
 * Validates a manifest object.
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    return { valid: false, error: "Manifest is missing or invalid" };
  }
  if (manifest.format !== EXPORT_FORMAT) {
    return { valid: false, error: `Unsupported format: ${manifest.format}` };
  }
  if (manifest.formatVersion !== EXPORT_FORMAT_VERSION) {
    return { valid: false, error: `Unsupported format version: ${manifest.formatVersion}` };
  }
  if (!manifest.includes || typeof manifest.includes !== "object") {
    return { valid: false, error: "Manifest is missing includes" };
  }
  return { valid: true };
}

/**
 * Heuristic to detect an OpenWebUI chat export.
 */
export function isOpenWebUIChat(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (Array.isArray(obj.messages) && obj.messages.length > 0) return true;
  if (Array.isArray(obj.chat?.messages) && obj.chat.messages.length > 0) return true;
  if (Array.isArray(obj) && obj.length > 0 && obj[0]?.messages) return true;
  return false;
}

function normalizeOpenWebUIMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  const role = msg.role;
  const content = typeof msg.content === "string" ? msg.content : "";
  const timestamp = msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString();
  return { id: generateId(), role, content, timestamp, parentId: null, branchIndex: 0, complete: true };
}

/**
 * Converts an OpenWebUI chat export into a native Libre Assistant conversation.
 */
export function convertOpenWebUIChatToNative(chat) {
  let messages = [];
  let title = "Imported chat";
  if (Array.isArray(chat?.messages)) {
    messages = chat.messages;
    title = chat.title || title;
  } else if (Array.isArray(chat?.chat?.messages)) {
    messages = chat.chat.messages;
    title = chat.chat?.title || chat.title || title;
  }

  const normalized = messages
    .map((m) => normalizeOpenWebUIMessage(m))
    .filter(Boolean);

  // Linear messages -> parentId chain
  for (let i = 1; i < normalized.length; i++) {
    normalized[i].parentId = normalized[i - 1].id;
  }

  return {
    id: generateId(),
    title,
    lastUpdated: new Date().toISOString(),
    messages: normalized,
    branchPath: [],
  };
}

/**
 * Validates a native conversation object.
 */
export function validateNativeChat(chat) {
  if (!chat || typeof chat !== "object") return { valid: false, error: "Chat is not an object" };
  if (!chat.id || typeof chat.id !== "string") return { valid: false, error: "Chat is missing id" };
  if (!Array.isArray(chat.messages)) return { valid: false, error: "Chat is missing messages array" };
  for (const msg of chat.messages) {
    if (!msg || typeof msg !== "object") return { valid: false, error: "Message is not an object" };
    if (!msg.id || typeof msg.id !== "string") return { valid: false, error: "Message is missing id" };
    if (!msg.role || typeof msg.role !== "string") return { valid: false, error: "Message is missing role" };
    if (typeof msg.content !== "string" && typeof msg.content !== "object") {
      return { valid: false, error: "Message content is invalid" };
    }
  }
  return { valid: true };
}

function cloneChat(chat) {
  return JSON.parse(JSON.stringify(chat));
}

function remapMessageIds(chat) {
  const idMap = new Map();
  const cloned = cloneChat(chat);
  for (const msg of cloned.messages) {
    const newId = generateId();
    idMap.set(msg.id, newId);
    msg.id = newId;
  }
  for (const msg of cloned.messages) {
    if (msg.parentId && idMap.has(msg.parentId)) {
      msg.parentId = idMap.get(msg.parentId);
    }
  }
  cloned.id = generateId();
  return cloned;
}

/**
 * Applies ID collision rules to a list of imported chats.
 * existingIds: Set of conversation IDs currently in storage.
 * mode: 'skip' | 'replace' | 'append'.
 */
export function prepareChatsForImport(chats, existingIds, mode) {
  const existingSet = new Set(existingIds);
  const result = [];
  const skipped = [];

  for (const chat of chats) {
    const validation = validateNativeChat(chat);
    if (!validation.valid) continue;

    if (mode === "skip") {
      if (existingSet.has(chat.id)) {
        skipped.push(chat.id);
      } else {
        result.push(chat);
      }
    } else if (mode === "replace") {
      // Keep original IDs; persist step will overwrite existing keys.
      result.push(chat);
    } else {
      // append: regenerate IDs only when colliding with existing storage.
      if (existingSet.has(chat.id)) {
        result.push(remapMessageIds(chat));
      } else {
        result.push(chat);
      }
    }
  }

  return { chats: result, skipped };
}

/**
 * Persists imported chats to localforage and refreshes the conversations list.
 */
export async function persistImportedChats(chats, mode) {
  const metadata = (await localforage.getItem("conversations_metadata")) || [];
  const metadataMap = new Map(metadata.map((m) => [m.id, m]));
  let importedCount = 0;
  let replacedCount = 0;
  const skippedIds = [];

  // In replace mode, collect the IDs that will survive after import.
  const importedIds = new Set();

  for (const chat of chats) {
    const validation = validateNativeChat(chat);
    if (!validation.valid) {
      console.error("[importExport] Skipping invalid chat:", validation.error);
      continue;
    }

    const existing = metadataMap.has(chat.id);
    if (existing && mode === "skip") {
      skippedIds.push(chat.id);
      continue;
    }

    await localforage.setItem(`conversation_${chat.id}`, chat);
    metadataMap.set(chat.id, { id: chat.id, title: chat.title || "Untitled", lastUpdated: chat.lastUpdated });
    importedIds.add(chat.id);
    if (existing) replacedCount++;
    else importedCount++;
  }

  // In replace mode, delete old chats that were not part of the import.
  // Only do this after all imported chats have been written successfully.
  if (mode === "replace") {
    for (const oldId of metadata.map((m) => m.id)) {
      if (!importedIds.has(oldId)) {
        await localforage.removeItem(`conversation_${oldId}`);
        metadataMap.delete(oldId);
      }
    }
  }

  const updatedMetadata = Array.from(metadataMap.values()).sort((a, b) => {
    const dateA = a.lastUpdated ? new Date(a.lastUpdated) : new Date(0);
    const dateB = b.lastUpdated ? new Date(b.lastUpdated) : new Date(0);
    return dateB - dateA;
  });

  await localforage.setItem("conversations_metadata", updatedMetadata);
  emitter.emit("updateConversations");

  return { imported: importedCount, replaced: replacedCount, skipped: skippedIds.length };
}

/**
 * Persists imported settings. Only fields present in the imported object are
 * overwritten. The API key is preserved unless the import includes a non-empty
 * value, so an export made without "Include API key" checked does not wipe the
 * user's existing key.
 */
export async function persistImportedSettings(settings, settingsManager) {
  if (!settings || typeof settings !== "object") return false;
  if (settings.version !== SETTINGS_VERSION) {
    console.warn("[importExport] Imported settings version mismatch:", settings.version);
  }

  const existingSettings = settingsManager
    ? JSON.parse(JSON.stringify(settingsManager.settings))
    : (await localforage.getItem("settings")) || {};

  const merged = { ...existingSettings };
  for (const [key, value] of Object.entries(settings)) {
    if (key === "custom_api_key") {
      // Only overwrite the API key if the import actually includes one.
      if (value) {
        merged[key] = value;
      }
    } else {
      merged[key] = value;
    }
  }

  if (settingsManager && typeof settingsManager.saveSettings === "function") {
    Object.assign(settingsManager.settings, merged);
    await settingsManager.saveSettings();
  } else {
    await localforage.setItem("settings", merged);
  }
  return true;
}

/**
 * Persists imported notepad content.
 */
export async function persistImportedNotepad(content, metadata) {
  if (typeof content !== "string" || content.trim() === "") return false;
  await saveNotepad(content, metadata || {});
  return true;
}

/**
 * Parses a zip buffer (or raw JSON buffer) into a structured archive object.
 */
export function parseImportArchive(buffer) {
  let records = {};
  let rawJson = null;

  try {
    records = unzipToRecordMap(buffer);
  } catch (zipErr) {
    // Try parsing as raw JSON (e.g. OpenWebUI .json file).
    const text = typeof buffer === "string" ? buffer : new TextDecoder().decode(buffer);
    try {
      rawJson = JSON.parse(text);
    } catch (jsonErr) {
      throw new Error("File is not a valid zip or JSON file");
    }
  }

  const chats = [];
  let notepad = null;
  let settings = null;
  let isOpenWebUI = false;

  // Raw JSON path: detect OpenWebUI or single native chat directly.
  if (rawJson) {
    if (isOpenWebUIChat(rawJson)) {
      isOpenWebUI = true;
      if (Array.isArray(rawJson)) {
        for (const c of rawJson) chats.push(normalizeChat(convertOpenWebUIChatToNative(c)));
      } else if (Array.isArray(rawJson.chats)) {
        for (const c of rawJson.chats) chats.push(normalizeChat(convertOpenWebUIChatToNative(c)));
      } else {
        chats.push(normalizeChat(convertOpenWebUIChatToNative(rawJson)));
      }
    } else if (validateNativeChat(rawJson).valid) {
      chats.push(normalizeChat(rawJson));
    } else if (rawJson.chat && validateNativeChat(rawJson.chat).valid) {
      chats.push(normalizeChat(rawJson.chat));
    }

    console.log("[importExport] Parsed raw JSON:", { chats: chats.length, isOpenWebUI });
    return {
      manifest: null,
      chats,
      notepad,
      settings,
      isOpenWebUI,
      records: {},
    };
  }

  const manifestRaw = records[MANIFEST_FILE];
  let manifest = null;
  if (manifestRaw) {
    try {
      manifest = JSON.parse(manifestRaw);
    } catch {
      throw new Error("Manifest file is invalid JSON");
    }
  }

  if (manifest && manifest.format === EXPORT_FORMAT) {
    const manifestValidation = validateManifest(manifest);
    if (!manifestValidation.valid) throw new Error(manifestValidation.error);

    if (manifest.includes?.chats) {
      if (manifest.singleChat && records[SINGLE_CHAT_FILE]) {
        try {
          const chat = normalizeChat(JSON.parse(records[SINGLE_CHAT_FILE]));
          chats.push(chat);
        } catch {
          console.warn("[importExport] Could not parse single chat file");
        }
      } else {
        for (const [name, content] of Object.entries(records)) {
          if (name.startsWith(`${CHATS_DIR}/`) && name.endsWith(".json")) {
            try {
              const chat = normalizeChat(JSON.parse(content));
              chats.push(chat);
            } catch {
              console.warn(`[importExport] Could not parse chat file: ${name}`);
            }
          }
        }
      }
    }

    if (manifest.includes?.memory) {
      const content = records[MEMORY_FILE];
      const metadataRaw = records[MEMORY_METADATA_FILE];
      if (content !== undefined) {
        try {
          notepad = { content, metadata: metadataRaw ? JSON.parse(metadataRaw) : {} };
        } catch {
          notepad = { content, metadata: {} };
        }
      }
    }

    if (manifest.includes?.settings) {
      const settingsRaw = records[SETTINGS_FILE];
      if (settingsRaw) {
        try {
          settings = JSON.parse(settingsRaw);
        } catch {
          settings = null;
        }
      }
    }
  }

  // Fallback: if no Libre manifest was found, look for native chat files by name.
  if (!manifest || manifest.format !== EXPORT_FORMAT) {
    console.log("[importExport] No Libre manifest found; scanning for native chat files");
    if (records[SINGLE_CHAT_FILE]) {
      try {
        const chat = normalizeChat(JSON.parse(records[SINGLE_CHAT_FILE]));
        chats.push(chat);
      } catch {
        console.warn("[importExport] Could not parse fallback single chat file");
      }
    }
    for (const [name, content] of Object.entries(records)) {
      if (name.startsWith(`${CHATS_DIR}/`) && name.endsWith(".json")) {
        try {
          const chat = normalizeChat(JSON.parse(content));
          chats.push(chat);
        } catch {
          console.warn(`[importExport] Could not parse fallback chat file: ${name}`);
        }
      }
    }
  }

  console.log("[importExport] Parsed archive:", {
    hasManifest: !!manifest,
    chats: chats.length,
    hasNotepad: !!notepad,
    hasSettings: !!settings,
  });

  return {
    manifest,
    chats,
    notepad,
    settings,
    isOpenWebUI,
    records,
  };
}

function normalizeChat(chat) {
  if (!chat || typeof chat !== "object") return null;
  return {
    id: typeof chat.id === "string" ? chat.id : generateId(),
    title: typeof chat.title === "string" ? chat.title : "Imported chat",
    lastUpdated: chat.lastUpdated ? new Date(chat.lastUpdated).toISOString() : new Date().toISOString(),
    messages: Array.isArray(chat.messages) ? chat.messages : [],
    branchPath: Array.isArray(chat.branchPath) ? chat.branchPath : [],
  };
}

/**
 * Imports an archive buffer into local storage.
 */
export async function importFromZipBuffer(
  buffer,
  {
    chatsMode = "append",
    notepadMode = "replace",
    settingsMode = "replace",
    settingsManager = null,
  } = {}
) {
  const archive = parseImportArchive(buffer);
  console.log("[importExport] Import options:", { chatsMode, notepadMode, settingsMode });

  const result = {
    chats: { imported: 0, replaced: 0, skipped: 0 },
    notepad: false,
    settings: false,
  };

  // Chats
  if (archive.chats.length > 0 && chatsMode !== "skip") {
    const existingMetadata = (await localforage.getItem("conversations_metadata")) || [];
    const existingIds = existingMetadata.map((m) => m.id);
    const { chats: preparedChats, skipped } = prepareChatsForImport(archive.chats, existingIds, chatsMode);
    const persistResult = await persistImportedChats(preparedChats, chatsMode);
    result.chats = { ...persistResult, skipped: skipped.length };
    console.log("[importExport] Chats import result:", result.chats);
  }

  // When chats are skipped entirely, count them as skipped.
  if (archive.chats.length > 0 && chatsMode === "skip") {
    result.chats.skipped = archive.chats.length;
  }

  // Notepad
  if (archive.notepad && notepadMode === "replace") {
    const ok = await persistImportedNotepad(archive.notepad.content, archive.notepad.metadata);
    result.notepad = ok;
  }

  // Settings
  if (archive.settings && settingsMode === "replace") {
    const ok = await persistImportedSettings(archive.settings, settingsManager);
    result.settings = ok;
  }

  console.log("[importExport] Import result:", result);
  return result;
}

/**
 * Reads a File/Blob into an ArrayBuffer.
 */
export function readFileAsBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Generates a filename for a full export zip.
 */
export function generateExportFilename(prefix = "libre-assistant-export") {
  const date = new Date().toISOString().split("T")[0];
  return `${prefix}-${date}.zip`;
}

/**
 * Generates a filename for a single-chat export zip.
 */
export function generateSingleChatExportFilename(conversationId) {
  return `chat-${conversationId}.zip`;
}

export default {
  exportAllToZip,
  exportSingleChatToZip,
  importFromZipBuffer,
  parseImportArchive,
  triggerDownload,
  generateExportFilename,
  generateSingleChatExportFilename,
  readFileAsBuffer,
  prepareChatsForImport,
  persistImportedChats,
  persistImportedSettings,
  persistImportedNotepad,
  validateNativeChat,
  isOpenWebUIChat,
  convertOpenWebUIChatToNative,
};
