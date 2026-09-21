<script lang="ts">
  let { message, busy = false }: { message: string; busy?: boolean } = $props();
</script>

<p role="status" aria-live="polite" aria-busy={busy}>{message}</p>

<style>
  p {
    color: var(--fl-muted);
    margin: 0;
  }
</style>
