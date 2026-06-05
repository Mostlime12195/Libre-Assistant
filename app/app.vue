<template>
  <div id="app">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </div>
</template>

<script setup>
import { onMounted, watch } from 'vue';
// Import the main CSS file to ensure all styling is loaded
import './assets/main.css';
import { runNotepadPipeline } from '~/composables/notepadPipeline';
import { useSettings } from '~/composables/useSettings';

const settingsManager = useSettings();

// Debounce so that we don't fire the pipeline multiple times in quick
// succession (e.g. when the user toggles the Notepad setting on and
// off, or when settings hydrate in several localforage round-trips).
let pendingRun = null;

function maybeRunPipeline() {
  if (pendingRun) return;

  const apiKey = settingsManager.settings?.custom_api_key;
  const notepadEnabled = settingsManager.settings?.notepad_enabled === true;

  if (!apiKey || !notepadEnabled) return;

  // Wait a tick in case settings is mid-hydration, then start.
  pendingRun = setTimeout(() => {
    pendingRun = null;
    runNotepadPipeline(apiKey).catch((error) => {
      console.error('[notepad] Pipeline error:', error);
    });
  }, 250);
}

onMounted(() => {
  // If settings are already loaded by the time we mount, fire immediately.
  if (settingsManager.isLoaded) {
    maybeRunPipeline();
  } else {
    // Otherwise watch for the load, fire once, then stop.
    const stop = watch(
      () => settingsManager.isLoaded,
      (loaded) => {
        if (loaded) {
          maybeRunPipeline();
          stop();
        }
      },
      { immediate: true },
    );
  }

  // Re-evaluate when the user toggles the Notepad on/off or sets a key.
  watch(
    () => [
      settingsManager.isLoaded,
      settingsManager.settings?.notepad_enabled,
      settingsManager.settings?.custom_api_key,
    ],
    () => {
      if (settingsManager.isLoaded) maybeRunPipeline();
    },
  );
});
</script>

<style>
a:hover {
  background-color: transparent;
}

html,
body,
#app {
  margin: 0;
  padding: 0;
  height: 100dvh;
  width: 100vw;
  background: var(--bg);
  color: var(--text-primary);
  font-family: var(--font);
  overflow: hidden;
}

img {
  user-select: none;
  -moz-user-select: none;
  -webkit-user-drag: none;
  -webkit-user-select: none;
  -ms-user-select: none;
}

button {
  background: transparent;
  border: none;
  padding: 8px;
  cursor: pointer;
  outline: none;
  border-radius: 12px;
  text-align: center;
  transition: all 0.2s ease;
  color: var(--text-primary);
}

button:hover {
  background-color: var(--bg-tertiary);
}

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

/* Global styles that apply app-wide */
.global-menu-toggle {
  position: fixed;
  z-index: 1800;
  background: transparent;
  border: none;
  box-shadow: none;
  top: 8px;
  left: 8px;
  width: 44px;
  height: 44px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin: 0;
  transition: all 0.18s, transform 0.2s;
  cursor: pointer;
}

.global-menu-toggle:hover {
  background: var(--btn-hover);
  transform: scale(1.05);
}

.dark .global-menu-toggle:hover {
  background: rgba(255, 255, 255, 0.1);
}
</style>