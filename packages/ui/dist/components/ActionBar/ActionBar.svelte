<script lang="ts">
  import ActionButton from '../ActionButton/ActionButton.svelte';
  import ContextMenuButton from '../ContextMenu/ContextMenuButton.svelte';
  import ControlBar from '../ControlBar/ControlBar.svelte';
  import ControlBarOverflow from '../ControlBar/ControlBarOverflow.svelte';
  import type { ActionBarProps } from '../../types.js';
  import { isEnabled, isMenuItemType } from '../../utilities/common.js';

  const { actions = [], overflowActions = [], children, ...restProps }: ActionBarProps = $props();

  const items = $derived(
    overflowActions.filter((action) => action !== undefined && (isMenuItemType(action) || isEnabled(action))),
  );
</script>

<ControlBar {...restProps}>
  {@render children?.()}
  <ControlBarOverflow>
    {#each actions as action, i (i)}
      <ActionButton {action} />
    {/each}
    <ContextMenuButton {items} />
  </ControlBarOverflow>
</ControlBar>
