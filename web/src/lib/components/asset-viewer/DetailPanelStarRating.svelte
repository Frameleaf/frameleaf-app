<script lang="ts">
  /**
   * The information panel's inline rating (FL-36), ported from the design's Rating section.
   *
   * The write is the production `updateAsset` change endpoint; clearing is the same call with no
   * rating (`null`), which the star control emits when the current value is picked again and the
   * Clear button sends (`RatingStars`, MediaViewer.jsx:2053-2085, audit V-20). As in the template the
   * section is the owner's, and not for an item in the trash (MediaViewer.jsx:2383-2388). A failure
   * states itself in place and offers the recovery that can work.
   */
  import ViewerInlineEditError from '$lib/components/frameleaf/ViewerInlineEditError.svelte';
  import { classifyInlineEditError, inlineEditRecovery, type InlineEditFailure } from '$lib/frameleaf/inline-edit';
  import StarRating, { type Rating } from '$lib/elements/StarRating.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { getAssetInfo, updateAsset, type AssetResponseDto } from '@immich/sdk';
  import { Text } from '@immich/ui';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    isOwner: boolean;
    onAssetRefresh?: (asset: AssetResponseDto) => void;
  }

  let { asset, isOwner, onAssetRefresh }: Props = $props();

  let rating = $derived(asset.exifInfo?.rating ?? null) as Rating;
  let failure = $state<InlineEditFailure | null>(null);
  let isSaving = $state(false);
  /** The last value chosen, so a retryable failure replays that value and not the stored one. */
  let pending = $state<Rating | null>(null);

  const handleChangeRating = async (next: Rating) => {
    isSaving = true;
    pending = next;
    try {
      await updateAsset({ id: asset.id, updateAssetDto: { rating: next } });
      failure = null;
      pending = null;
      // The top row's Rating tool reads the viewer's asset, so hand it the stored value.
      onAssetRefresh?.({ ...asset, exifInfo: { ...asset.exifInfo, rating: next } });
    } catch (error) {
      failure = classifyInlineEditError(error);
      handleError(error, $t('errors.cant_apply_changes'));
    } finally {
      isSaving = false;
    }
  };

  const reload = async () => {
    try {
      const updated = await getAssetInfo({ id: asset.id });
      failure = null;
      pending = null;
      onAssetRefresh?.(updated);
    } catch (error) {
      handleError(error, $t('frameleaf_info_error_reload_failed'));
    }
  };
</script>

{#if isOwner && !asset.isTrashed && !authManager.isSharedLink && authManager.authenticated && authManager.preferences.ratings.enabled}
  <section class="px-4 pt-4" data-testid="frameleaf-info-rating">
    <div class="flex h-8 w-full items-center text-sm">
      <Text color="muted">{$t('frameleaf_info_rating')}</Text>
    </div>
    <div class="flex items-center gap-2">
      <StarRating {rating} onRating={(value) => handlePromiseError(handleChangeRating(value))} />
      <button
        type="button"
        class="fl-stars-clear"
        disabled={!rating || isSaving}
        onclick={() => handlePromiseError(handleChangeRating(null))}
      >
        {$t('clear')}
      </button>
    </div>
    {#if failure}
      <ViewerInlineEditError
        {failure}
        busy={isSaving}
        onRetry={inlineEditRecovery(failure) === 'retry' && pending !== null
          ? () => handlePromiseError(handleChangeRating(pending as Rating))
          : undefined}
        onReload={inlineEditRecovery(failure) === 'reload' ? () => handlePromiseError(reload()) : undefined}
      />
    {/if}
  </section>
{/if}

<style>
  /* .mv-stars-clear (media-viewer.css:229-240). */
  .fl-stars-clear {
    margin-left: 6px;
    min-height: 30px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--fl-radius-control, 10px);
    background: none;
    color: var(--fl-viewer-muted, #979ba2);
    font: inherit;
    font-size: var(--fl-font-small, 13px);
    cursor: pointer;
  }

  .fl-stars-clear:hover:not(:disabled) {
    color: var(--fl-viewer-text, #f1f1f2);
    background: #ffffff0f;
  }

  .fl-stars-clear:disabled {
    cursor: default;
    opacity: 0.5;
  }
</style>
