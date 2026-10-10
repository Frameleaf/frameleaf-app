<script lang="ts">
  import Text from '../Text/Text.svelte';
  import { cleanClass } from '../../utilities/internal.js';
  import type { Snippet } from 'svelte';

  type Props = {
    class?: string;
    children: Snippet;
  };

  let { children, class: className }: Props = $props();
</script>

<Text size="small" class={cleanClass('text-dark/75', className)}>
  {@render children?.()}
</Text>
