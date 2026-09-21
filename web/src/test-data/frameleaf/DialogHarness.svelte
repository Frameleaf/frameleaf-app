<script lang="ts">
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  let open = $state(false);
  let opener = $state<HTMLButtonElement>();
</script>

<button bind:this={opener} type="button" onclick={() => (open = true)}>Open details</button>
<Dialog title="Details" closeLabel="Close details" returnFocus={opener} bind:open><input aria-label="Name" /></Dialog>
