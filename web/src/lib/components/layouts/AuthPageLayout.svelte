<script lang="ts">
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import type { Snippet } from 'svelte';
  interface Props {
    title?: string;
    subtitle?: string;
    children?: Snippet;
    withHeader?: boolean;
  }

  let { title, subtitle, children, withHeader = true }: Props = $props();
</script>

<AuthShell {title} {subtitle} {withHeader}>
  {@render children?.()}
</AuthShell>
