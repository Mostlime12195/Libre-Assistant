/**
 * @file contextCompressor.js
 * @description Core (pure) logic for context compression.
 *
 * Design contract:
 *   - Summaries live ONLY in a per-conversation sidecar record in
 *     localforage. The chat's `messages` array is NEVER mutated by
 *     compression: no marker messages, no re-parenting, no rewrites.
 *     This is what makes compression safe to run in the background
 *     while the user keeps chatting.
 *   - A summary record covers an ordered list of message ids
 *     (`sourceMessageIds`) ending at `anchorMessageId`. It is valid
 *     for the currently visible branch as long as those ids still
 *     appear there contiguously and in order. Edits/regenerations
 *     change ids, which silently invalidates affected summaries —
 *     the verbatim history simply resumes until the next run.
 *   - `buildApiHistory` swaps covered spans for a single labeled
 *     summary message (+ a short acknowledgement) when history is
 *     sent to the API. Everything else passes through verbatim.
 *
 * The orchestration (locks, reactive UI state, triggers) lives in
 * contextCompressionPipeline.js. This file stays side-effect free
 * except for the sidecar I/O helpers at the top.
 */

import localforage from "localforage";
import { toRaw } from "vue";
import { getSessionToken } from "~/composables/useSession";

// ---------------------------------------------------------------------------
// Defaults & keys
// ---------------------------------------------------------------------------

export const CONTEXT_SUMMARY_KEY_PREFIX = "context_summary_";

/** Cheap, large-context model used for compression by default. */
export const DEFAULT_COMPRESSION_MODEL = "deepseek/deepseek-v4-pro";

/** Effective-token count at which compression is offered / auto-runs. */
export const DEFAULT_THRESHOLD_TOKENS = 40_000;

/** How many tokens of the most recent conversation always stay verbatim. */
export const DEFAULT_KEEP_RECENT_TOKENS = 8_000;

/** Upper bound on the source tokens compressed in a single model call. */
export const MAX_RANGE_TOKENS = 10_000;

/** How many characters of a single message to feed the summarizer. */
export const MAX_MESSAGE_CHARS = 8_000;

/** Soft cap on the summary text length. */
export const MAX_SUMMARY_CHARS = 50_000;

/** Rough chars-per-token heuristic used for estimation. */
export const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Reactive-value normalization
// ---------------------------------------------------------------------------

/**
 * Recursively strips Vue reactivity proxies from a value. LocalForage/IndexedDB
 * uses structuredClone for persistence, which cannot clone Proxy objects; if
 * reactive arrays or objects leak into the sidecar, only the first write would
 * succeed and subsequent chunks would silently fail to persist.
 *
 * @param {*} value
 * @returns {*}
 */
function deepToRaw(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(deepToRaw);
  const raw = toRaw(value);
  if (raw === null || typeof raw !== "object") return raw;
  const result = {};
  for (const key of Object.keys(raw)) {
    result[key] = deepToRaw(raw[key]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Sidecar I/O
// ---------------------------------------------------------------------------

/**
 * Returns true if a stored chunk record has the shape this version of
 * the compressor understands. Legacy records (turn-range based, no id
 * coverage) are discarded — the conversations they came from are simply
 * re-compressed from scratch on the next run.
 *
 * @param {*} chunk
 * @returns {boolean}
 */
function isValidChunkRecord(chunk) {
  return (
    chunk &&
    typeof chunk === "object" &&
    typeof chunk.anchorMessageId === "string" &&
    Array.isArray(chunk.sourceMessageIds) &&
    chunk.sourceMessageIds.length > 0 &&
    (chunk.status === "completed" || chunk.status === "failed")
  );
}

/**
 * Loads the sidecar record for a conversation, discarding any legacy
 * or malformed chunk records.
 *
 * @param {string} conversationId
 * @returns {Promise<{conversationId: string, chunks: Array, lastUpdated: string|null}>}
 */
export async function loadContextSummary(conversationId) {
  try {
    const stored = await localforage.getItem(
      `${CONTEXT_SUMMARY_KEY_PREFIX}${conversationId}`,
    );
    if (stored && typeof stored === "object") {
      const chunks = Array.isArray(stored.chunks)
        ? stored.chunks.filter(isValidChunkRecord)
        : [];
      return {
        conversationId,
        chunks,
        lastUpdated: stored.lastUpdated || null,
      };
    }
  } catch (error) {
    console.error(
      `[contextCompressor] Failed to load summary for ${conversationId}:`,
      error,
    );
  }
  return { conversationId, chunks: [], lastUpdated: null };
}

/**
 * Persists the sidecar record.
 * @param {string} conversationId
 * @param {Object} record
 * @returns {Promise<boolean>}
 */
export async function saveContextSummary(conversationId, record) {
  try {
    await localforage.setItem(`${CONTEXT_SUMMARY_KEY_PREFIX}${conversationId}`, {
      ...deepToRaw(record),
      conversationId,
      lastUpdated: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    console.error(
      `[contextCompressor] Failed to save summary for ${conversationId}:`,
      error,
    );
    return false;
  }
}

/**
 * Deletes the sidecar record for a conversation.
 * @param {string} conversationId
 * @returns {Promise<boolean>}
 */
export async function deleteContextSummary(conversationId) {
  try {
    await localforage.removeItem(`${CONTEXT_SUMMARY_KEY_PREFIX}${conversationId}`);
    return true;
  } catch (error) {
    console.error(
      `[contextCompressor] Failed to delete summary for ${conversationId}:`,
      error,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Branch-path hashing (informational — validity itself is id-based)
// ---------------------------------------------------------------------------

/**
 * Stable, content-addressable hash of a branch path.
 * @param {Array<number>} branchPath
 * @returns {string}
 */
export function hashBranchPath(branchPath) {
  if (!Array.isArray(branchPath) || branchPath.length === 0) return "root";
  return branchPath.join("-");
}

// ---------------------------------------------------------------------------
// Settings resolution
// ---------------------------------------------------------------------------

/**
 * Resolves compression settings from the user's settings object,
 * falling back to safe defaults for anything missing or invalid.
 *
 * @param {Object} settings
 * @returns {{enabled: boolean, model: string, thresholdTokens: number, keepRecentTokens: number}}
 */
export function resolveCompressionSettings(settings) {
  const s = settings || {};
  const enabled = s.context_compression_enabled !== false; // default true
  const model =
    typeof s.context_compression_model === "string" &&
    s.context_compression_model.trim()
      ? s.context_compression_model.trim()
      : DEFAULT_COMPRESSION_MODEL;
  let thresholdTokens = Number(s.context_compression_threshold_tokens);
  if (!Number.isFinite(thresholdTokens) || thresholdTokens < 4000) {
    thresholdTokens = DEFAULT_THRESHOLD_TOKENS;
  }
  let keepRecentTokens = Number(s.context_compression_keep_recent_tokens);
  if (!Number.isFinite(keepRecentTokens) || keepRecentTokens < 1000) {
    keepRecentTokens = DEFAULT_KEEP_RECENT_TOKENS;
  }
  return { enabled, model, thresholdTokens, keepRecentTokens };
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Rough token estimate of a message's text content. Tool calls and
 * reasoning are weighted more cheaply than actual user-visible prose.
 *
 * @param {Object} msg
 * @returns {number}
 */
export function estimateMessageTokens(msg) {
  if (!msg) return 0;
  let chars = 0;
  if (typeof msg.content === "string") chars += msg.content.length;
  if (Array.isArray(msg.attachments)) {
    for (const a of msg.attachments) {
      if (a?.filename) chars += a.filename.length + 8;
    }
  }
  if (Array.isArray(msg.parts)) {
    for (const p of msg.parts) {
      if (p?.type === "content" && typeof p.content === "string") {
        chars += p.content.length;
      } else if (p?.type === "reasoning" && typeof p.content === "string") {
        // Reasoning is verbose; count half-weight.
        chars += Math.floor(p.content.length / 2);
      } else if (p?.type === "tool_group" && Array.isArray(p.tools)) {
        for (const t of p.tools) {
          if (t?.function?.arguments) {
            chars += t.function.arguments.length;
          }
          if (t?.result) {
            const r =
              typeof t.result === "string" ? t.result : JSON.stringify(t.result);
            // Tool results: full weight.
            chars += r.length;
          }
        }
      }
    }
  }
  if (typeof msg.reasoning === "string" && !Array.isArray(msg.parts)) {
    chars += Math.floor(msg.reasoning.length / 2);
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const t of msg.tool_calls) {
      if (t?.function?.arguments) chars += t.function.arguments.length;
    }
  }
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

/**
 * Sum of estimated tokens for a list of messages.
 * @param {Array} messages
 * @returns {number}
 */
export function estimateChunkTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

// ---------------------------------------------------------------------------
// Summary validity against the visible branch
// ---------------------------------------------------------------------------

/**
 * Matches one chunk's `sourceMessageIds` against `messages` starting the
 * search at `fromIndex`. Returns the covered [startIndex, endIndex] when
 * the ids appear contiguously and in order, or null.
 *
 * @param {Array} messages
 * @param {Object} chunk
 * @param {number} fromIndex
 * @returns {{startIndex: number, endIndex: number} | null}
 */
function matchChunkSpan(messages, chunk, fromIndex) {
  const ids = chunk.sourceMessageIds;
  if (!Array.isArray(ids) || ids.length === 0) return null;

  let startIndex = -1;
  for (let i = Math.max(0, fromIndex); i < messages.length; i++) {
    if (messages[i] && messages[i].id === ids[0]) {
      startIndex = i;
      break;
    }
  }
  if (startIndex === -1) return null;
  if (startIndex + ids.length > messages.length) return null;

  for (let j = 1; j < ids.length; j++) {
    const msg = messages[startIndex + j];
    if (!msg || msg.id !== ids[j]) return null;
  }
  return { startIndex, endIndex: startIndex + ids.length - 1 };
}

/**
 * Determines which stored summaries are valid for the given (visible)
 * message list. A summary is valid when its covered ids still appear
 * contiguously, in order, after the previous valid summary's span.
 *
 * Returns the valid chunks in conversation order, each augmented with
 * `startIndex` / `endIndex` relative to `messages`.
 *
 * @param {Array} messages  Visible messages of the current branch.
 * @param {Array} chunks    Chunk records from the sidecar.
 * @returns {Array}
 */
export function findValidSummaries(messages, chunks) {
  if (!Array.isArray(messages) || !Array.isArray(chunks)) return [];
  const valid = [];
  let fromIndex = 0;
  for (const chunk of chunks) {
    if (!isValidChunkRecord(chunk)) continue;
    if (chunk.status !== "completed" || !chunk.summaryText) continue;
    const span = matchChunkSpan(messages, chunk, fromIndex);
    if (!span) continue;
    valid.push({ ...chunk, ...span });
    fromIndex = span.endIndex + 1;
  }
  return valid;
}

// ---------------------------------------------------------------------------
// History transformation
// ---------------------------------------------------------------------------

/** Fixed acknowledgement emitted after each summary block. */
const SUMMARY_ACKNOWLEDGEMENT =
  "Acknowledged — I'll treat that summary as the authoritative record of the earlier conversation and continue from it.";

/**
 * Renders a valid summary record as a labeled user message for the API.
 * @param {Object} summary  Valid summary (from findValidSummaries).
 * @returns {{role: string, content: string}}
 */
export function renderSummaryAsApiMessage(summary) {
  const count = Array.isArray(summary.sourceMessageIds)
    ? summary.sourceMessageIds.length
    : 0;
  return {
    role: "user",
    content:
      `--- Earlier conversation summary (covers ${count} messages) ---\n` +
      summary.summaryText +
      `\n--- End of summary ---`,
  };
}

/**
 * Transforms a history list into what should be sent to the API: every
 * span covered by a valid summary collapses into one labeled summary
 * message plus a short assistant acknowledgement; all other messages
 * pass through untouched.
 *
 * Matching is id-based and strict: a summary is applied only when its
 * entire covered span appears contiguously in the input. This lets the
 * input be a filtered view of the visible messages (e.g. with the
 * in-flight assistant message removed) while guaranteeing that a
 * summary never leaks into a branch that shares only part of its span.
 *
 * Returns a NEW array; the input is not mutated.
 *
 * @param {Array} messages
 * @param {Array} validSummaries  From findValidSummaries (completed only).
 * @returns {Array}
 */
export function buildApiHistory(messages, validSummaries) {
  if (!Array.isArray(messages)) return [];
  if (!Array.isArray(validSummaries) || validSummaries.length === 0) {
    return messages.slice();
  }

  // A summary is only usable here when its ENTIRE covered span appears
  // contiguously in this exact list. This keeps summaries from leaking
  // into branches that share only part of the span.
  const indexById = new Map();
  messages.forEach((m, i) => {
    if (m && m.id) indexById.set(m.id, i);
  });

  const usable = validSummaries.filter((summary) => {
    if (
      !summary ||
      summary.status !== "completed" ||
      !summary.summaryText ||
      !Array.isArray(summary.sourceMessageIds) ||
      summary.sourceMessageIds.length === 0
    ) {
      return false;
    }
    const first = indexById.get(summary.sourceMessageIds[0]);
    if (first === undefined) return false;
    for (let j = 1; j < summary.sourceMessageIds.length; j++) {
      if (indexById.get(summary.sourceMessageIds[j]) !== first + j) {
        return false;
      }
    }
    return true;
  });

  if (usable.length === 0) return messages.slice();

  const coveredIds = new Set();
  const summaryByCoveredId = new Map();
  const emittedSummaries = new Set();

  for (const summary of usable) {
    for (const id of summary.sourceMessageIds) {
      coveredIds.add(id);
      if (!summaryByCoveredId.has(id)) summaryByCoveredId.set(id, summary);
    }
  }

  const out = [];
  for (const msg of messages) {
    if (!msg) continue;
    if (coveredIds.has(msg.id)) {
      const summary = summaryByCoveredId.get(msg.id);
      if (summary && !emittedSummaries.has(summary.id)) {
        emittedSummaries.add(summary.id);
        out.push(renderSummaryAsApiMessage(summary));
        out.push({ role: "assistant", content: SUMMARY_ACKNOWLEDGEMENT });
      }
      continue; // covered message is represented by the summary
    }
    out.push(msg);
  }
  return out;
}

/**
 * Estimates how many tokens the API history for this conversation
 * currently costs, after applying valid summaries.
 *
 * @param {Array} messages
 * @param {Array} validSummaries
 * @returns {number}
 */
export function estimateEffectiveTokens(messages, validSummaries) {
  return estimateChunkTokens(buildApiHistory(messages, validSummaries));
}

// ---------------------------------------------------------------------------
// Range selection
// ---------------------------------------------------------------------------

/**
 * Selects the next range of messages to compress.
 *
 * The eligible span starts after the last valid summary and ends before
 * a trailing "keep recent" window (~`keepRecentTokens`, always at least
 * the newest message). The returned range is the OLDEST part of the
 * eligible span, sized to roughly `targetTokens` and never exceeding
 * `maxRangeTokens`. When the range would end on a user message whose
 * assistant reply is still eligible, the reply is pulled in so turns
 * are not split.
 *
 * @param {Array} visibleMessages
 * @param {Array} validSummaries  From findValidSummaries.
 * @param {Object} options
 * @param {number} options.keepRecentTokens
 * @param {number} [options.maxRangeTokens]
 * @param {number} [options.targetTokens]  Use Infinity for "everything eligible".
 * @returns {{messages: Array, startIndex: number, endIndex: number, anchorMessageId: string, sourceMessageIds: string[], tokenEstimate: number} | null}
 */
export function selectCompressionRange(visibleMessages, validSummaries, options) {
  if (!Array.isArray(visibleMessages) || visibleMessages.length === 0) {
    return null;
  }
  const {
    keepRecentTokens,
    maxRangeTokens = MAX_RANGE_TOKENS,
    targetTokens = Infinity,
  } = options || {};
  if (!Number.isFinite(keepRecentTokens) || keepRecentTokens < 0) return null;

  const summaries = Array.isArray(validSummaries) ? validSummaries : [];
  const lastValid = summaries[summaries.length - 1];
  const startIndex = lastValid ? lastValid.endIndex + 1 : 0;

  // Trailing verbatim window.
  let tailStart = visibleMessages.length;
  let tailTokens = 0;
  while (tailStart > startIndex) {
    const t = estimateMessageTokens(visibleMessages[tailStart - 1]);
    if (tailTokens > 0 && tailTokens + t > keepRecentTokens) break;
    tailTokens += t;
    tailStart--;
  }

  if (tailStart <= startIndex) return null; // nothing eligible

  // Walk forward from the oldest eligible message until the target is met.
  let endIndex = startIndex;
  let tokenEstimate = 0;
  const goal = Math.max(1, Math.min(targetTokens, maxRangeTokens));
  while (endIndex < tailStart) {
    const t = estimateMessageTokens(visibleMessages[endIndex]);
    if (tokenEstimate > 0 && tokenEstimate + t > goal) break;
    tokenEstimate += t;
    endIndex++;
    if (tokenEstimate >= goal) break;
  }
  endIndex--; // convert to inclusive index of last message in range

  if (endIndex < startIndex) return null;

  // Avoid splitting a user turn from its assistant reply when the reply
  // is still inside the eligible span (soft cap: don't stretch a range
  // that already hit the hard cap).
  const lastMsg = visibleMessages[endIndex];
  const nextMsg = visibleMessages[endIndex + 1];
  if (
    lastMsg?.role === "user" &&
    endIndex + 1 < tailStart &&
    nextMsg?.role === "assistant" &&
    tokenEstimate < maxRangeTokens
  ) {
    endIndex++;
    tokenEstimate += estimateMessageTokens(nextMsg);
  }

  const rangeMessages = visibleMessages.slice(startIndex, endIndex + 1);
  if (rangeMessages.length === 0) return null;

  return {
    messages: rangeMessages,
    startIndex,
    endIndex,
    anchorMessageId: rangeMessages[rangeMessages.length - 1].id,
    sourceMessageIds: rangeMessages.filter((m) => m && m.id).map((m) => m.id),
    tokenEstimate,
  };
}

/**
 * Whether the manual compress prompt should be offered.
 *
 * @param {Object} params
 * @param {number} params.effectiveTokens
 * @param {number} params.thresholdTokens
 * @param {boolean} params.hasEligibleRange
 * @returns {boolean}
 */
export function shouldOfferCompression({
  effectiveTokens,
  thresholdTokens,
  hasEligibleRange,
}) {
  if (!Number.isFinite(effectiveTokens) || !Number.isFinite(thresholdTokens)) {
    return false;
  }
  return effectiveTokens > thresholdTokens && hasEligibleRange === true;
}

// ---------------------------------------------------------------------------
// Summary prompt construction & API call
// ---------------------------------------------------------------------------

/**
 * Formats a single message into the body of the summarization prompt.
 * Includes content, reasoning, tool calls, and tool results.
 *
 * @param {Object} msg
 * @returns {string}
 */
function formatMessageForSummaryPrompt(msg) {
  if (!msg) return "";
  const parts = [];
  const roleLabel = msg.role === "user" ? "User" : "Assistant";

  // Content
  let content = "";
  if (Array.isArray(msg.parts)) {
    for (const p of msg.parts) {
      if (p?.type === "content" && typeof p.content === "string") {
        content += p.content;
      }
    }
  }
  if (!content && typeof msg.content === "string") {
    content = msg.content;
  }
  if (content) {
    parts.push(content.substring(0, MAX_MESSAGE_CHARS));
  }

  // Reasoning
  let reasoning = "";
  if (Array.isArray(msg.parts)) {
    for (const p of msg.parts) {
      if (p?.type === "reasoning" && typeof p.content === "string") {
        reasoning += p.content;
      }
    }
  }
  if (!reasoning && typeof msg.reasoning === "string") {
    reasoning = msg.reasoning;
  }
  if (reasoning && reasoning.trim()) {
    parts.push(
      `<reasoning>\n${reasoning.substring(0, MAX_MESSAGE_CHARS)}\n</reasoning>`,
    );
  }

  // Tool calls
  const toolGroups = [];
  if (Array.isArray(msg.parts)) {
    for (const p of msg.parts) {
      if (p?.type === "tool_group" && Array.isArray(p.tools)) {
        toolGroups.push(...p.tools);
      }
    }
  }
  if (toolGroups.length === 0 && Array.isArray(msg.tool_calls)) {
    toolGroups.push(...msg.tool_calls);
  }
  for (const t of toolGroups) {
    const name = t?.function?.name || t?.name || "tool";
    const args = t?.function?.arguments || "";
    const result = t?.result;
    const resultStr =
      result === undefined || result === null
        ? ""
        : typeof result === "string"
          ? result
          : JSON.stringify(result);
    parts.push(
      `<tool name="${name}">\n<arguments>\n${String(args).substring(0, MAX_MESSAGE_CHARS)}\n</arguments>\n${
        resultStr
          ? `<result>\n${resultStr.substring(0, MAX_MESSAGE_CHARS)}\n</result>\n`
          : ""
      }</tool>`,
    );
  }

  return `${roleLabel}:\n${parts.join("\n\n")}`;
}

/**
 * Builds the summarization system prompt.
 *
 * @param {Object} params
 * @param {number} params.messageCount
 * @param {boolean} [params.hasPreviousSummary]
 * @returns {string}
 */
export function buildSummaryPrompt({ messageCount, hasPreviousSummary }) {
  return `You are compressing a section of an ongoing conversation between a user and an AI assistant into a list of compressed messages. The section contains ${messageCount} messages.

The compressed messages REPLACES the original messages in the context the assistant sees next. It must be possible to continue the conversation from your summary alone, seamlessly, as if nothing was removed.${hasPreviousSummary ? "\n\nYou are also given the summary of the preceding section in <previous_summary>. Do not repeat its contents — build on it so the two summaries read as one continuous record." : ""}

# What to do
- Respond with a summary of each message of the section of the conversation that you are given. You should concisely describe what the user communicated and what the assistant communicated in chronological order.
- When some turns are repetitive, only briefly describe what they contained.
- When a chain of messages are brief or unimportant, you can clump them together in one paragraph discussing them very briefly. When writing down a clump of messages at once, make sure you describe how many messages or turns this "clump" goes on for.
- This system prompt will be used in the system prompt of the assistant's next turn. It will be structured as: "{system prompt}, compressed summary of previous messages: {previous summaries (if available)}, {this summary}. current messages: {latest assistant/user message pairs that are not yet compressed}" as such, it is important that an AI assistant reads this summary and perfectly understands exactly three things: (A) the history and flow of the conversation from start to finish (B) the tone of the conversation (C) the important content of the conversation.

# Hard rules — what to keep

- **Code**: When a single code file appears in its "base" or full form, include it VERBATIM in a fenced code block with the right language tag. If subsequent turns are variations of the same file (edits, alternative versions, refactors), include the BASE/canonical version and the final edited version verbatim and use short diffs, unified diffs, or one-paragraph prose explanations for the variants. Do not paraphrase code into prose. The latest code file edit will always be included verbatim for easy access for the next assistant turn.
- **Documents, file names, IDs, version numbers, dependency names, URLs, error messages, and quoted text**: keep EXACTLY. Never reword these. You can add context to these if you think they is important to understand them.
- **User's stated goals, preferences, and personal context**: keep verbatim or near-verbatim.
- **Tool results that contain data the conversation depends on** (e.g. file contents, search results): keep the load-bearing facts; drop verbose logs that don't change the answer. I.E if a search tool has 10 results and only 2 is mentioned in the conversation, briefly describe how the search tool was called with 10 responses and that only 2 of them are important, and then describe the 2 important search results.
- **Reasoning**: keep ONLY when important to the conversation. In most cases, completely cull and ignore.
- **Numbered or labeled items the user is tracking** (todo lists, requirements): keep the latest state of each item. If they are tracked throughout the conversation, keep the base list at the location it was first described, and describe when it changes and how as the conversation progresses. At the location of the final change, keep the final edited version verbatim.

# Hard rules — what to drop

- Restated explanations the assistant gave that the user did not act on, unless important.
- Repeated tool calls with the same outcome (you can explain whether tool calls are repeated, but do not repeat the outcome).

# Output format

- Plain prose or short bullet lists, no preamble, no epilogue.
- Describe the conversation in the range in CHRONOLOGICAL order, explaining how the conversation progresses over time from the START to the END of the conversation range you are provided. No more, no less. An AI must be able to continue from this summary, therefore it must know how the conversation progressed at each point, including not only the user's requests but also the AI's responses.
- Code in fenced blocks with the right language tag.
- Target length: enough to be near-lossless for the section's content. If the section is dense, this may be long; do not pad thin sections.`;
}

/**
 * Calls the compression model and returns the summary text.
 * Returns null on failure.
 *
 * @param {Array} chunk  Messages in the range to summarize.
 * @param {Object} options
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {string} [options.previousSummary]  Summary of the preceding range, if any.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string|null>}
 */
export async function callCompressionModel(chunk, options) {
  const { apiKey, model = DEFAULT_COMPRESSION_MODEL, previousSummary, signal } =
    options || {};

  if (!Array.isArray(chunk) || chunk.length === 0) return null;

  const formatted = chunk
    .map(formatMessageForSummaryPrompt)
    .filter((s) => s && s.trim())
    .join("\n\n---\n\n");

  if (!formatted.trim()) return null;

  const systemPrompt = buildSummaryPrompt({
    messageCount: chunk.length,
    hasPreviousSummary: !!(previousSummary && previousSummary.trim()),
  });

  // Cheap models are strongly recency-driven: the transcript goes first
  // (wrapped in explicit tags so it reads as a document, not a chat to
  // continue) and the task instruction goes AFTER it, next to where the
  // model starts generating.
  const userContent =
    (previousSummary && previousSummary.trim()
      ? `<previous_summary>\n${previousSummary.trim()}\n</previous_summary>\n\n`
      : "") +
    `<messages_to_compress>\n${formatted}\n</messages_to_compress>\n\n` +
    `Summarize the ${chunk.length} messages above into a dense replacement summary, following the system instructions. Output ONLY the summary — do not reply to the messages or continue the conversation.`;

  try {
    const sessionToken = await getSessionToken();
    const response = await fetch("/api/ai", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-token": sessionToken,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        stream: false,
        ...(apiKey ? { customApiKey: apiKey } : {}),
      }),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      throw new Error(`Compression request failed: ${response.status}`);
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string") return null;

    const trimmed = text.trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_SUMMARY_CHARS
      ? trimmed.substring(0, MAX_SUMMARY_CHARS)
      : trimmed;
  } catch (error) {
    if (error?.name === "AbortError") return null;
    console.error("[contextCompressor] callCompressionModel failed:", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Record helpers
// ---------------------------------------------------------------------------

/**
 * Generates a unique ID for a summary record.
 * @returns {string}
 */
export function generateContextSummaryId() {
  return (
    "ctx_" + Date.now().toString(36) + Math.random().toString(36).substring(2, 11)
  );
}

/**
 * Builds a completed summary record for a compressed range.
 *
 * @param {Object} params
 * @param {Object} params.range  From selectCompressionRange.
 * @param {string} params.summaryText
 * @param {string} params.model
 * @param {string} params.branchPathHash
 * @returns {Object}
 */
export function buildSummaryRecord({ range, summaryText, model, branchPathHash }) {
  return {
    id: generateContextSummaryId(),
    anchorMessageId: range.anchorMessageId,
    sourceMessageIds: range.sourceMessageIds.slice(),
    summaryText,
    status: "completed",
    compressedAt: new Date().toISOString(),
    compressedBy: model || DEFAULT_COMPRESSION_MODEL,
    sourceTokens: range.tokenEstimate,
    summaryTokens: Math.max(1, Math.ceil((summaryText || "").length / CHARS_PER_TOKEN)),
    branchPathHash: branchPathHash || "root",
  };
}
