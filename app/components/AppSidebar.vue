<script setup>
import { ref, onBeforeUnmount, onMounted } from "vue";
import localforage from "localforage";
import { Icon } from "@iconify/vue";
import { useRouter, useRoute } from 'vue-router';
import { emitter } from '~/composables/emitter';

const emit = defineEmits([
  "reloadSettings",
  "toggleDark",
  "closeSidebar",
  "openSettings",
]);
const props = defineProps(["currConvo", "messages", "isDark", "isOpen"]);

const router = useRouter();
const route = useRoute();

const metadata = ref([]);
const windowWidth = ref(
  typeof window !== "undefined" ? window.innerWidth : 1200,
);

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

async function updateConversations() {
  const stored = await localforage.getItem("conversations_metadata");
  metadata.value = stored || [];
}

updateConversations(); // Initial load

emitter.on("updateConversations", updateConversations);

onBeforeUnmount(() => {
  emitter.off("updateConversations", updateConversations);
});

function closeSidebar() {
  emit("closeSidebar");
}

function handleNewConversation() {
  // Navigate to the new conversation page
  router.push('/');
}


async function handleDeleteConversation(id) {
  // Delete from localforage
  try {
    await localforage.removeItem(`conversation_${id}`);

    // Remove from metadata
    const storedMetadata = await localforage.getItem("conversations_metadata");
    if (storedMetadata) {
      const updatedMetadata = storedMetadata.filter(conv => conv.id !== id);
      await localforage.setItem("conversations_metadata", updatedMetadata);

      // Update local ref
      metadata.value = updatedMetadata;

      // If we're currently on this conversation, navigate away
      if (route.params.id === id) {
        router.push('/');
      }
    }
  } catch (error) {
    console.error('Error deleting conversation:', error);
  }
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
      <div class="main-content">
        <div class="conversation-list" v-if="metadata.length">
          <div class="conversation-wrapper" v-for="data in [...metadata].reverse()" :key="data.id">
            <NuxtLink
              class="conversation-button"
              :to="`/${data.id}`"
              :class="{ active: data.id == route.params.id }"
            >
              {{ data.title }}
            </NuxtLink>
            <button class="delete-button no-hover" @click.stop="handleDeleteConversation(data.id)"
              aria-label="Delete chat">
              <Icon icon="material-symbols:delete" width="16" height="16" />
            </button>
          </div>
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

.main-content {
  flex: 1 1 0;
  overflow-y: auto;
  padding: 0 16px;
  margin-bottom: 12px;
}

.conversation-list {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  gap: 4px;
}

.conversation-wrapper {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.conversation-button {
  flex-grow: 1;
  text-align: left;
  background: none;
  color: var(--text-primary);
  border: none;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 0.95em;
  font-family: inherit;
  font-weight: 500;
  text-decoration: none;
  transition:
    background 0.18s,
    color 0.18s;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
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

.delete-button.no-hover {
  background: none;
  border: none;
  padding: 4px;
  opacity: 0.6;
  flex-shrink: 0;
}

.delete-button.no-hover:hover {
  opacity: 1;
}

.delete-button :deep(svg) {
  color: var(--danger);
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
