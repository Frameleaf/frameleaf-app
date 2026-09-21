<script lang="ts">
  import DeleteAction from '$lib/components/asset-viewer/actions/DeleteAction.svelte';
  import type { OnAction, PreAction } from '$lib/components/asset-viewer/actions/action';
  import type { AssetResponseDto } from '@immich/sdk';
  let {
    cursor,
    preAction,
    onAction,
  }: {
    cursor: { current: AssetResponseDto };
    preAction: PreAction;
    onAction: OnAction;
  } = $props();
  let completed = $state('');
</script>

<output data-testid="current">{cursor.current.id}</output>
<output data-testid="completed">{completed}</output>
<DeleteAction
  asset={cursor.current}
  {preAction}
  onAction={(action) => {
    onAction(action);
    completed = 'asset' in action ? action.asset.id : '';
  }}
/>
