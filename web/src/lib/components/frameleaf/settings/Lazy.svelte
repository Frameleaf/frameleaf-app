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
</script>

{#key load}
  <Loader {load}>
    {#snippet children(module)}
      <module.default {...props} />
    {/snippet}
  </Loader>
{/key}
