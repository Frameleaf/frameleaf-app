<script lang="ts">
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { TooltipProvider } from '@frameleaf/ui';
  import { mdiDotsVertical } from '@mdi/js';

  let {
    hideContent = false,
    onFirst = () => {},
    onSecond = () => {},
    onStandalone = () => {},
  } = $props<{
    hideContent?: boolean;
    onFirst?: () => void;
    onSecond?: () => void;
    onStandalone?: () => void;
  }>();
</script>

<TooltipProvider>
  <ButtonContextMenu icon={mdiDotsVertical} title="First" {hideContent}>
    <MenuOption text="First option" onClick={onFirst} />
  </ButtonContextMenu>
  <ButtonContextMenu icon={mdiDotsVertical} title="Second">
    <MenuOption text="Second option" onClick={onSecond} />
  </ButtonContextMenu>
  <ul role="menu" aria-label="Standalone">
    <MenuOption text="Standalone option" onClick={onStandalone} />
  </ul>
</TooltipProvider>
