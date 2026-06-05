/**
 * @file notepadPipeline.js
 * @description Background pipeline for maintaining the Notepad memory system.
 *
 * The pipeline runs asynchronously and consists of three stages:
 *   1. Summarize    — Summarize chats that need it (parallel, cheap model)
 *   2. Consolidate  — Rewrite the Notepad from scratch using all new
 *                     summaries (single call, capable model)
 *   3. Atomic swap  — Persist the new Notepad only after validation
 *
 * The pipeline can be safely interrupted: state is persisted between
 * stages, and on the next run we resume from where we left off.
 *
 * Triggers (in `shouldRunNotepadPipeline`):
 *   - ≥ 5 chats have new content (configurable via PENDING_CHAT_THRESHOLD)
 *   - ≥ 24 hours since the last update AND there's at least one new summary
 *   - ≥ 48 hours since the last update (maintenance run)
 *   - There are summaries that were summarized but never incorporated
 *     (an interrupted previous run)
 */

import localforage from "localforage";
import mitt from "mitt";
import { getSessionToken } from "~/composables/useSession";
import {
  loadNotepad,
  saveNotepad,
  validateNotepad,
} from "./notepad";
import {
  getChatsNeedingSummary,
  processChatSummaries,
  getAllChatSummaries,
} from "./chatSummarizer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const NOTEPAD_PIPELINE_STATE_KEY = "notepad_pipeline_state";
export const NOTEPAD_PIPELINE_PENDING_KEY = "notepad_pipeline_pending";

/**
 * Model used for Stage 2 (consolidation). Centralized here so it's easy
 * to swap if the model is renamed or a better one becomes available.
 */
const CONSOLIDATION_MODEL = "anthropic/claude-haiku-4.5";

/** How long a pipeline run is allowed to stay in "running" before we assume it's stuck. */
const STUCK_THRESHOLD_MS = 30 * 60 * 1000;

/** Trigger thresholds. */
const PENDING_CHAT_THRESHOLD = 5;
const HOURS_THRESHOLD_FOR_UPDATE = 24;
const HOURS_THRESHOLD_FOR_MAINTENANCE = 48;

/** Hard ceiling on chats summarized per Stage 1 run, to bound API spend. */
const MAX_CHATS_PER_STAGE_1 = 30;

/** Soft ceiling on the consolidated Notepad size, in characters. */
const MAX_NOTEPAD_CHARS = 16_000;

// ---------------------------------------------------------------------------
// Event bus — components can subscribe to live pipeline progress.
// ---------------------------------------------------------------------------

export const notepadEvents = mitt();

/**
 * Emits a status event. Components (e.g. the Notepad page) listen via
 * `notepadEvents.on('status', handler)`.
 *
 * @param {string} status
 * @param {Object} [extra]
 */
function emitStatus(status, extra = {}) {
  notepadEvents.emit("status", { status, ...extra });
}

// ---------------------------------------------------------------------------
// Pipeline state persistence
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} NotepadPipelineState
 * @property {"idle"|"running"|"completed"|"failed"} status
 * @property {number} stage
 * @property {string|null} lastRun
 * @property {string|null} lastError
 * @property {string|null} startedAt
 * @property {string|null} lastHeartbeat
 */

const DEFAULT_STATE = Object.freeze({
  status: "idle",
  stage: 0,
  lastRun: null,
  lastError: null,
  startedAt: null,
  lastHeartbeat: null,
});

/** @returns {Promise<NotepadPipelineState>} */
async function loadPipelineState() {
  try {
    const stored = await localforage.getItem(NOTEPAD_PIPELINE_STATE_KEY);
    if (stored && typeof stored === "object") {
      return { ...DEFAULT_STATE, ...stored };
    }
    return { ...DEFAULT_STATE };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/**
 * @param {Partial<NotepadPipelineState>} patch
 */
async function savePipelineState(patch) {
  try {
    const current = await loadPipelineState();
    const next = { ...current, ...patch };
    await localforage.setItem(NOTEPAD_PIPELINE_STATE_KEY, next);
    emitStatus(next.status, { stage: next.stage, lastError: next.lastError });
    return next;
  } catch (error) {
    console.error("[notepad] Failed to save pipeline state:", error);
  }
}

// ---------------------------------------------------------------------------
// In-memory run lock — prevents two concurrent runs in the same tab.
// Cross-tab coordination is best-effort via the persisted state file.
// ---------------------------------------------------------------------------

let inFlightRun = null;

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

/**
 * Returns the summaries that need to be incorporated into the Notepad.
 * A summary needs incorporation when it has never been incorporated, or
 * when it has been re-summarized (incremental) since it was last
 * incorporated. We do NOT compare against the Notepad's `lastUpdated` —
 * that would cause every run to re-process the same data and drift the
 * Notepad over time.
 *
 * @returns {Promise<Array>}
 */
async function getUnincorporatedSummaries() {
  const all = await getAllChatSummaries();
  return all.filter((s) => {
    // `getAllChatSummaries` already filters out nothingNotable and
    // empty summaries, but defend against it being bypassed.
    if (s.nothingNotable) return false;
    if (!s.summary) return false;

    // A summary with no `incorporatedAt` has never been incorporated.
    // A summary that was summarized after it was last incorporated has
    // a newer version that hasn't been incorporated yet.
    if (!s.incorporatedAt) return true;
    return new Date(s.lastSummarizedAt) > new Date(s.incorporatedAt);
  });
}

/**
 * Returns `{ shouldRun, reason }` based on pipeline triggers.
 *
 * @returns {Promise<{shouldRun: boolean, reason?: string}>}
 */
export async function shouldRunNotepadPipeline() {
  try {
    const [notepad, chatsNeedingSummary, unincorporated] = await Promise.all([
      loadNotepad(),
      getChatsNeedingSummary(),
      getUnincorporatedSummaries(),
    ]);

    const lastUpdate = new Date(
      notepad.metadata.lastUpdated || notepad.metadata.lastConsolidatedAt || 0,
    );
    const hoursSinceUpdate = (Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60);

    // Trigger 1: A lot of chats have new content.
    if (chatsNeedingSummary.length >= PENDING_CHAT_THRESHOLD) {
      return {
        shouldRun: true,
        reason: `${chatsNeedingSummary.length} chats need summarization`,
      };
    }

    // Trigger 2: A day has passed and there is new material.
    if (
      hoursSinceUpdate >= HOURS_THRESHOLD_FOR_UPDATE &&
      unincorporated.length > 0
    ) {
      return {
        shouldRun: true,
        reason: `${hoursSinceUpdate.toFixed(1)}h since last update with ${unincorporated.length} new summaries`,
      };
    }

    // Trigger 3: Maintenance — a couple of days have passed.
    if (hoursSinceUpdate >= HOURS_THRESHOLD_FOR_MAINTENANCE) {
      return {
        shouldRun: true,
        reason: `Maintenance run — ${hoursSinceUpdate.toFixed(1)}h since last update`,
      };
    }

    return { shouldRun: false };
  } catch (error) {
    console.error("[notepad] Failed to evaluate pipeline triggers:", error);
    return { shouldRun: false };
  }
}

// ---------------------------------------------------------------------------
// Stage 1 — Summarize
// ---------------------------------------------------------------------------

/**
 * @param {string} apiKey
 * @returns {Promise<{success: boolean, error?: string, summaryCount?: number}>}
 */
async function stage1Summarize(apiKey) {
  try {
    const chats = await getChatsNeedingSummary();
    if (chats.length === 0) {
      return { success: true, summaryCount: 0 };
    }

    const chatsToProcess = chats.slice(0, MAX_CHATS_PER_STAGE_1);
    const results = await processChatSummaries(chatsToProcess, apiKey, 5);

    const successCount = results.filter((r) => r.success).length;
    const summaryCount = results.filter((r) => r.success && !r.nothingNotable).length;

    console.log(
      `[notepad] Stage 1: summarized ${successCount}/${chatsToProcess.length} chats (${summaryCount} with notable content)`,
    );
    return { success: true, summaryCount };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Stage 2 — Consolidate
// ---------------------------------------------------------------------------

/**
 * @param {string} apiKey
 * @returns {Promise<{success: boolean, error?: string, newNotepad?: {content: string, metadata: Object}, noChange?: boolean, summariesUsed?: string[]}>}
 */
async function stage2Consolidate(apiKey) {
  try {
    const [notepad, summaries] = await Promise.all([
      loadNotepad(),
      getUnincorporatedSummaries(),
    ]);

    if (summaries.length === 0) {
      // Nothing new — no AI call needed.
      return { success: true, newNotepad: notepad, noChange: true, summariesUsed: [] };
    }

    const sessionToken = await getSessionToken();
    const today = new Date().toISOString().split("T")[0];

    const prompt = buildConsolidationPrompt({
      previousNotepad: notepad.content,
      summaries,
      today,
    });

    const response = await fetch("/api/ai", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-token": sessionToken,
      },
      body: JSON.stringify({
        model: CONSOLIDATION_MODEL,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: "Write the complete replacement notepad now." },
        ],
        stream: false,
        temperature: 0.3,
        max_tokens: 6000,
        ...(apiKey && { customApiKey: apiKey }),
      }),
    });

    if (!response.ok) {
      throw new Error(`Consolidation request failed: ${response.status}`);
    }

    const data = await response.json();
    const newContent = data.choices?.[0]?.message?.content?.trim();

    if (!newContent) {
      throw new Error("Empty consolidation response");
    }

    const validation = validateNotepad(newContent);
    if (!validation.valid) {
      throw new Error(`Invalid notepad generated: ${validation.error}`);
    }

    if (newContent.length > MAX_NOTEPAD_CHARS) {
      console.warn(
        `[notepad] Consolidation output is large (~${Math.round(newContent.length / 4)} tokens). Consider tightening the model.`,
      );
    }

    return {
      success: true,
      newNotepad: {
        content: newContent,
        metadata: {
          ...notepad.metadata,
          updateCount: (notepad.metadata.updateCount || 0) + 1,
        },
      },
      summariesUsed: summaries.map((s) => s.conversationId),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Builds the consolidation system prompt. Kept as a separate function
 * so it can be unit-tested and tweaked without touching pipeline logic.
 *
 * @param {Object} params
 * @param {string} params.previousNotepad
 * @param {Array<{title: string, summary: string, lastSummarizedAt: string}>} params.summaries
 * @param {string} params.today  YYYY-MM-DD
 * @returns {string}
 */
export function buildConsolidationPrompt({ previousNotepad, summaries, today }) {
  const previous = (previousNotepad || "").trim() || "(empty — write from scratch)";

  const formattedSummaries = summaries
    .map((s) => {
      const date = s.lastSummarizedAt
        ? new Date(s.lastSummarizedAt).toLocaleDateString()
        : "unknown date";
      const title = s.title || "(untitled conversation)";
      return `[${date} — "${title}"]\n${s.summary}`;
    })
    .join("\n\n");

  return `You are maintaining a private working notepad that helps you remember
a user across conversations. Today is ${today}.

You will receive:
  1. Your PREVIOUS notepad (which may be empty).
  2. A set of NEW chat summaries that have not yet been folded in.

Your task: PRODUCE A FRESH, COMPLETE REPLACEMENT of the notepad.
The output you produce REPLACES the previous notepad entirely.

CRITICAL — READ THIS CAREFULLY:
- The output REPLACES the previous notepad. It is NOT appended to, NOT
  a "page 2", NOT "continued" from a previous version. Imagine you are
  rewriting a single document from scratch using both the old version
  and the new summaries as your source material.
- Do NOT start with phrases like "The user continues to..." or
  "Recent updates include..." — those imply continuation, which is
  wrong. Write the notepad as if you are writing it for the first
  time, informed by everything.
- Do NOT preserve "verbatim sections" — rewrite naturally using all
  the information available to you.
- The previous notepad and the new summaries are INPUTS. Your output
  is a complete, standalone document.

TONE:
- Observational, not evaluative. State what the user has done, is
  working on, and has expressed — do not praise, encourage, or
  editorialize.
- Avoid sycophantic language ("impressive", "great taste", "wonderful
  question", "I appreciate..."). State facts, not feelings.
- A short, dry note like "the user is debugging X" beats a paragraph
  of admiration. If you have no signal about something, OMIT it — do
  not invent personality traits to fill space.

SIZE & STRUCTURE:
- There is no fixed length or fixed structure. The notepad is your
  own working memory — size it to fit what you actually know.
- A user you've barely talked to might warrant a few short lines. A
  user you've worked with for months might warrant a longer document.
  Use your judgment.
- You may use sections, lists, free-form prose, tables, or any format
  that helps you recall. The structure should evolve naturally with
  what you know.
- A small suggested skeleton (you can throw it away or reshape it):
    ## What the user is working on
    ## Recurring interests / preferences
    ## Communication style
    ## Things to remember
  Feel free to invent your own sections, drop unused ones, or write
  as a single flowing document.

WHAT TO INCLUDE:
- Concrete, dated facts: projects, tools, decisions, completed work.
- Recurring preferences (e.g., "prefers TypeScript", "dislikes X").
- Communication quirks that affect how to respond to them.
- Anything the user has explicitly asked you to remember.
- Concrete bullet points are fine for "things to remember" — short
  facts you can scan later beat prose for that section.

WHAT TO OMIT:
- Anything speculative or inferred from a single message.
- Editorializing about the user's character unless they have
  demonstrated it consistently.
- Old, completed items that no longer matter. They were interesting
  once; they aren't now. Drop them.

OUTPUT:
- Plain Markdown. No YAML frontmatter. No code fences wrapping the
  whole thing. Just the notepad content, ready to be saved.

INPUTS:

PREVIOUS NOTEPAD:
${previous}

NEW SUMMARIES:
${formattedSummaries}

Write the complete replacement notepad now.`;
}

// ---------------------------------------------------------------------------
// Stage 3 — Atomic swap
// ---------------------------------------------------------------------------

/**
 * @param {{content: string, metadata: Object}} newNotepad
 * @param {string[]} summariesUsed  Conversation IDs that were folded in.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function stage3AtomicSwap(newNotepad, summariesUsed) {
  try {
    await saveNotepad(newNotepad.content, {
      ...newNotepad.metadata,
      lastConsolidatedAt: new Date().toISOString(),
    });

    await markSummariesIncorporated(summariesUsed);

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Marks a set of chat summaries as incorporated, so they won't be
 * re-processed next time. We write each summary individually (a small
 * N+1) because the number of summaries per run is bounded by
 * MAX_CHATS_PER_STAGE_1 — keeping the operation simple and per-summary
 * is more important than micro-optimising this hot path.
 *
 * @param {string[]} conversationIds
 */
async function markSummariesIncorporated(conversationIds) {
  if (!conversationIds || conversationIds.length === 0) return;

  const now = new Date().toISOString();

  await Promise.all(
    conversationIds.map(async (id) => {
      const key = `chat_summary_${id}`;
      try {
        const summary = await localforage.getItem(key);
        if (!summary) return;
        await localforage.setItem(key, { ...summary, incorporatedAt: now });
      } catch (error) {
        console.error(`[notepad] Failed to mark summary incorporated for ${id}:`, error);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

/**
 * Runs the complete Notepad pipeline. Resumes from a previously
 * interrupted run if `state.status === "running"` and we haven't
 * exceeded STUCK_THRESHOLD_MS.
 *
 * @param {string} apiKey  OpenRouter API key (required)
 * @returns {Promise<Object>} Pipeline result
 */
export async function runNotepadPipeline(apiKey) {
  if (!apiKey) {
    return {
      success: false,
      error: "API key is required to run the notepad pipeline",
    };
  }

  // Bail out early if another run is already in flight in this tab.
  if (inFlightRun) {
    return inFlightRun;
  }

  const run = async () => {
    const state = await loadPipelineState();
    const now = new Date().toISOString();

    // Detect stuck runs: if state claims "running" but the startedAt /
    // lastHeartbeat is older than STUCK_THRESHOLD_MS, we treat the
    // previous run as dead and start over.
    let resumeFromStage = 0;
    if (state.status === "running" && state.stage > 0) {
      const lastBeat = state.lastHeartbeat || state.startedAt || state.lastRun;
      const isStuck =
        !lastBeat || Date.now() - new Date(lastBeat).getTime() > STUCK_THRESHOLD_MS;
      if (!isStuck) {
        return { success: false, reason: "already_running" };
      }
      console.warn(
        `[notepad] Previous run appears stuck (stage ${state.stage}); resuming.`,
      );
      resumeFromStage = state.stage;
    }

    // Always re-evaluate triggers at the start of a run, but include
    // unincorporated summaries as an implicit trigger (handles resumed
    // runs after partial completion).
    const unincorporated = await getUnincorporatedSummaries();
    let trigger = await shouldRunNotepadPipeline();
    if (!trigger.shouldRun && unincorporated.length > 0) {
      trigger = {
        shouldRun: true,
        reason: `${unincorporated.length} unincorporated summaries from a prior run`,
      };
    }
    if (!trigger.shouldRun) {
      return { success: true, ran: false, reason: "no_trigger" };
    }

    let currentStage = resumeFromStage > 0 ? resumeFromStage : 1;
    await savePipelineState({
      status: "running",
      stage: currentStage,
      startedAt: now,
      lastRun: now,
      lastHeartbeat: now,
      lastError: null,
    });
    console.log(`[notepad] Pipeline starting: ${trigger.reason}`);

    try {
      // ---- Stage 1: Summarize ----
      if (currentStage <= 1) {
        console.log("[notepad] Stage 1: summarizing chats");
        const r1 = await stage1Summarize(apiKey);
        if (!r1.success) throw new Error(`Stage 1 failed: ${r1.error}`);

        currentStage = 2;
        await savePipelineState({
          stage: 2,
          lastHeartbeat: new Date().toISOString(),
        });
      }

      // ---- Stage 2: Consolidate ----
      let stage2Result;
      if (currentStage <= 2) {
        console.log("[notepad] Stage 2: consolidating");
        stage2Result = await stage2Consolidate(apiKey);
        if (!stage2Result.success) {
          throw new Error(`Stage 2 failed: ${stage2Result.error}`);
        }

        if (stage2Result.noChange) {
          console.log("[notepad] No new summaries to consolidate; done");
          await savePipelineState({
            status: "completed",
            stage: 0,
            lastRun: new Date().toISOString(),
            startedAt: null,
          });
          return { success: true, ran: true, notepadUpdated: false };
        }

        // Persist the proposed new notepad for the atomic-swap stage.
        await localforage.setItem(
          NOTEPAD_PIPELINE_PENDING_KEY,
          stage2Result.newNotepad,
        );

        currentStage = 3;
        await savePipelineState({
          stage: 3,
          lastHeartbeat: new Date().toISOString(),
        });
      }

      // ---- Stage 3: Atomic swap ----
      if (currentStage <= 3) {
        console.log("[notepad] Stage 3: atomic swap");
        let pending = await localforage.getItem(NOTEPAD_PIPELINE_PENDING_KEY);
        let summariesUsed = [];

        if (pending) {
          // We don't currently persist summariesUsed alongside the
          // pending notepad (kept the persisted state minimal), so the
          // conservative behaviour is to re-derive the unincorporated
          // set at this point. The state-machine guard in stage2Result
          // ensures we only call the model when there's something to
          // consolidate.
          const fresh = await getUnincorporatedSummaries();
          summariesUsed = fresh.map((s) => s.conversationId);
        } else {
          // Pending state was lost (storage cleared, schema bump, etc.).
          // Re-run Stage 2 to regenerate it. The summaries involved will
          // not be re-marked-as-incorporated from this pass (we only mark
          // on a successful Stage 3), so they're safe to re-process.
          console.warn(
            "[notepad] Pending notepad was missing on Stage 3; re-running Stage 2",
          );
          stage2Result = await stage2Consolidate(apiKey);
          if (!stage2Result.success || stage2Result.noChange) {
            throw new Error(
              "Could not regenerate pending notepad for Stage 3",
            );
          }
          pending = stage2Result.newNotepad;
          summariesUsed = stage2Result.summariesUsed || [];
          await localforage.setItem(NOTEPAD_PIPELINE_PENDING_KEY, pending);
        }

        const r3 = await stage3AtomicSwap(pending, summariesUsed);
        if (!r3.success) throw new Error(`Stage 3 failed: ${r3.error}`);

        await localforage.removeItem(NOTEPAD_PIPELINE_PENDING_KEY);
      }

      await savePipelineState({
        status: "completed",
        stage: 0,
        lastRun: new Date().toISOString(),
        startedAt: null,
        lastHeartbeat: null,
      });

      console.log("[notepad] Pipeline completed successfully");
      return { success: true, ran: true, notepadUpdated: true };
    } catch (error) {
      console.error(`[notepad] Pipeline failed at stage ${currentStage}:`, error);
      await savePipelineState({
        status: "failed",
        stage: currentStage,
        lastError: error.message,
        startedAt: null,
      });
      return {
        success: false,
        error: error.message,
        failedAtStage: currentStage,
      };
    }
  };

  inFlightRun = run().finally(() => {
    inFlightRun = null;
  });
  return inFlightRun;
}

/**
 * Returns the latest pipeline state for UI display.
 * @returns {Promise<Object>}
 */
export async function getNotepadPipelineStatus() {
  return loadPipelineState();
}

/**
 * Forces a pipeline run, ignoring the in-memory lock. Use sparingly —
 * this is intended for manual "rebuild from scratch" actions, not for
 * routine UI buttons.
 *
 * @param {string} apiKey
 * @returns {Promise<Object>}
 */
export async function forceRunNotepadPipeline(apiKey) {
  await savePipelineState({
    status: "idle",
    stage: 0,
    lastError: null,
    startedAt: null,
    lastHeartbeat: null,
  });
  return runNotepadPipeline(apiKey);
}

/**
 * Returns true if the pipeline is currently running (according to
 * persisted state). Useful for UI guards.
 *
 * @returns {Promise<boolean>}
 */
export async function isNotepadPipelineRunning() {
  const state = await loadPipelineState();
  if (state.status !== "running") return false;
  const lastBeat = state.lastHeartbeat || state.startedAt;
  if (!lastBeat) return false;
  return Date.now() - new Date(lastBeat).getTime() < STUCK_THRESHOLD_MS;
}
