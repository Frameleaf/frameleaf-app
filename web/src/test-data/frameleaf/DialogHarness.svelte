<script lang="ts">
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  let open = $state(false);
</script>

<button type="button" onclick={() => (open = true)}>Open details</button>
<Dialog title="Details" closeLabel="Close details" bind:open><input aria-label="Name" /></Dialog>
