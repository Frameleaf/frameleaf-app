<script lang="ts">
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import type { Snippet } from 'svelte';
  interface Props {
    title?: string;
    children?: Snippet;
    withHeader?: boolean;
    hero?: 'summit' | 'cabin';
    keypad?: 'auto' | 'always' | 'never';
  }

  // Legacy public/maintenance callers stay on the single pane; auth routes opt into prototype hero art.
  let { title, children, withHeader = true, hero, keypad = 'auto' }: Props = $props();
</script>

<AuthShell {title} {withHeader} {hero} {keypad}>
  {@render children?.()}
</AuthShell>
