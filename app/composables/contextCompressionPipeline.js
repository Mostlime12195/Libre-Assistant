/**
 * @file contextCompressionPipeline.js
 * @description Orchestration for context compression.
 *
 * The pipeline NEVER touches the chat's messages array. It only:
 *   1. Reads the visible messages (via a getter, fresh on every pass).
 *   2. Calls the compression model for a selected range.
 *   3. Writes the resulting summary record to the sidecar.
 *   4. Publishes reactive per-conversation state for the UI
 *      (threshold reached, running, progress, savings, errors).
 *
 * Because the messages array is immutable as far as compression is
 * concerned, runs are safe to overlap with ongoing chatting and
 * streaming: a send simply uses whatever summaries exist at that
 * moment (see buildApiHistory in contextCompressor.js).
 */

import { reactive } from "vue";
import {
  loadContextSummary,
  saveContextSummary,
  findValidSummaries,
  selectCompressionRange,
  estimateEffectiveTokens,
  resolveCompressionSettings,
  shouldOfferCompression,
  callCompressionModel,
  buildSummaryRecord,
  hashBranchPath,
  MAX_RANGE_TOKENS,
} from "./contextCompressor";

// ---------------------------------------------------------------------------
// Reactive per-conversation state (consumed by ChatPanel / the chip)
// ---------------------------------------------------------------------------

/**
 * @type {Object<string, {
 *   status: 'idle'|'running',
 *   loaded: boolean,
 *   chunks: Array,
 *   validSummaries: Array,
 *   effectiveTokens: number,
 *   thresholdReached: boolean,
 *   hasEligibleRange: boolean,
 *   runningAnchorId: string|null,
 *   progress: {current: number}|null,
 *   lastError: string|null,
 *   lastSavings: {sourceTokens: number, summaryTokens: number}|null,
 *   dismissed: boolean,
 *   dismissedAtTokens: number,
 *   destroyed: boolean,
 * }>}
 */
export const compressionStates = reactive({});

function freshState() {
  return {
    status: "idle",
    loaded: false,
    chunks: [],
    validSummaries: [],
    effectiveTokens: 0,
    thresholdReached: false,
    hasEligibleRange: false,
    runningAnchorId: null,
    progress: null,
    lastError: null,
    lastSavings: null,
    dismissed: false,
    dismissedAtTokens: 0,
    destroyed: false,
  };
}

/**
 * Returns the reactive state object for a conversation, creating it
 * on first access.
 * @param {string} conversationId
 */
export function getCompressionState(conversationId) {
  if (!conversationId) return null;
  if (!compressionStates[conversationId]) {
    compressionStates[conversationId] = freshState();
  }
  return compressionStates[conversationId];
}

/**
 * Drops all state for a conversation (e.g. after it was deleted).
 * In-flight runs for it discard their result instead of persisting.
 * @param {string} conversationId
 */
export function clearCompressionState(conversationId) {
  const state = compressionStates[conversationId];
  if (state) state.destroyed = true;
  delete compressionStates[conversationId];
}

// ---------------------------------------------------------------------------
// Sidecar loading / refresh
// ---------------------------------------------------------------------------

/**
 * Loads the sidecar into the reactive cache. Call when a conversation
 * becomes active.
 * @param {string} conversationId
 */
export async function loadCompressionState(conversationId) {
  const state = getCompressionState(conversationId);
  if (!state) return;
  const record = await loadContextSummary(conversationId);
  if (state.destroyed) return;
  state.chunks = record.chunks;
  state.loaded = true;
}

/**
 * Recomputes derived state (valid summaries, effective tokens,
 * threshold) against the current visible messages. Cheap heuristic
 * math only — safe to call on every send / message change.
 *
 * @param {string} conversationId
 * @param {Array} visibleMessages
 * @param {Object} settings
 */
export function refreshCompressionState(conversationId, visibleMessages, settings) {
  const state = getCompressionState(conversationId);
  if (!state || state.destroyed) return;

  const { thresholdTokens, keepRecentTokens } = resolveCompressionSettings(settings);
  const messages = Array.isArray(visibleMessages) ? visibleMessages : [];

  const valid = findValidSummaries(messages, state.chunks);
  state.validSummaries = valid;
  state.effectiveTokens = estimateEffectiveTokens(messages, valid);

  const probe = selectCompressionRange(messages, valid, {
    keepRecentTokens,
    targetTokens: Infinity,
  });
  state.hasEligibleRange = probe !== null;

  state.thresholdReached = shouldOfferCompression({
    effectiveTokens: state.effectiveTokens,
    thresholdTokens,
    hasEligibleRange: state.hasEligibleRange,
  });

  // Re-offer after dismissal once the context has grown meaningfully.
  if (
    state.dismissed &&
    state.effectiveTokens > state.dismissedAtTokens * 1.25
  ) {
    state.dismissed = false;
  }
}

/**
 * Returns the currently valid summaries for a conversation (empty
 * array when unknown). Used by the send path to build API history.
 * @param {string} conversationId
 * @returns {Array}
 */
export function getCachedValidSummaries(conversationId) {
  const state = compressionStates[conversationId];
  return state ? state.validSummaries : [];
}

// ---------------------------------------------------------------------------
// In-memory run lock (per conversation, per tab)
// ---------------------------------------------------------------------------

/** @type {Map<string, Promise<any>>} */
const inFlightRuns = new Map();

export function isCompressionRunning(conversationId) {
  return inFlightRuns.has(conversationId);
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/**
 * Removes chunk records that the new record fully supersedes (their
 * covered id list is a subset of the new record's). Records that only
 * partially overlap — e.g. summaries made on a different branch that
 * share a prefix — are kept, since they remain valid for that branch.
 *
 * @param {Array} chunks
 * @param {Object} newRecord
 * @returns {Array}
 */
function pruneChunks(chunks, newRecord) {
  const newIds = new Set(newRecord.sourceMessageIds);
  const kept = (chunks || []).filter((chunk) => {
    if (!chunk || !Array.isArray(chunk.sourceMessageIds)) return false;
    const fullyCovered = chunk.sourceMessageIds.every((id) => newIds.has(id));
    return !fullyCovered;
  });
  // Cap sidecar growth; drop the oldest records first.
  const MAX_RECORDS = 50;
  while (kept.length >= MAX_RECORDS) kept.shift();
  return kept;
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

/**
 * Runs compression for a conversation. Never throws, never blocks the
 * chat, and never mutates messages.
 *
 * mode "auto":   compress a single range sized to get back under the
 *                threshold (small, fast, incremental).
 * mode "manual": compress everything eligible, in as many sequential
 *                ranges as needed (whole-chat compression).
 *
 * @param {Object} params
 * @param {string} params.conversationId
 * @param {() => Array} params.getVisibleMessages  Fresh getter (re-read every pass).
 * @param {Object} params.settings
 * @param {string} params.apiKey
 * @param {Array<number>} [params.branchPath]
 * @param {'auto'|'manual'} [params.mode]
 * @returns {Promise<{ran: boolean, status: string, reason?: string}>}
 */
export async function compressConversation(params) {
  const {
    conversationId,
    getVisibleMessages,
    settings,
    apiKey,
    branchPath,
    mode = "auto",
  } = params || {};

  if (!conversationId || typeof getVisibleMessages !== "function") {
    return { ran: false, status: "skipped", reason: "no_conversation" };
  }
  if (inFlightRuns.has(conversationId)) {
    return inFlightRuns.get(conversationId);
  }

  const run = runCompressionInternal({
    conversationId,
    getVisibleMessages,
    settings,
    apiKey,
    branchPath,
    mode,
  });

  inFlightRuns.set(
    conversationId,
    run.finally(() => inFlightRuns.delete(conversationId)),
  );
  return inFlightRuns.get(conversationId);
}

async function runCompressionInternal({
  conversationId,
  getVisibleMessages,
  settings,
  apiKey,
  branchPath,
  mode,
}) {
  const state = getCompressionState(conversationId);
  if (!state) return { ran: false, status: "skipped", reason: "no_state" };

  const { model, thresholdTokens, keepRecentTokens } =
    resolveCompressionSettings(settings);
  const branchPathHash = hashBranchPath(branchPath);

  state.status = "running";
  state.lastError = null;
  state.progress = { current: 0 };

  let totalSource = 0;
  let totalSummary = 0;
  let rangesDone = 0;

  try {
    // Ensure we have the sidecar before selecting ranges.
    if (!state.loaded) {
      await loadCompressionState(conversationId);
      if (state.destroyed) return { ran: false, status: "skipped", reason: "destroyed" };
    }

    while (true) {
      const rawVisible = getVisibleMessages() || [];
      const visible = Array.isArray(rawVisible) ? rawVisible : [];
      refreshCompressionState(conversationId, visible, settings);

      const valid = state.validSummaries;
      const effective = state.effectiveTokens;

      // Size the next range.
      let targetTokens = Infinity;
      if (mode === "auto") {
        // Compress enough to get comfortably back under the threshold.
        targetTokens = Math.min(
          MAX_RANGE_TOKENS,
          Math.max(2000, effective - thresholdTokens + Math.round(thresholdTokens * 0.15)),
        );
      }

      const range = selectCompressionRange(visible, valid, {
        keepRecentTokens,
        maxRangeTokens: MAX_RANGE_TOKENS,
        targetTokens,
      });
      if (!range) break;

      state.progress = { current: rangesDone + 1 };
      state.runningAnchorId = range.anchorMessageId;

      // Continuity: hand the summarizer the directly preceding summary.
      const previous = valid[valid.length - 1];
      const previousSummary =
        previous && previous.endIndex === range.startIndex - 1
          ? previous.summaryText
          : null;

      const summaryText = await callCompressionModel(range.messages, {
        apiKey,
        model,
        previousSummary,
      });

      if (state.destroyed) {
        return { ran: rangesDone > 0, status: "discarded" };
      }

      if (!summaryText) {
        state.lastError = "The compression model did not return a summary.";
        break;
      }

      const record = buildSummaryRecord({
        range,
        summaryText,
        model,
        branchPathHash,
      });

      const chunks = pruneChunks(state.chunks, record);
      chunks.push(record);
      await saveContextSummary(conversationId, { chunks });
      state.chunks = chunks;

      totalSource += record.sourceTokens;
      totalSummary += record.summaryTokens;
      rangesDone++;

      // Reflect the new summary immediately.
      refreshCompressionState(conversationId, getVisibleMessages() || [], settings);

      if (mode === "auto") break; // one range per trigger
    }
  } catch (error) {
    console.error("[contextCompressionPipeline] run failed:", error);
    state.lastError = error?.message || "Compression failed.";
  } finally {
    state.status = "idle";
    state.runningAnchorId = null;
    state.progress = null;
    if (rangesDone > 0) {
      state.lastSavings = {
        sourceTokens: totalSource,
        summaryTokens: totalSummary,
      };
      state.dismissed = false;
    }
  }

  if (rangesDone > 0) {
    return {
      ran: true,
      status: state.lastError ? "partial" : "completed",
      ranges: rangesDone,
    };
  }
  return {
    ran: false,
    status: state.lastError ? "failed" : "skipped",
    reason: state.lastError ? "model_error" : "no_range",
  };
}

/**
 * Post-reply auto trigger. Runs at most one range, in the background,
 * only when auto compression is enabled and the threshold is crossed.
 *
 * @param {Object} params
 * @param {string} params.conversationId
 * @param {() => Array} params.getVisibleMessages
 * @param {Object} params.settings
 * @param {string} params.apiKey
 * @param {Array<number>} [params.branchPath]
 * @param {boolean} [params.isIncognito]
 * @returns {Promise<{ran: boolean, status: string, reason?: string}>}
 */
export async function maybeAutoCompress(params) {
  const {
    conversationId,
    getVisibleMessages,
    settings,
    apiKey,
    branchPath,
    isIncognito,
  } = params || {};

  if (!conversationId || isIncognito) {
    return { ran: false, status: "skipped", reason: "unavailable" };
  }
  const { enabled } = resolveCompressionSettings(settings);
  if (!enabled) return { ran: false, status: "skipped", reason: "disabled" };
  if (!apiKey) return { ran: false, status: "skipped", reason: "no_api_key" };
  if (inFlightRuns.has(conversationId)) {
    return { ran: false, status: "skipped", reason: "already_running" };
  }

  refreshCompressionState(
    conversationId,
    typeof getVisibleMessages === "function" ? getVisibleMessages() : [],
    settings,
  );
  const state = getCompressionState(conversationId);
  if (!state?.thresholdReached) {
    return { ran: false, status: "skipped", reason: "below_threshold" };
  }

  return compressConversation({ ...params, mode: "auto" });
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

/**
 * Marks the manual prompt as dismissed for this conversation. It
 * re-appears once the context grows ~25% past the dismissal point,
 * or after any successful compression.
 * @param {string} conversationId
 */
export function dismissCompressionPrompt(conversationId) {
  const state = getCompressionState(conversationId);
  if (!state) return;
  state.dismissed = true;
  state.dismissedAtTokens = state.effectiveTokens;
}

/**
 * Formats a token count compactly for labels ("~48k", "~900").
 * @param {number} tokens
 * @returns {string}
 */
export function formatTokenCount(tokens) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1000) return `~${Math.round(n / 1000)}k`;
  return `~${Math.round(n)}`;
}
