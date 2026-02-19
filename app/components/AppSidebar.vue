<script setup>
import { ref, onBeforeUnmount, onMounted, nextTick } from "vue";
import { Icon } from "@iconify/vue";
import { useRouter, useRoute } from "vue-router";
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "reka-ui";
import { useConversationsList } from "~/composables/useConversationsList";

const emit = defineEmits([
  "reloadSettings",
  "toggleDark",
  "closeSidebar",
  "openSettings",
]);
const props = defineProps(["currConvo", "messages", "isDark", "isOpen"]);

const router = useRouter();
const route = useRoute();

// Use the conversations list composable
const {
  metadata,
  searchQuery,
  renamingId,
  newTitle,
  groupedConversations,
  isSearching,
  togglePin,
  handleDelete,
  startRename,
  cancelRename,
  saveRename,
  handleRenameKeydown,
  clearSearch,
} = useConversationsList();

const windowWidth = ref(
  typeof window !== "undefined" ? window.innerWidth : 1200,
);

// Collapsible pinned section state
const isPinnedExpanded = ref(true);

function togglePinnedExpanded() {
  isPinnedExpanded.value = !isPinnedExpanded.value;
}

function handleResize() {
  windowWidth.value = window.innerWidth;
}

onMounted(() => {
  window.addEventListener("resize", handleResize);
  handleResize();
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", handleResize);
});

function closeSidebar() {
  emit("closeSidebar");
}

function handleNewConversation() {
  router.push("/");
}
</script>

<template>
  <div>
    <div :class="['sidebar-overlay', { active: props.isOpen }]" @click="closeSidebar"></div>
    <div :class="['sidebar', { active: props.isOpen }]">
      <div class="sidebar-header">
        <button class="close-button" aria-label="Close sidebar" @click="closeSidebar">
          <Icon icon="material-symbols:side-navigation" width="24" height="24" />
        </button>
        <span class="sidebar-title">Chats</span>
        <button class="settings-button" aria-label="Open settings" @click="$emit('openSettings')">
          <Icon icon="material-symbols:settings" width="24" height="24" />
        </button>
      </div>
      <button id="new-chat-button" class="new-chat-btn" @click="handleNewConversation">
        <span>New Chat</span>
      </button>
      
      <!-- Search Input -->
      <div class="search-container">
        <Icon icon="material-symbols:search" class="search-icon" width="18" height="18" />
        <input
          v-model="searchQuery"
          type="text"
          class="search-input"
          placeholder="Search conversations..."
        />
        <button
          v-if="searchQuery"
          class="search-clear"
          @click="clearSearch"
          aria-label="Clear search"
        >
          <Icon icon="material-symbols:close" width="16" height="16" />
        </button>
      </div>
      
      <div class="main-content">
        <!-- Empty state when no conversations -->
        <div v-if="!metadata.length" class="empty-state">
          <Icon icon="material-symbols:chat-bubble-outline" width="48" height="48" />
          <p>No conversations yet</p>
          <p class="empty-hint">Start a new chat to begin</p>
        </div>
        
        <!-- Empty search results -->
        <div v-else-if="isSearching && !groupedConversations.length" class="empty-state">
          <Icon icon="material-symbols:search" width="48" height="48" />
          <p>No results found</p>
          <p class="empty-hint">Try a different search term</p>
        </div>
        
        <!-- Grouped conversation list -->
        <div v-else class="conversation-list">
          <template v-for="(group, index) in groupedConversations" :key="group.key">
            <!-- Group Header -->
            <div class="group-header">
              <span class="group-label">
                <Icon
                  v-if="group.key === 'pinned'"
                  icon="boxicons:pin-alt-filled"
                  width="14"
                  height="14"
                  class="header-pin-icon"
                />
                {{ group.label }}
              </span>
              <button
                v-if="group.key === 'pinned'"
                class="collapse-btn"
                @click="togglePinnedExpanded"
                aria-label="Toggle pinned section"
              >
                <Icon
                  :icon="isPinnedExpanded ? 'material-symbols:keyboard-arrow-up' : 'material-symbols:keyboard-arrow-down'"
                  width="24"
                  height="24"
                />
              </button>
            </div>
            
            <!-- Conversations in this group -->
            <template v-if="group.key !== 'pinned' || isPinnedExpanded">
              <div
                v-for="data in group.conversations"
                :key="data.id"
                class="conversation-wrapper"
              >
                <!-- Rename input (shown when renaming) -->
                <input
                  v-if="renamingId === data.id"
                  v-model="newTitle"
                  class="rename-input"
                  @keydown="handleRenameKeydown($event, data.id)"
                  @blur="saveRename(data.id)"
                  ref="renameInput"
                  autofocus
                />
                
                <!-- Normal conversation button (shown when not renaming) -->
                <NuxtLink
                  v-else
                  class="conversation-button"
                  :to="`/${data.id}`"
                  :class="{ active: data.id == route.params.id }"
                >
                  <span class="conversation-title">{{ data.title }}</span>
                </NuxtLink>
                
                <!-- Dropdown Menu -->
                <DropdownMenuRoot v-if="renamingId !== data.id">
                  <DropdownMenuTrigger class="menu-trigger" @click.stop aria-label="More options">
                    <Icon icon="material-symbols:more-horiz" width="18" height="18" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent class="conversation-menu-dropdown" side="bottom" align="start" :side-offset="4">
                    <DropdownMenuItem class="conversation-menu-item" @select="togglePin(data.id)">
                      <Icon
                        :icon="data.pinned ? 'material-symbols:keep-off-outline' : 'material-symbols:keep-outline'"
                        width="16"
                        height="16"
                      />
                      <span>{{ data.pinned ? 'Unpin' : 'Pin' }}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem class="conversation-menu-item" @select="startRename(data.id, data.title)">
                      <Icon icon="material-symbols:edit-outline" width="16" height="16" />
                      <span>Rename</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem class="conversation-menu-item delete-item" @select="handleDelete(data.id)">
                      <Icon icon="material-symbols:delete" width="16" height="16" />
                      <span>Delete</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenuRoot>
              </div>
            </template>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sidebar {
  position: fixed;
  left: 0;
  top: 0;
  height: 100dvh;
  width: 280px;
  max-width: 90vw;
  z-index: 1001;
  background: var(--bg-sidebar);
  color: var(--text-primary);
  border-right: 1px solid var(--border);
  transform: translateX(-100%);
  transition: transform 0.3s cubic-bezier(.4, 1, .6, 1);
  display: flex;
  flex-direction: column;
}

.sidebar.active {
  transform: translateX(0);
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 60px;
  color: var(--text-primary);
  padding: 0 8px;
  position: relative;
  flex-shrink: 0;
}

.sidebar-title {
  font-family: "Inter", sans-serif;
  font-size: 1.1em;
  font-weight: 600;
  color: inherit;
}

#new-chat-button {
  margin: 16px 16px 12px 16px;
  width: calc(100% - 32px);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
  border-radius: 8px;
  height: 36px;
  padding: 0;
  font-size: 1em;
  font-weight: 600;
  transition:
    background 0.18s,
    box-shadow 0.18s,
    transform 0.15s;
  flex-shrink: 0;
}

#new-chat-button:hover {
  background: var(--primary-600);
  transform: scale(1.03);
}

/* Search Container */
.search-container {
  margin: 0 16px 12px 16px;
  position: relative;
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.search-icon {
  position: absolute;
  left: 10px;
  color: var(--text-secondary);
  pointer-events: none;
}

.search-input {
  width: 100%;
  height: 36px;
  padding: 0 32px 0 36px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.9em;
  font-family: inherit;
  transition: border-color 0.18s, box-shadow 0.18s;
}

.search-input::placeholder {
  color: var(--text-secondary);
}

.search-input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-a2, rgba(192, 74, 44, 0.2));
}

.search-clear {
  position: absolute;
  right: 6px;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-secondary);
  transition: background 0.15s, color 0.15s;
}

.search-clear:hover {
  background: var(--btn-hover);
  color: var(--text-primary);
}

.main-content {
  flex: 1 1 0;
  overflow-y: auto;
  padding: 0 16px;
  margin-bottom: 12px;
}

/* Empty State */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 16px;
  color: var(--text-secondary);
  text-align: center;
}

.empty-state p {
  margin: 8px 0 0 0;
  font-size: 0.95em;
}

.empty-state .empty-hint {
  font-size: 0.85em;
  color: var(--text-tertiary);
  margin-top: 4px;
}

/* Conversation List */
.conversation-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* Group Header */
.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 2px 8px;
  margin-top: 8px;
}

.group-header:first-child {
  margin-top: 0;
}

.group-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.7em;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  user-select: none;
}

.header-pin-icon {
  color: var(--text-muted);
}

.collapse-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 6px;
  padding: 4px;
  width: 28px;
  height: 28px;
  margin-right: -6px;
  cursor: pointer;
  color: var(--text-muted);
  transition: background 0.15s, color 0.15s;
}

.collapse-btn:hover {
  background: var(--btn-hover);
  color: var(--text-primary);
}

.conversation-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.conversation-button {
  flex-grow: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  text-align: left;
  background: none;
  color: var(--text-primary);
  border: none;
  border-radius: 6px;
  padding: 4px 8px;
  padding-right: 40px;
  font-size: 0.95em;
  font-family: inherit;
  font-weight: 500;
  text-decoration: none;
  transition:
    background 0.18s,
    color 0.18s;
  min-width: 0;
  width: 100%;
}

.conversation-title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pin-icon {
  flex-shrink: 0;
  color: var(--primary);
}

.conversation-button:hover {
  background: var(--btn-hover-2);
  color: var(--primary);
}

.conversation-button.active {
  background: var(--btn-hover-2);
  color: var(--primary);
  font-weight: 700;
}

.dark .conversation-button {
  color: var(--text-secondary);
}

/* Rename input */
.rename-input {
  flex-grow: 1;
  background: var(--bg-input);
  color: var(--text-primary);
  border: 1px solid var(--primary);
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 0.95em;
  font-family: inherit;
  font-weight: 500;
  outline: none;
  width: 100%;
}

.rename-input:focus {
  box-shadow: 0 0 0 2px var(--primary-a2, rgba(192, 74, 44, 0.2));
}

/* Menu trigger button (3-dot) */
.menu-trigger {
  position: absolute;
  right: 0;
  top: 0;
  height: 100%;
  aspect-ratio: 1;
  background: transparent;
  border: none;
  padding: 0;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
  flex-shrink: 0;
  color: var(--text-primary);
  z-index: 1;
}

.conversation-wrapper:hover .menu-trigger,
.conversation-button.active + .menu-trigger,
.conversation-wrapper:has(.conversation-button.active) .menu-trigger {
  opacity: 0.6;
}

.menu-trigger:hover {
  opacity: 1 !important;
  background: var(--btn-hover-2);
}

.conversation-wrapper:has(.conversation-button.active) .menu-trigger:hover {
  background: transparent;
}

.menu-trigger[data-state="open"] {
  opacity: 1 !important;
  background: var(--btn-hover);
}

.sidebar-overlay {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.4);
  opacity: 0;
  z-index: 1000;
  transition: opacity 0.3s cubic-bezier(.4, 1, .6, 1);
  will-change: opacity;
  pointer-events: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.sidebar-overlay.active {
  opacity: 1;
  pointer-events: auto;
}

.settings-button {
  border-radius: 8px;
  height: 36px;
  width: 36px;
  transition: background 0.18s;
  flex-shrink: 0;
  padding: 0;
  background: none;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.settings-button:hover {
  background: var(--btn-hover);
}

.close-button {
  border-radius: 8px;
  height: 36px;
  width: 36px;
  background: none;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin: 0;
  transition: background 0.18s;
  flex-shrink: 0;
}

.close-button:hover {
  background: var(--btn-hover);
}

@media (min-width: 950px) {
  .sidebar {
    position: fixed;
  }

  .sidebar-overlay {
    display: none;
  }
}

@media (max-width: 949px) {
  .sidebar {
    position: fixed;
    width: 80vw;
    max-width: 340px;
    box-shadow: 4px 0 24px #0002;
  }

  .dark .sidebar {
    box-shadow: 4px 0 24px #0004;
  }
}

@media (max-width: 600px) {
  .conversation-button {
    font-size: 0.9em;
  }
}
</style>