<script lang="ts" module>
  /** How many videos the stand-in strip reports, set by the spec. */
  export const moments = $state({ found: 0 });
</script>

<script lang="ts">
  let { found = $bindable(0) }: { query?: string; found?: number } = $props();
  $effect(() => {
    found = moments.found;
  });
</script>
