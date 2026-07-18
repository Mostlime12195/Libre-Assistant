<script setup>
import { ref, computed, watch } from "vue";
import { Icon } from "@iconify/vue";
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "reka-ui";
import {
  importFromZipBuffer,
  parseImportArchive,
  readFileAsBuffer,
} from "~/composables/importExport";
import { useSettings } from "~/composables/useSettings";

const props = defineProps({
  isOpen: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(["close", "import-complete"]);

const settingsManager = useSettings();

const file = ref(null);
const fileName = ref("");
const archive = ref(null);
const parseError = ref("");
const isImporting = ref(false);
const isDragging = ref(false);

const chatsMode = ref("append");
const notepadMode = ref("replace");
const settingsMode = ref("replace");

const hasChats = computed(() => !!archive.value?.chats?.length);
const hasNotepad = computed(() => !!archive.value?.notepad);
const hasSettings = computed(() => !!archive.value?.settings);

const canImport = computed(() => {
  return (
    file.value != null &&
    archive.value != null &&
    (hasChats.value || hasNotepad.value || hasSettings.value) &&
    (chatsMode.value !== "skip" || notepadMode.value !== "skip" || settingsMode.value !== "skip")
  );
});

const chatOptions = [
  { value: "skip", label: "Skip" },
  { value: "replace", label: "Replace" },
  { value: "append", label: "Append" },
];

const binaryOptions = [
  { value: "skip", label: "Skip" },
  { value: "replace", label: "Replace" },
];

function reset() {
  file.value = null;
  fileName.value = "";
  archive.value = null;
  parseError.value = "";
  chatsMode.value = "append";
  notepadMode.value = "replace";
  settingsMode.value = "replace";
}

function close() {
  emit("close");
}

watch(
  () => props.isOpen,
  (newVal) => {
    if (newVal) reset();
  }
);

async function handleFile(selectedFile) {
  if (!selectedFile) return;
  file.value = selectedFile;
  fileName.value = selectedFile.name;
  parseError.value = "";
  archive.value = null;

  try {
    const buffer = await readFileAsBuffer(selectedFile);
    archive.value = parseImportArchive(new Uint8Array(buffer));
  } catch (error) {
    parseError.value = error.message || "Could not read this file.";
    console.error("[ImportMenu] Parse error:", error);
  }
}

function onFileChange(event) {
  handleFile(event.target.files?.[0]);
}

function onDrop(event) {
  event.preventDefault();
  isDragging.value = false;
  handleFile(event.dataTransfer.files?.[0]);
}

function onDragOver(event) {
  event.preventDefault();
  isDragging.value = true;
}

function onDragLeave() {
  isDragging.value = false;
}

function onFileInputClick(event) {
  // Reset so selecting the same file re-triggers the change handler.
  event.target.value = "";
}

async function handleImport() {
  if (isImporting.value || !canImport.value) return;
  isImporting.value = true;
  try {
    const buffer = await readFileAsBuffer(file.value);
    const result = await importFromZipBuffer(new Uint8Array(buffer), {
      chatsMode: chatsMode.value,
      notepadMode: notepadMode.value,
      settingsMode: settingsMode.value,
      settingsManager,
    });
    emit("import-complete", result);
    close();
  } catch (error) {
    console.error("[ImportMenu] Import failed:", error);
    alert("Import failed. See console for details.");
  } finally {
    isImporting.value = false;
  }
}

function labelFor(options, value) {
  return options.find((opt) => opt.value === value)?.label || value;
}
</script>

<template>
  <div class="import-overlay" v-if="isOpen" @click.self="close">
    <div class="import-panel" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <div class="panel-header">
        <h2 id="import-title" class="panel-title">Import Data</h2>
        <button class="close-btn" @click="close" aria-label="Close import menu">
          <Icon icon="material-symbols:close" width="20" height="20" />
        </button>
      </div>

      <div class="panel-content">
        <div
          class="drop-zone"
          :class="{ dragging: isDragging, hasFile: !!file }"
          @drop="onDrop"
          @dragover="onDragOver"
          @dragleave="onDragLeave"
          @click="$refs.fileInput.click()"
        >
          <input
            ref="fileInput"
            type="file"
            accept=".zip,.json"
            class="file-input"
            @change="onFileChange"
            @click="onFileInputClick"
          />
          <Icon icon="material-symbols:upload-file" width="36" height="36" class="drop-icon" />
          <p class="drop-title">Drop a zip or JSON file here</p>
          <p class="drop-hint">or click to browse</p>
          <p v-if="fileName" class="file-name">Selected: {{ fileName }}</p>
        </div>

        <p v-if="parseError" class="error-text">{{ parseError }}</p>

        <div v-if="archive" class="sections">
          <p class="sections-title">Choose how to merge each section:</p>

          <div class="section-row" v-if="hasChats">
            <div class="section-info">
              <span class="section-label">Chats</span>
              <span class="section-hint">{{ archive.chats.length }} conversation{{ archive.chats.length === 1 ? '' : 's' }} found</span>
            </div>
            <DropdownMenuRoot>
              <DropdownMenuTrigger class="model-selector-btn" :aria-label="`Chats merge mode: ${labelFor(chatOptions, chatsMode)}`">
                <span class="model-name-display">{{ labelFor(chatOptions, chatsMode) }}</span>
                <Icon icon="material-symbols:keyboard-arrow-down-rounded" class="dropdown-icon" />
              </DropdownMenuTrigger>
              <DropdownMenuContent class="model-selector-dropdown import-dropdown" side="bottom" align="end" :side-offset="4">
                <DropdownMenuItem
                  v-for="opt in chatOptions"
                  :key="opt.value"
                  class="model-list-item"
                  :class="{ selected: chatsMode === opt.value }"
                  @click="chatsMode = opt.value"
                >
                  <span>{{ opt.label }}</span>
                  <Icon v-if="chatsMode === opt.value" icon="material-symbols:check-rounded" class="icon" width="18" height="18" />
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenuRoot>
          </div>

          <div class="section-row" v-if="hasNotepad">
            <div class="section-info">
              <span class="section-label">Notepad</span>
              <span class="section-hint">Memory document found</span>
            </div>
            <DropdownMenuRoot>
              <DropdownMenuTrigger class="model-selector-btn" :aria-label="`Notepad merge mode: ${labelFor(binaryOptions, notepadMode)}`">
                <span class="model-name-display">{{ labelFor(binaryOptions, notepadMode) }}</span>
                <Icon icon="material-symbols:keyboard-arrow-down-rounded" class="dropdown-icon" />
              </DropdownMenuTrigger>
              <DropdownMenuContent class="model-selector-dropdown import-dropdown" side="bottom" align="end" :side-offset="4">
                <DropdownMenuItem
                  v-for="opt in binaryOptions"
                  :key="opt.value"
                  class="model-list-item"
                  :class="{ selected: notepadMode === opt.value }"
                  @click="notepadMode = opt.value"
                >
                  <span>{{ opt.label }}</span>
                  <Icon v-if="notepadMode === opt.value" icon="material-symbols:check-rounded" class="icon" width="18" height="18" />
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenuRoot>
          </div>

          <div class="section-row" v-if="hasSettings">
            <div class="section-info">
              <span class="section-label">Settings</span>
              <span class="section-hint">Preferences found</span>
            </div>
            <DropdownMenuRoot>
              <DropdownMenuTrigger class="model-selector-btn" :aria-label="`Settings merge mode: ${labelFor(binaryOptions, settingsMode)}`">
                <span class="model-name-display">{{ labelFor(binaryOptions, settingsMode) }}</span>
                <Icon icon="material-symbols:keyboard-arrow-down-rounded" class="dropdown-icon" />
              </DropdownMenuTrigger>
              <DropdownMenuContent class="model-selector-dropdown import-dropdown" side="bottom" align="end" :side-offset="4">
                <DropdownMenuItem
                  v-for="opt in binaryOptions"
                  :key="opt.value"
                  class="model-list-item"
                  :class="{ selected: settingsMode === opt.value }"
                  @click="settingsMode = opt.value"
                >
                  <span>{{ opt.label }}</span>
                  <Icon v-if="settingsMode === opt.value" icon="material-symbols:check-rounded" class="icon" width="18" height="18" />
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenuRoot>
          </div>

          <p v-if="!hasChats && !hasNotepad && !hasSettings" class="empty-archive">
            No importable data found in this file.
          </p>
        </div>
      </div>

      <div class="panel-footer">
        <button class="cancel-btn" @click="close">Cancel</button>
        <button class="import-btn" :disabled="!canImport || isImporting" @click="handleImport">
          <Icon v-if="isImporting" icon="svg-spinners:180-ring" width="18" height="18" />
          <span>{{ isImporting ? "Importing..." : "Import" }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.import-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2100;
  padding: 1rem;
}

.import-panel {
  background: var(--bg-primary);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-xl);
  width: 100%;
  max-width: 480px;
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

.drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 2rem;
  border: 2px dashed var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.drop-zone:hover,
.drop-zone.dragging {
  border-color: var(--primary);
  background: var(--bg-primary);
}

.drop-zone.hasFile {
  border-color: var(--primary-600);
}

.file-input {
  display: none;
}

.drop-icon {
  color: var(--text-muted);
}

.drop-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 500;
  color: var(--text-primary);
}

.drop-hint {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--text-secondary);
}

.file-name {
  margin: 0.5rem 0 0;
  font-size: 0.8125rem;
  color: var(--primary);
  word-break: break-all;
}

.error-text {
  margin: 1rem 0 0;
  font-size: 0.875rem;
  color: var(--destructive);
  text-align: center;
}

.sections {
  margin-top: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.sections-title {
  margin: 0 0 0.25rem;
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.section-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.875rem 1rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.section-info {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.section-label {
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--text-primary);
}

.section-hint {
  font-size: 0.8125rem;
  color: var(--text-secondary);
}

.import-dropdown {
  min-width: auto;
  width: auto;
}

.empty-archive {
  margin: 0;
  padding: 1rem;
  text-align: center;
  font-size: 0.875rem;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
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
.import-btn {
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

.import-btn {
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
}

.import-btn:hover:not(:disabled) {
  background: var(--primary-600);
}

.import-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
