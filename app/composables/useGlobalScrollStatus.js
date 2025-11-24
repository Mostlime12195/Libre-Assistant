import { ref, computed } from 'vue';

// Create a global state for scroll status
const globalIsScrolledTop = ref(true);

/**
 * Composable to manage global scroll status
 */
export function useGlobalScrollStatus() {
  const setIsScrolledTop = (value) => {
    globalIsScrolledTop.value = value;
  };

  const getIsScrolledTop = computed(() => globalIsScrolledTop.value);

  return {
    setIsScrolledTop,
    getIsScrolledTop
  };
}