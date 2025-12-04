import localforage from "localforage";

// Define the key used for storing memory in localforage
const MEMORY_STORAGE_KEY = "global_chatbot_memory";

// Task description for Qwen embeddings instruction format
const EMBEDDING_TASK = "Retrieve memories relevant to the user's query";

/**
 * Generates an embedding for the given text using Hack Club AI's embeddings API.
 * Uses Qwen's instruction format for improved retrieval performance.
 * Includes conversation history for better contextual understanding (up to 10 recent messages).
 * @param {string} text - The text to generate embedding for
 * @param {Array<Object>} messageHistory - Recent conversation messages (optional)
 * @returns {Promise<Array<number>|null>} - The binary embedding vector (768 dims) or null on error
 */
async function generateEmbedding(text, messageHistory = []) {
  try {
    // Construct context from the last 10 messages (both user and assistant)
    let contextText = '';
    if (messageHistory && messageHistory.length > 0) {
      const recentMessages = messageHistory.slice(-10);
      contextText = recentMessages
        .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
        .join('\n');
      contextText += '\n\n';
    }

    // Format text with Qwen's instruction format
    const formattedInput = `Instruct: ${EMBEDDING_TASK}\nQuery: ${contextText}${text}`;

    const response = await fetch('/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: formattedInput })
    });

    if (!response.ok) {
      console.error('Embeddings API error:', response.status);
      return null;
    }

    const data = await response.json();
    return data.data?.[0]?.embedding || null;
  } catch (err) {
    console.error('Error generating embedding:', err);
    return null;
  }
}

/**
 * Calculates Hamming distance between two binary vectors.
 * Hamming distance is the number of positions at which the corresponding bits differ.
 * For binary embeddings, this is much faster than cosine similarity.
 * Returns normalized distance (0 = identical, 1 = completely different).
 * @param {Array<number>} a - First binary vector (0s and 1s)
 * @param {Array<number>} b - Second binary vector (0s and 1s)
 * @returns {number} - Normalized Hamming distance between 0 and 1
 */
function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 1; // Maximum distance if invalid

  let differences = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      differences++;
    }
  }

  // Normalize by vector length to get value between 0 and 1
  return differences / a.length;
}

/**
 * Converts Hamming distance to similarity score.
 * @param {number} distance - Hamming distance (0-1)
 * @returns {number} - Similarity score (0-1, where 1 = identical)
 */
function hammingToSimilarity(distance) {
  return 1 - distance;
}

/**
 * Lists the global memory from localforage.
 * @returns {Promise<Array>} - Array of memory facts
 */
export async function listMemory() {
  try {
    const stored_memory = await localforage.getItem(MEMORY_STORAGE_KEY);
    if (stored_memory) {
      const global_memory_array = JSON.parse(stored_memory);
      if (Array.isArray(global_memory_array)) {
        // Extract just the fact strings for backward compatibility
        return global_memory_array.map((item) =>
          typeof item === "string" ? item : item.fact
        );
      }
    }
  } catch (err) {
    console.error("Error loading global memory:", err);
  }
  return [];
}

/**
 * Adds a new fact to the global memory.
 * @param {string} fact - The fact to add
 * @param {boolean} isGlobal - Whether this is a global memory (always included)
 * @param {Array<Object>} messageHistory - Recent conversation messages for embedding context
 * @returns {Promise<void>}
 */
export async function addMemory(fact, isGlobal = false, messageHistory = []) {
  try {
    let global_memory_array = [];
    const stored_memory = await localforage.getItem(MEMORY_STORAGE_KEY);
    if (stored_memory) {
      global_memory_array = JSON.parse(stored_memory);
      if (!Array.isArray(global_memory_array)) {
        console.warn(
          "Stored memory is not an array. Initializing with empty memory."
        );
        global_memory_array = [];
      }
    }

    const trimmed_fact = fact.trim();
    if (trimmed_fact) {
      // Check if fact already exists (handle both old and new formats)
      const exists = global_memory_array.some((item) =>
        typeof item === "string"
          ? item === trimmed_fact
          : item.fact === trimmed_fact
      );

      if (!exists) {
        // Generate embedding only for local memories
        let embedding = null;
        if (!isGlobal) {
          embedding = await generateEmbedding(trimmed_fact, messageHistory);
          if (!embedding) {
            console.warn('Failed to generate embedding for memory, storing without embedding');
          }
        }

        // Add with timestamp, embedding, and global flag
        global_memory_array.push({
          fact: trimmed_fact,
          timestamp: new Date().toISOString(),
          embedding: embedding,
          global: isGlobal
        });

        await localforage.setItem(
          MEMORY_STORAGE_KEY,
          JSON.stringify(global_memory_array)
        );
        console.log(`Memory fact added (${isGlobal ? 'global' : 'local'}):`, trimmed_fact);
      } else {
        console.log("Memory fact already exists, skipping:", trimmed_fact);
      }
    }
  } catch (err) {
    console.error("Error adding to memory:", err);
    throw new Error("Error adding to memory: " + err);
  }
}

/**
 * Modifies an existing fact in the global memory.
 * @param {string} oldFact - The existing fact to modify
 * @param {string} newFact - The new fact to replace it with
 * @param {boolean} isGlobal - Whether this should be a global memory
 * @param {Array<Object>} messageHistory - Recent conversation messages for embedding context
 * @returns {Promise<void>}
 */
export async function modifyMemory(oldFact, newFact, isGlobal, messageHistory = []) {
  try {
    const stored_memory = await localforage.getItem(MEMORY_STORAGE_KEY);
    if (stored_memory) {
      let global_memory_array = JSON.parse(stored_memory);
      if (Array.isArray(global_memory_array)) {
        const trimmed_old = oldFact.trim();
        const trimmed_new = newFact.trim();

        if (trimmed_old && trimmed_new) {
          // Find and update the fact (handle both old and new formats)
          const index = global_memory_array.findIndex((item) =>
            typeof item === "string"
              ? item === trimmed_old
              : item.fact === trimmed_old
          );

          if (index !== -1) {
            const oldItem = global_memory_array[index];

            // Preserve global flag from old item if not specified
            const shouldBeGlobal = isGlobal !== undefined
              ? isGlobal
              : (typeof oldItem === 'object' && oldItem.global) || false;

            // Generate new embedding only for local memories
            let embedding = null;
            if (!shouldBeGlobal) {
              embedding = await generateEmbedding(trimmed_new, messageHistory);
              if (!embedding) {
                console.warn('Failed to generate embedding for modified memory');
              }
            }

            // Replace with new fact and update timestamp
            global_memory_array[index] = {
              fact: trimmed_new,
              timestamp: new Date().toISOString(),
              embedding: embedding,
              global: shouldBeGlobal
            };

            await localforage.setItem(
              MEMORY_STORAGE_KEY,
              JSON.stringify(global_memory_array)
            );
            console.log(`Memory fact modified: "${trimmed_old}" -> "${trimmed_new}"`);
          } else {
            console.warn(`Attempted to modify non-existent fact: "${trimmed_old}"`);
          }
        }
      }
    }
  } catch (err) {
    console.error("Error modifying memory fact:", err);
    throw new Error("Error modifying memory fact: " + err);
  }
}

/**
 * Deletes a specific memory fact from the global memory.
 * @param {string} fact - The fact to delete
 * @returns {Promise<void>}
 */
export async function deleteMemory(fact) {
  try {
    const stored_memory = await localforage.getItem(MEMORY_STORAGE_KEY);
    if (stored_memory) {
      let global_memory_array = JSON.parse(stored_memory);
      if (Array.isArray(global_memory_array)) {
        // Filter out the fact to delete (handle both old and new formats)
        global_memory_array = global_memory_array.filter((existing_fact) => {
          if (typeof existing_fact === "string") {
            return existing_fact !== fact;
          } else {
            return existing_fact.fact !== fact;
          }
        });

        // Save the updated memory array or remove if empty
        if (global_memory_array.length > 0) {
          await localforage.setItem(
            MEMORY_STORAGE_KEY,
            JSON.stringify(global_memory_array)
          );
        } else {
          await localforage.removeItem(MEMORY_STORAGE_KEY);
        }

        console.log("Memory fact deleted:", fact);
      }
    }
  } catch (err) {
    console.error("Error deleting memory fact:", err);
    throw new Error("Error deleting memory fact: " + err);
  }
}

/**
 * Clears all memory facts from the global memory.
 * @returns {Promise<void>}
 */
export async function clearAllMemory() {
  try {
    await localforage.removeItem(MEMORY_STORAGE_KEY);
    console.log("All memory cleared");
  } catch (err) {
    console.error("Error clearing all memory:", err);
    throw new Error("Error clearing all memory: " + err);
  }
}

/**
 * Finds memories relevant to the given query using semantic search with binary embeddings.
 * @param {string} query - The query to find relevant memories for
 * @param {number} similarityThreshold - Minimum similarity score (0-1) to include a memory
 * @param {Array<Object>} messageHistory - Recent conversation messages for context
 * @returns {Promise<Array<string>>} - Array of relevant memory facts
 */
export async function findRelevantMemories(query, similarityThreshold = 0.65, messageHistory = []) {
  try {
    const stored_memory = await localforage.getItem(MEMORY_STORAGE_KEY);
    if (!stored_memory) {
      return [];
    }

    let global_memory_array = JSON.parse(stored_memory);
    if (!Array.isArray(global_memory_array)) {
      return [];
    }

    const relevantFacts = [];

    // Separate global and local memories
    const globalMemories = [];
    const localMemories = [];

    for (const item of global_memory_array) {
      // Handle different formats for backward compatibility
      if (typeof item === "string") {
        // Old format - treat as local memory without embedding
        localMemories.push({ fact: item, embedding: null, global: false });
      } else if (item.global) {
        // Global memory - always include
        globalMemories.push(item.fact);
      } else {
        // Local memory - filter by relevance
        localMemories.push(item);
      }
    }

    // Add all global memories
    relevantFacts.push(...globalMemories);

    // If there are no local memories, return just global memories
    if (localMemories.length === 0) {
      return relevantFacts;
    }

    // Generate embedding for the query with message history for context
    const queryEmbedding = await generateEmbedding(query, messageHistory);

    if (!queryEmbedding) {
      // If we can't generate query embedding, fall back to returning all memories
      console.warn('Failed to generate query embedding, returning all memories');
      return await listMemory();
    }

    // Calculate similarity for local memories using Hamming distance
    for (const item of localMemories) {
      if (!item.embedding) {
        // Memory doesn't have embedding (old format or generation failed)
        // Include it to be safe
        relevantFacts.push(item.fact);
        continue;
      }

      const distance = hammingDistance(queryEmbedding, item.embedding);
      const similarity = hammingToSimilarity(distance);

      if (similarity >= similarityThreshold) {
        relevantFacts.push(item.fact);
      }
    }

    return relevantFacts;
  } catch (err) {
    console.error('Error finding relevant memories:', err);
    // Fall back to returning all memories on error
    return await listMemory();
  }
}

// Legacy function kept for backward compatibility - now deprecated
export async function updateMemory(message, context) {
  console.warn("updateMemory is deprecated. The memory system is now tool-based and managed by the AI model directly.");
}
