<script setup>
import { ref, computed } from "vue";
import { Icon } from "@iconify/vue";
import {
  exportAllToZip,
  generateExportFilename,
  triggerDownload,
} from "~/composables/importExport";

const props = defineProps({
  isOpen: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(["close"]);

const includeChats = ref(true);
const includeNotepad = ref(true);
const includeSettings = ref(true);
const includeApiKey = ref(false);
const isExporting = ref(false);

const canExport = computed(() => {
  return includeChats.value || includeNotepad.value || includeSettings.value;
});

function close() {
  emit("close");
}

async function handleExport() {
  if (isExporting.value || !canExport.value) return;
  isExporting.value = true;
  try {
    const blob = await exportAllToZip({
      includeChats: includeChats.value,
      includeNotepad: includeNotepad.value,
      includeSettings: includeSettings.value,
      includeApiKey: includeApiKey.value,
    });
    const filename = generateExportFilename();
    triggerDownload(blob, filename);
    close();
  } catch (error) {
    console.error("[ExportMenu] Export failed:", error);
    alert("Export failed. See console for details.");
  } finally {
    isExporting.value = false;
  }
}
</script>

<template>
  <div class="export-overlay" v-if="isOpen" @click.self="close">
    <div class="export-panel" role="dialog" aria-modal="true" aria-labelledby="export-title">
      <div class="panel-header">
        <h2 id="export-title" class="panel-title">Export Data</h2>
        <button class="close-btn" @click="close" aria-label="Close export menu">
          <Icon icon="material-symbols:close" width="20" height="20" />
        </button>
      </div>

      <div class="panel-content">
        <p class="panel-description">
          Choose what to include in your export archive. Empty or default sections are omitted automatically.
        </p>

        <div class="options-list">
          <label class="option-row">
            <input type="checkbox" v-model="includeChats" />
            <div class="option-info">
              <span class="option-label">Chats</span>
              <span class="option-hint">All conversations with branching, reasoning, and attachments.</span>
            </div>
          </label>

          <label class="option-row">
            <input type="checkbox" v-model="includeNotepad" />
            <div class="option-info">
              <span class="option-label">Notepad</span>
              <span class="option-hint">Your private memory document.</span>
            </div>
          </label>

          <label class="option-row">
            <input type="checkbox" v-model="includeSettings" />
            <div class="option-info">
              <span class="option-label">Settings</span>
              <span class="option-hint">Preferences, model settings, and parameters.</span>
            </div>
          </label>

          <label class="option-row sub-option" :class="{ disabled: !includeSettings }">
            <input type="checkbox" v-model="includeApiKey" :disabled="!includeSettings" />
            <div class="option-info">
              <span class="option-label">Include API key</span>
              <span class="option-hint">Export your custom API key with the settings.</span>
            </div>
          </label>
        </div>
      </div>

      <div class="panel-footer">
        <button class="cancel-btn" @click="close">Cancel</button>
        <button class="export-btn" :disabled="!canExport || isExporting" @click="handleExport">
          <Icon v-if="isExporting" icon="svg-spinners:180-ring" width="18" height="18" />
          <span>{{ isExporting ? "Exporting..." : "Export" }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.export-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2100;
  padding: 1rem;
}

.export-panel {
  background: var(--bg-primary);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-xl);
  width: 100%;
  max-width: 460px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.panel-title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary);
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  background: var(--btn-hover);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.close-btn:hover {
  color: var(--text-primary);
}

.panel-content {
  padding: 1.5rem;
  overflow-y: auto;
  flex: 1;
}

.panel-description {
  margin: 0 0 1.25rem;
  font-size: 0.875rem;
  color: var(--text-secondary);
  line-height: 1.5;
}

.options-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.option-row {
  display: flex;
  align-items: flex-start;
  gap: 0.875rem;
  padding: 0.875rem 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.2s ease;
}

.option-row:hover {
  border-color: var(--primary-a4);
}

.option-row.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.option-row.sub-option {
  margin-left: 1rem;
}

.option-row input[type="checkbox"] {
  width: 18px;
  height: 18px;
  margin-top: 0.125rem;
  accent-color: var(--primary);
  cursor: pointer;
  flex-shrink: 0;
}

.option-row.disabled input[type="checkbox"] {
  cursor: not-allowed;
}

.option-info {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.option-label {
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--text-primary);
}

.option-hint {
  font-size: 0.8125rem;
  color: var(--text-secondary);
  line-height: 1.4;
}

.panel-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  padding: 1rem 1.5rem;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

.cancel-btn,
.export-btn {
  padding: 0 1.25rem;
  height: 36px;
  border-radius: var(--radius-md);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.cancel-btn {
  background: none;
  color: var(--text-secondary);
  border: 1px solid var(--border);
}

.cancel-btn:hover {
  background: var(--btn-hover);
  color: var(--text-primary);
}

.export-btn {
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
}

.export-btn:hover:not(:disabled) {
  background: var(--primary-600);
}

.export-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
