<script lang="ts" generics="T extends Record<string, unknown>">
  import { TooltipProvider } from '@frameleaf/ui';
  import type { Component } from 'svelte';

  type Props = {
    component: Component<T>;
    componentProps: T;
  };

  const { component: Test, componentProps }: Props = $props();
</script>

<TooltipProvider>
  <Test {...componentProps} />
</TooltipProvider>
