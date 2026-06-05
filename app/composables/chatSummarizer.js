/**
 * @file chatSummarizer.js
 * @description Summarizes chat conversations for Notepad integration.
 *
 * Creates concise, narrative summaries of conversations from the user's
 * perspective, focusing on facts and state changes about the user
 * rather than assistant explanations. The Notepad pipeline consumes
 * these summaries on its next run.
 */

import localforage from "localforage";
import { getSessionToken } from "~/composables/useSession";

export const CHAT_SUMMARY_KEY_PREFIX = "chat_summary_";

/** Model used for chat-level summarization. Cheap and fast. */
const SUMMARIZATION_MODEL = "z-ai/glm-4.7-flash";

/** How many characters of a single message we send to the summarizer. */
const MAX_MESSAGE_CHARS = 2000;

/** How many recent messages we consider when summarizing. */
const MAX_RECENT_MESSAGES = 50;

/**
 * Loads summary metadata for a single conversation.
 * @param {string} conversationId
 * @returns {Promise<Object|null>}
 */
export async function loadChatSummary(conversationId) {
  try {
    return await localforage.getItem(
      `${CHAT_SUMMARY_KEY_PREFIX}${conversationId}`,
    );
  } catch (error) {
    console.error(
      `[chatSummarizer] Failed to load summary for ${conversationId}:`,
      error,
    );
    return null;
  }
}

/**
 * Saves summary metadata for a conversation. Stamps `lastSummarizedAt`
 * if not already set.
 *
 * @param {string} conversationId
 * @param {Object} summary
 * @returns {Promise<boolean>}
 */
export async function saveChatSummary(conversationId, summary) {
  try {
    const merged = {
      ...summary,
      conversationId,
      lastSummarizedAt: summary.lastSummarizedAt || new Date().toISOString(),
    };
    await localforage.setItem(
      `${CHAT_SUMMARY_KEY_PREFIX}${conversationId}`,
      merged,
    );
    return true;
  } catch (error) {
    console.error(
      `[chatSummarizer] Failed to save summary for ${conversationId}:`,
      error,
    );
    return false;
  }
}

/**
 * Returns the conversations that need (re-)summarization. A chat needs
 * a new summary if it has no summary yet, or if it has new messages
 * since the last summary was generated.
 *
 * @returns {Promise<Array>}
 */
export async function getChatsNeedingSummary() {
  try {
    const metadata =
      (await localforage.getItem("conversations_metadata")) || [];
    const chatsNeedingSummary = [];

    for (const conv of metadata) {
      const summary = await loadChatSummary(conv.id);
      const convData = await localforage.getItem(
        `conversation_${conv.id}`,
      );
      const messages = convData?.messages || [];
      if (messages.length === 0) continue;

      if (!summary) {
        chatsNeedingSummary.push({
          ...conv,
          messages,
          hasExistingSummary: false,
        });
        continue;
      }

      const lastSummarizedIdx = messages.findIndex(
        (m) => m.id === summary.lastMessageId,
      );
      const lastMessage = messages[messages.length - 1];
      if (
        lastSummarizedIdx === -1 ||
        !lastMessage ||
        lastMessage.id !== summary.lastMessageId
      ) {
        const newMessages =
          lastSummarizedIdx >= 0
            ? messages.slice(lastSummarizedIdx + 1)
            : messages;
        chatsNeedingSummary.push({
          ...conv,
          messages,
          newMessages,
          existingSummary: summary.summary,
          hasExistingSummary: true,
        });
      }
    }

    return chatsNeedingSummary;
  } catch (error) {
    console.error("[chatSummarizer] Failed to get chats needing summary:", error);
    return [];
  }
}

/**
 * Summarizes a full conversation from scratch using a cheap, fast model.
 *
 * @param {Array} messages
 * @param {string} apiKey
 * @returns {Promise<{summary: string|null, nothingNotable: boolean}>}
 */
export async function summarizeChat(messages, apiKey) {
  try {
    const relevantMessages = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role,
        content: m.content?.substring(0, MAX_MESSAGE_CHARS) || "",
      }))
      .slice(-MAX_RECENT_MESSAGES);

    if (relevantMessages.length === 0) {
      return { summary: null, nothingNotable: true };
    }

    const sessionToken = await getSessionToken();
    const response = await fetch("/api/ai", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-token": sessionToken,
      },
      body: JSON.stringify({
        model: SUMMARIZATION_MODEL,
        messages: [
          {
            role: "system",
            content: `You are creating notes about a user based on their conversation with an AI assistant.

Your task: Write a brief summary (2-6 sentences) of what this conversation reveals about the user.

Guidelines:
- Write in third person from the AI's perspective observing the user.
- Focus on facts about the user: their goals, questions, interests, preferences, work, challenges.
- Ignore the AI's explanations unless the user actively engaged with them.
- Note any projects mentioned, technical choices, or decisions made.
- If the conversation is trivial (greeting, small talk, weather), return exactly: NOTHING_NOTABLE
- Be specific but concise — concrete details over generalizations.`,
          },
          {
            role: "user",
            content: `Here is the conversation to summarize:\n\n${formatMessagesForSummary(relevantMessages)}`,
          },
        ],
        stream: false,
        ...(apiKey && { customApiKey: apiKey }),
      }),
    });

    if (!response.ok) {
      throw new Error(`Summary request failed: ${response.status}`);
    }

    const data = await response.json();
    const summary = data.choices?.[0]?.message?.content?.trim();

    if (summary === "NOTHING_NOTABLE") {
      return { summary: null, nothingNotable: true };
    }
    if (!summary) {
      return { summary: null, nothingNotable: true };
    }

    return { summary, nothingNotable: false };
  } catch (error) {
    console.error("[chatSummarizer] summarizeChat failed:", error);
    return { summary: null, nothingNotable: true };
  }
}

/**
 * Incrementally updates an existing summary with new messages.
 *
 * @param {string} existingSummary
 * @param {Array} newMessages
 * @param {string} apiKey
 * @returns {Promise<{summary: string|null, nothingNotable: boolean}>}
 */
export async function incrementalSummarize(existingSummary, newMessages, apiKey) {
  try {
    const relevantMessages = newMessages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role,
        content: m.content?.substring(0, MAX_MESSAGE_CHARS) || "",
      }));

    if (relevantMessages.length === 0) {
      return { summary: existingSummary, nothingNotable: false };
    }

    const sessionToken = await getSessionToken();
    const response = await fetch("/api/ai", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-token": sessionToken,
      },
      body: JSON.stringify({
        model: SUMMARIZATION_MODEL,
        messages: [
          {
            role: "system",
            content: `You are updating notes about a user based on new conversation activity.

You have:
1. An existing summary of previous conversations.
2. New messages from the user.

Your task: Produce an updated summary that integrates the new information.

Guidelines:
- Preserve important details from the existing summary.
- Add new facts, projects, or insights from the recent messages.
- Remove or update outdated information if contradicted.
- Keep the length reasonable (2-6 sentences).
- Write in third person from an AI observing the user.
- If the new messages add nothing notable, return the existing summary unchanged.
- If the existing summary plus new messages reveal nothing notable, return: NOTHING_NOTABLE`,
          },
          {
            role: "user",
            content: `Existing summary:\n${existingSummary}\n\nNew messages:\n${formatMessagesForSummary(relevantMessages)}\n\nUpdated summary:`,
          },
        ],
        stream: false,
        ...(apiKey && { customApiKey: apiKey }),
      }),
    });

    if (!response.ok) {
      throw new Error(`Incremental summary request failed: ${response.status}`);
    }

    const data = await response.json();
    const summary = data.choices?.[0]?.message?.content?.trim();

    if (summary === "NOTHING_NOTABLE") {
      return { summary: null, nothingNotable: true };
    }
    if (!summary) {
      return { summary: existingSummary, nothingNotable: false };
    }
    return { summary, nothingNotable: false };
  } catch (error) {
    console.error("[chatSummarizer] incrementalSummarize failed:", error);
    return { summary: existingSummary, nothingNotable: false };
  }
}

/**
 * Processes a batch of chats for summarization. Runs summaries in
 * parallel with a concurrency limit.
 *
 * @param {Array} chats  Chats needing summary from getChatsNeedingSummary()
 * @param {string} apiKey
 * @param {number} concurrency
 * @returns {Promise<Array<{chatId: string, success: boolean, summary?: string, nothingNotable?: boolean, error?: string}>>}
 */
export async function processChatSummaries(chats, apiKey, concurrency = 5) {
  const results = [];

  for (let i = 0; i < chats.length; i += concurrency) {
    const batch = chats.slice(i, i + concurrency);

    const batchPromises = batch.map(async (chat) => {
      try {
        let result;
        if (chat.hasExistingSummary && chat.existingSummary && chat.newMessages) {
          result = await incrementalSummarize(
            chat.existingSummary,
            chat.newMessages,
            apiKey,
          );
        } else {
          result = await summarizeChat(chat.messages, apiKey);
        }

        const lastMessage = chat.messages[chat.messages.length - 1];
        const baseRecord = {
          lastMessageId: lastMessage?.id,
          lastSummarizedAt: new Date().toISOString(),
          messageCount: chat.messages.length,
        };

        if (result.summary) {
          await saveChatSummary(chat.id, {
            ...baseRecord,
            summary: result.summary,
          });
          return {
            chatId: chat.id,
            success: true,
            summary: result.summary,
            nothingNotable: false,
          };
        }

        // No notable content. We still record the summary with
        // `nothingNotable: true` so that we don't re-summarize this
        // range of messages on the next pass. The Notepad pipeline
        // filters on this flag and skips these records.
        await saveChatSummary(chat.id, {
          ...baseRecord,
          summary: null,
          nothingNotable: true,
        });
        return { chatId: chat.id, success: true, nothingNotable: true };
      } catch (error) {
        console.error(
          `[chatSummarizer] Failed to summarize chat ${chat.id}:`,
          error,
        );
        return { chatId: chat.id, success: false, error: error.message };
      }
    });

    results.push(...(await Promise.all(batchPromises)));
  }

  return results;
}

/**
 * Formats messages for the summarization prompt.
 * @param {Array<{role: string, content: string}>} messages
 * @returns {string}
 */
function formatMessagesForSummary(messages) {
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

/**
 * Deletes the summary for a specific conversation. Called when a
 * conversation is deleted.
 *
 * @param {string} conversationId
 * @returns {Promise<boolean>}
 */
export async function deleteChatSummary(conversationId) {
  try {
    await localforage.removeItem(
      `${CHAT_SUMMARY_KEY_PREFIX}${conversationId}`,
    );
    return true;
  } catch (error) {
    console.error(
      `[chatSummarizer] Failed to delete summary for ${conversationId}:`,
      error,
    );
    return false;
  }
}

/**
 * Clears all chat summaries. Used when resetting the Notepad so that
 * every chat gets re-summarized and re-incorporated from scratch.
 *
 * @returns {Promise<boolean>}
 */
export async function clearAllSummaries() {
  try {
    const metadata =
      (await localforage.getItem("conversations_metadata")) || [];

    await Promise.all(
      metadata.map((conv) =>
        localforage.removeItem(`${CHAT_SUMMARY_KEY_PREFIX}${conv.id}`),
      ),
    );
    return true;
  } catch (error) {
    console.error("[chatSummarizer] Failed to clear summaries:", error);
    return false;
  }
}

/**
 * Returns all chat summaries that are not "nothing notable", enriched
 * with the conversation title. The caller is responsible for filtering
 * by `incorporatedAt` / `lastSummarizedAt` to decide which ones still
 * need to be incorporated into the Notepad.
 *
 * @returns {Promise<Array<{
 *   conversationId: string,
 *   title: string,
 *   summary: string,
 *   lastSummarizedAt: string,
 *   incorporatedAt: string|null,
 *   nothingNotable: boolean,
 * }>>}
 */
export async function getAllChatSummaries() {
  try {
    const metadata =
      (await localforage.getItem("conversations_metadata")) || [];
    const summaries = [];

    for (const conv of metadata) {
      const record = await loadChatSummary(conv.id);
      if (!record) continue;
      if (record.nothingNotable === true) continue;
      if (!record.summary) continue;

      summaries.push({
        conversationId: conv.id,
        title: conv.title,
        summary: record.summary,
        lastSummarizedAt: record.lastSummarizedAt,
        incorporatedAt: record.incorporatedAt || null,
        nothingNotable: false,
      });
    }

    return summaries;
  } catch (error) {
    console.error(
      "[chatSummarizer] Failed to get all chat summaries:",
      error,
    );
    return [];
  }
}
