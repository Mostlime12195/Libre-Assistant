<template>
  <div class="parameter-config-wrapper">
    <!-- Global tooltip element -->
    <div v-if="tooltipVisible" class="global-tooltip show" :style="tooltipStyle">
      {{ tooltipText }}
      <div class="tooltip-arrow"></div>
    </div>

    <div :class="['parameter-config-overlay', { active: isOpen && isMobile }]" @click="closePanel"></div>
    <div class="parameter-config-panel" :class="{ active: isOpen }">
      <!-- Header -->
      <div class="panel-header">
        <span class="panel-title">Parameters</span>
        <div class="header-actions">
          <button class="action-btn" @click="resetToDefaults" aria-label="Reset to defaults">
            <Icon icon="material-symbols:refresh" width="20" height="20" />
          </button>
          <button class="action-btn" @click="closePanel" aria-label="Close">
            <Icon icon="material-symbols:close" width="20" height="20" />
          </button>
        </div>
      </div>

      <div class="panel-content">
        <div class="settings-group">
          <div v-for="param in parameters" :key="param.name" class="setting-item"
            @mouseenter="showTooltip($event, param.description)" @mouseleave="hideTooltip">
            <div class="setting-header">
              <label class="setting-label">{{ param.label }}</label>
              <input v-if="param.type === 'seed'" type="number" :value="param.value.value" @input="param.inputHandler"
                class="value-input" placeholder="-1" />
            </div>
            <div class="input-slider-container">
              <SliderRoot v-if="param.type !== 'seed'" class="slider" :min="param.min" :max="param.max"
                :step="param.step" :model-value="[param.value.value]" @update:model-value="param.sliderHandler">
                <SliderTrack class="slider-track">
                  <SliderRange class="slider-range" />
                </SliderTrack>
                <SliderThumb class="slider-thumb" />
              </SliderRoot>
              <input v-if="param.type !== 'seed'" type="number" :value="param.value.value" @input="param.inputHandler"
                class="value-input" :min="param.min" :max="param.max" :step="param.step" />
            </div>
          </div>
        </div>

        <!-- Middleware Section -->
        <div class="settings-group middleware-section">
          <h3 class="section-title">Middleware</h3>
          <div v-for="param in middlewareParameters" :key="param.name" class="setting-item"
            @mouseenter="showTooltip($event, param.description)" @mouseleave="hideTooltip">
            <div class="setting-header">
              <label class="setting-label">{{ param.label }}</label>
              <div class="switch-container">
                <SwitchRoot class="switch-root" :modelValue="param.value.value" @update:modelValue="param.inputHandler">
                  <SwitchThumb class="switch-thumb" />
                </SwitchRoot>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, watch, ref, onMounted, onUnmounted } from "vue";
import { Icon } from "@iconify/vue";
import { SliderRoot, SliderTrack, SliderRange, SliderThumb, SwitchRoot, SwitchThumb } from "reka-ui";
import DEFAULT_PARAMETERS from '@/composables/defaultParameters';

const props = defineProps({
  isOpen: {
    type: Boolean,
    default: false
  },
  settingsManager: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(["close", "save"]);

// Mobile detection
const isMobile = ref(false);

const checkMobile = () => {
  isMobile.value = typeof window !== 'undefined' && window.innerWidth <= 950;
};

// Watch for window resize to update mobile status
let resizeObserver;

onMounted(() => {
  if (typeof window !== 'undefined') {
    checkMobile();
    resizeObserver = new ResizeObserver(checkMobile);
    resizeObserver.observe(document.body);
  }
});

onUnmounted(() => {
  if (resizeObserver) {
    resizeObserver.disconnect();
  }
});

// Tooltip state
const tooltipVisible = ref(false);
const tooltipText = ref('');
const tooltipX = ref(0);
const tooltipY = ref(0);

function showTooltip(event, text) {
  const rect = event.currentTarget.getBoundingClientRect();
  tooltipVisible.value = true;
  tooltipText.value = text;
  // Position tooltip to the left of the setting item
  tooltipX.value = rect.left - 12; // 12px offset
  tooltipY.value = rect.top + (rect.height / 2);
}

function hideTooltip() {
  tooltipVisible.value = false;
}

const tooltipStyle = computed(() => {
  return {
    left: `${tooltipX.value}px`,
    top: `${tooltipY.value}px`,
    transform: 'translate(-100%, -50%)',
    zIndex: '999999'
  };
});

// Individual computed properties for each parameter to ensure perfect synchronization
const temperature = computed({
  get: () => {
    if (!props.settingsManager?.settings?.parameter_config) return DEFAULT_PARAMETERS.temperature;
    return props.settingsManager.settings.parameter_config.temperature ?? DEFAULT_PARAMETERS.temperature;
  },
  set: (value) => {
    if (props.settingsManager) {
      // Ensure parameter_config exists
      if (!props.settingsManager.settings.parameter_config) {
        props.settingsManager.settings.parameter_config = { ...DEFAULT_PARAMETERS };
      }

      // Update the specific parameter
      props.settingsManager.settings.parameter_config.temperature = value;
      saveSettings();
    }
  }
});

const topP = computed({
  get: () => {
    if (!props.settingsManager?.settings?.parameter_config) return DEFAULT_PARAMETERS.top_p;
    return props.settingsManager.settings.parameter_config.top_p ?? DEFAULT_PARAMETERS.top_p;
  },
  set: (value) => {
    if (props.settingsManager) {
      // Ensure parameter_config exists
      if (!props.settingsManager.settings.parameter_config) {
        props.settingsManager.settings.parameter_config = { ...DEFAULT_PARAMETERS };
      }

      // Update the specific parameter
      props.settingsManager.settings.parameter_config.top_p = value;
      saveSettings();
    }
  }
});

// Handler functions for slider value changes
function handleTemperatureChange(value) {
  // Extract the first value from the array
  temperature.value = value[0];
}

function handleTopPChange(value) {
  // Extract the first value from the array
  topP.value = value[0];
}

const seed = computed({
  get: () => {
    if (!props.settingsManager?.settings?.parameter_config) return DEFAULT_PARAMETERS.seed;
    return props.settingsManager.settings.parameter_config.seed ?? DEFAULT_PARAMETERS.seed;
  },
  set: (value) => {
    if (props.settingsManager) {
      // Ensure parameter_config exists
      if (!props.settingsManager.settings.parameter_config) {
        props.settingsManager.settings.parameter_config = { ...DEFAULT_PARAMETERS };
      }

      // Update the specific parameter
      props.settingsManager.settings.parameter_config.seed = value;
      saveSettings();
    }
  }
});

const grounding = computed({
  get: () => {
    if (!props.settingsManager?.settings?.parameter_config) return DEFAULT_PARAMETERS.grounding;
    return props.settingsManager.settings.parameter_config.grounding ?? DEFAULT_PARAMETERS.grounding;
  },
  set: (value) => {
    if (props.settingsManager) {
      // Ensure parameter_config exists
      if (!props.settingsManager.settings.parameter_config) {
        props.settingsManager.settings.parameter_config = { ...DEFAULT_PARAMETERS };
      }

      // Update the specific parameter
      props.settingsManager.settings.parameter_config.grounding = value;
      saveSettings();
    }
  }
});

// Watch for changes in parameter config and save settings
watch(
  () => props.settingsManager?.settings?.parameter_config,
  () => {
    if (props.settingsManager) {
      saveSettings();
    }
  },
  { deep: true }
);

function closePanel() {
  emit("close");
}

function saveSettings() {
  if (props.settingsManager) {
    props.settingsManager.saveSettings();
  }
  emit("save");
}

function resetToDefaults() {
  if (props.settingsManager) {
    // Reset to default values
    const defaults = { ...DEFAULT_PARAMETERS };

    // Ensure parameter_config exists
    if (!props.settingsManager.settings.parameter_config) {
      props.settingsManager.settings.parameter_config = {};
    }

    // Apply defaults
    props.settingsManager.settings.parameter_config = defaults;
    saveSettings();
  }
}

// Define parameters configuration
const parameters = [
  {
    name: 'temperature',
    label: 'Temperature',
    type: 'slider',
    value: temperature,
    min: 0,
    max: 2,
    step: 0.05,
    description: 'Controls randomness: Lower values make outputs more deterministic, higher values make them more random.',
    inputHandler: (e) => temperature.value = parseFloat(e.target.value),
    sliderHandler: handleTemperatureChange
  },
  {
    name: 'top_p',
    label: 'Top P',
    type: 'slider',
    value: topP,
    min: 0,
    max: 1,
    step: 0.05,
    description: 'Controls diversity via nucleus sampling: 0.5 means half of all likelihood-weighted options are considered.',
    inputHandler: (e) => topP.value = parseFloat(e.target.value),
    sliderHandler: handleTopPChange
  },
  {
    name: 'seed',
    label: 'Seed',
    type: 'seed',
    value: seed,
    description: 'If specified, our system will make a best effort to sample deterministically.',
    inputHandler: (e) => seed.value = e.target.value ? parseInt(e.target.value) : null
  }
];

// Middleware parameters
const middlewareParameters = [
  {
    name: 'grounding',
    label: 'Grounding with Web Search',
    type: 'boolean',
    value: grounding,
    description: 'Enable grounding with web search results to provide factually accurate responses.',
    inputHandler: (value) => grounding.value = value
  }
];
</script>

<style scoped>
.parameter-config-wrapper {
  position: relative;
}

.parameter-config-overlay {
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

.parameter-config-overlay.active {
  opacity: 1;
  pointer-events: auto;
}

.parameter-config-panel {
  position: fixed;
  right: 0;
  top: 0;
  height: 100dvh;
  width: 300px;
  max-width: 90vw;
  z-index: 1001;
  background: var(--panel-bg);
  color: var(--text-primary);
  border-left: 1px solid var(--border);
  transform: translateX(100%);
  transition: transform 0.3s cubic-bezier(.4, 1, .6, 1);
  display: flex;
  flex-direction: column;
  font-family: var(--font);
}

.parameter-config-panel.active {
  transform: translateX(0);
}

/* Header */
.panel-header {
  display: flex;
  align-items: center;
  position: relative;
  justify-content: space-between;
  height: 60px;
  padding: 0 16px;
  background: var(--panel-bg);
  flex-shrink: 0;
}

.panel-title {
  font-family: "Inter", sans-serif;
  font-size: 1.1em;
  font-weight: 600;
  color: inherit;
  padding-left: 0;
}

/* Middleware section */
.middleware-section {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.section-title {
  font-size: 0.9em;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 0 0 12px 0;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-size: 0.8em;
}

.value-checkbox {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border);
  border-radius: 4px;
  background-color: transparent;
  cursor: pointer;
  transition: all 0.2s ease;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
}

.value-checkbox:checked {
  background-color: var(--primary);
  border-color: var(--primary);
  position: relative;
}

.value-checkbox:checked::after {
  content: '';
  position: absolute;
  left: 5px;
  top: 1px;
  width: 6px;
  height: 12px;
  border: solid white;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

/* Switch styling from SettingsPanel */
.switch-container {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.switch-root {
  width: 42px;
  height: 24px;
  background-color: var(--text-muted);
  border-radius: 9999px;
  position: relative;
  -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin: 0;
  transition: background-color 100ms;
}

.switch-root[data-state='checked'] {
  background-color: var(--primary-600);
}

.switch-thumb {
  width: 20px;
  height: 20px;
  background-color: var(--border);
  border-radius: 9999px;
  box-shadow: 0 2px 2px var(--black-a7);
  transition: transform 100ms;
  transform: translateX(-9px);
  will-change: transform;
  position: relative;
  z-index: 1;
}

.switch-thumb[data-state='checked'] {
  transform: translateX(9px);
}

.dark .switch-thumb {
  background-color: var(--bg-primary);
}

.switch-thumb[data-state='checked'] {
  transform: translateX(8px);
  background-color: var(--bg-primary);
}

.header-actions {
  display: flex;
  gap: 8px;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  background: transparent;
  border-radius: 8px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.action-btn:hover {
  background: var(--btn-hover);
  color: var(--text-primary);
}

/* Main Content */
.panel-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px 16px;
  background: var(--panel-bg);
}

.settings-group {
  display: flex;
  flex-direction: column;
  gap: 32px;
}

.setting-item {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border-radius: 8px;
  transition: background-color 0.2s ease;
}

.setting-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.setting-label {
  font-size: 0.95rem;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0;
  flex: 1;
}

.input-slider-container {
  display: flex;
  align-items: center;
  gap: 12px;
}

.value-input {
  width: 60px;
  padding: 4px 4px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-input-bg);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.9rem;
  text-align: center;
  transition: all 0.2s ease;
}

.value-input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 1px var(--focus-ring);
}

.slider {
  position: relative;
  display: flex;
  height: 5px;
  border-radius: 3px;
  background: var(--border);
  outline: none;
  flex: 1;
  align-items: center;
  transition: none;
  margin: 0;
}

.slider-track {
  height: 100%;
  border-radius: 3px;
  background: var(--border);
  flex-grow: 1;
  position: relative;
}

.slider-range {
  position: absolute;
  height: 100%;
  background: var(--primary);
  border-radius: 3px;
}

.slider-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--primary);
  cursor: pointer;
  display: block;
  z-index: 10;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

/* Tooltip */
.global-tooltip {
  border-radius: 4px;
  padding: 10px 15px;
  font-size: 15px;
  line-height: 1;
  color: var(--tooltip-text);
  background-color: var(--tooltip-bg);
  box-shadow:
    0px 10px 38px -10px rgba(0, 0, 0, 0.35),
    0px 10px 20px -15px rgba(0, 0, 0, 0.2);
  user-select: none;
  max-width: 250px;
  word-wrap: break-word;
  z-index: 999999;
  pointer-events: none;
  transition: opacity 0.3s ease;
  opacity: 0;
  position: fixed;
}

.global-tooltip.show {
  opacity: 1;
}

.tooltip-arrow {
  position: absolute;
  right: -8px;
  top: 50%;
  transform: translateY(-50%);
  width: 0;
  height: 0;
  border-top: 8px solid transparent;
  border-bottom: 8px solid transparent;
  border-left: 8px solid var(--tooltip-bg);
}

@keyframes slideLeftAndFade {
  from {
    opacity: 0;
    transform: translateX(2px);
  }

  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes slideRightAndFade {
  from {
    opacity: 0;
    transform: translateX(-2px);
  }

  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes slideUpAndFade {
  from {
    opacity: 0;
    transform: translateY(2px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes slideDownAndFade {
  from {
    opacity: 0;
    transform: translateY(-2px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Mobile responsiveness */
@media (max-width: 950px) {
  .parameter-config-panel {
    position: fixed;
    width: 80vw;
    max-width: 340px;
  }
  
  .setting-label {
    font-size: 0.9rem;
  }
  
  .value-input {
    width: 50px;
    font-size: 0.85rem;
  }
  
  .panel-title {
    font-size: 1rem;
  }
}
</style>