<script lang="ts">
  import '$lib/frameleaf/tokens.css';
  import type { Snippet } from 'svelte';
  let { theme, children }: { theme: 'dark' | 'light'; children: Snippet } = $props();
</script>

<div class="frameleaf" data-theme={theme}>{@render children()}</div>
