<script lang="ts">
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  let { withActions = false, wide = false }: { withActions?: boolean; wide?: boolean } = $props();
  let open = $state(false);
  let opener = $state<HTMLButtonElement>();
</script>

<button bind:this={opener} type="button" onclick={() => (open = true)}>Open details</button>
{#if withActions}
  <Dialog title="Details" closeLabel="Close details" returnFocus={opener} {wide} bind:open>
    <input aria-label="Name" />
    <input aria-label="Place" data-initial-focus />
    {#snippet actions()}
      <button type="button" class="button primary" onclick={() => (open = false)}>Save</button>
    {/snippet}
  </Dialog>
{:else}
  <Dialog title="Details" closeLabel="Close details" returnFocus={opener} {wide} bind:open
    ><input aria-label="Name" /></Dialog
  >
{/if}
