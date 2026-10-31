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
  import { getExifRating } from '$lib/frameleaf/rating';
  import ViewerInlineEditError from '$lib/components/frameleaf/ViewerInlineEditError.svelte';
  import { classifyInlineEditError, inlineEditRecovery, type InlineEditFailure } from '$lib/frameleaf/inline-edit';
  import StarRating, { type Rating } from '$lib/elements/StarRating.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { getAssetInfo, updateAsset, type AssetResponseDto } from '@frameleaf/sdk';
  import { Text } from '@frameleaf/ui';
  import { t } from 'svelte-i18n';
  import { onDestroy } from 'svelte';

  interface Props {
    asset: AssetResponseDto;
    isOwner: boolean;
    onAssetRefresh?: (asset: AssetResponseDto) => void;
  }

  let { asset, isOwner, onAssetRefresh }: Props = $props();

  let rating = $derived(getExifRating(asset.exifInfo)) as Rating;
  let failure = $state<InlineEditFailure | null>(null);
  let isSaving = $state(false);
  /** The last value chosen, so a retryable failure replays that value and not the stored one. */
  let pending = $state<Rating | null>(null);
  let destroyed = false;
  onDestroy(() => (destroyed = true));
  let displayedAssetId = asset.id;
  $effect(() => {
    if (displayedAssetId !== asset.id) {
      displayedAssetId = asset.id;
      failure = null;
      pending = null;
      isSaving = false;
    }
  });
  const captureView = () => {
    const id = asset.id;
    const isCurrentSession = authManager.captureSession();
    return () => !destroyed && asset.id === id && isCurrentSession();
  };

  const handleChangeRating = async (next: Rating) => {
    const isCurrent = captureView();
    isSaving = true;
    pending = next;
    try {
      await updateAsset({ id: asset.id, updateAssetDto: { rating: next } });
      if (!isCurrent()) {
        return;
      }
      failure = null;
      pending = null;
      // The top row's Rating tool reads the viewer's asset, so hand it the stored value.
      onAssetRefresh?.({ ...asset, exifInfo: { ...asset.exifInfo, rating: next, isRejected: next === -1 } });
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      failure = classifyInlineEditError(error);
      handleError(error, $t('errors.cant_apply_changes'));
    } finally {
      if (isCurrent()) {
        isSaving = false;
      }
    }
  };

  const reload = async () => {
    const isCurrent = captureView();
    try {
      const updated = await getAssetInfo({ id: asset.id });
      if (!isCurrent()) {
        return;
      }
      failure = null;
      pending = null;
      onAssetRefresh?.(updated);
    } catch (error) {
      if (isCurrent()) {
        handleError(error, $t('frameleaf_info_error_reload_failed'));
      }
    }
  };
</script>

{#if isOwner && !asset.isTrashed && !authManager.isSharedLink && authManager.authenticated && authManager.preferences.ratings.enabled}
  <section data-testid="frameleaf-info-rating">
    <div class="fl-info-heading-row">
      <h3 class="fl-info-heading">{$t('frameleaf_info_rating')}</h3>
    </div>
    <div class="flex items-center gap-2">
      {#if rating === -1}
        <Text color="muted">{$t('frameleaf_library_rating_rejected')}</Text>
      {/if}
      {#key asset.id}
        <StarRating {rating} onRating={(value) => handlePromiseError(handleChangeRating(value))} />
      {/key}
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
  /*
   * .mv-stars (media-viewer.css:204-228): 34px stars, muted until set, set stars in the warm
   * star colour; a star grows a little under the pointer.
   */
  [data-testid='frameleaf-info-rating'] :global([data-testid='star-container']) {
    gap: var(--fl-space-half);
  }

  [data-testid='frameleaf-info-rating'] :global([data-testid='star']) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: var(--fl-radius-control);
    color: var(--fl-viewer-muted);
    transition:
      transform var(--fl-motion-fast) var(--fl-ease),
      color var(--fl-motion-fast) var(--fl-ease);
  }

  [data-testid='frameleaf-info-rating'] :global([data-testid='star'].filled) {
    color: var(--fl-warning);
  }

  [data-testid='frameleaf-info-rating'] :global([data-testid='star']:hover) {
    transform: scale(1.12);
  }

  @media (pointer: coarse) {
    [data-testid='frameleaf-info-rating'] :global([data-testid='star']) {
      width: 40px;
      height: 40px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    [data-testid='frameleaf-info-rating'] :global([data-testid='star']:hover) {
      transform: none;
    }
  }

  /* .mv-stars-clear (media-viewer.css:229-240). */
  .fl-stars-clear {
    margin-inline-start: 6px;
    min-height: 30px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--fl-radius-control, 10px);
    background: none;
    color: var(--fl-viewer-muted);
    font: inherit;
    font-size: var(--fl-font-small, 13px);
    cursor: pointer;
  }

  .fl-stars-clear:hover:not(:disabled) {
    color: var(--fl-viewer-text);
    background: color-mix(in srgb, var(--fl-viewer-text) 6%, transparent);
  }

  .fl-stars-clear:disabled {
    cursor: default;
    opacity: 0.5;
  }
</style>
