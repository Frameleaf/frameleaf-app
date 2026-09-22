<script lang="ts">
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import type { Snippet } from 'svelte';
  interface Props {
    title?: string;
    children?: Snippet;
    withHeader?: boolean;
    withBackdrop?: boolean;
  }

  // `withBackdrop` is accepted for call-site compatibility only: the Frameleaf auth
  // shell has no logo backdrop to suppress.
  let { title, children, withHeader = true }: Props = $props();
</script>

<AuthShell {title} {withHeader}>
  {@render children?.()}
</AuthShell>
