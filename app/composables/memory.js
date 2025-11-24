import localforage from "localforage";

// Define the key used for storing memory in localforage
const MEMORY_STORAGE_KEY = "global_chatbot_memory";

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
 * @returns {Promise<void>}
 */
export async function addMemory(fact) {
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
        // Add with timestamp
        global_memory_array.push({
          fact: trimmed_fact,
          timestamp: new Date().toISOString(),
        });

        await localforage.setItem(
          MEMORY_STORAGE_KEY,
          JSON.stringify(global_memory_array)
        );
        console.log("Memory fact added:", trimmed_fact);
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
 * @returns {Promise<void>}
 */
export async function modifyMemory(oldFact, newFact) {
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
            // Replace with new fact and update timestamp
            global_memory_array[index] = {
              fact: trimmed_new,
              timestamp: new Date().toISOString(),
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

// Legacy function kept for backward compatibility - now deprecated
export async function updateMemory(message, context) {
  console.warn("updateMemory is deprecated. The memory system is now tool-based and managed by the AI model directly.");
}
