<script setup>
import { ref, computed, watch, nextTick, toRaw } from "vue";
import { Icon } from "@iconify/vue";
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "reka-ui";
import { useWindowSize } from "@vueuse/core";
import Logo from "./Logo.vue";
import BottomSheetModelSelector from "./BottomSheetModelSelector.vue";
import { useAttachments } from "~/composables/useAttachments";
import { findModelById } from "~/composables/availableModels";

// Define component properties and emitted events
const props = defineProps({
  isLoading: Boolean,
  selectedModelId: String, // Add selected model ID to determine if search is supported
  availableModels: Array, // Add available models to check tool support
  settingsManager: Object, // Add settings manager prop
  selectedModelName: String,
});
const emit = defineEmits([
  "send-message",
  "abort-controller",
  "typing",
  "empty",
]);

const keys = useMagicKeys();

// Local state for reasoning effort
const reasoningEffort = ref();

// --- Reactive State ---
const inputMessage = ref("");
const textareaRef = ref(null); // Ref for the textarea element
const messageFormRoot = ref(null); // Ref for the root element
const fileInputRef = ref(null); // Ref for the hidden file input
const isDragging = ref(false); // Track drag state for visual feedback
const isProcessingFiles = ref(false); // Track file processing state for loading indicator
const isFocused = ref(false); // Track focus state for the textarea

// --- Attachments ---
const {
  attachments,
  error: attachmentError,
  hasAttachments,
  addFile,
  removeAttachment,
  clearAttachments,
  clearError: clearAttachmentError
} = useAttachments();

// Computed property to check if the input is empty (after trimming whitespace)
const trimmedMessage = computed(() => inputMessage.value.trim());

// Computed property to get the selected model object
const selectedModel = computed(() => {
  if (!props.selectedModelId || !props.availableModels) return null;


  return findModelById(props.availableModels, props.selectedModelId);
});

// Computed property to check if the current model supports vision (image attachments)
const supportsVision = computed(() => {
  return selectedModel.value?.vision === true;
});

// Computed property for accepted file types based on model capabilities
// PDFs work with any model (via file-parser plugin), images require vision
const acceptedFileTypes = computed(() => {
  return supportsVision.value
    ? 'image/png,image/jpeg,image/webp,image/gif,.pdf,application/pdf'
    : '.pdf,application/pdf';
});

// Computed property to check if the current model supports reasoning
const supportsReasoning = computed(() => {
  if (!selectedModel.value) return false;

  const reasoningConfig = selectedModel.value.reasoning;
  // Models with reasoning: false don't support reasoning
  if (reasoningConfig === false) return false;
  // Models with reasoning: true or array or string support reasoning
  return reasoningConfig !== false;
});

// Computed property to check if the current model has reasoning effort parameters
const isReasoningEffortSupported = computed(() => {
  return selectedModel.value && selectedModel.value.extra_parameters &&
    selectedModel.value.extra_parameters.reasoning_effort;
});

// Computed property to check if the current model has toggleable reasoning that requires prepending text (array format with string)
const hasToggleableTextReasoning = computed(() => {
  if (!selectedModel.value) return false;

  const reasoningConfig = selectedModel.value.reasoning;
  // Check if reasoning is an array [default, toggle_string] which requires prepending text
  return Array.isArray(reasoningConfig) &&
         reasoningConfig.length >= 2 &&
         typeof reasoningConfig[1] === 'string' &&
         reasoningConfig[1] !== 'true' &&
         reasoningConfig[1] !== 'false';
});

// Computed property to check if the current model should show a reasoning toggle
// According to requirements:
// - Models with reasoning: true AND NO REASONING_EFFORT -> NO TOGGLE
// - Models with reasoning: false -> NO TOGGLE
// - Models with reasoning: "model-id" -> TOGGLE
// - Models with reasoning: array -> TOGGLE
// - Models with reasoning: true AND REASONING_EFFORT -> NO TOGGLE but reasoning effort switcher
// - Special case: z-ai/glm-4.6 should have reasoning always on but NO TOGGLE displayed
const showReasoningToggle = computed(() => {
  if (!selectedModel.value) return false;

  const reasoningConfig = selectedModel.value.reasoning;

  // Special case: z-ai/glm-4.6 should not show a toggle
  if (selectedModel.value.id === 'z-ai/glm-4.6') return false;

  // Models with reasoning: false never show a toggle
  if (reasoningConfig === false) return false;

  // Models with reasoning: true and reasoning effort parameters show reasoning effort switcher, not toggle
  if (reasoningConfig === true && isReasoningEffortSupported.value) return false;

  // Models with reasoning: true and NO reasoning effort don't show toggle
  if (reasoningConfig === true && !isReasoningEffortSupported.value) return false;

  // Models with reasoning: "model-id" (string) and models with reasoning: array show toggle
  return Array.isArray(reasoningConfig) || typeof reasoningConfig === 'string';
});

// Computed property to check if the current model has reasoning effort switcher
// This is for models that have reasoning: true AND REASONING_EFFORT
const showReasoningEffortSwitcher = computed(() => {
  if (!selectedModel.value) return false;

  const reasoningConfig = selectedModel.value.reasoning;
  // Only show reasoning effort switcher for models with reasoning: true AND reasoning effort parameters
  return reasoningConfig === true && isReasoningEffortSupported.value;
});

// Computed property to get reasoning effort options for the current model
// Reversing the order so that "high" appears at the top and "low" at the bottom
const reasoningEffortOptions = computed(() => {
  if (!showReasoningEffortSwitcher.value) return [];
  const options = selectedModel.value.extra_parameters.reasoning_effort[0];
  // For GPT OSS models, we want high at top and low at bottom
  if (selectedModel.value.id.includes('gpt-oss')) {
    return [...options].reverse();
  }
  return options;
});

// Computed property to get the default reasoning effort for the current model
const defaultReasoningEffort = computed(() => {
  if (!showReasoningEffortSwitcher.value) return "default";
  return selectedModel.value.extra_parameters.reasoning_effort[1];
});

// Computed property to check if reasoning is currently enabled based on the model's configuration
const isReasoningEnabled = computed(() => {
  if (!selectedModel.value) return false;

  const reasoningConfig = selectedModel.value.reasoning;

  // Special case: z-ai/glm-4.6 always has reasoning enabled
  if (selectedModel.value.id === 'z-ai/glm-4.6') {
    return true;
  }

  // For models with toggleable reasoning (array or string)
  if (showReasoningToggle.value) {
    // For [true, false] arrays, reasoning is enabled when effort is not 'none'
    if (Array.isArray(reasoningConfig) &&
        reasoningConfig.length === 2 &&
        reasoningConfig[0] === true &&
        reasoningConfig[1] === false) {
      return reasoningEffort.value !== 'none';
    }

    // For [default, toggle_string] arrays, check based on the default value
    if (Array.isArray(reasoningConfig) &&
        reasoningConfig.length >= 2 &&
        typeof reasoningConfig[1] === 'string' &&
        reasoningConfig[1] !== 'true' &&
        reasoningConfig[1] !== 'false') {
      const [defaultReasoning, toggleString] = reasoningConfig;
      return defaultReasoning ? reasoningEffort.value !== 'none' : reasoningEffort.value === 'default';
    }

    // For string (model-id) reasoning, it's enabled when effort is not 'none'
    if (typeof reasoningConfig === 'string') {
      return reasoningEffort.value !== 'none';
    }
  }

  // For models with reasoning effort parameters, check the current setting
  if (showReasoningEffortSwitcher.value) {
    return reasoningEffort.value !== 'none';
  }

  // For models with reasoning: true without effort params, it's always enabled
  if (reasoningConfig === true) {
    return true;
  }

  // For other models (reasoning: false), it's never enabled
  return false;
});


// Watch the selected model and load the appropriate reasoning effort setting
watch(
  () => [props.selectedModelId, props.settingsManager?.settings?.model_settings],
  ([newModelId]) => {
    if (newModelId && props.settingsManager) {
      // Special case: z-ai/glm-4.6 should have reasoning always enabled
      if (newModelId === 'z-ai/glm-4.6') {
        reasoningEffort.value = "default";  // Always default for glm-4.6 since it's always on
        return;
      }

      const savedReasoningEffort = props.settingsManager.getModelSetting(newModelId, "reasoning_effort");
      if (savedReasoningEffort !== undefined) {
        reasoningEffort.value = savedReasoningEffort;
      } else if (defaultReasoningEffort.value) {
        reasoningEffort.value = defaultReasoningEffort.value;
      } else {
        reasoningEffort.value = "default";
      }
    }
  },
  { immediate: true }
);

// --- Mobile Model Selector Logic ---
const { width: windowWidth } = useWindowSize();
const isMobile = computed(() => windowWidth.value < 600);
const isBottomSheetOpen = ref(false);

const selectedModelLogo = computed(() => {
  if (!props.selectedModelId || !props.availableModels) return null;
  for (const item of props.availableModels) {
    if (item.category) {
      const modelInCategory = item.models.find(model => model.id === props.selectedModelId);
      if (modelInCategory) return item.logo;
    } else if (item.id === props.selectedModelId) {
      return item.logo;
    }
  }
  return null;
});

function openBottomSheet() {
  isBottomSheetOpen.value = true;
}

function closeBottomSheet() {
  isBottomSheetOpen.value = false;
}

function handleModelSelect(modelId, modelName) {
  if (props.settingsManager) {
    props.settingsManager.settings.selected_model_id = modelId;
    props.settingsManager.saveSettings();
  }
  closeBottomSheet();
}

// --- Event Handlers ---

watch(inputMessage, (newValue) => {
  if (newValue.trim()) {
    emit("typing");
  } else {
    emit("empty");
  }
});

/**
 * Handles the main action button click.
 * If loading, it aborts the request. Otherwise, it submits the message.
 */
function handleActionClick() {
  if (props.isLoading) {
    emit("abort-controller");
  } else if (trimmedMessage.value) {
    submitMessage();
  }
}

/**
 * Handles the Enter key press on the textarea.
 * On desktop (>= 768px), Enter submits the message.
 * On mobile, Enter creates a new line, as Shift+Enter is often unavailable.
 * @param {KeyboardEvent} event
 */
function handleEnterKey(event) {
  if (typeof window !== 'undefined' && window.innerWidth >= 768 && !event.shiftKey) {
    event.preventDefault(); // Prevent default newline behavior on desktop
    if (!props.isLoading) {
      submitMessage();
    }
  }
  // On mobile or with Shift key, allow the default behavior (newline).
  // Prevent submission during loading
  if (props.isLoading && !event.shiftKey) {
    event.preventDefault();
  }
}

// --- Core Logic ---

/**
 * Emits the message to the parent, then clears the input.
 */
async function submitMessage() {
  let processedMessage = inputMessage.value;
  const originalMessage = inputMessage.value;

  // Handle models with toggleable reasoning that require prepending text
  if (selectedModel.value && hasToggleableTextReasoning.value) {
    const reasoningConfig = selectedModel.value.reasoning;
    if (Array.isArray(reasoningConfig) && reasoningConfig.length >= 2) {
      const [defaultReasoning, toggleString] = reasoningConfig;

      // If the default behavior is reasoning but reasoning is turned off, prepend the toggle string
      if (defaultReasoning && !isReasoningEnabled.value && toggleString) {
        processedMessage = toggleString + " " + processedMessage;
      }
      // If the default behavior is non-reasoning but reasoning is turned on, prepend the toggle string
      else if (!defaultReasoning && isReasoningEnabled.value && toggleString) {
        processedMessage = toggleString + " " + processedMessage;
      }
    }
  }

  // Emit both the processed message (for API request) and original message (for storage)
  // Include attachments in the emission

  emit("send-message", processedMessage, originalMessage, toRaw(attachments.value));
  inputMessage.value = "";
  // Clear attachments after sending
  clearAttachments();
  // Force textarea resize after clearing
  await nextTick();
  if (textareaRef.value) {
    textareaRef.value.style.height = "auto";
  }
}

/**
 * Watches the input message to automatically resize the textarea.
 */
watch(inputMessage, async () => {
  // Wait for the DOM to update before calculating the new height

  await nextTick();
  if (textareaRef.value) {
    // Temporarily set height to 'auto' to correctly calculate the new scrollHeight

    textareaRef.value.style.height = "auto";
    // Set the height to match the content, up to the max-height defined in CSS

    // If the content is empty, let CSS handle the min-height

    if (inputMessage.value !== "") {
      textareaRef.value.style.height = `${textareaRef.value.scrollHeight}px`;
    }
  }
});

// --- Exposed Methods ---

/**
 * Allows the parent component to programmatically set the input message.
 * @param {string} text - The message to set in the textarea.
 */
function setMessage(text) {
  inputMessage.value = text;
}


/**
 * Toggles the reasoning state and updates the settings
 */
function toggleReasoning() {
  // Special case: z-ai/glm-4.6 cannot have reasoning disabled, so don't toggle
  if (selectedModel.value?.id === 'z-ai/glm-4.6') {
    // For GLM 4.6, we don't do anything since reasoning is always on with no toggle
    return;
  }

  if (showReasoningToggle.value) {
    // For models with reasoning toggle, toggle between "default" and "none"
    reasoningEffort.value = reasoningEffort.value === "default" ? "none" : "default";
  } else if (showReasoningEffortSwitcher.value) {
    // For models with reasoning effort options, cycle through them
    const currentIndex = reasoningEffortOptions.value.indexOf(reasoningEffort.value);
    const nextIndex = (currentIndex + 1) % reasoningEffortOptions.value.length;
    reasoningEffort.value = reasoningEffortOptions.value[nextIndex];
  } else {
    // For other reasoning-enabled models, we'll just toggle between default and none
    reasoningEffort.value = reasoningEffort.value === "default" ? "none" : "default";
  }

  // Update the setting in the settings manager
  if (props.settingsManager && props.selectedModelId) {
    props.settingsManager.setModelSetting(props.selectedModelId, "reasoning_effort", reasoningEffort.value);
    props.settingsManager.saveSettings();
  }
}

/**
 * Sets the reasoning effort for GPT-OSS models and updates the settings
 * @param {string} value - The selected reasoning effort value
 */
function setReasoningEffort(value) {
  reasoningEffort.value = value;
  // Update the setting in the settings manager
  if (props.settingsManager && props.selectedModelId) {
    props.settingsManager.setModelSetting(props.selectedModelId, "reasoning_effort", value);
    props.settingsManager.saveSettings();
  }
}

// --- Attachment Handlers ---

/**
 * Opens the file picker dialog
 */
function openFilePicker() {
  fileInputRef.value?.click();
}

/**
 * Handles file selection from the file input
 * @param {Event} event - The change event from file input
 */
async function handleFileSelect(event) {
  const files = Array.from(event.target.files || []);
  for (const file of files) {
    await addFile(file, supportsVision.value);
  }
  // Reset input to allow selecting the same file again
  event.target.value = '';
}

/**
 * Checks if a file is an allowed type (image or PDF)
 * @param {File} file - The file to check
 * @returns {boolean}
 */
function isAllowedFileType(file) {
  const imageTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
  const pdfTypes = ['application/pdf'];
  const extension = file.name.split('.').pop()?.toLowerCase();
  
  // PDFs are always allowed
  if (pdfTypes.includes(file.type) || extension === 'pdf') {
    return true;
  }
  
  // Images require vision support
  if (imageTypes.includes(file.type) || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) {
    return supportsVision.value;
  }
  
  return false;
}

/**
 * Handles paste event to support pasting images/PDFs from clipboard
 * @param {ClipboardEvent} event - The paste event
 */
async function handlePaste(event) {
  if (props.isLoading) return;
  
  const items = event.clipboardData?.items;
  if (!items) return;
  
  const filesToAdd = [];
  
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file && isAllowedFileType(file)) {
        filesToAdd.push(file);
      }
    }
  }
  
  // Only prevent default if we found files to add
  if (filesToAdd.length > 0) {
    event.preventDefault();
    isProcessingFiles.value = true;
    try {
      for (const file of filesToAdd) {
        await addFile(file, supportsVision.value);
      }
    } finally {
      isProcessingFiles.value = false;
    }
  }
}

/**
 * Handles dragenter event
 * @param {DragEvent} event - The drag event
 */
function handleDragEnter(event) {
  event.preventDefault();
  event.stopPropagation();
  isDragging.value = true;
}

/**
 * Handles dragover event
 * @param {DragEvent} event - The drag event
 */
function handleDragOver(event) {
  event.preventDefault();
  event.stopPropagation();
  isDragging.value = true;
}

/**
 * Handles dragleave event
 * @param {DragEvent} event - The drag event
 */
function handleDragLeave(event) {
  event.preventDefault();
  event.stopPropagation();
  
  // Only set isDragging to false if we're leaving the container entirely
  // Check if the related target is outside our drop zone
  const rect = event.currentTarget.getBoundingClientRect();
  const x = event.clientX;
  const y = event.clientY;
  
  if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
    isDragging.value = false;
  }
}

/**
 * Handles drop event for drag-and-drop file uploads
 * @param {DragEvent} event - The drop event
 */
async function handleDrop(event) {
  event.preventDefault();
  event.stopPropagation();
  isDragging.value = false;
  
  if (props.isLoading) return;
  
  const files = Array.from(event.dataTransfer?.files || []);
  const filesToAdd = files.filter(file => isAllowedFileType(file));
  
  if (filesToAdd.length > 0) {
    isProcessingFiles.value = true;
    try {
      for (const file of filesToAdd) {
        await addFile(file, supportsVision.value);
      }
    } finally {
      isProcessingFiles.value = false;
    }
  }
}

// If text form isn't focused and / is pressed, focus text form
// We don't use whenever here to prevent the default action
onKeyStroke("/", (e) => {
  if (!isFocused.value) {
    e.preventDefault();
    textareaRef.value.focus();
  }
})

// Expose the setMessage function to be called from the parent component
defineExpose({ setMessage, toggleReasoning, setReasoningEffort, $el: messageFormRoot });
</script>

<template>
  <div ref="messageFormRoot" class="input-section">
    <!-- Hidden file input -->
    <input
      ref="fileInputRef"
      type="file"
      :accept="acceptedFileTypes"
      multiple
      class="hidden-file-input"
      @change="handleFileSelect"
    />

    <div 
      class="input-area-wrapper"
      :class="{ 'drag-over': isDragging }"
      @dragenter="handleDragEnter"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <!-- Attachment error message -->
      <div v-if="attachmentError" class="attachment-error">
        <Icon icon="material-symbols:error-outline" width="16" height="16" />
        <span>{{ attachmentError }}</span>
        <button class="dismiss-error" @click="clearAttachmentError" aria-label="Dismiss error">
          <Icon icon="material-symbols:close" width="14" height="14" />
        </button>
      </div>

      <!-- Attachment previews -->
      <div v-if="hasAttachments || isProcessingFiles" class="attachment-preview-row">
        <!-- Processing indicator -->
        <div v-if="isProcessingFiles" class="attachment-preview processing">
          <div class="processing-spinner"></div>
          <span class="attachment-name">Processing...</span>
        </div>
        <div
          v-for="attachment in attachments"
          :key="attachment.id"
          class="attachment-preview"
          :class="attachment.type"
        >
          <img v-if="attachment.type === 'image'" :src="attachment.dataUrl" :alt="attachment.filename" />
          <Icon v-else icon="material-symbols:picture-as-pdf" width="24" height="24" class="pdf-icon" />
          <span class="attachment-name">{{ attachment.filename }}</span>
          <button class="remove-attachment" @click="removeAttachment(attachment.id)" aria-label="Remove attachment">
            <Icon icon="material-symbols:close" width="14" height="14" />
          </button>
        </div>
      </div>

      <textarea 
        ref="textareaRef" 
        v-model="inputMessage" 
        :disabled="isLoading" 
        @keydown.enter="handleEnterKey"
        @paste="handlePaste"
        @focus="isFocused = true"
        @blur="isFocused = false"
        placeholder="Type your message..." 
        class="chat-textarea" 
        rows="1"
      ></textarea>

      <div class="input-actions">
        <!-- Attachment button (plus icon) - PDFs work with any model, images require vision -->
        <button
          type="button"
          class="feature-button attachment-btn"
          @click="openFilePicker"
          :disabled="isLoading"
          :aria-label="supportsVision ? 'Attach image or PDF' : 'Attach PDF'"
          :title="supportsVision ? 'Attach image or PDF' : 'Attach PDF (images require vision model)'"
        >
          <Icon icon="material-symbols:add" width="22" height="22" />
        </button>

        <!-- Reasoning toggle for models that should show a reasoning toggle -->
        <button v-if="selectedModel && showReasoningToggle && supportsReasoning"
          type="button" class="feature-button search-toggle-btn"
          :class="{ 'search-enabled': isReasoningEnabled }" @click="toggleReasoning"
          :aria-label="isReasoningEnabled ? 'Disable reasoning' : 'Enable reasoning'">
          <Icon icon="material-symbols:lightbulb" width="22" height="22" />
          <span class="search-label">Reasoning</span>
        </button>

        <!-- Reasoning effort dropdown for models that support reasoning effort (reasoning: true with effort params) -->
        <DropdownMenuRoot v-else-if="selectedModel && showReasoningEffortSwitcher">
          <DropdownMenuTrigger class="feature-button search-toggle-btn">
            <Icon icon="material-symbols:lightbulb" width="22" height="22" />
            <span>{{ reasoningEffort.charAt(0).toUpperCase() + reasoningEffort.slice(1) }}</span>
          </DropdownMenuTrigger>

          <DropdownMenuContent class="popover-dropdown reasoning-effort-dropdown" side="top" align="center"
            :side-offset="8">
            <div class="dropdown-scroll-container">
              <DropdownMenuItem v-for="option in reasoningEffortOptions" :key="option" class="reasoning-effort-item"
                :class="{ selected: option === reasoningEffort }" @click="() => setReasoningEffort(option)">
                <span>{{ option.charAt(0).toUpperCase() + option.slice(1) }}</span>
              </DropdownMenuItem>
            </div>
          </DropdownMenuContent>
        </DropdownMenuRoot>

        <!-- Right aligned actions -->
        <div class="right-actions">
          <!-- Mobile Model Selector Button -->
          <button v-if="isMobile" type="button" class="feature-button model-selector-mobile-btn"
            @click="openBottomSheet" :aria-label="`Change model, currently ${props.selectedModelName}`">
            <Logo v-if="selectedModelLogo" :src="selectedModelLogo" :size="18" class="logo-inline" />
            <span class="model-name-truncate">{{ props.selectedModelName }}</span>
          </button>

          <button type="submit" class="action-btn send-btn" :disabled="!trimmedMessage && !isLoading"
            @click="handleActionClick" :aria-label="isLoading ? 'Stop generation' : 'Send message'">
            <Icon v-if="!isLoading" icon="material-symbols:arrow-upward-rounded" width="22" height="22" />
            <Icon v-else icon="material-symbols:stop-rounded" width="22" height="22" />
          </button>
        </div>
      </div>
    </div>
  </div>

  <BottomSheetModelSelector
    v-if="isMobile"
    :is-open="isBottomSheetOpen"
    :selected-model-id="props.selectedModelId"
    :selected-model-name="props.selectedModelName"
    @close="closeBottomSheet"
    @model-selected="handleModelSelect"
  />
</template>

<style scoped>
/* --- LAYOUT & STRUCTURE --- */
.input-section {
  /* Stick to the bottom of the scroll container (chat-column) */
  position: sticky;
  background: var(--bg); 
  border-radius: 20px 20px 0 0;
  bottom: 0px;
  width: 100%;
  padding: 0;
  box-sizing: border-box;
  z-index: 10;
  box-shadow: 0px -5px 15px 10px var(--bg);
}

.input-area-wrapper {
  display: flex;
  margin-bottom: 8px;
  flex-direction: column;
  background-color: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 8px;
  box-shadow: var(--shadow-default);
  position: relative;
  z-index: 10;
  transition: border-color 0.2s ease, background-color 0.2s ease;
}

.input-area-wrapper.drag-over {
  border-color: var(--primary);
  background-color: var(--primary-50, rgba(79, 70, 229, 0.05));
}

.chat-textarea {
  display: block;
  width: 100%;
  padding: 10px 12px;
  background: transparent;
  border: none;
  resize: none;
  color: var(--text-primary);
  font-size: 1rem;
  line-height: 1.5;
  min-height: 24px;
  max-height: 250px;
  overflow-y: auto;
}

.chat-textarea:focus {
  outline: none;
}

/* --- BUTTONS --- */
.action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    transform 0.15s ease;
}

.action-btn:hover:not(:disabled) {
  transform: translateY(-1px);
}

.send-btn {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background-color: var(--btn-send-bg);
  color: var(--btn-send-text);
  flex-shrink: 0;
}

.send-btn:hover:not(:disabled) {
  background-color: var(--btn-send-hover-bg);
}

.send-btn:disabled {
  background-color: var(--btn-send-disabled-bg);
  cursor: not-allowed;
  transform: none;
}

.send-btn:disabled .icon-send {
  stroke: var(--btn-send-text);
  opacity: 0.7;
}

/* Feature button base styles */
.feature-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 8px;

  color: var(--btn-model-selector-text);
  border: 1px solid var(--border);
  cursor: pointer;
  flex-shrink: 0;
  font-weight: 500;
  font-size: 13px;
  transition: all 0.2s ease;
  height: 36px;
  margin: 0;
}

.feature-button:hover:not(:disabled) {
  background-color: var(--btn-model-selector-hover-bg);
}

.search-toggle-btn.search-enabled {
  background-color: var(--primary);
  color: var(--primary-foreground);
  border-color: var(--primary);
}

.search-toggle-btn.search-enabled:hover:not(:disabled) {
  background-color: var(--primary-600);
  border-color: var(--primary-600);
}

.input-actions {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  padding: 8px 0 0;
  gap: 6px;
  width: 100%;
}

/* No special casing for sidebars needed – the parent layout
   (chat-column) controls horizontal alignment and width. */

/* Reasoning effort dropdown styles */
.reasoning-effort-dropdown {
  animation: popIn 0.2s ease-out forwards;
  min-width: 200px;
  background: var(--popover-bg);
  border-radius: 12px;
  padding: 6px;
  box-shadow: var(--popover-shadow);
  border: 1px solid var(--popover-border);
  z-index: 1001;
}

.reasoning-effort-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 8px 12px;
  text-align: left;
  background: none;
  color: var(--popover-list-item-text);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
  font-size: 0.95rem;
  border-radius: 6px;
  margin-bottom: 2px;
  border: none;
}

.reasoning-effort-item:hover {
  background-color: var(--popover-list-item-bg-hover);
}

.reasoning-effort-item.selected {
  background-color: var(--popover-list-item-selected-bg);
  color: var(--popover-list-item-selected-text);
  font-weight: 500;
}

/* Animation for dropdown */
@keyframes popIn {
  0% {
    opacity: 0;
    transform: scale(0.95) translateY(-5px);
  }

  100% {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

/* Mobile-specific styles */
@media (max-width: 768px) {
  .input-section {
    max-width: 100%;
    padding: 8px 10px 0;
  }
  
  .chat-textarea {
    font-size: 16px; /* Prevent zoom on iOS */
  }
}

.logo-inline {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.model-name-truncate {
  max-width: 100px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-selector-mobile-btn {
  padding: 4px 8px;
  gap: 4px;
}

.right-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* --- ATTACHMENTS --- */
.hidden-file-input {
  display: none;
}

.attachment-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 8px;
  background-color: var(--error-bg, rgba(239, 68, 68, 0.1));
  border: 1px solid var(--error-border, rgba(239, 68, 68, 0.3));
  border-radius: 8px;
  color: var(--error-text, #ef4444);
  font-size: 0.875rem;
}

.attachment-error span {
  flex: 1;
}

.dismiss-error {
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  padding: 4px;
  cursor: pointer;
  color: inherit;
  opacity: 0.7;
  transition: opacity 0.15s ease;
}

.dismiss-error:hover {
  opacity: 1;
}

.attachment-preview-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-bottom: 8px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border);
}

.attachment-preview {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background-color: var(--bg-secondary, var(--bg-input));
  border: 1px solid var(--border);
  border-radius: 8px;
  max-width: 200px;
}

.attachment-preview.image {
  padding: 4px;
}

.attachment-preview.image img {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: 6px;
}

.attachment-preview.pdf {
  padding-right: 28px;
}

.attachment-preview .pdf-icon {
  color: var(--error-text, #ef4444);
  flex-shrink: 0;
}

.attachment-name {
  font-size: 0.8rem;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100px;
}

.attachment-preview.image .attachment-name {
  display: none;
}

.remove-attachment {
  position: absolute;
  padding: 0;
  top: -6px;
  right: -6px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background-color: var(--bg);
  border: 1px solid var(--border);
  border-radius: 50%;
  cursor: pointer;
  color: var(--text-secondary);
  transition: all 0.15s ease;
}

.remove-attachment:hover {
  background-color: var(--error-bg, rgba(239, 68, 68, 0.1));
  border-color: var(--error-border, rgba(239, 68, 68, 0.3));
  color: var(--error-text, #ef4444);
}

.attachment-btn {
  width: 36px;
  height: 36px;
  padding: 0;
}

.attachment-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Processing indicator styles */
.attachment-preview.processing {
  background-color: var(--bg-secondary, var(--bg-input));
  border-style: dashed;
}

.processing-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
