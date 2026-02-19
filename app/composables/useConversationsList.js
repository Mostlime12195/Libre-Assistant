import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import localforage from "localforage";
import { emitter } from "./emitter";
import { deleteConversation as deleteConv } from "./storeConversations";

/**
 * Groups conversations by time periods
 * @param {Date} lastUpdated - The conversation's last updated date
 * @returns {string} Group key
 */
function getTimeGroup(lastUpdated) {
  if (!lastUpdated) return "older";

  const now = new Date();
  const date = new Date(lastUpdated);
  const diffMs = now - date;
  const diffHours = diffMs / (1000 * 60 * 60);
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (diffHours < 24) {
    return "today";
  } else if (diffHours < 48) {
    return "yesterday";
  } else if (diffDays < 7) {
    return "thisWeek";
  } else if (diffDays < 30) {
    return "thisMonth";
  }
  return "older";
}

/**
 * Gets display label for a time group
 * @param {string} groupKey - The group key
 * @returns {string} Human-readable label
 */
function getGroupLabel(groupKey) {
  const labels = {
    pinned: "Pinned",
    today: "Today",
    yesterday: "Yesterday",
    thisWeek: "This Week",
    thisMonth: "This Month",
    older: "Older"
  };
  return labels[groupKey] || groupKey;
}

/**
 * Gets order priority for groups (lower = higher priority)
 * @param {string} groupKey - The group key
 * @returns {number} Priority order
 */
function getGroupOrder(groupKey) {
  const order = {
    pinned: 0,
    today: 1,
    yesterday: 2,
    thisWeek: 3,
    thisMonth: 4,
    older: 5
  };
  return order[groupKey] ?? 99;
}

/**
 * Composable for managing conversations list with grouping, search, and pinning
 * @returns {Object} Conversations list state and methods
 */
export function useConversationsList() {
  const metadata = ref([]);
  const searchQuery = ref("");
  const renamingId = ref(null);
  const newTitle = ref("");

  // Load conversations from storage
  async function updateConversations() {
    const stored = await localforage.getItem("conversations_metadata");
    metadata.value = stored || [];
  }

  // Initial load
  updateConversations();

  // Listen for updates from other parts of the app
  emitter.on("updateConversations", updateConversations);

  onBeforeUnmount(() => {
    emitter.off("updateConversations", updateConversations);
  });

  // Computed: Filter conversations by search query
  const filteredConversations = computed(() => {
    if (!searchQuery.value.trim()) {
      return metadata.value;
    }
    const query = searchQuery.value.toLowerCase().trim();
    return metadata.value.filter(conv =>
      conv.title?.toLowerCase().includes(query)
    );
  });

  // Computed: Group conversations by time and pinned status
  const groupedConversations = computed(() => {
    const groups = {};

    // Sort by lastUpdated (most recent first)
    const sorted = [...filteredConversations.value].sort((a, b) => {
      const dateA = a.lastUpdated ? new Date(a.lastUpdated) : new Date(0);
      const dateB = b.lastUpdated ? new Date(b.lastUpdated) : new Date(0);
      return dateB - dateA;
    });

    // Group conversations
    for (const conv of sorted) {
      let groupKey;
      if (conv.pinned) {
        groupKey = "pinned";
      } else {
        groupKey = getTimeGroup(conv.lastUpdated);
      }

      if (!groups[groupKey]) {
        groups[groupKey] = [];
      }
      groups[groupKey].push(conv);
    }

    // Sort groups by priority
    const sortedGroups = Object.entries(groups)
      .sort(([keyA], [keyB]) => getGroupOrder(keyA) - getGroupOrder(keyB))
      .map(([key, conversations]) => ({
        key,
        label: getGroupLabel(key),
        conversations
      }));

    return sortedGroups;
  });

  // Check if search is active
  const isSearching = computed(() => searchQuery.value.trim().length > 0);

  // Toggle pin status
  async function togglePin(id) {
    try {
      const storedMetadata = await localforage.getItem("conversations_metadata");
      if (storedMetadata) {
        const updatedMetadata = storedMetadata.map(conv =>
          conv.id === id ? { ...conv, pinned: !conv.pinned } : conv
        );
        await localforage.setItem("conversations_metadata", updatedMetadata);
        metadata.value = updatedMetadata;
        emitter.emit("updateConversations");
      }
    } catch (error) {
      console.error("Error toggling pin:", error);
    }
  }

  // Delete conversation
  async function handleDelete(id) {
    try {
      await deleteConv(id);
      await updateConversations();
    } catch (error) {
      console.error("Error deleting conversation:", error);
    }
  }

  // Rename functions
  function startRename(id, currentTitle) {
    renamingId.value = id;
    newTitle.value = currentTitle;
  }

  function cancelRename() {
    renamingId.value = null;
    newTitle.value = "";
  }

  async function saveRename(id) {
    if (!newTitle.value.trim()) {
      cancelRename();
      return;
    }

    try {
      const storedMetadata = await localforage.getItem("conversations_metadata");
      if (storedMetadata) {
        const updatedMetadata = storedMetadata.map(conv =>
          conv.id === id ? { ...conv, title: newTitle.value.trim() } : conv
        );
        await localforage.setItem("conversations_metadata", updatedMetadata);
        metadata.value = updatedMetadata;
        emitter.emit("updateConversations");
        emitter.emit("conversationTitleUpdated", { conversationId: id, title: newTitle.value.trim() });
      }
    } catch (error) {
      console.error("Error renaming conversation:", error);
    }

    cancelRename();
  }

  function handleRenameKeydown(event, id) {
    if (event.key === "Enter") {
      saveRename(id);
    } else if (event.key === "Escape") {
      cancelRename();
    }
  }

  // Clear search
  function clearSearch() {
    searchQuery.value = "";
  }

  return {
    // State
    metadata,
    searchQuery,
    renamingId,
    newTitle,

    // Computed
    groupedConversations,
    filteredConversations,
    isSearching,

    // Methods
    updateConversations,
    togglePin,
    handleDelete,
    startRename,
    cancelRename,
    saveRename,
    handleRenameKeydown,
    clearSearch
  };
}