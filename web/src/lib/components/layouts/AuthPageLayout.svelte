<script lang="ts">
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import type { Snippet } from 'svelte';
  interface Props {
    title?: string;
    subtitle?: string;
    children?: Snippet;
    withHeader?: boolean;
    withBackdrop?: boolean;
  }

  // `withBackdrop` is accepted for call-site compatibility only: the Frameleaf auth
  // shell has no logo backdrop to suppress.
  let { title, subtitle, children, withHeader = true }: Props = $props();
</script>

<AuthShell {title} {subtitle} {withHeader}>
  {@render children?.()}
</AuthShell>
