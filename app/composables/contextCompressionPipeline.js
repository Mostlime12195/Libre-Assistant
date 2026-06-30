/**
 * @file contextCompressionPipeline.js
 * @description Background orchestration for context compression.
 *
 * The pipeline is intentionally fire-and-forget: the chat UI should
 * never block on a compression call. The only side effects are
 *   1. Inserting an `in_progress` `context_summary` marker into the
 *      chat's `messages` array so the UI shows progress.
 *   2. Mutating that marker to `completed` (with `summaryText`) or
 *      `stale` when the model call finishes (or fails).
 *   3. Persisting the chunk's metadata to the sidecar.
 *
 * The pipeline never deletes data, never edits user/assistant
 * messages, and is safe to interrupt: on the next call we simply
 * detect any `in_progress` markers and treat them as not-yet-done.
 *
 * Triggers:
 *   - The chat messages array contains a "closed" chunk (a span of
 *     `chunkSize` user turns that ends strictly before the last user
 *     message) AND the chunk is above `minChunkTokens`.
 *   - No in-flight compression run for this conversation.
 *
 * The pipeline is also a public entry point: a UI button or a future
 * "rebuild all summaries" command can call `forceCompressConversation`.
 */

import localforage from "localforage";
import mitt from "mitt";
import {
  loadContextSummary,
  saveContextSummary,
  identifyNextChunk,
  buildInProgressMarker,
  estimateChunkTokens,
  callCompressionModel,
  hashBranchPath,
} from "./contextCompressor";

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

export const contextCompressionEvents = mitt();

function emitEvent(conversationId, payload) {
  contextCompressionEvents.emit("change", { conversationId, ...payload });
}

// ---------------------------------------------------------------------------
// In-memory run lock (per conversation, per tab)
// ---------------------------------------------------------------------------

/** @type {Map<string, Promise<any>>} */
const inFlightRuns = new Map();

/**
 * Returns true if a compression run is currently in flight for the
 * given conversation in this tab.
 * @param {string} conversationId
 * @returns {boolean}
 */
export function isCompressionRunning(conversationId) {
  return inFlightRuns.has(conversationId);
}

// ---------------------------------------------------------------------------
// Settings resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the compression settings from the user's settings object.
 * Returns safe defaults if anything is missing or invalid.
 *
 * @param {Object} settings
 * @returns {{enabled: boolean, model: string, chunkSize: number, minChunkTokens: number}}
 */
export function resolveCompressionSettings(settings) {
  const s = settings || {};
  const enabled = s.context_compression_enabled !== false; // default true
  const model =
    typeof s.context_compression_model === "string" && s.context_compression_model.trim()
      ? s.context_compression_model.trim()
      : "deepseek/deepseek-v4-flash";
  let chunkSize = Number(s.context_compression_chunk_size);
  if (!Number.isFinite(chunkSize) || chunkSize < 2) chunkSize = 10;
  let minChunkTokens = Number(s.context_compression_min_chunk_tokens);
  if (!Number.isFinite(minChunkTokens) || minChunkTokens < 0) minChunkTokens = 2000;
  return { enabled, model, chunkSize, minChunkTokens };
}

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

/**
 * Returns `{shouldRun, chunk, reason}` for a given conversation.
 * Pure read; does not mutate anything.
 *
 * @param {Array} visibleMessages
 * @param {Object} settings
 * @returns {{shouldRun: boolean, chunk: Object|null, reason: string|null}}
 */
export function shouldRunCompression(visibleMessages, settings) {
  const { enabled, chunkSize, minChunkTokens } = resolveCompressionSettings(settings);
  if (!enabled) return { shouldRun: false, chunk: null, reason: "disabled" };

  const next = identifyNextChunk(visibleMessages, chunkSize);
  if (!next) return { shouldRun: false, chunk: null, reason: "no_chunk" };
  if (!next.isClosed) {
    return { shouldRun: false, chunk: next, reason: "chunk_not_closed" };
  }

  const tokens = estimateChunkTokens(next.chunk);
  if (tokens < minChunkTokens) {
    return { shouldRun: false, chunk: next, reason: "below_token_floor" };
  }

  return { shouldRun: true, chunk: next, reason: null };
}

// ---------------------------------------------------------------------------
// Message mutation helpers
// ---------------------------------------------------------------------------

/**
 * Inserts a `context_summary` marker into the messages array directly
 * after the last message of the chunk. Returns the new array and the
 * inserted marker (by reference).
 *
 * @param {Array} messages
 * @param {Object} chunk
 * @param {Object} params
 * @param {string} params.model
 * @returns {{messages: Array, marker: Object}}
 */
export function insertInProgressMarker(messages, chunk, { model }) {
  if (!Array.isArray(messages) || !chunk) return { messages, marker: null };
  const lastChunkMsg = chunk.chunk[chunk.chunk.length - 1];
  const parentId = lastChunkMsg ? lastChunkMsg.id : null;
  const tokenEstimate = estimateChunkTokens(chunk.chunk);

  const marker = buildInProgressMarker({
    rangeStart: chunk.rangeStart,
    rangeEnd: chunk.rangeEnd,
    parentId,
    compressedBy: model,
    tokenEstimate,
  });
  marker.sourceMessageIds = chunk.chunk
    .filter((m) => m && m.id)
    .map((m) => m.id);

  // Find the index of the last chunk message in the messages array.
  const insertAt = messages.findIndex((m) => m && m.id === parentId);
  const out = messages.slice();
  if (insertAt === -1) {
    out.push(marker);
  } else {
    out.splice(insertAt + 1, 0, marker);
  }
  return { messages: out, marker };
}

/**
 * Replaces an `in_progress` marker with a `completed` (or `stale`) one,
 * preserving the original object identity where possible. Operates on
 * the messages array by id and returns a NEW array.
 *
 * @param {Array} messages
 * @param {string} markerId
 * @param {Object} updates
 * @returns {Array}
 */
export function updateMarker(messages, markerId, updates) {
  if (!Array.isArray(messages) || !markerId) return messages;
  return messages.map((m) => {
    if (!m || m.id !== markerId) return m;
    return { ...m, ...updates };
  });
}

// ---------------------------------------------------------------------------
// Sidecar update
// ---------------------------------------------------------------------------

/**
 * Persists a chunk's completion (or staleness) into the sidecar. The
 * sidecar stores one record per chunk, keyed by range. Existing
 * records for the same range are overwritten.
 *
 * @param {string} conversationId
 * @param {string} branchPathHash
 * @param {Object} chunkRecord
 */
async function persistChunk(conversationId, branchPathHash, chunkRecord) {
  const record = await loadContextSummary(conversationId);
  const idx = record.chunks.findIndex(
    (c) =>
      c &&
      c.rangeStart === chunkRecord.rangeStart &&
      c.rangeEnd === chunkRecord.rangeEnd,
  );
  const next = { ...chunkRecord, branchPathHash };
  if (idx === -1) {
    record.chunks.push(next);
  } else {
    record.chunks[idx] = { ...record.chunks[idx], ...next };
  }
  await saveContextSummary(conversationId, record);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Triggers a compression pass for a conversation if appropriate. The
 * call is fire-and-forget from the caller's perspective: it returns
 * a promise that resolves to the pipeline result but never throws.
 *
 * @param {Object} params
 * @param {string} params.conversationId
 * @param {Array} params.messages  Current full messages array.
 * @param {Array<number>} params.branchPath
 * @param {Object} params.settings
 * @param {string} params.apiKey
 * @param {Object} [params.controllers]  Map of conversationId -> { updateMessages, persist }.
 * @returns {Promise<{ran: boolean, status: string, reason?: string, markerId?: string, summaryText?: string}>}
 */
export async function triggerContextCompression(params) {
  const {
    conversationId,
    messages,
    branchPath,
    settings,
    apiKey,
    controllers,
  } = params || {};

  if (!conversationId || !Array.isArray(messages)) {
    return { ran: false, status: "skipped", reason: "no_conversation" };
  }

  if (inFlightRuns.has(conversationId)) {
    return { ran: false, status: "skipped", reason: "already_running" };
  }

  // Re-evaluate triggers against the current messages.
  const { shouldRun, chunk, reason } = shouldRunCompression(messages, settings);
  if (!shouldRun || !chunk) {
    return { ran: false, status: "skipped", reason: reason || "no_trigger" };
  }

  const run = runCompressionInternal({
    conversationId,
    messages,
    chunk,
    branchPath,
    settings,
    apiKey,
    controllers,
  });

  inFlightRuns.set(
    conversationId,
    run.finally(() => inFlightRuns.delete(conversationId)),
  );

  return inFlightRuns.get(conversationId);
}

/**
 * Force-run a compression pass regardless of triggers. Used by future
 * "rebuild all" controls. Returns the same shape as
 * `triggerContextCompression`.
 */
export async function forceCompressConversation(params) {
  const {
    conversationId,
    messages,
    branchPath,
    settings,
    apiKey,
    controllers,
  } = params || {};
  if (!conversationId || !Array.isArray(messages)) {
    return { ran: false, status: "skipped", reason: "no_conversation" };
  }
  if (inFlightRuns.has(conversationId)) {
    return inFlightRuns.get(conversationId);
  }

  const { model, chunkSize } = resolveCompressionSettings(settings);
  const next = identifyNextChunk(messages, chunkSize);
  if (!next) return { ran: false, status: "skipped", reason: "no_chunk" };

  const run = runCompressionInternal({
    conversationId,
    messages,
    chunk: next,
    branchPath,
    settings,
    apiKey,
    controllers,
    force: true,
  });

  inFlightRuns.set(
    conversationId,
    run.finally(() => inFlightRuns.delete(conversationId)),
  );
  return inFlightRuns.get(conversationId);
}

async function runCompressionInternal({
  conversationId,
  messages,
  chunk,
  branchPath,
  settings,
  apiKey,
  controllers,
  force,
}) {
  const { model } = resolveCompressionSettings(settings);
  const branchPathHash = hashBranchPath(branchPath);

  // 1. Insert in_progress marker
  const { messages: withMarker, marker } = insertInProgressMarker(messages, chunk, {
    model,
  });
  if (!marker) {
    return { ran: false, status: "skipped", reason: "marker_insert_failed" };
  }

  // Push the new messages array back to the caller so the UI updates.
  if (controllers?.updateMessages) {
    try {
      controllers.updateMessages(withMarker);
    } catch (error) {
      console.error("[contextCompressionPipeline] updateMessages failed:", error);
    }
  }
  emitEvent(conversationId, {
    status: "started",
    markerId: marker.id,
    range: { start: chunk.rangeStart, end: chunk.rangeEnd },
  });

  // 2. Call the compression model.
  let summaryText = null;
  try {
    summaryText = await callCompressionModel(chunk.chunk, {
      apiKey,
      model,
      rangeStart: chunk.rangeStart,
      rangeEnd: chunk.rangeEnd,
    });
  } catch (error) {
    console.error("[contextCompressionPipeline] compression error:", error);
  }

  // 3. Update the marker in the caller's messages array.
  if (summaryText) {
    const finalMessages = updateMarker(withMarker, marker.id, {
      status: "completed",
      summaryText,
      compressedAt: new Date().toISOString(),
    });
    if (controllers?.updateMessages) {
      try {
        controllers.updateMessages(finalMessages);
      } catch (error) {
        console.error("[contextCompressionPipeline] updateMessages failed:", error);
      }
    }
    if (controllers?.persist) {
      try {
        await controllers.persist(finalMessages);
      } catch (error) {
        console.error("[contextCompressionPipeline] persist failed:", error);
      }
    }

    await persistChunk(conversationId, branchPathHash, {
      rangeStart: chunk.rangeStart,
      rangeEnd: chunk.rangeEnd,
      sourceMessageIds: marker.sourceMessageIds,
      status: "completed",
      summaryText,
      compressedAt: new Date().toISOString(),
      compressedBy: model,
      tokenEstimate: marker.tokenEstimate,
    });

    emitEvent(conversationId, {
      status: "completed",
      markerId: marker.id,
      range: { start: chunk.rangeStart, end: chunk.rangeEnd },
    });

    return {
      ran: true,
      status: "completed",
      markerId: marker.id,
      summaryText,
    };
  }

  // 4. Failure path: mark the chunk stale.
  const finalMessages = updateMarker(withMarker, marker.id, {
    status: "stale",
    compressedAt: new Date().toISOString(),
  });
  if (controllers?.updateMessages) {
    try {
      controllers.updateMessages(finalMessages);
    } catch (error) {
      console.error("[contextCompressionPipeline] updateMessages failed:", error);
    }
  }
  if (controllers?.persist) {
    try {
      await controllers.persist(finalMessages);
      // eslint-disable-next-line no-unused-vars
      const _ = force;
    } catch (error) {
      console.error("[contextCompressionPipeline] persist failed:", error);
    }
  }

  await persistChunk(conversationId, branchPathHash, {
    rangeStart: chunk.rangeStart,
    rangeEnd: chunk.rangeEnd,
    sourceMessageIds: marker.sourceMessageIds,
    status: "stale",
    summaryText: null,
    compressedAt: new Date().toISOString(),
    compressedBy: model,
    tokenEstimate: marker.tokenEstimate,
  });

  emitEvent(conversationId, {
    status: "failed",
    markerId: marker.id,
    range: { start: chunk.rangeStart, end: chunk.rangeEnd },
  });

  return { ran: true, status: "stale", markerId: marker.id };
}
