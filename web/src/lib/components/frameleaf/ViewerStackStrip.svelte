<script lang="ts">
  /**
   * The viewer's stack strip (FL-35).
   *
   * The thumbnails are the existing strip from `AssetViewer.svelte`, now with the heading,
   * the primary badge and the two inline decisions the approved template calls for:
   * "keep this, remove the rest" and "set as stack primary". Both go through the same
   * production paths the More-menu entries use — `keepThisDeleteOthers` from
   * `$lib/utils/asset-utils` and `updateStack` from the SDK — and emit the same
   * `AssetAction` events, so no new endpoint or alternative code path is introduced.
   * Both are hidden for anyone who does not own the asset.
   */
  import type { OnAction } from '$lib/components/asset-viewer/actions/action';
  import Thumbnail from '$lib/components/assets/thumbnail/Thumbnail.svelte';
  import { AssetAction } from '$lib/constants';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { keepThisDeleteOthers } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { updateStack, type AssetResponseDto, type StackResponseDto } from '@immich/sdk';
  import { Button, Icon, modalManager } from '@immich/ui';
  import { mdiCrownOutline, mdiLayersTripleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    stack: StackResponseDto;
    asset: AssetResponseDto;
    onAction: OnAction;
    onSelect: (asset: AssetResponseDto) => void;
    onPreview: (asset: AssetResponseDto | undefined) => void;
  };

  let { stack, asset, onAction, onSelect, onPreview }: Props = $props();

  const thumbnailSize = 60;
  const selectedThumbnailSize = 65;

  const isOwner = $derived(authManager.authenticated && asset.ownerId === authManager.user.id);
  const isPrimary = $derived(stack.primaryAssetId === asset.id);

  let busy = $state(false);

  const handleSetPrimary = async () => {
    busy = true;
    try {
      const updatedStack = await updateStack({ id: stack.id, stackUpdateDto: { primaryAssetId: asset.id } });
      if (updatedStack) {
        onAction({ type: AssetAction.SET_STACK_PRIMARY_ASSET, stack: updatedStack });
      }
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_settings'));
    } finally {
      busy = false;
    }
  };

  const handleKeepThis = async () => {
    const isConfirmed = await modalManager.showDialog({
      title: $t('keep_this_delete_others'),
      prompt: $t('confirm_keep_this_delete_others'),
      confirmText: $t('delete_others'),
    });

    if (!isConfirmed) {
      return;
    }

    busy = true;
    try {
      const keptAsset = await keepThisDeleteOthers(asset, stack);
      if (keptAsset) {
        onAction({ type: AssetAction.UNSTACK, assets: [toTimelineAsset(keptAsset)] });
      }
    } finally {
      busy = false;
    }
  };
</script>

<div class="flex w-fit max-w-full flex-col items-start gap-1" data-testid="viewer-stack-strip">
  <div class="dark flex items-center gap-2 px-2 text-xs text-white">
    <Icon icon={mdiLayersTripleOutline} size="15" aria-hidden />
    <span>{$t('frameleaf_viewer_stack_count', { values: { count: stack.assets.length } })}</span>
    {#if isOwner}
      <Button size="tiny" color="secondary" variant="ghost" disabled={busy} onclick={handleKeepThis}>
        {$t('keep_this_delete_others')}
      </Button>
      {#if !isPrimary}
        <Button size="tiny" color="secondary" variant="ghost" disabled={busy} onclick={handleSetPrimary}>
          {$t('set_stack_primary_asset')}
        </Button>
      {/if}
    {/if}
  </div>

  <div class="no-wrap horizontal-scrollbar relative flex flex-row overflow-x-auto overflow-y-hidden">
    {#each stack.assets as stackedAsset (stackedAsset.id)}
      {@const isCurrent = stackedAsset.id === asset.id}
      <div class="relative inline-block px-1 pb-2 transition-all" style:bottom={isCurrent ? '0' : '-10px'}>
        <Thumbnail
          imageClass={isCurrent ? 'border-2 border-white' : 'brightness-70'}
          brokenAssetClass="text-xs"
          asset={toTimelineAsset(stackedAsset)}
          onClick={() => onSelect(stackedAsset)}
          onMouseEvent={({ isMouseOver }) => onPreview(isMouseOver ? stackedAsset : undefined)}
          readonly
          thumbnailSize={isCurrent ? selectedThumbnailSize : thumbnailSize}
          showStackedIcon={false}
          disableLinkMouseOver
        />

        {#if stack.primaryAssetId === stackedAsset.id}
          <span
            class="pointer-events-none absolute inset-s-1 top-0 flex items-center gap-0.5 rounded-ss-sm rounded-ee-sm bg-black/70 px-1 text-[10px] text-white"
          >
            <Icon icon={mdiCrownOutline} size="12" aria-hidden />
            {$t('frameleaf_viewer_stack_primary')}
          </span>
        {/if}

        {#if isCurrent}
          <div class="flex w-full place-content-center place-items-center">
            <div class="mt-0.5 flex size-2 rounded-full bg-white"></div>
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .horizontal-scrollbar::-webkit-scrollbar {
    width: 8px;
    height: 10px;
  }

  .horizontal-scrollbar::-webkit-scrollbar-track {
    background: #000000;
    border-radius: 16px;
  }

  .horizontal-scrollbar::-webkit-scrollbar-thumb {
    background: rgba(159, 159, 159, 0.408);
    border-radius: 16px;
  }

  .horizontal-scrollbar::-webkit-scrollbar-thumb:hover {
    background: #adcbfa;
    border-radius: 16px;
  }
</style>
