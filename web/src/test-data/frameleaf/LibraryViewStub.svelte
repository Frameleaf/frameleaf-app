<script lang="ts">
  import type { Snippet } from 'svelte';

  /** Stands in for `LibraryView`: shows the timeline options it was given and renders the page's slots. */
  let {
    options,
    children,
    toolbarStart,
    empty,
  }: {
    options?: Record<string, unknown>;
    children?: Snippet;
    toolbarStart?: Snippet;
    empty?: Snippet;
  } = $props();
</script>

<output data-testid="library-options">{JSON.stringify(options)}</output>
{@render children?.()}
<div data-testid="library-toolbar-start">{@render toolbarStart?.()}</div>
<div data-testid="library-empty">{@render empty?.()}</div>
