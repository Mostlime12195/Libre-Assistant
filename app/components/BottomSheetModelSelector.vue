<template>
  <Motion
    v-if="isOpen"
    :initial="{ opacity: 0 }"
    :animate="{ opacity: 0.5 }"
    :exit="{ opacity: 0 }"
    :transition="{ duration: 0.3, ease: 'easeOut' }"
    class="backdrop"
    @click="closeSheet"
  ></Motion>

  <Motion
    v-if="isOpen"
    :initial="{ y: '100%' }"
    :animate="isClosing ? { y: '100%' } : { y: '0%' }"
    :exit="{ y: '100%' }"
    :transition="{ type: 'tween', duration: 0.3, ease: 'easeOut' }"
    :on-animation-complete="onAnimationComplete"
    class="bottom-sheet-container"
    @click.stop
  >

    <!-- Sheet header and content with sliding effect -->
    <div class="content-wrapper">
      <!-- Sheet header -->
      <div class="sheet-header">
        <div class="nav-content">
          <div class="nav-side">
            <button v-if="currentView === 'models'" class="nav-button" @click="goBackToProviders" aria-label="Go back">
              <Icon icon="material-symbols:arrow-back-ios-new" width="20" height="20" />
            </button>
            <div v-else class="nav-placeholder"></div>
          </div>
          <h2 class="header-text">
            <template v-if="currentView === 'models'">
              <Logo :src="selectedProvider?.logo" :size="16" class="provider-logo-header" :alt="selectedProvider?.category" />
              {{ selectedProvider?.category }}
            </template>
            <template v-else>
              Select Model
            </template>
          </h2>
          <div class="nav-side">
            <!-- Right side placeholder for alignment -->
          </div>
        </div>
      </div>

      <!-- Content container -->
      <div class="content-container">
        <!-- Providers page -->
        <Motion
          :initial="firstOpen && currentView === 'providers' ? { x: 0 } : (currentView === 'providers' ? { x: 0 } : { x: '-100%' })"
          :animate="currentView === 'providers' ? { x: 0 } : { x: '-100%' }"
          :transition="{ type: 'tween', duration: 0.3, ease: 'easeOut' }"
          class="providers-page"
        >
          <div v-if="providers.length === 0" class="no-providers">
            No providers found
          </div>
          <div
            v-for="provider in providers"
            :key="provider.category"
            class="provider-item"
            @click="selectProvider(provider)"
          >
            <Logo v-if="provider.logo" :src="provider.logo" :size="24" class="provider-logo" :alt="provider.category" />
            <span class="provider-name">{{ provider.category }}</span>
            <Icon icon="material-symbols:chevron-right" width="20" height="20" class="chevron-icon" />
          </div>
        </Motion>

        <!-- Models page -->
        <Motion
          :initial="firstOpen && currentView === 'models' ? { x: 0 } : (currentView === 'models' ? { x: 0 } : { x: '100%' })"
          :animate="currentView === 'models' ? { x: 0 } : { x: '100%' }"
          :transition="{ type: 'tween', duration: 0.3, ease: 'easeOut' }"
          class="models-page"
        >
          <div
            v-for="model in selectedProvider?.models"
            :key="model.id"
            class="model-item"
            :class="{ selected: model.id === selectedModelId }"
            @click="selectModel(model.id, model.name)"
          >
            <div class="model-info">
              <span class="model-name">{{ model.name }}</span>
              <span v-if="model.description" class="model-description">{{ model.description }}</span>
            </div>

            <div v-if="model.id === selectedModelId" class="selected-indicator">
              <Icon icon="material-symbols:check" width="24" height="20" />
            </div>
          </div>
        </Motion>
      </div>
    </div> <!-- Close content-wrapper div -->
  </Motion> <!-- Close main sheet container Motion -->
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue';
import { Motion } from 'motion-v';
import { Icon } from '@iconify/vue';
import { availableModels } from '../composables/availableModels';
import Logo from './Logo.vue';

const props = defineProps({
  isOpen: {
    type: Boolean,
    default: false
  },
  selectedModelId: {
    type: String,
    default: ''
  },
  selectedModelName: {
    type: String,
    default: ''
  }
});

const emit = defineEmits(['close', 'model-selected']);

const isClosing = ref(false);

// Navigation state
const currentView = ref('providers'); // 'providers' or 'models'
const selectedProvider = ref(null);
// State for tracking if this is the first time opening (not just initial render)
let firstOpen = true;

// Computed providers (only categories, not standalone models)
const providers = computed(() => {
  return availableModels.filter(item => item?.category);
});

// Watch for changes in isOpen to reset the state when opening
watch(() => props.isOpen, (newIsOpen) => {
  if (newIsOpen) {
    // Reset states when opening
    currentView.value = 'providers';
    selectedProvider.value = null;
    isClosing.value = false;
    // When sheet opens, we're not in first open anymore
    firstOpen = false;
  } else {
    // When closing, reset firstOpen for the next time it opens
    firstOpen = true;
  }
});

const selectModel = (modelId, modelName) => {
  emit('model-selected', modelId, modelName);
  emit('close');
};

const selectProvider = (provider) => {
  selectedProvider.value = provider;
  currentView.value = 'models';
};

const goBackToProviders = () => {
  currentView.value = 'providers';
  // Reset the selected provider when going back
  selectedProvider.value = null;
};

// Function to update dragY with animation when closing
const animateToClose = () => {
  // Update the initial state to animate to closed position
  isClosing.value = true;
  // The Motion component will handle the animation to y: '100%'
  emit('close');
};

// Function to animate closing when backdrop is clicked
const closeSheet = () => {
  isClosing.value = true;
};

// Handle animation completion
const onAnimationComplete = () => {
  if (isClosing.value) {
    // Only emit close after animation is complete
    emit('close');
  }
};
</script>

<style scoped>
.backdrop {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 1); /* Will be animated by Motion */
  z-index: 9998;
}

.bottom-sheet-container {
  position: fixed;
  bottom: 0;
  left: 0;
  background: var(--surface);
  border-top-left-radius: 36px;
  border-top-right-radius: 36px;
  width: 100%;
  max-height: 90vh;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.bottom-sheet {
  width: 100%;
  max-height: 60vh;
  border-top-left-radius: 20px;
  border-top-right-radius: 20px;
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--text-primary);
  box-sizing: border-box;
  user-select: none; /* Disable text selection during drag */
  height: 60vh; /* Explicitly set height instead of relying on content */
}

.content-wrapper {
  display: flex;
  flex-direction: column;
  flex-grow: 1;
  overflow: hidden;
  width: 100%;
  height: 100%;
  /* Ensure the wrapper can properly handle the slide animation */
}

.content-container {
  display: flex;
  flex-direction: column;
  flex-grow: 1;
  overflow: hidden;
  width: 100%;
}


.sheet-header {
  padding: 16px;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  min-height: 56px; /* Ensure consistent height */
}

.nav-content {
  display: flex;
  align-items: center;
  width: 100%;
}

.nav-side {
  flex: 0 0 auto; /* Fixed width that matches the button area */
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 56px; /* Match the button area including padding */
}

.nav-button, .nav-placeholder {
  min-width: 40px;
  min-height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
  border-radius: 8px;
  flex-shrink: 0;
}

.nav-button {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-primary);
}

.nav-button:hover {
  background: var(--btn-hover);
}

.header-text {
  margin: 0;
  font-size: 1.2rem;
  font-weight: 600;
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 40px; /* Ensure consistent height with the button */
  flex: 1; /* Take remaining space */
}

.provider-logo-header {
  margin: 0 !important; /* Override any default margins on the logo */
  display: flex;
  align-items: center;
}

.content-container {
  display: flex;
  flex-direction: column;
  flex-grow: 1;
  overflow: hidden;
  width: 100%;
  height: calc(60vh - 60px); /* Fixed height accounting for header height */
}

.providers-page, .models-page {
  height: 100%;
  padding: 8px 0;
  overflow-y: auto;
  /* The slide animation is handled by individual Motion components */
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  will-change: transform; /* Improve performance */
  /* Remove any default transitions that might interfere */
}

.content-container {
  display: flex;
  flex-direction: column;
  flex-grow: 1;
  overflow: hidden;
  width: 100%;
  height: calc(60vh - 60px); /* Fixed height accounting for header height */
  position: relative; /* Contain absolutely positioned pages */
}

.no-providers {
  padding: 16px;
  text-align: center;
  color: var(--text-secondary);
}

.provider-item {
  display: flex;
  align-items: center;
  padding: 16px;
  cursor: pointer;
  transition: background 0.2s;
  gap: 12px; /* Add gap between logo and provider name */
}

.provider-item:hover {
  background: var(--btn-hover);
}

.provider-name {
  flex-grow: 1;
  font-weight: 500;
}

.models-page {
  padding: 8px 0;
}

.model-item {
  display: flex;
  align-items: center;
  padding: 16px;
  cursor: pointer;
  transition: background 0.2s;
}

.model-item:hover {
  background: var(--btn-hover);
}

.model-item.selected {
  background: var(--primary);
  color: var(--primary-foreground);
}

.model-item.selected .model-description {
  color: var(--primary-foreground);
  opacity: 0.9;
}

.model-info {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
}

.model-name {
  font-weight: 500;
  margin-bottom: 4px;
}

.model-description {
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.selected-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--primary-foreground);
}

/* Mobile-specific adjustments */
@media (max-width: 500px) {
  .bottom-sheet {
    max-height: 60vh;
  }
}
</style>