import { ref } from 'vue';

// Create a shared ref for incognito state
const globalIsIncognito = ref(false);

/**
 * Composable to manage global incognito state
 * This allows the layout and pages to share the same incognito state
 */
export function useGlobalIncognito() {
  return {
    isIncognito: globalIsIncognito,
    toggleIncognito: () => {
      globalIsIncognito.value = !globalIsIncognito.value;
    },
    setIncognito: (value) => {
      globalIsIncognito.value = value;
    }
  };
}