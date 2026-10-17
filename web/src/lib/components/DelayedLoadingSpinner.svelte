<script lang="ts">
  import { LoadingSpinner } from '@frameleaf/ui';
</script>

<div class="delayed-spinner absolute flex h-full items-center justify-center">
  <LoadingSpinner />
</div>

<style>
  @keyframes delayedVisibility {
    to {
      visibility: visible;
    }
  }

  .delayed-spinner {
    visibility: hidden;
    animation: 0s linear 0.4s forwards delayedVisibility;
  }
</style>
