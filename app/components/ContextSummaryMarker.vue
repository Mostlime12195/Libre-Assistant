<script setup>
/**
 * ContextSummaryMarker
 * --------------------
 * A subtle divider rendered at the boundary where a span of earlier
 * messages has been compressed into a sidecar summary. Purely
 * presentational: the marker is NOT a chat message and never touches
 * the messages array — ChatPanel renders it after the message whose
 * id is the summary's anchor.
 *
 * States:
 *   - "in_progress": spinner + "Compressing context…"
 *   - "completed":   "Earlier messages summarized · ~X → ~Y tokens"
 */
import { computed } from "vue";
import { formatTokenCount } from "../composables/contextCompressionPipeline";

const props = defineProps({
  status: {
    type: String,
    default: "completed", // "in_progress" | "completed"
  },
  sourceTokens: {
    type: Number,
    default: null,
  },
  summaryTokens: {
    type: Number,
    default: null,
  },
});

const statusClass = computed(() => `status-${props.status || "completed"}`);
const label = computed(() => {
  if (props.status === "in_progress") return "Compressing context…";
  let text = "Earlier messages summarized";
  if (
    typeof props.sourceTokens === "number" &&
    typeof props.summaryTokens === "number" &&
    props.sourceTokens > 0 &&
    props.summaryTokens > 0
  ) {
    text += ` · ${formatTokenCount(props.sourceTokens)} → ${formatTokenCount(props.summaryTokens)} tokens`;
  }
  return text;
});
</script>

<template>
  <div
    class="context-summary-marker"
    :class="statusClass"
    role="separator"
    :aria-label="label"
    :data-status="status"
    :title="status === 'completed' ? 'These earlier messages are sent to the model as a summary. The originals stay on your device.' : 'Summarizing earlier messages in the background…'"
  >
    <div class="line line-left" />
    <div class="marker-label">
      <span v-if="status === 'in_progress'" class="spinner" aria-hidden="true" />
      <span class="label-text">{{ label }}</span>
    </div>
    <div class="line line-right" />
  </div>
</template>

<style scoped>
.context-summary-marker {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  max-width: 800px;
  margin: 14px auto;
  padding: 0 12px;
  box-sizing: border-box;
  user-select: none;
  -webkit-user-select: none;
  font-size: 0.72rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted, #8b8b8b);
}

.line {
  flex: 1;
  height: 1px;
  background: var(--border, #e0e0e0);
  opacity: 0.6;
}

.marker-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  font-weight: 500;
}

.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: ctx-spin 0.8s linear infinite;
  display: inline-block;
}

@keyframes ctx-spin {
  to {
    transform: rotate(360deg);
  }
}

.context-summary-marker.status-in_progress {
  color: var(--text-secondary, #555);
}

.context-summary-marker.status-completed {
  color: var(--text-muted, #8b8b8b);
}
</style>
