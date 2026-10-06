<script lang="ts">
  import Toast from './Toast.svelte';
  import TooltipProvider from '../Tooltip/TooltipProvider.svelte';
  import { zIndex } from '../../constants.js';
  import { isCustomToast } from '../../services/toast-manager.svelte.js';
  import type { ToastPanelProps } from '../../types.js';
  import { cleanClass } from '../../utilities/internal.js';

  const { items, class: className, ...props }: ToastPanelProps = $props();

  const isEmpty = $derived(items.length === 0);
</script>

<TooltipProvider>
  <div
    class={cleanClass(
      isEmpty ? 'hidden' : 'absolute top-0 right-0 flex flex-col items-end justify-end gap-2 p-4',
      zIndex.ToastPanel,
      className,
    )}
    {...props}
  >
    {#each items as item (item.id)}
      {#if isCustomToast(item)}
        <item.component {...item.props} />
      {:else}
        <Toast {...item} />
      {/if}
    {/each}
  </div>
</TooltipProvider>
