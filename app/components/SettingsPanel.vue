<script setup>
import { onMounted, ref, watch } from "vue";
import { useSettings } from "@/composables/useSettings";
import { useDark, useToggle } from "@vueuse/core";
import { SwitchRoot, SwitchThumb } from "reka-ui";
import { Icon } from "@iconify/vue";
import { listMemory, deleteMemory, clearAllMemory } from "@/composables/memory";

// Define props and emits
const props = defineProps(["isOpen", "initialTab"]);
const emit = defineEmits(["reloadSettings", "close"]);

// --- Reactive State Variables ---
const settingsManager = useSettings();
const currTab = ref("general");
const isDark = useDark();
const toggleDark = useToggle(isDark);
const globalMemoryEnabled = ref(false);
const gptOssLimitTables = ref(false);
const memoryFacts = ref([]);

// User profile fields
const userName = ref("");
const occupation = ref("");
const customInstructions = ref("");

// --- Constants for Navigation ---
const navItems = [
  {
    key: "general",
    label: "General",
    icon: "material-symbols:settings"
  },
  {
    key: "customization",
    label: "Customization",
    icon: "material-symbols:palette"
  },
  {
    key: "memory",
    label: "Memory",
    icon: "material-symbols:memory"
  },
  {
    key: "about",
    label: "About",
    icon: "material-symbols:info"
  }
];

// --- Lifecycle Hooks ---
onMounted(async () => {
  await settingsManager.loadSettings();
  console.log("Loaded settings:", settingsManager.settings);
  userName.value = settingsManager.settings.user_name || "";
  occupation.value = settingsManager.settings.occupation || "";
  customInstructions.value = settingsManager.settings.custom_instructions || "";
  globalMemoryEnabled.value = settingsManager.settings.global_memory_enabled === true;
  gptOssLimitTables.value = settingsManager.settings.gpt_oss_limit_tables === true;

  // Load memory facts
  await loadMemoryFacts();
});

watch(
  () => props.isOpen,
  (newVal) => {
    if (newVal) {
      currTab.value = props.initialTab || "general";
    }
  }
);

watch(globalMemoryEnabled, (newVal) => {
  console.log("globalMemoryEnabled changed to:", newVal);
});

// --- Functions ---
async function loadMemoryFacts() {
  memoryFacts.value = await listMemory();
}

function closeSettings() {
  emit("close");
}

function toggleGlobalMemory(val) {
  console.log("Toggling global memory from", globalMemoryEnabled.value, "to", val);
  globalMemoryEnabled.value = val;
}

async function saveSettings() {
  // Save settings logic
  settingsManager.setSetting("user_name", userName.value);
  settingsManager.setSetting("occupation", occupation.value);
  settingsManager.setSetting("custom_instructions", customInstructions.value);
  settingsManager.setSetting("global_memory_enabled", globalMemoryEnabled.value);
  settingsManager.setSetting("gpt_oss_limit_tables", gptOssLimitTables.value);

  console.log("Saving settings:", {
    user_name: userName.value,
    occupation: occupation.value,
    custom_instructions: customInstructions.value,
    global_memory_enabled: globalMemoryEnabled.value,
    gpt_oss_limit_tables: gptOssLimitTables.value
  });

  await settingsManager.saveSettings();

  // Reload memory facts after saving settings
  await loadMemoryFacts();

  // Close settings and refresh the page
  closeSettings();
  location.reload();
}

async function removeMemoryFact(fact) {
  try {
    await deleteMemory(fact);
    // Reload the memory facts after deletion
    await loadMemoryFacts();
  } catch (error) {
    console.error("Error deleting memory fact:", error);
  }
}

async function handleClearAllMemory() {
  if (confirm("Are you sure you want to clear all memory? This cannot be undone.")) {
    try {
      await clearAllMemory();
      // Reload the memory facts after clearing
      await loadMemoryFacts();
    } catch (error) {
      console.error("Error clearing all memory:", error);
    }
  }
}
</script>

<template>
  <div class="settings-overlay" v-if="isOpen" @click.self="closeSettings">
    <div class="settings-panel">
      <!-- Header -->
      <div class="panel-header">
        <div class="header-content">
          <h1 class="panel-title">Settings</h1>
        </div>
        <button class="close-btn" @click="closeSettings" aria-label="Close settings">
          <Icon icon="material-symbols:close" width="20" height="20" />
        </button>
      </div>

      <div class="panel-content-wrapper">
        <!-- Vertical Navigation -->
        <div class="settings-nav">
          <div class="nav-items">
            <div v-for="item in navItems" :key="item.key" class="nav-item">
              <button class="nav-link" :class="{ active: currTab === item.key }" @click="currTab = item.key">
                <Icon :icon="item.icon" width="24" height="24" />
                <span class="nav-label">{{ item.label }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Content Area -->
        <div class="panel-content">
          <!-- General Tab -->
          <div v-show="currTab === 'general'" class="settings-section">
            <div class="settings-content">
              <div class="content-header">
                <h2>General Settings</h2>
                <p>Basic configuration options</p>
              </div>
              <div class="setting-item">
                <div class="setting-info">
                  <h3>Dark Mode</h3>
                  <p>Toggle between light and dark themes</p>
                </div>
                <div class="switch-container">
                  <SwitchRoot class="switch-root" :modelValue="isDark" @update:modelValue="toggleDark()">
                    <SwitchThumb class="switch-thumb" />
                  </SwitchRoot>
                </div>
              </div>
              <div class="setting-item">
                <div class="setting-info">
                  <h3>Limit Tables for GPT-OSS</h3>
                  <p>When using GPT-OSS models (20B or 120B), limit table usage as much as possible</p>
                </div>
                <div class="switch-container">
                  <SwitchRoot class="switch-root" :modelValue="gptOssLimitTables" @update:modelValue="gptOssLimitTables = $event">
                    <SwitchThumb class="switch-thumb" />
                  </SwitchRoot>
                </div>
              </div>
            </div>
          </div>

          <!-- Customization Tab -->
          <div v-show="currTab === 'customization'" class="settings-section">
            <div class="settings-content">
              <div class="content-header">
                <h2>Customization</h2>
                <p>Personalize your experience</p>
              </div>

              <div class="setting-item textarea-item">
                <div class="setting-info">
                  <h3>What should Libre call you?</h3>
                  <p>Enter your name</p>
                </div>
                <div class="input-container">
                  <input v-model="userName" type="text" placeholder="Enter your name" class="custom-input" />
                </div>
              </div>

              <div class="setting-item textarea-item">
                <div class="setting-info">
                  <h3>What occupation do you have?</h3>
                  <p>Teacher, software engineer, student, etc.</p>
                </div>
                <div class="input-container">
                  <input v-model="occupation" type="text" placeholder="Teacher, software engineer, student, etc."
                    class="custom-input" />
                </div>
              </div>

              <div class="setting-item textarea-item">
                <div class="setting-info">
                  <h3>What custom instructions do you want Libre to follow?</h3>
                  <p>Be precise, be witty, etc.</p>
                </div>
                <div class="input-container">
                  <textarea v-model="customInstructions" placeholder="Be precise, be witty, etc."
                    class="custom-textarea" rows="3"></textarea>
                </div>
              </div>
            </div>
          </div>

          <!-- Memory Tab -->
          <div v-show="currTab === 'memory'" class="settings-section">
            <div class="settings-content">
              <div class="content-header">
                <h2>Memory</h2>
                <p>Manage conversation memory</p>
              </div>
              <div class="setting-item">
                <div class="setting-info">
                  <h3>Global Memory</h3>
                  <p>Remember important facts about you across conversations</p>
                </div>
                <div class="switch-container">
                  <SwitchRoot class="switch-root" :modelValue="globalMemoryEnabled"
                    @update:modelValue="toggleGlobalMemory">
                    <SwitchThumb class="switch-thumb" />
                  </SwitchRoot>
                </div>
              </div>

              <!-- Memory Facts List -->
              <div v-if="globalMemoryEnabled && memoryFacts.length > 0" class="memory-facts-section">
                <h3>Remembered Facts</h3>
                <div class="memory-facts-list">
                  <div v-for="(fact, index) in memoryFacts" :key="index" class="memory-fact-item">
                    <span class="memory-fact-text">{{ fact }}</span>
                    <button @click="removeMemoryFact(fact)" class="delete-memory-btn" aria-label="Delete memory">
                      <Icon icon="material-symbols:delete" width="18" height="18" />
                    </button>
                  </div>
                </div>
                <div class="clear-memory-container">
                  <button @click="handleClearAllMemory" class="clear-memory-btn">Clear All Memory</button>
                </div>
              </div>

              <div v-else-if="globalMemoryEnabled" class="no-memory-message">
                <p>No memories stored yet. Start a conversation to build your memory.</p>
              </div>

              <div v-else class="memory-disabled-message">
                <p>Global memory is currently disabled. Enable it to start remembering facts about you.</p>
              </div>
            </div>
          </div>

          <!-- About Tab -->
          <div v-show="currTab === 'about'" class="settings-section">
            <div class="settings-content">
              <div class="content-header">
                <h2>About</h2>
                <p>Information about Libre Assistant Interface</p>
              </div>
              <div class="info-section">
                <p>
                  Libre Assistant is a modern, Nuxt-powered interface designed for seamless AI interactions. 
                  Built with developers in mind, it offers a customizable experience that adapts to your needs.
                </p>
                <p>
                  Features include:
                </p>
                <ul>
                  <li>Real-time AI conversation interface</li>
                  <li>Customizable user preferences</li>
                  <li>Persistent memory management</li>
                  <li>Dark/light mode support</li>
                  <li>Hack Club API integration</li>
                </ul>
                <p>
                  For more information, visit our 
                  <a href="https://github.com/Mostlime12195/Libre-Assistant" target="_blank" rel="noopener noreferrer">Libre Assistant GitHub repository</a>.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Footer Actions -->
      <div class="panel-footer">
        <div class="footer-actions">
          <button @click="closeSettings" class="cancel-btn">Cancel</button>
          <button @click="saveSettings" class="save-btn">Save Changes</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
  padding: 1rem;
}

.settings-panel {
  background: var(--bg-primary);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-xl);
  width: 100%;
  max-width: 900px;
  height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
}


/* Header */
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.5rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-primary);
  flex-shrink: 0;
}

.header-content h1 {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-primary);
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  background: var(--btn-hover);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.close-btn:hover {
  background: var(--btn-hover);
  color: var(--text-primary);
}

/* Main Content Layout */
.panel-content-wrapper {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* Vertical Navigation */
.settings-nav {
  width: 200px;
  border-right: 1px solid var(--border);
  background: var(--bg-primary);
  flex-shrink: 0;
  overflow-y: auto;
}

.nav-items {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem;
}

.nav-item {
  width: 100%;
}

.nav-link {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border: none;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: var(--radius-md);
  transition: all 0.2s ease;
  font-size: 0.875rem;
  font-weight: 500;
  width: 100%;
  text-align: left;
}

.nav-link:hover {
  background: var(--btn-hover-2);
  color: var(--text-primary);
}

.nav-link.active {
  background: var(--btn-hover-2);
  color: var(--primary);
}

.nav-label {
  flex: 1;
}

/* Content Area */
.panel-content {
  flex: 1;
  overflow-y: auto;
  background: var(--bg-secondary);
}

.settings-section {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem;
}

.content-header h2 {
  margin: 0 0 0.5rem;
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-primary);
}

.content-header p {
  margin: 0 0 1.5rem;
  color: var(--text-secondary);
}

/* Settings row */
.setting-item {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 0;
  gap: 0.75rem;
}

.setting-item.textarea-item {
  flex-direction: column;
  align-items: stretch;
}

.setting-info h3 {
  margin: 0 0 0.25rem;
  font-size: 1rem;
  font-weight: 500;
  color: var(--text-primary);
}

.setting-info p {
  margin: 0;
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.setting-item.textarea-item .setting-info {
  margin-bottom: 0.5rem;
}

.input-container {
  width: 100%;
  max-width: 400px;
}

.setting-item.textarea-item .input-container {
  max-width: 400px;
}

.custom-input,
.custom-textarea {
  width: 100%;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.875rem;
  resize: vertical;
}

.custom-input:focus,
.custom-textarea:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-a2);
}

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

.clear-memory-container {
  margin-top: 1.5rem;
  display: flex;
  justify-content: flex-end;
}

.clear-memory-btn {
  padding: 0 1rem;
  background: var(--destructive);
  color: var(--destructive-foreground);
  border: none;
  border-radius: var(--radius-md);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.clear-memory-btn:hover {
  background: var(--destructive-600);
}

/* Memory Facts List */
.memory-facts-section {
  margin-top: 1.5rem;
}

.memory-facts-section h3 {
  margin: 0 0 1rem;
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--text-primary);
}

.memory-facts-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.memory-fact-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  transition: all 0.2s ease;
}

.memory-fact-item:hover {
  border-color: var(--primary-300);
}

.memory-fact-text {
  flex: 1;
  font-size: 0.875rem;
  color: var(--text-primary);
  word-break: break-word;
  padding-right: 1rem;
}

.delete-memory-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  background: transparent;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.delete-memory-btn:hover {
  background: var(--bg-tertiary);
  color: var(--destructive);
}

.no-memory-message,
.memory-disabled-message {
  margin-top: 1.5rem;
  padding: 1rem;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.no-memory-message p,
.memory-disabled-message p {
  margin: 0;
  font-size: 0.875rem;
  color: var(--text-secondary);
}

/* Footer */
.panel-footer {
  padding: 1.25rem 1.5rem;
  border-top: 1px solid var(--border);
  background: var(--bg-primary);
  flex-shrink: 0;
}

.footer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}

.cancel-btn,
.save-btn {
  padding: 0 1.25rem;
  border-radius: var(--radius-md);
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
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

.save-btn {
  background: var(--primary);
  color: var(--primary-foreground);
  border: none;
}

.save-btn:hover {
  background: var(--primary-600);
}

/* Responsive */
@media (max-width: 768px) {
  .settings-nav {
    width: 60px;
  }

  .nav-label {
    display: none;
  }

  /* Make nav buttons smaller and center the icon */
  .nav-link {
    width: 36px;
    /* Reduced width */
    height: 36px;
    /* Reduced height, keep it square */
    padding: 0.6rem;
    /* Adjusted padding */
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0.25rem auto;
    /* Center the button within the 60px nav item */
  }

  .settings-panel {
    height: 100dvh;
  }

  .settings-overlay {
    padding: 0;
    align-items: stretch;
    justify-content: stretch;
  }

  .settings-panel {
    max-width: 100vw;
    height: 100dvh;
    border-radius: 0;
    box-shadow: none;
  }

  .settings-content {
    padding-left: 1rem;
    padding-right: 1rem;
  }

  .input-container {
    max-width: 100%;
  }
}

/* Horizontal Navigation (for tall narrow screens) */
@media (max-aspect-ratio: 2/3) {
  .panel-content-wrapper {
    flex-direction: column;
  }

  .settings-nav {
    width: 100%;
    border-right: none;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    overflow-y: hidden;
    overflow-x: auto;
  }

  .nav-items {
    flex-direction: row;
    padding: 0.25rem 0.5rem;
  }
}
</style>
