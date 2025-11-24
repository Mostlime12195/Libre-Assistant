<template>
  <div class="svg-logo" ref="svgContainerRef"></div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue';

const props = defineProps({
  src: {
    type: String,
    required: true
  },
  size: {
    type: Number,
    default: 24
  }
});

const svgContainerRef = ref(null);

const loadSvgContent = async () => {
  if (svgContainerRef.value) {
    try {
      const response = await fetch(props.src);
      let svgContent = await response.text();

      // The SVGs already use fill="currentColor", so just make sure we preserve this
      // and don't add unnecessary stroke attributes
      if (svgContainerRef.value) {  // Double-check it still exists
        svgContainerRef.value.innerHTML = svgContent;
      }
    } catch (error) {
      console.error('Error loading SVG:', error);
      if (svgContainerRef.value) {  // Double-check it still exists
        svgContainerRef.value.innerHTML = '<svg></svg>'; // Fallback
      }
    }
  }
};

// Flag to track if component is still mounted
const isMounted = ref(true);

onMounted(() => {
  loadSvgContent();
});

// Watch for changes to the src prop and reload the SVG content when it changes
watch(() => props.src, () => {
  if (isMounted.value) {
    loadSvgContent();
  }
});

onUnmounted(() => {
  isMounted.value = false;
});
</script>

<style scoped>
.svg-logo {
  width: v-bind('props.size + "px"');
  height: v-bind('props.size + "px"');
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
}

.svg-logo :deep(svg) {
  width: 100%;
  height: 100%;
  fill: currentColor;
  color: inherit;
  /* Do not apply stroke to preserve original visual weight */
}
</style>