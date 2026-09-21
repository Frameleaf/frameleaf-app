<script lang="ts">
  let { onRefresh }: { onRefresh: () => Promise<void> } = $props();
</script>

<button type="button" onclick={onRefresh}>Refresh people</button>
