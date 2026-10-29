<script lang="ts">
  import Icon from "./Icon.svelte";
  let {
    origin,
    onSettings,
  }: { origin?: string | null; onSettings?: () => void } = $props();
  const server = $derived(origin ? origin.replace(/^https?:\/\//, "") : "");
</script>

<header class="ext-head">
  <img src="icons/icon48.png" width="20" height="20" alt="" />
  <h1>Save to Frameleaf</h1>
  {#if server}<span class="ext-server" title={`Connected to ${server}`}
      ><span class="visually-hidden">Connected to </span>{server}</span
    >{/if}
  {#if onSettings}<button
      type="button"
      class="icon-button"
      aria-label="Settings"
      title="Settings"
      onclick={onSettings}><Icon name="cogOutline" size={18} /></button
    >{/if}
</header>
