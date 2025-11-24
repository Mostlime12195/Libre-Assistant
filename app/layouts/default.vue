<template>
  <div class="app-container">
    <Suspense>
      <AppSidebar :curr-convo="route.params.id" :messages="[]" :is-open="sidebarOpen"
        @close-sidebar="sidebarOpen = false" @toggle-sidebar="toggleSidebar"
        :is-dark="isDark" @delete-conversation="handleDeleteConversation"
        @new-conversation="handleNewConversation"
        @reload-settings="settingsManager.loadSettings" @open-settings="openSettingsPanel('general')" />
      <!-- Opens to General tab -->
    </Suspense>
    <ParameterConfigPanel :is-open="parameterConfigPanelOpen" :settings-manager="settingsManager"
      @close="parameterConfigPanelOpen = false" @save="handleParameterConfigSave" />
    <!--
      Restructured layout:
      - app-container: Main flex container with sidebar
      - main-container: Full width/height container for chat content
      - NuxtPage: Takes full width with internal max-width constraint (contains page-specific content)
    -->
    <div class="main-container"
      :class="{ 'sidebar-open': sidebarOpen, 'parameter-config-open': parameterConfigPanelOpen }">
      <TopBar :is-scrolled-top="isScrolledTop" :selected-model-name="selectedModelName"
        :selected-model-id="selectedModelId" :toggle-sidebar="toggleSidebar" :sidebar-open="sidebarOpen"
        :is-incognito="isIncognito" :show-incognito-button="!route.params.id && messages.length === 0" :messages="messages"
        :parameter-config-open="parameterConfigPanelOpen" @model-selected="handleModelSelect"
        @toggle-incognito="toggleIncognito"
        @toggle-parameter-config="parameterConfigPanelOpen = !parameterConfigPanelOpen" />

      <!-- Chat panel from the current page -->
      <slot />
    </div>
    <DialogRoot v-model:open="isSettingsOpen">
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 bg-black/25" />
        <div class="fixed inset-0 overflow-y-auto">
          <div class="flex min-h-full items-center justify-center p-4 text-center">
            <DialogContent
              class="w-full max-w-4xl transform overflow-hidden rounded-2xl bg-white p-6 text-left align-middle shadow-xl transition-all dark:bg-gray-800 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-top-[48%]">
              <SettingsPanel :is-open="isSettingsOpen" :initial-tab="settingsInitialTab"
                @close="isSettingsOpen = false; settingsInitialTab = 'general';"
                @reload-settings="settingsManager.loadSettings" />
            </DialogContent>
          </div>
        </div>
      </DialogPortal>
    </DialogRoot>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted, computed, watch, onBeforeUnmount } from 'vue';
import 'highlight.js/styles/github.css';
import 'highlight.js/styles/github-dark.css';
import { inject } from "@vercel/analytics"
import { injectSpeedInsights } from '@vercel/speed-insights';
import { useDark } from "@vueuse/core";
import { useHead } from '@unhead/vue';
import { DialogRoot, DialogContent, DialogPortal, DialogOverlay } from 'reka-ui';
import { useRoute, useRouter } from 'vue-router';

import { availableModels } from '~/composables/availableModels';
import { useSettings } from '~/composables/useSettings';
import { useGlobalScrollStatus } from '~/composables/useGlobalScrollStatus';
import { useGlobalIncognito } from '~/composables/useGlobalIncognito';

import AppSidebar from '~/components/AppSidebar.vue'
import SettingsPanel from '~/components/SettingsPanel.vue'
import ParameterConfigPanel from '~/components/ParameterConfigPanel.vue'
import TopBar from '~/components/TopBar.vue'

// Inject Vercel's analytics and performance insights
inject();
injectSpeedInsights();

const isDark = useDark();

// Use the shared settings instance
const settingsManager = useSettings();

// Use global scroll status
const { getIsScrolledTop } = useGlobalScrollStatus();

// Use global incognito state
const { isIncognito, toggleIncognito: globalToggleIncognito } = useGlobalIncognito();

const route = useRoute(); // Get current route
const router = useRouter();

const sidebarOpen = ref(false); // Set to false initially, will be updated in onMounted
const parameterConfigPanelOpen = ref(false);
const isSettingsOpen = ref(false);
const settingsInitialTab = ref('general'); // Controls which tab opens in settings panel

// Set up dynamic page title
const title = computed(() => {
  if (route.params.id) {
    return `${route.params.id} - Libre Assistant`;
  } else if (route.path === '/' || route.path === '/new') {
    return 'New Chat - Libre Assistant';
  } else {
    return 'Libre Assistant';
  }
});

useHead({
  title: title,
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    { name: 'description', content: 'An open-source AI assistant interface' }
  ]
});

// Make availableModels reactive
const models = ref(availableModels);

// Reactive state for TopBar functionality (placeholders since chat state is in pages)
const messages = ref([]); // Placeholder for messages
const isLoading = ref(false); // Placeholder for loading state
const controller = ref(new AbortController()); // Placeholder for controller
const currConvo = ref(route.params.id || ''); // Current conversation ID
const conversationTitle = ref(''); // Current conversation title
const isTyping = ref(false); // Typing state

// Use the global scroll status instead of local state
const isScrolledTop = computed(() => getIsScrolledTop.value); // Track if chat is scrolled to the top

onMounted(async () => {
  await settingsManager.loadSettings();
  // Set sidebar open state based on window width (only in browser)
  if (typeof window !== 'undefined') {
    sidebarOpen.value = window.innerWidth > 900;
  }
});

function toggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value;
  // On mobile, when closing the sidebar, we might want to ensure focus returns to the main content
  if (!sidebarOpen.value && typeof window !== 'undefined' && window.innerWidth < 900) {
    // Focus on main content area for accessibility
    nextTick(() => {
      const mainContent = document.querySelector('.content-wrapper');
      if (mainContent) {
        mainContent.focus();
      }
    });
  }
}

function openSettingsPanel(tabKey = 'general') {
  settingsInitialTab.value = tabKey;
  isSettingsOpen.value = true;
}

function handleParameterConfigSave(params) {
  console.log("Parameter config saved:", params);
  // The settings are already saved in the ParameterConfigPanel component
  // This function can be used for any additional actions needed after saving
}

function handleDeleteConversation(id) {
  // This will be handled in the page components, but we can emit an event
  console.log("Delete conversation:", id);
}

function handleNewConversation() {
  // This will be handled by navigating to the /new route
  router.push('/new');
  console.log("New conversation requested");
}

/**
 * Computed property to get the name of the currently selected model from settings.
 * This will be displayed in the TopBar.
 */
const selectedModelName = computed(() => {
  // Helper function to find a model by ID, including nested models in categories
  function findModelById(models, id) {
    for (const model of models) {
      if (model.id === id) {
        return model;
      }
      if (model.models && Array.isArray(model.models)) {
        const found = findModelById(model.models, id);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  // Find the model in our available models and return its name
  const selectedModel = findModelById(availableModels, settingsManager.settings.selected_model_id);
  return selectedModel ? selectedModel.name : 'Loading...';
});

/**
 * Computed property to get the ID of the currently selected model from settings.
 * This will be used to highlight the selected model in the TopBar.
 */
const selectedModelId = computed(() => {
  return settingsManager.settings.selected_model_id || "";
});

/**
 * Handles model selection from the TopBar component.
 * Updates the settings with the selected model.
 */
function handleModelSelect(modelId, modelName) {
  settingsManager.settings.selected_model_id = modelId;
  settingsManager.saveSettings();
}

/**
 * Toggles incognito mode
 */
function toggleIncognito() {
  globalToggleIncognito();
}

/**
 * Sends a message
 */
function sendMessage(message, originalMessage = null) {
  // This will be implemented based on actual needs
  console.log("Sending message:", message);
}
</script>

<style scoped>
.app-container {
  display: flex;
  padding: 0;
  height: 100dvh;
  max-width: 100vw;
  box-sizing: border-box;
  overflow: hidden;
  background: var(--bg);
  position: relative;
  transition: all 0.3s cubic-bezier(.4, 1, .6, 1);
}

/*
  .main-container fills the viewport height and available width.
  Uses flexbox to allow the chat panel to grow/shrink and keep the message form at the bottom.
*/
.main-container {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 0;
  height: 100dvh;
  position: relative;
  background: inherit;
  width: 100%;
  overflow: hidden;
  transition: all 0.3s cubic-bezier(.4, 1, .6, 1);
  z-index: 10;
}

/* Sidebar open shifts main content right by sidebar width (280px) */
@media (min-width: 900px) {
  .main-container.sidebar-open {
    margin-left: 280px;
  }

  .main-container.parameter-config-open {
    margin-right: 300px;
  }

  .main-container.sidebar-open.parameter-config-open {
    margin-left: 280px;
    margin-right: 300px;
  }
}

/* Top bar styling */

/* Update fade transition timing */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.12s ease-out;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* Other display size styles */

@media (max-width: 1024px) {
  .flag {
    display: none;
  }
}

@media (max-width: 768px) {
  #disclaimer {
    margin-top: -16px;
    font-size: smaller;
  }

  .app-container {
    padding: 0;
    /* Remove padding that was causing scrollbar */
  }

  header {
    padding-top: 0px;
  }

  /* Ensure proper sidebar behavior on mobile - use overlay instead of transform */
  .main-container {
    transition: none;
    /* Remove transitions that interfere with positioning */
    transform: none;
  }

  .main-container.sidebar-open,
  .main-container.parameter-config-open,
  .main-container.sidebar-open.parameter-config-open {
    transform: none;
    margin: 0;
  }
}

/* Mobile-specific styles - use overlay instead of transform for better positioning */
@media (max-width: 900px) {
  .main-container {
    transform: none;
    /* Remove transforms that interfere with fixed positioning */
    margin: 0;
    /* Reset any margin changes */
  }

  /* Use overlay positioning for mobile panels */
  .sidebar-open .main-container,
  .parameter-config-open .main-container {
    transform: none;
    margin: 0;
  }
}

.app-header {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 60px;
  z-index: 1001;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 16px;
  background: transparent;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>