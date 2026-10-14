<script lang="ts">
  let { pathname }: { pathname: string } = $props();

  // Settings must remain usable even when the administrator's CSS hides the rest of the app.
  const settings = $derived(
    ['/user-settings', '/admin'].some((root) => pathname === root || pathname.startsWith(`${root}/`)),
  );
</script>

<svelte:head>
  {#if !settings}
    <link rel="stylesheet" href="/custom.css" />
  {/if}
</svelte:head>
