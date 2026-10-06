<script lang="ts">
  import IconButton from '../IconButton/IconButton.svelte';
  import { menuManager } from '../../services/menu-manager.svelte.js';
  import { t } from '../../services/translation.svelte.js';
  import type { ContextMenuButtonProps } from '../../types.js';
  import { mdiDotsVertical } from '@mdi/js';

  const {
    color = 'secondary',
    position = 'top-right',
    icon = mdiDotsVertical,
    variant = 'ghost',
    shape = 'round',
    'aria-label': ariaLabel,
    items,
    bottomItems,
    translations,
    ...rest
  }: ContextMenuButtonProps = $props();

  const onclick = async (event: Event) => {
    event.stopPropagation();
    event.preventDefault();
    await menuManager.show({ target: event.currentTarget as HTMLElement, position, items, bottomItems });
  };
</script>

{#if items.length > 0}
  <IconButton
    {icon}
    {color}
    {shape}
    {variant}
    aria-label={ariaLabel ?? t('open_menu', translations)}
    {...rest}
    {onclick}
  />
{/if}
