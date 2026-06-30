<script setup>
/**
 * ContextSummaryMarker
 * --------------------
 * A non-interactive visual marker that sits between a summarized
 * chunk of messages and the next chunk. Renders nothing actionable
 * — no buttons, no hover, no copy, no expand.
 *
 * Two visual states:
 *   - "Compressing" (in_progress): spinner + label "Compressing"
 *   - "Completed": static label "Context summary · messages N–M"
 *   - "Stale": static label "Stale"
 *
 * The component never reveals the summary text to the user; the
 * summary only flows to the model via the API history.
 */
import { computed } from "vue";

const props = defineProps({
  status: {
    type: String,
    default: "completed", // "in_progress" | "completed" | "stale"
  },
  rangeStart: {
    type: Number,
    default: null,
  },
  rangeEnd: {
    type: Number,
    default: null,
  },
});

const statusClass = computed(() => `status-${props.status || "completed"}`);
const label = computed(() => {
  if (props.status === "in_progress") return "Compressing";
  if (props.status === "stale") return "Stale";
  if (
    typeof props.rangeStart === "number" &&
    typeof props.rangeEnd === "number"
  ) {
    return `Context summary · messages ${props.rangeStart}\u2013${props.rangeEnd}`;
  }
  return "Context summary";
});
</script>

<template>
  <div
    class="context-summary-marker"
    :class="statusClass"
    role="separator"
    :aria-label="label"
    :data-status="status"
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
  margin: 18px auto;
  padding: 0 12px;
  box-sizing: border-box;
  user-select: none;
  -webkit-user-select: none;
  pointer-events: none;
  font-size: 0.75rem;
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

.context-summary-marker.status-stale {
  color: var(--text-muted, #8b8b8b);
  font-style: italic;
}

.context-summary-marker.status-completed {
  color: var(--text-muted, #8b8b8b);
}
</style>
