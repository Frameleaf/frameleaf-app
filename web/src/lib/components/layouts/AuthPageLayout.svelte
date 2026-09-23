<script lang="ts">
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import type { Snippet } from 'svelte';
  interface Props {
    title?: string;
    children?: Snippet;
    withHeader?: boolean;
  }

  // The Frameleaf auth shell has no logo backdrop, so there is no `withBackdrop` to pass.
  let { title, children, withHeader = true }: Props = $props();
</script>

<AuthShell {title} {withHeader}>
  {@render children?.()}
</AuthShell>
