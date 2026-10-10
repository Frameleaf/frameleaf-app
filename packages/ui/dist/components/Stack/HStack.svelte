<script lang="ts">
  import Stack from './Stack.svelte';
  import type { HStackProps } from '../../types.js';

  const { class: className, children, ...props }: HStackProps = $props();
</script>

<Stack direction="row" align="center" class={className} {...props}>
  {@render children()}
</Stack>
