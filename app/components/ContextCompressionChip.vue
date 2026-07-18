<script setup>
/**
 * ContextCompressionChip
 * ----------------------
 * A small, unobtrusive floating pill shown above the composer when a
 * conversation's effective context crosses the compression threshold.
 * It appears regardless of whether auto compression is enabled —
 * manual compression is always offered. Dismissal is per conversation
 * and session-only; the chip re-appears once the context grows ~25%
 * past the dismissal point.
 *
 * The chip never blocks anything: compression runs in the background
 * and the chat stays fully usable while it does.
 */
import { computed, ref, watch, onUnmounted } from "vue";
import { Icon } from "@iconify/vue";
import { useSettings } from "../composables/useSettings";
import { useContextCompression } from "../composables/useContextCompression";

const props = defineProps({
  conversationId: {
    type: [String, Number],
    default: "",
  },
  getVisibleMessages: {
    type: Function,
    required: true,
  },
  branchPath: {
    type: Array,
    default: () => [],
  },
  isIncognito: {
    type: Boolean,
    default: false,
  },
});

const settingsManager = useSettings();
const {
  getCompressionState,
  dismissCompressionPrompt,
  compressConversation,
  formatTokenCount,
} = useContextCompression();

const state = computed(() =>
  props.conversationId ? getCompressionState(String(props.conversationId)) : null,
);

const hasApiKey = computed(
  () => !!settingsManager.settings?.custom_api_key,
);

// Transient success state after a run completes.
const showSuccess = ref(false);
let successTimer = null;
let wasRunning = false;

watch(
  () => state.value?.status,
  (status) => {
    if (
      wasRunning &&
      status === "idle" &&
      state.value?.lastSavings &&
      !state.value?.lastError
    ) {
      showSuccess.value = true;
      clearTimeout(successTimer);
      successTimer = setTimeout(() => {
        showSuccess.value = false;
      }, 5000);
    }
    wasRunning = status === "running";
  },
);

watch(
  () => props.conversationId,
  () => {
    showSuccess.value = false;
    clearTimeout(successTimer);
  },
);

onUnmounted(() => clearTimeout(successTimer));

const mode = computed(() => {
  const s = state.value;
  if (!s) return "hidden";
  if (s.status === "running") return "running";
  if (showSuccess.value) return "success";
  if (s.lastError && s.thresholdReached) return "error";
  if (s.thresholdReached && !s.dismissed) return "prompt";
  return "hidden";
});

const visible = computed(
  () =>
    !props.isIncognito &&
    hasApiKey.value &&
    !!props.conversationId &&
    mode.value !== "hidden",
);

const tokensSaved = computed(() => {
  const s = state.value?.lastSavings;
  if (!s) return 0;
  return Math.max(0, s.sourceTokens - s.summaryTokens);
});

const text = computed(() => {
  const s = state.value;
  switch (mode.value) {
    case "running":
      return s?.progress?.current > 1
        ? `Compressing context… (${s.progress.current})`
        : "Compressing context…";
    case "success":
      return `Context compressed · saved ${formatTokenCount(tokensSaved.value)} tokens`;
    case "error":
      return "Compression failed";
    case "prompt":
      return `Context is getting long (${formatTokenCount(s?.effectiveTokens)} tokens)`;
    default:
      return "";
  }
});

const icon = computed(() => {
  switch (mode.value) {
    case "success":
      return "material-symbols:check-circle-outline";
    case "error":
      return "material-symbols:error-outline";
    default:
      return "material-symbols:compress";
  }
});

async function compressNow() {
  if (!props.conversationId || state.value?.status === "running") return;
  if (state.value) state.value.lastError = null;
  await compressConversation({
    conversationId: String(props.conversationId),
    getVisibleMessages: props.getVisibleMessages,
    settings: settingsManager.settings,
    apiKey: settingsManager.settings.custom_api_key,
    branchPath: props.branchPath,
    mode: "manual",
  });
}

function dismiss() {
  if (state.value) state.value.lastError = null;
  dismissCompressionPrompt(String(props.conversationId));
  showSuccess.value = false;
}
</script>

<template>
  <Transition name="chip-fade">
    <div
      v-if="visible"
      class="context-compression-chip"
      :class="`chip-${mode}`"
      role="status"
    >
      <span v-if="mode === 'running'" class="chip-spinner" aria-hidden="true" />
      <Icon v-else :icon="icon" width="14" height="14" class="chip-icon" />
      <span class="chip-text">{{ text }}</span>
      <button
        v-if="mode === 'prompt'"
        type="button"
        class="chip-action"
        @click="compressNow"
      >
        Compress
      </button>
      <button
        v-if="mode === 'error'"
        type="button"
        class="chip-action"
        @click="compressNow"
      >
        Retry
      </button>
      <button
        v-if="mode === 'prompt' || mode === 'error' || mode === 'success'"
        type="button"
        class="chip-dismiss"
        aria-label="Dismiss"
        @click="dismiss"
      >
        <Icon icon="material-symbols:close" width="13" height="13" />
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.context-compression-chip {
  /* Float just above the sticky composer without shifting layout much. */
  position: sticky;
  bottom: 104px;
  align-self: center;
  z-index: 11;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  width: fit-content;
  max-width: 100%;
  margin-bottom: 6px;
  padding: 5px 11px;
  border-radius: 999px;
  font-size: 0.75rem;
  line-height: 1.2;
  background: var(--bg-input);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  box-shadow: var(--shadow-default);
  user-select: none;
  -webkit-user-select: none;
}

.chip-icon {
  flex-shrink: 0;
  color: var(--text-muted, var(--text-secondary));
}

.chip-success .chip-icon {
  color: var(--success, #22c55e);
}

.chip-error .chip-icon {
  color: var(--error, #ef4444);
}

.chip-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chip-action {
  background: transparent;
  border: none;
  padding: 2px 6px;
  margin: -2px -4px -2px 0;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--primary);
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.chip-action:hover {
  background: var(--btn-hover);
}

.chip-dismiss {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  padding: 2px;
  margin: -2px -4px -2px 0;
  border-radius: 6px;
  color: var(--text-muted, var(--text-secondary));
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.chip-dismiss:hover {
  background: var(--btn-hover);
  color: var(--text-primary);
}

.chip-spinner {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: chip-spin 0.8s linear infinite;
}

@keyframes chip-spin {
  to {
    transform: rotate(360deg);
  }
}

.chip-fade-enter-active,
.chip-fade-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.chip-fade-enter-from,
.chip-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
