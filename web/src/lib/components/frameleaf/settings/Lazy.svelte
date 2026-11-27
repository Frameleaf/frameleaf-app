<script lang="ts">
  /**
   * Draws a settings page whose code is fetched when the page is first opened (FL-1799), so the
   * Command Center does not ship every section up front. While the code loads it shows the same
   * placeholder a section shows while its data loads.
   */
  import type { Component } from 'svelte';
  import Loader from './Loader.svelte';

  type Props = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each page declares its own props
    load: () => Promise<{ default: Component<any> }>;
    props?: Record<string, unknown>;
  };

  let { load, props = {} }: Props = $props();

  // A page's code that failed to arrive is usually from a release this tab predates: the browser
  // keeps the failure, so only a reload fetches the current files. Unsaved server settings come back
  // from the tab's draft journal.
  const reload = () => location.reload();
</script>

{#key load}
  <Loader {load} onRetry={reload}>
    {#snippet children(module)}
      <module.default {...props} />
    {/snippet}
  </Loader>
{/key}
