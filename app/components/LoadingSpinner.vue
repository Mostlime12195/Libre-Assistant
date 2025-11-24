<template>
  <div class="loading-spinner">
    <div class="circle"></div>
  </div>
</template>

<script>
export default {
  name: 'LoadingSpinner'
}
</script>

<style scoped>
.loading-spinner {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  height: 1.2em;
  /* Keep it within one line of text */
}

.circle {
  width: 0.9em;
  height: 0.9em;
  border-radius: 50%;
  background-color: var(--primary);
  /* Use the primary color */
  animation: resize 2s infinite ease-in-out;
}

@keyframes resize {

  0%,
  100% {
    transform: scale(1);
  }

  50% {
    transform: scale(1.2);
  }
}
</style>