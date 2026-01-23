import localforage from "localforage";
import { emitter } from "~/composables/emitter";
import { migrateMessages } from "./branchManager";

export async function createConversation(plainMessages, lastUpdated) {
  const conversationId = crypto.randomUUID();

  // Ensure that the messages are in a format suitable for storage,
  // Without this, an error occurs.
  // Use JSON.parse(JSON.stringify()) to deep clone and remove Vue reactive proxies
  let rawMessages = plainMessages.map((msg) => ({
    id: msg.id, // Include all necessary properties
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp, // Date objects are fine here
    complete: msg.complete,
    // Branching metadata
    parentId: msg.parentId ?? null,
    branchIndex: msg.branchIndex ?? 0,
    // Add attachments for user messages (deep clone to remove reactive proxies)
    ...(msg.role === "user" && msg.attachments && msg.attachments.length > 0 && {
      attachments: JSON.parse(JSON.stringify(msg.attachments)),
    }),
    // Add reasoning properties for assistant messages
    ...(msg.role === "assistant" && {
      reasoning: msg.reasoning,
      reasoningStartTime: msg.reasoningStartTime,
      reasoningEndTime: msg.reasoningEndTime,
      reasoningDuration: msg.reasoningDuration,
      tool_calls: msg.tool_calls
        ? JSON.parse(JSON.stringify(msg.tool_calls))
        : [], // Ensure tool_calls are serializable
      // New timing properties
      apiCallTime: msg.apiCallTime,
      firstTokenTime: msg.firstTokenTime,
      completionTime: msg.completionTime,
      // Token counting
      tokenCount: msg.tokenCount,
      // Annotations for reuse
      annotations: msg.annotations ? JSON.parse(JSON.stringify(msg.annotations)) : null,
      // Timeline parts for interleaved rendering
      parts: msg.parts ? JSON.parse(JSON.stringify(msg.parts)) : null,
    }),
    // Add any other properties your message objects might have
  }));

  const title = "Untitled";  // Set as Untitled initially

  try {
    // Store full conversation immediately with Untitled title
    await localforage.setItem(`conversation_${conversationId}`, {
      title,
      lastUpdated,
      messages: rawMessages,
      branchPath: [], // Initialize with empty branch path (follow first branch at each fork)
    });

    // Store metadata separately (only ID, title, and timestamp)
    const metadata =
      (await localforage.getItem("conversations_metadata")) || [];
    metadata.push({ id: conversationId, title, lastUpdated });
    await localforage.setItem("conversations_metadata", metadata);

    emitter.emit("updateConversations");

    console.log("Conversation saved successfully with Untitled title!");

    // Now generate title in the background
    generateTitleInBackground(conversationId, plainMessages, lastUpdated);

    return conversationId;
  } catch (error) {
    console.error("Error creating conversation:", error);
  }
}

async function generateTitleInBackground(conversationId, plainMessages, lastUpdated) {
  const systemPrompt = `You are an AI with the task of shortening and summarising messages into a short title. You must summarise the given messages based on their content into at most a 40 character title. Each conversation is between a user and an AI chatbot. The messages provided to you are the first messages of the conversation. The title must be general enough to apply to what you think the conversation will be about. Only output the title, without any additional explainations or commentary.`;

  try {
    const response = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          ...plainMessages.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
        ],
        model: "google/gemini-2.5-flash",
        stream: false,
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
  // Attempt to get the existing conversation data.
  const data = await localforage.getItem(`conversation_${conversationId}`);
  if (!data) {
    console.warn(`No conversation found for id ${conversationId}.`);
    return;
  }

  // Use JSON.parse(JSON.stringify()) to deep clone and remove Vue reactive proxies
  let rawMessages = plainMessages.map((msg) => ({
    id: msg.id, // Include all necessary properties
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp, // Date objects are fine here
    complete: msg.complete,
    // Branching metadata
    parentId: msg.parentId ?? null,
    branchIndex: msg.branchIndex ?? 0,
    // Add attachments for user messages (deep clone to remove reactive proxies)
    ...(msg.role === "user" && msg.attachments && msg.attachments.length > 0 && {
      attachments: JSON.parse(JSON.stringify(msg.attachments)),
    }),
    // Add reasoning properties for assistant messages
    ...(msg.role === "assistant" && {
      reasoning: msg.reasoning,
      reasoningStartTime: msg.reasoningStartTime,
      reasoningEndTime: msg.reasoningEndTime,
      reasoningDuration: msg.reasoningDuration,
      tool_calls: msg.tool_calls
        ? JSON.parse(JSON.stringify(msg.tool_calls))
        : [], // Ensure tool_calls are serializable
      // New timing properties
      apiCallTime: msg.apiCallTime,
      firstTokenTime: msg.firstTokenTime,
      completionTime: msg.completionTime,
      // Token counting
      tokenCount: msg.tokenCount,
      // Annotations for reuse
      annotations: msg.annotations ? JSON.parse(JSON.stringify(msg.annotations)) : null,
      // Timeline parts for interleaved rendering
      parts: msg.parts ? JSON.parse(JSON.stringify(msg.parts)) : null,
    }),
    // Add any other properties your message objects might have
  }));

  const title = data.title || "Untitled";
  const branchPath = data.branchPath ?? []; // Preserve existing branch path

  // Store full conversation
  await localforage.setItem(`conversation_${conversationId}`, {
    title,
    lastUpdated,
    messages: rawMessages,
    branchPath,
  });

  // Optionally update metadata. If you want to replace existing metadata,
  // you can filter out the old entry before pushing the new one.
  const metadata = (await localforage.getItem("conversations_metadata")) || [];
  // Remove any existing entry with the same id:
  const updatedMetadata = metadata.filter((m) => m.id !== conversationId);
  updatedMetadata.push({ id: conversationId, title, lastUpdated });
  await localforage.setItem("conversations_metadata", updatedMetadata);

  console.log("Conversation saved successfully!");
}

export async function deleteConversation(conversationId) {
  // Remove full conversation data
  await localforage.removeItem(`conversation_${conversationId}`);

  // Update metadata by filtering out the deleted conversation.
  const metadata = (await localforage.getItem("conversations_metadata")) || [];
  const updatedMetadata = metadata.filter((m) => m.id !== conversationId);
  await localforage.setItem("conversations_metadata", updatedMetadata);

  // Emit an event so that the sidebar updates its list.
  emitter.emit("updateConversations");

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
export async function loadConversation(conversationId) {
  const data = await localforage.getItem(`conversation_${conversationId}`);
  if (!data) return null;

  // Migrate messages if they don't have branching metadata
  const needsMigration = data.messages?.length > 0 &&
    data.messages[0].parentId === undefined;

  if (needsMigration) {
    const migratedMessages = migrateMessages(data.messages);
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

  return {
    ...data,
    branchPath: data.branchPath ?? [],
  };
}
