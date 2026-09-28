<script lang="ts">
  /**
   * The library's Compare view (FL-61), ported from the prototype's `compare` view in `App.jsx`.
   *
   * The first selected item is pinned on the left; the rest of the selection comes up on the right
   * one at a time. Keep and Reject write the item's rating, deciding on the right-hand item moves on
   * to the next one, and every decision can be undone. Zooming one photo zooms both at the same
   * point, so detail is compared where it matters. Only the owner of an item can rate it; anybody
   * else's item is shown but not decided.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import {
    compareDecisionOf,
    comparePair,
    compareRating,
    nextChallenger,
    pushUndo,
    type CompareDecision,
    type CompareUndo,
  } from '$lib/frameleaf/library-compare';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { AssetMediaSize, getAssetInfo, updateAsset, type AssetResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiCheck, mdiClose, mdiMagnifyMinusOutline, mdiMagnifyPlusOutline, mdiPinOutline, mdiUndo } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    /** The selected ids, in selection order. */
    selection: string[];
    onDone: () => void;
  };

  let { selection, onDone }: Props = $props();

  const ZOOM = 2.5;
  let index = $state(1);
  let assets = $state<Record<string, AssetResponseDto>>({});
  let ratings = $state<Record<string, number | null>>({});
  let history = $state<CompareUndo[]>([]);
  let zoom = $state<{ x: number; y: number } | null>(null);
  let busy = $state(false);
  /** Items being fetched right now, so a re-run of the loader never asks twice. */
  const loading = new Set<string>();

  const pair = $derived(comparePair(selection, index));
  const shown = $derived(pair ? [pair.pinned, pair.challenger] : []);
  const currentUserId = $derived(authManager.authenticated ? authManager.user.id : undefined);

  // load the two items on show; their ratings are the starting point for the decisions
  $effect(() => {
    for (const id of shown) {
      if (Object.hasOwn(assets, id) || loading.has(id)) {
        continue;
      }
      loading.add(id);
      void getAssetInfo({ ...authManager.params, id })
        .then((asset) => {
          assets = { ...assets, [id]: asset };
          if (!Object.hasOwn(ratings, id)) {
            ratings = { ...ratings, [id]: asset.exifInfo?.rating ?? null };
          }
        })
        .catch((error) => handleError(error, $t('errors.failed_to_load_asset')))
        .finally(() => loading.delete(id));
    }
  });

  const canRate = (asset: AssetResponseDto | undefined) => !!asset && asset.ownerId === currentUserId;

  const setRating = async (id: string, rating: number | null) => {
    await updateAsset({ id, updateAssetDto: { rating } });
    ratings = { ...ratings, [id]: rating };
  };

  const decide = async (id: string, decision: CompareDecision) => {
    if (busy || !canRate(assets[id])) {
      return;
    }
    busy = true;
    const previous = ratings[id] ?? null;
    try {
      await setRating(id, compareRating(decision, previous));
      history = pushUndo(history, { assetId: id, previous });
      if (id === pair?.challenger) {
        index = nextChallenger(selection, index);
      }
    } catch (error) {
      handleError(error, $t('frameleaf_compare_error_rating'));
    } finally {
      busy = false;
    }
  };

  const undo = async () => {
    const entry = history.at(-1);
    if (!entry || busy) {
      return;
    }
    busy = true;
    try {
      await setRating(entry.assetId, entry.previous);
      history = history.slice(0, -1);
      const at = selection.indexOf(entry.assetId);
      if (at > 0) {
        index = at;
      }
    } catch (error) {
      handleError(error, $t('frameleaf_compare_error_rating'));
    } finally {
      busy = false;
    }
  };

  const pointAt = (event: PointerEvent | MouseEvent) => {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return {
      x: Math.min(100, Math.max(0, ((event.clientX - box.left) / box.width) * 100)),
      y: Math.min(100, Math.max(0, ((event.clientY - box.top) / box.height) * 100)),
    };
  };

  const zoomStyle = $derived(zoom ? `transform: scale(${ZOOM}); transform-origin: ${zoom.x}% ${zoom.y}%;` : '');
</script>

<section class="fl-compare" aria-label={$t('frameleaf_compare_title')} data-testid="frameleaf-library-compare">
  <div class="fl-compare-heading">
    <h2>{$t('frameleaf_compare_title')}</h2>
    {#if pair}
      <span>
        {$t('frameleaf_compare_position', { values: { index, total: selection.length - 1 } })}
      </span>
    {/if}
    <span class="fl-compare-grow"></span>
    <Button pressed={!!zoom} disabled={!pair} onclick={() => (zoom = zoom ? null : { x: 50, y: 50 })}>
      <Icon icon={zoom ? mdiMagnifyMinusOutline : mdiMagnifyPlusOutline} size="16" aria-hidden={true} />
      {zoom ? $t('frameleaf_duplicates_zoom_reset') : $t('frameleaf_duplicates_zoom_both')}
    </Button>
    <Button onclick={onDone}>{$t('frameleaf_compare_done')}</Button>
  </div>

  {#if !pair}
    <p>{$t('frameleaf_compare_select_two')}</p>
  {:else}
    <div class="fl-compare-images">
      {#each shown as id, position (`${id}-${position}`)}
        {@const asset = assets[id]}
        {@const decision = compareDecisionOf(ratings[id])}
        <section>
          <button
            type="button"
            class="fl-compare-image"
            aria-pressed={!!zoom}
            aria-label={zoom ? $t('frameleaf_duplicates_zoom_reset') : $t('frameleaf_compare_zoom_here')}
            onclick={(event) => (zoom = zoom ? null : pointAt(event))}
            onpointermove={(event) => {
              if (zoom) {
                zoom = pointAt(event);
              }
            }}
          >
            <img
              src={getAssetMediaUrl({ id, size: AssetMediaSize.Preview, cacheKey: asset?.thumbhash })}
              alt={asset?.originalFileName ?? ''}
              style={zoomStyle}
              draggable="false"
            />
          </button>
          <h3>
            {#if position === 0}
              <Icon icon={mdiPinOutline} size="16" aria-label={$t('frameleaf_compare_pinned')} />
            {/if}
            {asset?.originalFileName ?? ''}
          </h3>
          <div class="fl-compare-actions">
            <Button
              pressed={decision === 'keep'}
              disabled={busy || !canRate(asset)}
              onclick={() => void decide(id, 'keep')}
            >
              <Icon icon={mdiCheck} size="16" aria-hidden={true} />
              {$t('frameleaf_compare_keep')}
            </Button>
            <Button
              pressed={decision === 'reject'}
              disabled={busy || !canRate(asset)}
              onclick={() => void decide(id, 'reject')}
            >
              <Icon icon={mdiClose} size="16" aria-hidden={true} />
              {$t('frameleaf_compare_reject')}
            </Button>
          </div>
          {#if asset && !canRate(asset)}
            <small>{$t('frameleaf_compare_owner_only')}</small>
          {/if}
        </section>
      {/each}
    </div>
  {/if}

  <Button disabled={history.length === 0 || busy} onclick={() => void undo()}>
    <Icon icon={mdiUndo} size="16" aria-hidden={true} />
    {$t('frameleaf_compare_undo')}
  </Button>
</section>

<style>
  .fl-compare {
    padding: 22px;
    color: var(--fl-text);
    background: var(--fl-canvas);
  }
  .fl-compare-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin-bottom: 20px;
  }
  .fl-compare-heading h2 {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
  }
  .fl-compare-heading span {
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .fl-compare-heading .fl-compare-grow {
    flex: 1;
  }
  .fl-compare-images {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px;
    margin: 18px 0;
  }
  .fl-compare-image {
    display: block;
    width: 100%;
    padding: 0;
    overflow: hidden;
    cursor: zoom-in;
    background: #080b0d;
    border: 0;
    border-radius: var(--fl-radius-control);
  }
  .fl-compare-image[aria-pressed='true'] {
    cursor: zoom-out;
  }
  .fl-compare-image img {
    display: block;
    width: 100%;
    aspect-ratio: 1.5;
    object-fit: contain;
    transition: transform var(--fl-motion-fast) var(--fl-ease);
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 12px 0;
    font-size: var(--fl-font-size);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .fl-compare-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  small {
    display: block;
    margin-top: 6px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  @media (max-width: 700px) {
    .fl-compare {
      padding: 14px;
    }
    .fl-compare-images {
      gap: 8px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-compare-image img {
      transition: none;
    }
  }
</style>
