import localforage from "localforage";
import { emitter } from "~/composables/emitter";
import { migrateMessages } from "./branchManager";
import { getSessionToken } from "~/composables/useSession";
import { useSettings } from "~/composables/useSettings";
import { deleteChatSummary } from "./chatSummarizer";
import { deleteContextSummary } from "./contextCompressor";

/**
 * Serializes a message object for storage, removing Vue reactivity proxies
 * and ensuring all data is JSON-serializable.
 * @param {Object} msg - The message object to serialize
 * @returns {Object} Serialized message ready for storage
 */
function serializeMessage(msg) {
  const baseMessage = {
    id: msg.id,
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp,
    complete: msg.complete,
    // Branching metadata
    parentId: msg.parentId ?? null,
    branchIndex: msg.branchIndex ?? 0,
  };

  // Add attachments for user messages (deep clone to remove reactive proxies)
  if (msg.role === "user" && msg.attachments && msg.attachments.length > 0) {
    baseMessage.attachments = JSON.parse(JSON.stringify(msg.attachments));
  }

  // Add reasoning properties for assistant messages
  if (msg.role === "assistant") {
    baseMessage.reasoning = msg.reasoning;
    baseMessage.reasoningStartTime = msg.reasoningStartTime;
    baseMessage.reasoningEndTime = msg.reasoningEndTime;
    baseMessage.reasoningDuration = msg.reasoningDuration;
    baseMessage.tool_calls = msg.tool_calls
      ? JSON.parse(JSON.stringify(msg.tool_calls))
      : [];
    baseMessage.apiCallTime = msg.apiCallTime;
    baseMessage.firstTokenTime = msg.firstTokenTime;
    baseMessage.completionTime = msg.completionTime;
    baseMessage.tokenCount = msg.tokenCount;
    baseMessage.totalTokens = msg.totalTokens;
    baseMessage.promptTokens = msg.promptTokens;
    baseMessage.annotations = msg.annotations
      ? JSON.parse(JSON.stringify(msg.annotations))
      : null;
    baseMessage.parts = msg.parts
      ? JSON.parse(JSON.stringify(msg.parts))
      : null;
  }

  // Add tool message properties
  if (msg.role === "tool") {
    baseMessage.tool_call_id = msg.tool_call_id;
    baseMessage.name = msg.name;
  }

  return baseMessage;
}

export async function createConversation(plainMessages, lastUpdated) {
  const conversationId = crypto.randomUUID();
  const rawMessages = plainMessages.map(serializeMessage);
  const title = "Untitled";

  try {
    await localforage.setItem(`conversation_${conversationId}`, {
      title,
      lastUpdated,
      messages: rawMessages,
      branchPath: [],
    });

    const metadata =
      (await localforage.getItem("conversations_metadata")) || [];
    metadata.push({ id: conversationId, title, lastUpdated });
    await localforage.setItem("conversations_metadata", metadata);

    emitter.emit("updateConversations");
    console.log("Conversation saved successfully with Untitled title!");

    generateTitleInBackground(conversationId, plainMessages, lastUpdated);

    return conversationId;
  } catch (error) {
    console.error("Error creating conversation:", error);
  }
}

async function generateTitleInBackground(conversationId, plainMessages, lastUpdated) {
  const systemPrompt = `You are an AI with the task of shortening and summarising messages into a short title. You must summarise the given messages based on their content into at most a 40 character title. Each conversation is between a user and an AI chatbot. The messages provided to you are the first messages of the conversation. The title must be general enough to apply to what you think the conversation will be about. Only output the title, without any additional explainations or commentary.`;

  try {
    // Load settings to get the API key
    const settings = await localforage.getItem("settings") || {};
    const customApiKey = settings.custom_api_key;

    if (!customApiKey) {
      console.warn("No API key found in settings, skipping title generation");
      return;
    }

    const sessionToken = await getSessionToken();
    const response = await fetch("/api/ai", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-token": sessionToken,
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          ...plainMessages.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
        ],
        model: "z-ai/glm-4.7-flash",
        stream: false,
        ...(customApiKey && {
          customApiKey: customApiKey,
        }),
      }),
    });

    let newTitle = "Untitled"; // Default to Untitled if API call fails
    if (response.ok) {
      const data = await response.json();
      // Handle both regular responses and potential streaming data
      if (data.choices) {
        newTitle = data.choices?.[0]?.message?.content || "Untitled";
        // Truncate title to 40 characters if needed
        if (newTitle.length > 40) {
          newTitle = newTitle.substring(0, 40);
        }
      } else {
        console.error("Unexpected response format for title generation:", data);
      }
    } else {
      console.error("Title generation request failed:", response.status, response.statusText);
    }

    // Update the conversation with the new title
    const conversation = await localforage.getItem(`conversation_${conversationId}`);
    if (conversation) {
      conversation.title = newTitle;
      conversation.lastUpdated = lastUpdated;
      await localforage.setItem(`conversation_${conversationId}`, conversation);

      // Update metadata as well
      const metadata = (await localforage.getItem("conversations_metadata")) || [];
      const updatedMetadata = metadata.map(conv =>
        conv.id === conversationId ? { ...conv, title: newTitle, lastUpdated } : conv
      );
      await localforage.setItem("conversations_metadata", updatedMetadata);

      emitter.emit("updateConversations");
      emitter.emit("conversationTitleUpdated", { conversationId, title: newTitle });
      console.log(`Title updated for conversation ${conversationId}: ${newTitle}`);
    }
  } catch (error) {
    console.error("Error generating title in background:", error);
    // Keep the "Untitled" title if API call fails
  }
}

export async function storeMessages(
  conversationId,
  plainMessages,
  lastUpdated
) {
  const data = await localforage.getItem(`conversation_${conversationId}`);
  if (!data) {
    console.warn(`No conversation found for id ${conversationId}.`);
    return;
  }

  const rawMessages = plainMessages.map(serializeMessage);
  const title = data.title || "Untitled";
  const branchPath = data.branchPath ?? [];

  await localforage.setItem(`conversation_${conversationId}`, {
    title,
    lastUpdated,
    messages: rawMessages,
    branchPath,
  });

  const metadata = (await localforage.getItem("conversations_metadata")) || [];
  const updatedMetadata = metadata.filter((m) => m.id !== conversationId);
  updatedMetadata.push({ id: conversationId, title, lastUpdated });
  await localforage.setItem("conversations_metadata", updatedMetadata);

  console.log("Conversation saved successfully!");
}

export async function deleteConversation(conversationId) {
  // Remove full conversation data
  await localforage.removeItem(`conversation_${conversationId}`);

  // Delete the chat summary for this conversation
  await deleteChatSummary(conversationId);

  // Delete the context-compression sidecar for this conversation
  await deleteContextSummary(conversationId);

  // Update metadata by filtering out the deleted conversation.
  const metadata = (await localforage.getItem("conversations_metadata")) || [];
  const updatedMetadata = metadata.filter((m) => m.id !== conversationId);
  await localforage.setItem("conversations_metadata", updatedMetadata);

  // Emit an event so that the sidebar updates its list.
  emitter.emit("updateConversations");

  // Emit an event with the deleted conversation ID so pages can react
  emitter.emit("conversationDeleted", { conversationId });

  console.log(`Conversation ${conversationId} deleted successfully!`);
}

/**
 * Updates the branch path for a conversation
 * @param {string} conversationId - The conversation ID
 * @param {Array<number>} branchPath - The new branch path
 */
export async function updateBranchPath(conversationId, branchPath) {
  const data = await localforage.getItem(`conversation_${conversationId}`);
  if (!data) {
    console.warn(`No conversation found for id ${conversationId}.`);
    return;
  }

  await localforage.setItem(`conversation_${conversationId}`, {
    ...data,
    branchPath,
    lastUpdated: new Date(),
  });
}

/**
 * Loads a conversation and migrates messages if needed for branching support
 * @param {string} conversationId - The conversation ID
 * @returns {Object|null} The conversation data with migrated messages, or null if not found
 */
/**
 * Removes legacy `context_summary` marker messages left behind by the
 * old in-chat compression implementation. Those markers lost their
 * summary fields on persist (serializeMessage never kept them), so
 * they are unrecoverable husks. Any message orphaned by the removal
 * is re-parented to the marker's parent.
 *
 * @param {Array} messages
 * @returns {{messages: Array, stripped: boolean}}
 */
function stripLegacySummaryMarkers(messages) {
  if (!Array.isArray(messages)) return { messages, stripped: false };

  const huskParentById = new Map();
  for (const msg of messages) {
    if (msg && msg.role === "context_summary") {
      huskParentById.set(msg.id, msg.parentId ?? null);
    }
  }
  if (huskParentById.size === 0) return { messages, stripped: false };

  const cleaned = messages
    .filter((msg) => msg && !huskParentById.has(msg.id))
    .map((msg) =>
      huskParentById.has(msg.parentId)
        ? { ...msg, parentId: huskParentById.get(msg.parentId) }
        : msg,
    );
  return { messages: cleaned, stripped: true };
}

export async function loadConversation(conversationId) {
  const data = await localforage.getItem(`conversation_${conversationId}`);
  if (!data) return null;

  // Strip legacy context_summary husks left by the old compressor.
  const { messages: strippedMessages, stripped } = stripLegacySummaryMarkers(
    data.messages,
  );

  // Migrate messages if they don't have branching metadata
  const needsMigration = strippedMessages?.length > 0 &&
    strippedMessages[0].parentId === undefined;

  if (needsMigration) {
    const migratedMessages = migrateMessages(strippedMessages);
    // Save the migrated data
    await localforage.setItem(`conversation_${conversationId}`, {
      ...data,
      messages: migratedMessages,
      branchPath: data.branchPath ?? [],
    });
    return {
      ...data,
      messages: migratedMessages,
      branchPath: data.branchPath ?? [],
    };
  }

  if (stripped) {
    await localforage.setItem(`conversation_${conversationId}`, {
      ...data,
      messages: strippedMessages,
    });
  }

  return {
    ...data,
    messages: strippedMessages,
    branchPath: data.branchPath ?? [],
  };
}
