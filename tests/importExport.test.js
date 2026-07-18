/**
 * @file importExport.test.js
 * @description Unit tests for the import/export system: zip generation,
 * OpenWebUI conversion, ID collision handling, and round-trip persistence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { store } = vi.hoisted(() => ({ store: new Map() }));
const emitted = [];

vi.mock("localforage", () => ({
  default: {
    getItem: vi.fn(async (key) => (store.has(key) ? store.get(key) : null)),
    setItem: vi.fn(async (key, value) => {
      store.set(key, value);
      return value;
    }),
    removeItem: vi.fn(async (key) => {
      store.delete(key);
    }),
  },
}));

vi.mock("~/composables/emitter", () => ({
  emitter: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn((name, payload) => emitted.push({ name, payload })),
  },
}));

import {
  stripSecrets,
  isDefaultNotepad,
  buildManifest,
  validateManifest,
  isOpenWebUIChat,
  convertOpenWebUIChatToNative,
  validateNativeChat,
  prepareChatsForImport,
  persistImportedChats,
  persistImportedNotepad,
  persistImportedSettings,
  exportAllToZip,
  exportSingleChatToZip,
  importFromZipBuffer,
  parseImportArchive,
  unzipToRecordMap,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  SETTINGS_VERSION,
} from "../app/composables/importExport.js";

beforeEach(() => {
  store.clear();
  emitted.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  store.clear();
});

function createSampleChat(id = "conv-1", messageCount = 2) {
  const messages = [];
  for (let i = 0; i < messageCount; i++) {
    const parentId = i > 0 ? messages[i - 1].id : null;
    messages.push({
      id: `msg-${id}-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
      timestamp: new Date().toISOString(),
      complete: true,
      parentId,
      branchIndex: 0,
    });
  }
  return {
    id,
    title: `Chat ${id}`,
    lastUpdated: new Date().toISOString(),
    messages,
    branchPath: [],
  };
}

function seedChat(chat) {
  store.set(`conversation_${chat.id}`, chat);
  const meta = store.get("conversations_metadata") || [];
  meta.push({ id: chat.id, title: chat.title, lastUpdated: chat.lastUpdated });
  store.set("conversations_metadata", meta);
}

async function blobToBuffer(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

describe("buildManifest", () => {
  it("produces a valid manifest with all fields", () => {
    const manifest = buildManifest({
      includes: { chats: true, memory: true, settings: true, attachments: true },
      counts: { chats: 3, attachments: 5 },
    });
    expect(manifest.format).toBe(EXPORT_FORMAT);
    expect(manifest.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(manifest.appVersion).toBeTruthy();
    expect(manifest.settingsVersion).toBe(SETTINGS_VERSION);
    expect(manifest.exportedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(manifest.includes.chats).toBe(true);
    expect(manifest.counts.chats).toBe(3);
  });

  it("defaults missing counts to zero", () => {
    const manifest = buildManifest({ includes: {} });
    expect(manifest.counts.chats).toBe(0);
    expect(manifest.counts.attachments).toBe(0);
  });
});

describe("validateManifest", () => {
  it("accepts a valid manifest", () => {
    const result = validateManifest(buildManifest({ includes: { chats: true } }));
    expect(result.valid).toBe(true);
  });

  it("rejects an unsupported format", () => {
    const result = validateManifest({ format: "other", formatVersion: 1, includes: {} });
    expect(result.valid).toBe(false);
  });

  it("rejects a missing includes block", () => {
    const result = validateManifest({ format: EXPORT_FORMAT, formatVersion: EXPORT_FORMAT_VERSION });
    expect(result.valid).toBe(false);
  });
});

describe("stripSecrets", () => {
  it("removes the custom API key", () => {
    const settings = { custom_api_key: "secret", version: 5 };
    const stripped = stripSecrets(settings);
    expect(stripped.custom_api_key).toBe("");
    expect(stripped.version).toBe(5);
  });

  it("does not mutate the original object", () => {
    const settings = { custom_api_key: "secret" };
    const stripped = stripSecrets(settings);
    expect(stripped).not.toBe(settings);
    expect(settings.custom_api_key).toBe("secret");
  });
});

describe("isDefaultNotepad", () => {
  it("returns true for empty content", () => {
    expect(isDefaultNotepad("", {}, true)).toBe(true);
    expect(isDefaultNotepad("   \n", {}, true)).toBe(true);
  });

  it("returns true when notepad is disabled", () => {
    expect(isDefaultNotepad("some notes", {}, false)).toBe(true);
  });

  it("returns false for real content with enabled notepad", () => {
    expect(isDefaultNotepad("# Notes", { updateCount: 1 }, true)).toBe(false);
  });
});

describe("isOpenWebUIChat and conversion", () => {
  it("detects an OpenWebUI-style chat object", () => {
    expect(
      isOpenWebUIChat({
        title: "Test",
        messages: [{ role: "user", content: "hi" }],
      })
    ).toBe(true);
  });

  it("detects an OpenWebUI chat wrapped in a .chat property", () => {
    expect(
      isOpenWebUIChat({
        chat: { title: "Test", messages: [{ role: "user", content: "hi" }] },
      })
    ).toBe(true);
  });

  it("converts a linear OpenWebUI chat to a native parentId chain", () => {
    const chat = convertOpenWebUIChatToNative({
      title: "Hello",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "bye" },
      ],
    });
    expect(chat.title).toBe("Hello");
    expect(chat.messages).toHaveLength(3);
    expect(chat.messages[0].parentId).toBeNull();
    expect(chat.messages[1].parentId).toBe(chat.messages[0].id);
    expect(chat.messages[2].parentId).toBe(chat.messages[1].id);
    expect(chat.branchPath).toEqual([]);
  });
});

describe("validateNativeChat", () => {
  it("accepts a valid chat", () => {
    const result = validateNativeChat(createSampleChat());
    expect(result.valid).toBe(true);
  });

  it("rejects a chat without messages", () => {
    const result = validateNativeChat({ id: "x" });
    expect(result.valid).toBe(false);
  });

  it("rejects a message without an id", () => {
    const chat = createSampleChat();
    chat.messages[0].id = null;
    const result = validateNativeChat(chat);
    expect(result.valid).toBe(false);
  });
});

describe("prepareChatsForImport", () => {
  it("keeps IDs in replace mode", () => {
    const chat = createSampleChat("existing");
    const { chats } = prepareChatsForImport([chat], ["existing"], "replace");
    expect(chats[0].id).toBe("existing");
  });

  it("skips existing IDs in skip mode", () => {
    const chat = createSampleChat("existing");
    const { chats, skipped } = prepareChatsForImport([chat], ["existing"], "skip");
    expect(chats).toHaveLength(0);
    expect(skipped).toContain("existing");
  });

  it("remaps IDs and parentIds in append mode on collision", () => {
    const chat = createSampleChat("existing", 3);
    const { chats } = prepareChatsForImport([chat], ["existing"], "append");
    expect(chats[0].id).not.toBe("existing");
    const ids = new Set(chats[0].messages.map((m) => m.id));
    expect(ids.size).toBe(3);
    // Every parentId should point to a message inside the new chat.
    for (const msg of chats[0].messages) {
      if (msg.parentId) {
        expect(ids.has(msg.parentId)).toBe(true);
      }
    }
  });

  it("keeps IDs in append mode when there is no collision", () => {
    const chat = createSampleChat("new");
    const { chats } = prepareChatsForImport([chat], ["other"], "append");
    expect(chats[0].id).toBe("new");
  });
});

describe("exportAllToZip", () => {
  it("exports a manifest, settings, notepad, and chats", async () => {
    store.set("settings", {
      version: 5,
      selected_model_id: "z-ai/glm-4.7-flash-0905",
      custom_api_key: "secret",
      notepad_enabled: true,
    });
    store.set("user_notepad", "# Notes");
    store.set("user_notepad_metadata", { version: 1, updateCount: 1, lastConsolidatedAt: null });

    const chat = createSampleChat("c1");
    seedChat(chat);

    const blob = await exportAllToZip({ includeApiKey: true });
    const records = unzipToRecordMap(await blobToBuffer(blob));

    const manifest = JSON.parse(records["manifest.json"]);
    expect(manifest.format).toBe(EXPORT_FORMAT);
    expect(manifest.includes.chats).toBe(true);
    expect(manifest.includes.memory).toBe(true);
    expect(manifest.includes.settings).toBe(true);
    expect(manifest.counts.chats).toBe(1);

    expect(records["settings.json"]).toContain("custom_api_key");
    const settings = JSON.parse(records["settings.json"]);
    expect(settings.custom_api_key).toBe("secret");

    expect(records["memory.md"]).toBe("# Notes");
    expect(JSON.parse(records["memory.metadata.json"]).updateCount).toBe(1);

    expect(records["chats/c1.json"]).toBeTruthy();
  });

  it("redacts the API key by default", async () => {
    store.set("settings", {
      version: 5,
      custom_api_key: "secret",
    });
    const chat = createSampleChat("c1");
    seedChat(chat);

    const blob = await exportAllToZip();
    const records = unzipToRecordMap(await blobToBuffer(blob));
    const settings = JSON.parse(records["settings.json"]);
    expect(settings.custom_api_key).toBe("");
  });

  it("omits the notepad when empty or disabled", async () => {
    store.set("settings", { version: 5, notepad_enabled: false });
    store.set("user_notepad", "");
    store.set("user_notepad_metadata", { version: 1, updateCount: 0, lastConsolidatedAt: null });
    const chat = createSampleChat("c1");
    seedChat(chat);

    const blob = await exportAllToZip();
    const records = unzipToRecordMap(await blobToBuffer(blob));
    expect(records["memory.md"]).toBeUndefined();
    expect(records["memory.metadata.json"]).toBeUndefined();
  });

  it("omits default settings from the zip", async () => {
    store.set("settings", {
      version: 5,
      notepad_enabled: false,
      context_compression_enabled: true,
      context_compression_model: "deepseek/deepseek-v4-flash",
      context_compression_threshold_tokens: 25000,
      context_compression_keep_recent_tokens: 5000,
      selected_model_id: "moonshotai/kimi-k2.6",
      search_enabled: false,
      model_settings: {},
      parameter_config: { temperature: 1.0, top_p: 0.95, seed: null, max_tokens: 8192, grounding: false },
      gpt_oss_limit_tables: false,
      custom_api_key: "",
    });
    const chat = createSampleChat("c1");
    seedChat(chat);

    const blob = await exportAllToZip();
    const records = unzipToRecordMap(await blobToBuffer(blob));
    expect(records["settings.json"]).toBeUndefined();
  });

  it("omits empty chat files", async () => {
    store.set("settings", { version: 5 });
    store.set("conversation_empty", { id: "empty", title: "Empty", messages: [], branchPath: [] });
    const meta = [{ id: "empty", title: "Empty", lastUpdated: new Date().toISOString() }];
    store.set("conversations_metadata", meta);

    const blob = await exportAllToZip();
    const records = unzipToRecordMap(await blobToBuffer(blob));
    expect(records["chats/empty.json"]).toBeUndefined();
  });
});

describe("exportSingleChatToZip", () => {
  it("exports a single chat as manifest + chat.json", async () => {
    const chat = createSampleChat("single");
    store.set("conversation_single", chat);

    const blob = await exportSingleChatToZip("single");
    const records = unzipToRecordMap(await blobToBuffer(blob));

    const manifest = JSON.parse(records["manifest.json"]);
    expect(manifest.singleChat).toBe(true);
    expect(manifest.conversationId).toBe("single");

    const exported = JSON.parse(records["chat.json"]);
    expect(exported.id).toBe("single");
    expect(exported.messages).toHaveLength(2);
  });

  it("throws when the conversation is missing", async () => {
    await expect(exportSingleChatToZip("missing")).rejects.toThrow("Conversation not found");
  });
});

describe("importFromZipBuffer round-trip", () => {
  it("imports a full native export back into storage", async () => {
    store.set("settings", { version: 5, selected_model_id: "x", custom_api_key: "secret", notepad_enabled: true });
    store.set("user_notepad", "# Memory");
    store.set("user_notepad_metadata", { version: 1, updateCount: 2 });
    const chat = createSampleChat("c1");
    seedChat(chat);

    const blob = await exportAllToZip({ includeApiKey: true });
    // Clear storage to simulate import into a fresh instance.
    store.clear();

    await importFromZipBuffer(await blobToBuffer(blob));

    expect(store.get("settings").selected_model_id).toBe("x");
    expect(store.get("user_notepad")).toBe("# Memory");
    const meta = store.get("conversations_metadata");
    expect(meta).toHaveLength(1);
    expect(meta[0].id).toBe("c1");
    const imported = store.get("conversation_c1");
    expect(imported.messages).toHaveLength(2);
  });

  it("imports a single-chat archive", async () => {
    const chat = createSampleChat("single");
    store.set("conversation_single", chat);

    const blob = await exportSingleChatToZip("single");
    store.clear();

    await importFromZipBuffer(await blobToBuffer(blob));

    const meta = store.get("conversations_metadata");
    expect(meta).toHaveLength(1);
    expect(store.get("conversation_single").messages).toHaveLength(2);
  });

  it("imports an OpenWebUI JSON file", async () => {
    const openwebui = {
      title: "OpenWebUI chat",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
    };
    const text = JSON.stringify(openwebui);
    const encoder = new TextEncoder();
    await importFromZipBuffer(encoder.encode(text));

    const meta = store.get("conversations_metadata");
    expect(meta).toHaveLength(1);
    expect(meta[0].title).toBe("OpenWebUI chat");

    const imported = store.get(`conversation_${meta[0].id}`);
    expect(imported.messages).toHaveLength(2);
    expect(imported.messages[1].parentId).toBe(imported.messages[0].id);
  });

  it("appends without overwriting existing chats", async () => {
    const existing = createSampleChat("existing");
    seedChat(existing);
    const incoming = createSampleChat("existing");
    const blob = await exportSingleChatToZip("existing");

    const result = await importFromZipBuffer(await blobToBuffer(blob), { chatsMode: "append" });
    const meta = store.get("conversations_metadata");
    expect(meta).toHaveLength(2);
    expect(result.chats.imported).toBe(1);
  });

  it("replaces existing chats when chosen", async () => {
    const existing = createSampleChat("existing");
    existing.messages[0].content = "original";
    seedChat(existing);
    const incoming = createSampleChat("existing");
    incoming.messages[0].content = "replaced";
    store.set("conversation_existing", incoming);
    const blob = await exportSingleChatToZip("existing");

    await importFromZipBuffer(await blobToBuffer(blob), { chatsMode: "replace" });
    expect(store.get("conversation_existing").messages[0].content).toBe("replaced");
  });

  it("deletes old chats in replace mode after importing", async () => {
    const new1 = createSampleChat("new1");
    const new2 = createSampleChat("new2");
    seedChat(new1);
    seedChat(new2);

    const blob = await exportAllToZip();

    // Clear and seed with old chats that should be replaced.
    store.clear();
    const old1 = createSampleChat("old1");
    const old2 = createSampleChat("old2");
    seedChat(old1);
    seedChat(old2);

    await importFromZipBuffer(await blobToBuffer(blob), { chatsMode: "replace" });

    const meta = store.get("conversations_metadata");
    const ids = meta.map((m) => m.id).sort();
    expect(ids).toEqual(["new1", "new2"]);
    expect(store.get("conversation_old1")).toBeUndefined();
    expect(store.get("conversation_old2")).toBeUndefined();
    expect(store.get("conversation_new1")).toBeTruthy();
    expect(store.get("conversation_new2")).toBeTruthy();
  });

  it("skips duplicate chats in skip mode", async () => {
    const existing = createSampleChat("existing");
    seedChat(existing);
    const blob = await exportSingleChatToZip("existing");

    const result = await importFromZipBuffer(await blobToBuffer(blob), { chatsMode: "skip" });
    expect(result.chats.skipped).toBe(1);
    expect(result.chats.imported).toBe(0);
  });

  it("throws on a corrupted manifest before touching storage", async () => {
    const { zipSync, strToU8 } = await import("fflate");
    const records = { "manifest.json": strToU8("not json") };
    const buffer = zipSync(records, { level: 6 });
    await expect(importFromZipBuffer(buffer)).rejects.toThrow();
  });
});

describe("parseImportArchive", () => {
  it("parses a native zip archive", async () => {
    const chat = createSampleChat("c1");
    seedChat(chat);
    store.set("settings", { version: 5 });

    const blob = await exportAllToZip();
    const archive = parseImportArchive(await blobToBuffer(blob));

    expect(archive.manifest.format).toBe(EXPORT_FORMAT);
    expect(archive.chats).toHaveLength(1);
    expect(archive.settings).toBeTruthy();
  });
});

describe("persistImportedNotepad", () => {
  it("writes notepad content and metadata", async () => {
    const ok = await persistImportedNotepad("# Notes", { updateCount: 3 });
    expect(ok).toBe(true);
    expect(store.get("user_notepad")).toBe("# Notes");
  });

  it("returns false for empty content", async () => {
    const ok = await persistImportedNotepad("", {});
    expect(ok).toBe(false);
  });
});

describe("persistImportedSettings", () => {
  it("writes settings directly when no manager is provided", async () => {
    const ok = await persistImportedSettings({ version: 5, custom: true }, null);
    expect(ok).toBe(true);
    expect(store.get("settings").custom).toBe(true);
  });

  it("preserves existing API key when import has none", async () => {
    store.set("settings", { version: 5, custom_api_key: "existing-key", selected_model_id: "x" });
    await persistImportedSettings({ version: 5, selected_model_id: "y" }, null);
    expect(store.get("settings").selected_model_id).toBe("y");
    expect(store.get("settings").custom_api_key).toBe("existing-key");
  });

  it("preserves existing API key when import has empty string", async () => {
    store.set("settings", { version: 5, custom_api_key: "existing-key", selected_model_id: "x" });
    await persistImportedSettings({ version: 5, custom_api_key: "", selected_model_id: "y" }, null);
    expect(store.get("settings").selected_model_id).toBe("y");
    expect(store.get("settings").custom_api_key).toBe("existing-key");
  });
});
