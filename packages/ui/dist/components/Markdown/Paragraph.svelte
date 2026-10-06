<script lang="ts">
  import Text from '../Text/Text.svelte';
  import type { Snippet } from 'svelte';

  type Props = {
    children: Snippet;
  };

  const { children }: Props = $props();
</script>

<Text>{@render children()}</Text>
