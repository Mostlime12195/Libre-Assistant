/**
 * @file contextCompressor.js
 * @description Per-chunk context compression for long conversations.
 *
 * Strategy:
 *   - The conversation is divided into chunks of N user turns (default 10).
 *   - When a chunk "closes" (the latest user-turn count crosses a new
 *     multiple of N) AND its estimated token count is above a floor, the
 *     pipeline summarizes that exact chunk.
 *   - The summary is stored on a `role: "context_summary"` message that
 *     is inserted into the chat at the boundary between the summarized
 *     chunk and the next (verbatim) chunk. The UI renders that message
 *     as a non-interactive visual marker.
 *   - When sending to the API, the verbatim messages that fall inside a
 *     summarized chunk are REPLACED by a single labeled system-style
 *     user message containing the summary. This guarantees no overlap.
 *
 * The summary model is configurable but defaults to a cheap, large-
 * context model (DeepSeek V4 Flash).
 */

import localforage from "localforage";
import { getSessionToken } from "~/composables/useSession";

// ---------------------------------------------------------------------------
// Defaults & keys
// ---------------------------------------------------------------------------

export const CONTEXT_SUMMARY_KEY_PREFIX = "context_summary_";

/** Cheap, large-context model used for compression by default. */
export const DEFAULT_COMPRESSION_MODEL = "deepseek/deepseek-v4-flash";

/** Default chunk size in user turns. */
export const DEFAULT_CHUNK_SIZE = 10;

/** Default minimum tokens for a chunk to be worth compressing. */
export const DEFAULT_MIN_CHUNK_TOKENS = 2000;

/** How many characters of a single message to feed the summarizer. */
export const MAX_MESSAGE_CHARS = 8000;

/** Soft cap on the summary text length. */
export const MAX_SUMMARY_CHARS = 6000;

/** Rough chars-per-token heuristic used for estimation. */
export const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Sidecar I/O
// ---------------------------------------------------------------------------

/**
 * Loads the sidecar record for a conversation.
 * @param {string} conversationId
 * @returns {Promise<{conversationId: string, chunks: Array, lastCountedMessageId: string|null, lastUpdated: string|null}>}
 */
export async function loadContextSummary(conversationId) {
  try {
    const stored = await localforage.getItem(
      `${CONTEXT_SUMMARY_KEY_PREFIX}${conversationId}`,
    );
    if (stored && typeof stored === "object") {
      return {
        conversationId,
        chunks: Array.isArray(stored.chunks) ? stored.chunks : [],
        lastCountedMessageId: stored.lastCountedMessageId || null,
        lastUpdated: stored.lastUpdated || null,
      };
    }
  } catch (error) {
    console.error(
      `[contextCompressor] Failed to load summary for ${conversationId}:`,
      error,
    );
  }
  return {
    conversationId,
    chunks: [],
    lastCountedMessageId: null,
    lastUpdated: null,
  };
}

/**
 * Persists the sidecar record.
 * @param {string} conversationId
 * @param {Object} record
 * @returns {Promise<boolean>}
 */
export async function saveContextSummary(conversationId, record) {
  try {
    await localforage.setItem(
      `${CONTEXT_SUMMARY_KEY_PREFIX}${conversationId}`,
      {
        ...record,
        conversationId,
        lastUpdated: new Date().toISOString(),
      },
    );
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
    await localforage.removeItem(
      `${CONTEXT_SUMMARY_KEY_PREFIX}${conversationId}`,
    );
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
// Branch-path hashing
// ---------------------------------------------------------------------------

/**
 * Stable, content-addressable hash of a branch path. We don't need
 * cryptographic strength — just something deterministic that changes
 * when the user navigates to a different branch.
 *
 * @param {Array<number>} branchPath
 * @returns {string}
 */
export function hashBranchPath(branchPath) {
  if (!Array.isArray(branchPath) || branchPath.length === 0) return "root";
  return branchPath.join("-");
}

// ---------------------------------------------------------------------------
// Chunk identification
// ---------------------------------------------------------------------------

/**
 * Counts user turns in the visible message list. Each user message
 * counts as one turn (attachments-only messages also count).
 *
 * @param {Array} visibleMessages
 * @returns {number}
 */
export function countUserTurns(visibleMessages) {
  if (!Array.isArray(visibleMessages)) return 0;
  return visibleMessages.filter((m) => m && m.role === "user").length;
}

/**
 * Returns the list of `context_summary` messages already present on the
 * active branch path (in order). The chat array is filtered to
 * completed/in-progress markers only — stale ones are ignored.
 *
 * @param {Array} visibleMessages
 * @returns {Array}
 */
export function getContextSummaryMarkers(visibleMessages) {
  if (!Array.isArray(visibleMessages)) return [];
  return visibleMessages.filter(
    (m) =>
      m &&
      m.role === "context_summary" &&
      (m.status === "in_progress" || m.status === "completed"),
  );
}

/**
 * Identifies the next chunk that needs summarization.
 *
 * "Already covered" messages are those that fall strictly before a
 * completed `context_summary` marker. The "next chunk" is the next
 * `chunkSize` user turns that come after the last completed marker
 * (or, if there are no markers, the first `chunkSize` user turns).
 *
 * The chunk closes (and becomes eligible for compression) only when
 * the user-turn count reaches the next multiple of `chunkSize` AND
 * the chunk is non-empty.
 *
 * @param {Array} visibleMessages  Full visible message list.
 * @param {number} chunkSize
 * @returns {{chunk: Array, rangeStart: number, rangeEnd: number, isClosed: boolean} | null}
 */
export function identifyNextChunk(visibleMessages, chunkSize) {
  if (!Array.isArray(visibleMessages) || chunkSize <= 0) return null;

  const summaryMarkers = getContextSummaryMarkers(visibleMessages);
  // The boundary index: messages before this index are already covered.
  // The last completed/in-progress marker's index in the visible list
  // plus one — i.e. the first message NOT covered by any prior summary.
  const lastMarker = summaryMarkers[summaryMarkers.length - 1];
  const startIdx = lastMarker
    ? visibleMessages.indexOf(lastMarker) + 1
    : 0;

  // Walk forward collecting user turns until we have `chunkSize`.
  const chunk = [];
  let userTurnCount = 0;
  const totalUserTurns = countUserTurns(visibleMessages);

  // We need to figure out which user-turn range this chunk covers.
  // 1-indexed across the WHOLE chat, ignoring markers.
  const userTurnsBeforeChunk = countUserTurns(visibleMessages.slice(0, startIdx));

  for (let i = startIdx; i < visibleMessages.length; i++) {
    const msg = visibleMessages[i];
    if (!msg) continue;
    chunk.push(msg);
    if (msg.role === "user") {
      userTurnCount++;
      if (userTurnCount >= chunkSize) break;
    }
  }

  if (userTurnCount === 0) return null;

  const rangeStart = userTurnsBeforeChunk + 1;
  const rangeEnd = rangeStart + userTurnCount - 1;
  // Chunk is "closed" if we've actually seen the next user turn after
  // it (so the boundary is a hard cut with no in-flight user message
  // being included) — equivalently, totalUserTurns > rangeEnd.
  const isClosed = totalUserTurns > rangeEnd;

  return { chunk, rangeStart, rangeEnd, isClosed };
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
            const r = typeof t.result === "string"
              ? t.result
              : JSON.stringify(t.result);
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
 * Sum of estimated tokens for a chunk of messages.
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
// Message mutation helpers
// ---------------------------------------------------------------------------

/**
 * Generates a unique ID for a context_summary marker.
 * @returns {string}
 */
export function generateContextSummaryId() {
  return "ctx_" + Date.now().toString(36) + Math.random().toString(36).substring(2, 11);
}

/**
 * Builds an `in_progress` context_summary marker message. The marker
 * lives in the messages array; the actual summary is filled in by the
 * pipeline. The `parentId` is set to the last message of the chunk so
 * the marker sits naturally between the chunk and the next message.
 *
 * @param {Object} params
 * @param {number} params.rangeStart
 * @param {number} params.rangeEnd
 * @param {string} params.parentId  ID of the chunk's last message.
 * @param {string} params.compressedBy  Model used (or will be used).
 * @param {number} params.tokenEstimate
 * @param {string} [params.id]
 * @returns {Object}
 */
export function buildInProgressMarker({
  rangeStart,
  rangeEnd,
  parentId,
  compressedBy,
  tokenEstimate,
  id,
}) {
  return {
    id: id || generateContextSummaryId(),
    role: "context_summary",
    parentId: parentId || null,
    branchIndex: 0,
    timestamp: new Date(),
    rangeStart,
    rangeEnd,
    status: "in_progress",
    summaryText: null,
    compressedAt: null,
    compressedBy: compressedBy || DEFAULT_COMPRESSION_MODEL,
    tokenEstimate: tokenEstimate || 0,
    sourceMessageIds: [],
  };
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
 * @param {Object} params
 * @param {number} params.rangeStart
 * @param {number} params.rangeEnd
 * @returns {string}
 */
export function buildSummaryPrompt({ rangeStart, rangeEnd }) {
  return `You are summarizing a portion of a long conversation between a user and an AI assistant. The portion you are summarizing covers messages ${rangeStart} through ${rangeEnd} (user turns).

This is a CONTINUATION of an ongoing conversation. Treat the chunk as if you were the same assistant picking the conversation back up. Preserve information as faithfully as possible — the model reading this summary later will be told the range it covers and will use it as authoritative context.

# Hard rules — what to keep

- **Code**: When a single code file appears in its "base" or full form, include it VERBATIM in a fenced code block with the right language tag. If subsequent turns are variations of the same file (edits, alternative versions, refactors), include the BASE/canonical version verbatim and use short diffs, unified diffs, or one-paragraph prose explanations for the variants. Do not paraphrase code into prose.
- **Documents, file names, IDs, version numbers, dependency names, URLs, error messages, and quoted text**: keep EXACTLY. Never reword these.
- **User's stated goals, decisions, constraints, and preferences**: keep verbatim or near-verbatim.
- **Tool results that contain data the conversation depends on** (e.g. file contents, search results): keep the load-bearing facts; drop verbose logs that don't change the answer.
- **Reasoning**: keep only the conclusion. Drop the long internal monologue.
- **Numbered or labeled items the user is tracking** (todo lists, requirements): keep the latest state of each item.

# Hard rules — what to drop

- Greetings, "thanks", "sounds good", small talk, and any other pure pleasantries.
- Restated explanations the assistant gave that the user did not act on.
- Repeated tool calls with the same outcome.

# Output format

- Plain prose or short bullet lists, no preamble, no epilogue.
- Code in fenced blocks with the right language tag.
- Target length: enough to be near-lossless for the chunk's content. If the chunk is dense, this may be long; do not pad short chunks.
- Do NOT begin with phrases like "The user" or "In this conversation" — just start.
- Do NOT end with offers to help or summaries of what you did.`;
}

/**
 * Calls the cheap compression model and returns the summary text.
 * Returns null on failure.
 *
 * @param {Array} chunk  Messages in the chunk to summarize.
 * @param {Object} options
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {number} options.rangeStart
 * @param {number} options.rangeEnd
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string|null>}
 */
export async function callCompressionModel(chunk, options) {
  const {
    apiKey,
    model = DEFAULT_COMPRESSION_MODEL,
    rangeStart,
    rangeEnd,
    signal,
  } = options || {};

  if (!Array.isArray(chunk) || chunk.length === 0) return null;

  const formatted = chunk
    .map(formatMessageForSummaryPrompt)
    .filter((s) => s && s.trim())
    .join("\n\n---\n\n");

  if (!formatted.trim()) return null;

  const systemPrompt = buildSummaryPrompt({ rangeStart, rangeEnd });

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
          {
            role: "user",
            content: `Here are messages ${rangeStart}–${rangeEnd}. Produce the summary now.\n\n${formatted}`,
          },
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
// History transformation
// ---------------------------------------------------------------------------

/**
 * Renders a `context_summary` marker into a single labeled user
 * message suitable for the API. The label makes the range explicit so
 * the model reading it can place the summary in time.
 *
 * @param {Object} marker
 * @returns {Object|null}
 */
export function renderContextSummaryAsApiMessage(marker) {
  if (!marker || marker.role !== "context_summary") return null;
  if (marker.status !== "completed" || !marker.summaryText) return null;
  const text =
    `--- Context summary: messages ${marker.rangeStart}–${marker.rangeEnd} ---\n` +
    marker.summaryText +
    `\n--- end summary ---`;
  return { role: "user", content: text };
}

/**
 * Acknowledgement message emitted once per turn after the first
 * context_summary, so the assistant has a stable reply to anchor to.
 * Using a constant string is fine — the model treats it as
 * acknowledgement and moves on.
 */
const SUMMARY_ACKNOWLEDGEMENT = {
  role: "assistant",
  content: "Acknowledged. I'll use those summaries as the authoritative continuation of the conversation.",
};

/**
 * Transforms a list of visible messages into the history list that
 * should be sent to the API. Messages that fall inside a completed
 * `context_summary` chunk are replaced by the rendered summary
 * message. The most recent chunk stays verbatim. Stale or
 * in-progress markers are ignored.
 *
 * Returns a NEW array; the input is not mutated.
 *
 * @param {Array} visibleMessages
 * @returns {Array}
 */
export function transformHistoryForAPI(visibleMessages) {
  if (!Array.isArray(visibleMessages) || visibleMessages.length === 0) {
    return [];
  }

  const markers = getContextSummaryMarkers(visibleMessages).filter(
    (m) => m.status === "completed",
  );

  if (markers.length === 0) {
    return visibleMessages.filter((m) => m.role !== "context_summary");
  }

  // Build a Set of message IDs that are covered by a completed marker.
  // A message is "covered" iff it appears strictly before the marker
  // AND after the previous marker (or the start of the visible list).
  const coveredIds = new Set();
  let segmentStart = 0;
  for (const marker of markers) {
    const markerIdx = visibleMessages.indexOf(marker);
    if (markerIdx === -1) continue;
    for (let i = segmentStart; i < markerIdx; i++) {
      const m = visibleMessages[i];
      if (m && m.role !== "context_summary") coveredIds.add(m.id);
    }
    segmentStart = markerIdx + 1;
  }

  const out = [];
  let hasAcknowledgedSummary = false;
  for (const msg of visibleMessages) {
    if (!msg) continue;
    if (msg.role === "context_summary") {
      if (msg.status !== "completed" || !msg.summaryText) continue;
      const rendered = renderContextSummaryAsApiMessage(msg);
      if (rendered) {
        out.push(rendered);
        if (!hasAcknowledgedSummary) {
          out.push(SUMMARY_ACKNOWLEDGEMENT);
          hasAcknowledgedSummary = true;
        }
      }
      continue;
    }
    if (coveredIds.has(msg.id)) continue; // already represented by a summary
    out.push(msg);
  }
  return out;
}

 