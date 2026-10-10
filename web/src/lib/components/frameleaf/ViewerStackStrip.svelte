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
  import { updateStack, type AssetResponseDto, type StackResponseDto } from '@frameleaf/sdk';
  import { Button, Icon, modalManager } from '@frameleaf/ui';
  import { mdiCrownOutline, mdiLayersTripleOutline } from '@mdi/js';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { t } from 'svelte-i18n';

  type Props = {
    stack: StackResponseDto;
    asset: AssetResponseDto;
    onAction: OnAction;
    onSelect: (asset: AssetResponseDto) => void;
    onPreview: (asset: AssetResponseDto | undefined) => void;
  };

  let { stack, asset, onAction, onSelect, onPreview }: Props = $props();

  // One tile for every strip in the viewer (see ViewerFilmstrip).
  const tileWidth = 76;
  const tileHeight = 56;

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

<div class="fl-stack" data-testid="viewer-stack-strip">
  <div class="fl-stack-head dark">
    <Icon icon={mdiLayersTripleOutline} size={ICON_SIZE.sm} aria-hidden />
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

  <div class="fl-strip">
    {#each stack.assets as stackedAsset (stackedAsset.id)}
      {@const isCurrent = stackedAsset.id === asset.id}
      <div class="fl-strip-tile" class:current={isCurrent} aria-current={isCurrent ? 'true' : undefined}>
        <Thumbnail
          brokenAssetClass="text-xs"
          asset={toTimelineAsset(stackedAsset)}
          onClick={() => onSelect(stackedAsset)}
          onMouseEvent={({ isMouseOver }) => onPreview(isMouseOver ? stackedAsset : undefined)}
          readonly
          thumbnailWidth={tileWidth}
          thumbnailHeight={tileHeight}
          showStackedIcon={false}
          disableLinkMouseOver
        />

        {#if stack.primaryAssetId === stackedAsset.id}
          <span class="fl-stack-primary">
            <Icon icon={mdiCrownOutline} size={ICON_SIZE.xs} aria-hidden />
            {$t('frameleaf_viewer_stack_primary')}
          </span>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .fl-stack {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: fit-content;
    max-width: 100%;
  }

  .fl-stack-head {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    padding: var(--fl-space-1) var(--fl-space-3) 0;
    color: var(--fl-viewer-text);
    font: var(--fl-type-caption);
  }

  .fl-strip {
    display: flex;
    gap: var(--fl-space-2);
    max-width: 100%;
    padding: var(--fl-space-2) var(--fl-space-3);
    overflow: auto hidden;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--fl-viewer-text) 28%, transparent) transparent;
  }

  /* The same tile as the filmstrip: the open item at full strength inside an accent ring. */
  .fl-strip-tile {
    position: relative;
    flex-shrink: 0;
    overflow: hidden;
    border-radius: var(--fl-radius-control);
    opacity: 0.72;
    box-shadow: 0 0 0 2px transparent;
    transition:
      opacity var(--fl-duration-fade) var(--fl-ease),
      box-shadow var(--fl-duration-fade) var(--fl-ease);
  }

  .fl-strip-tile:hover,
  .fl-strip-tile:focus-within {
    opacity: 1;
  }

  .fl-strip-tile.current {
    opacity: 1;
    box-shadow: 0 0 0 2px var(--fl-accent);
  }

  .fl-stack-primary {
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: 0;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: var(--fl-space-half);
    padding: 1px var(--fl-space-1);
    border-end-end-radius: var(--fl-radius-sm);
    background: color-mix(in srgb, var(--fl-viewer-panel) 82%, transparent);
    color: var(--fl-viewer-text);
    font: var(--fl-type-micro);
    pointer-events: none;
  }
</style>
