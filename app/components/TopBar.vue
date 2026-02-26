<template>
  <div class="top-bar" :class="{ 'with-border': !isScrolledTopValue }" ref="topBarRef">
    <div class="top-bar-content">
      <button v-if="!sidebarOpen" class="sidebar-toggle" @click="toggleSidebar" aria-label="Toggle sidebar">
        <Icon icon="material-symbols:side-navigation" width="24" height="24" />
      </button>
      <button v-if="!sidebarOpen" class="new-chat-btn" @click="handleNewChat" aria-label="New chat">
        <Icon icon="material-symbols:add-box-outline" width="24" height="24" />
      </button>
      <div class="model-selector-container">
        <template v-if="!isMobile || maxMode">
          <DropdownMenuRoot>
            <DropdownMenuTrigger class="model-selector-btn"
              :aria-label="`Change model, currently ${maxMode ? 'Max Mode slots' : effectiveSelectedModelName}`">
              <div class="model-logo-name">
                <Logo v-if="selectedModelLogo" :src="selectedModelLogo" :size="24" class="logo-inline" :alt="effectiveSelectedModelName" />
                <span class="model-name-display">{{ maxMode ? '4 models' : effectiveSelectedModelName }}</span>
              </div>
              <Icon icon="material-symbols:keyboard-arrow-down-rounded" width="24" height="24" class="icon" />
            </DropdownMenuTrigger>

            <DropdownMenuContent class="model-selector-dropdown" side="bottom" align="start" :side-offset="8">
              <DropdownMenuLabel class="dropdown-label">{{ maxMode ? 'Pick a model for each slot' : 'Models' }}</DropdownMenuLabel>
              <DropdownMenuSeparator />

              <div class="dropdown-scroll-container" v-if="maxMode">
                <DropdownMenuSub v-for="slotIndex in 4" :key="slotIndex">
                  <DropdownMenuSubTrigger class="category-item">
                    <span>Slot {{ slotIndex }}: {{ slotModelName(slotIndex - 1) }}</span>
                    <Icon icon="material-symbols:chevron-right" width="24" height="24" class="icon" />
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent class="subcategory-content">
                    <template v-for="provider in maxModeModelsList" :key="provider.category">
                      <DropdownMenuItem
                        v-for="model in provider.models"
                        :key="model.id"
                        class="model-list-item"
                        :class="{ selected: (maxModeModels && maxModeModels[slotIndex - 1]) === model.id }"
                        @click="selectModel(model.id, slotIndex - 1)"
                      >
                        <div class="model-info">
                          <div class="model-text">
                            <strong>{{ model.name }}</strong>
                            <div class="model-description">{{ model.description }}</div>
                          </div>
                        </div>
                        <span v-if="(maxModeModels && maxModeModels[slotIndex - 1]) === model.id" class="selected-indicator">
                          <Icon icon="material-symbols:check-rounded" width="24" height="24" class="icon" />
                        </span>
                      </DropdownMenuItem>
                    </template>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </div>

              <div class="dropdown-scroll-container" v-else>
                <template v-for="item in modelsForDropdown" :key="item.id || item.category">
                  <DropdownMenuItem v-if="!item.category" class="model-list-item"
                    :class="{ selected: item.id === effectiveSelectedModelId }" @click="() => selectModel(item.id)">
                    <div class="model-info">
                      <Logo v-if="item.logo" :src="item.logo" :size="24" class="logo-inline" :alt="item.name" />
                      <div class="model-text">
                        <strong>{{ item.name }}</strong>
                        <div class="model-description">{{ item.description }}</div>
                      </div>
                    </div>
                    <span v-if="item.id === effectiveSelectedModelId">
                      <Icon icon="material-symbols:check-rounded" width="24" height="24" class="icon" />
                    </span>
                  </DropdownMenuItem>

                  <DropdownMenuSub v-else>
                    <DropdownMenuSubTrigger class="category-item">
                      <Logo :src="item.logo" :size="24" class="logo-inline" :alt="item.category" />
                      {{ item.category }}
                      <Icon icon="material-symbols:chevron-right" width="24" height="24" class="icon" />
                    </DropdownMenuSubTrigger>

                    <DropdownMenuSubContent class="subcategory-content">
                      <DropdownMenuItem v-for="model in item.models" :key="model.id" class="model-list-item"
                        :class="{ selected: model.id === effectiveSelectedModelId }" @click="() => selectModel(model.id)">
                        <div class="model-info">
                          <div class="model-text">
                            <strong>{{ model.name }}</strong>
                            <div class="model-description">{{ model.description }}</div>
                          </div>
                        </div>
                        <span v-if="model.id === effectiveSelectedModelId" class="selected-indicator">
                          <Icon icon="material-symbols:check-rounded" width="24" height="24" class="icon" />
                        </span>
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </template>
              </div>
            </DropdownMenuContent>
          </DropdownMenuRoot>
        </template>
      </div>


      <div v-if="(isIncognito && messages && messages.length > 0) || isIncognitoRoute" class="incognito-indicator">
        <Icon icon="mdi:incognito" width="20" height="20" />
        <span class="incognito-text">{{ isIncognitoRoute ? 'Incognito Mode' : 'Incognito mode' }}</span>
      </div>
      <div class="action-toggles">
        <button v-if="showIncognitoButton && !isIncognitoRoute" class="action-toggle incognito-toggle" :class="{ active: isIncognito }"
          @click="$emit('toggle-incognito')"
          :aria-label="isIncognito ? 'Disable incognito mode' : 'Enable incognito mode'">
          <Icon icon="mdi:incognito" width="20" height="20" />
        </button>
        <button v-if="!parameterConfigOpen" class="action-toggle parameter-config-toggle"
          @click="$emit('toggle-parameter-config')" aria-label="Model parameters">
          <Icon icon="material-symbols:tune" width="20" height="20" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "reka-ui";
import { availableModels, getMaxModeModelList } from "../composables/availableModels";
import { Icon } from "@iconify/vue";
import { useRoute, useRouter } from "vue-router";
import Logo from "./Logo.vue";
import { useWindowSize } from "@vueuse/core";

const props = defineProps({
  isScrolledTop: {
    type: [Boolean, Object],
    default: true
  },
  selectedModelName: {
    type: String,
    default: "Default Model",
  },
  selectedModelId: {
    type: String,
    default: "",
  },
  toggleSidebar: {
    type: Function,
    default: () => { }
  },
  sidebarOpen: {
    type: Boolean,
    default: false
  },
  isIncognito: {
    type: Boolean,
    default: false
  },
  showIncognitoButton: {
    type: Boolean,
    default: false
  },
  messages: {
    type: Array,
    default: () => []
  },
  parameterConfigOpen: {
    type: Boolean,
    default: false
  },
  maxMode: {
    type: Boolean,
    default: false
  },
  maxModeModels: {
    type: Array,
    default: () => []
  }
});

const emit = defineEmits(['model-selected', 'toggle-incognito', 'toggle-parameter-config', 'max-mode-change']);

// Get the current route
const route = useRoute();
const router = useRouter();

const handleNewChat = () => {
  router.push('/');
};

// Computed property to check if we're on the incognito route
const isIncognitoRoute = computed(() => route.path === '/incognito');

const effectiveSelectedModelId = computed(() => props.selectedModelId);
const effectiveSelectedModelName = computed(() => props.selectedModelName);
const modelsForDropdown = computed(() => availableModels);
const maxModeModelsList = computed(() => {
  return availableModels.map(item => {
    if (!item.category) return item;
    const filtered = (item.models || []).filter(m => m.maxModeSupported === true);
    return filtered.length ? { ...item, models: filtered } : null;
  }).filter(Boolean);
});

function selectModel(modelId, slotIndex) {
  const selectedModel = availableModels.flatMap(item =>
    item.category ? item.models : item
  ).find((model) => model.id === modelId);
  if (selectedModel) {
    emit('model-selected', modelId, selectedModel.name, slotIndex);
  }
}

function slotModelName(slotIndex) {
  const id = props.maxModeModels && props.maxModeModels[slotIndex];
  if (!id) return 'Select';
  const m = availableModels.flatMap(item => item.models || [item]).find(x => x.id === id);
  return m?.name || id;
}
const topBarRef = ref(null);

// Handle both direct boolean values and refs
const isScrolledTopValue = computed(() => {
  return typeof props.isScrolledTop === 'boolean'
    ? props.isScrolledTop
    : props.isScrolledTop.value;
});

// Get window size
const { width: windowWidth } = useWindowSize();

// Computed property to check if we're on a mobile screen
const isMobile = computed(() => {
  return windowWidth.value < 600;
});

// Computed property to get the logo of the currently selected model
const selectedModelLogo = computed(() => {
  const id = effectiveSelectedModelId.value;
  if (!id) return null;
  for (const item of availableModels) {
    if (item.category) {
      const modelInCategory = item.models.find(model => model.id === id);
      if (modelInCategory) return item.logo;
    } else if (item.id === id) {
      return item.logo;
    }
  }
  return null;
});

// Function to ensure top bar visibility
function ensureTopBarVisibility() {
  if (topBarRef.value) {
    // Force the element to be visible
    topBarRef.value.style.display = 'block';

    // Ensure it's at the top
    topBarRef.value.style.position = 'relative';
    topBarRef.value.style.zIndex = '100';
  }
}



onMounted(() => {
  console.log('TopBar mounted');

  // Ensure the top bar is visible and properly positioned
  // Use nextTick and requestAnimationFrame to ensure DOM is fully updated
  nextTick(() => {
    requestAnimationFrame(() => {
      ensureTopBarVisibility();
    });
  });
});

// Watch for any changes that might affect the top bar
watch(() => [props.sidebarOpen, props.isIncognito], () => {
  // Ensure visibility after any prop changes
  ensureTopBarVisibility();
});

</script>

<style scoped>
/* Icon styling to ensure proper color inheritance */
.sidebar-toggle :deep(svg) {
  color: var(--text-primary);
}

.new-chat-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  margin: 0;
  transition: background 0.18s;
  color: var(--text-primary);
}

.new-chat-btn:hover {
  background: var(--btn-hover);
}

.model-selector-btn :deep(svg) {
  color: var(--text-primary);
}

.model-list-item :deep(svg) {
  color: var(--text-primary);
}

.category-item :deep(svg) {
  color: var(--text-primary);
}

/* Logo styling to ensure proper display */
.logo-inline {
  width: 24px;
  height: 24px;
  margin-right: 8px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.model-logo-name {
  display: flex;
  align-items: center;
  gap: 8px;
}

.model-text {
  display: flex;
  flex-direction: column;
}

/* Style for the category item to include logo */
.category-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Mobile selector button styling */
.mobile-selector {
  background: none;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--text-primary);
  font-size: inherit;
  min-width: 200px;
}

.mobile-selector:hover {
  background: var(--btn-hover);
}

.top-bar {
  position: sticky;
  top: 0;
  height: 60px;
  background-color: var(--bg);
  width: 100%;
  z-index: 100;
  flex-shrink: 0;
  border-bottom: 1px solid transparent;
  transition: border-bottom 0.2s ease;
}

.top-bar.with-border {
  border-bottom: 1px solid var(--border);
}

.top-bar-content {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  height: 100%;
  padding: 0 16px;
  gap: 12px;
}

.incognito-indicator {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  font-size: 1.1rem;
  color: var(--text-secondary);
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 8px;
}

.incognito-text {
  font-weight: 600;
}

.action-toggles {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.action-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  /* Make it spherical */
  background: none;

  cursor: pointer;
  padding: 0;
  margin: 0;
  transition: background 0.18s;
  color: var(--text-primary);
}

.action-toggle:hover {
  background: var(--btn-hover);
}

/* Add active state styling for when toggles are enabled */
.action-toggle:active:not(.parameter-config-toggle),
.action-toggle.active:not(.parameter-config-toggle) {
  background-color: var(--primary);
  /* Use primary color when enabled */
  color: var(--primary-foreground);
  /* Ensure icon is visible on primary color */
}
</style>