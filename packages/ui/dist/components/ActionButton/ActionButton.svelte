<script lang="ts">
  import Button from '../Button/Button.svelte';
  import IconButton from '../IconButton/IconButton.svelte';
  import type { ActionItem, Color, Size, Variants } from '../../types.js';
  import { isEnabled } from '../../utilities/common.js';
  import { mdiPlus } from '@mdi/js';

  type Props = {
    action: ActionItem & { data?: { title?: string } };
    color?: Color;
    size?: Size;
    variant?: Variants;
    type?: 'icon' | 'button';
  };

  const { action, type = 'icon', size, color: colorOverride, variant: variantOverride }: Props = $props();
  const { title, icon, onAction } = $derived(action);
  const common = $derived({
    variant: variantOverride ?? 'ghost',
    color: colorOverride ?? action.color ?? 'secondary',
    onclick: () => onAction(action),
  });
</script>

{#if isEnabled(action)}
  {#if type === 'icon'}
    <IconButton {...common} {size} shape="round" icon={icon ?? mdiPlus} aria-label={title} />
  {:else if type === 'button'}
    <Button {...common} size={size ?? 'small'} leadingIcon={icon} title={action.data?.title}>
      {title}
    </Button>
  {/if}
{/if}
