<script lang="ts">
  /**
   * Work's information panel (FL-33): the selected item's details beside the results, the
   * template's `<aside className="inspector">` in `App.jsx` — heading with a close control, a
   * preview that opens the item, its name, Info and People tabs, then the Info rows (type,
   * resolution, duration, captured, camera, location), the location card, people, tags and rating.
   *
   * Ported from PR #133's `LibraryWorkInspector`, whose selection metadata and collapse behaviour it
   * keeps, with the prototype's pane in place of that layout. What the template shows but production
   * has no source for is left out rather than invented: the frame rate, the device-local note and
   * the prototype's Versions tab (versions live in the editor).
   */
  import { formatDuration, cameraLabel, dimensionsLabel } from '$lib/frameleaf/viewer-headline';
  import { locationLabel } from '$lib/frameleaf/info-panel';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { AssetMediaSize, getAssetInfo, updateAsset, type AssetResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiClose, mdiMapMarker, mdiPlay, mdiStar, mdiStarOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    /** The selected item, when it is in the view. */
    asset: TimelineAsset | null;
    /** How many items are selected, for the heading when more than one is. */
    selectedCount?: number;
    onOpen: (asset: TimelineAsset) => void;
    onClose: () => void;
  };

  let { asset, selectedCount = 0, onOpen, onClose }: Props = $props();

  let tab = $state<'info' | 'people'>('info');
  let detail = $state<AssetResponseDto | null>(null);
  let rating = $state<number | null>(null);
  let ratingBusy = $state(false);

  // The full record (EXIF, people, tags) is read per item; a newer selection wins over a slower answer.
  $effect(() => {
    const id = asset?.id;
    detail = null;
    rating = null;
    if (!id) {
      return;
    }
    let current = true;
    void getAssetInfo({ ...authManager.params, id })
      .then((response) => {
        if (!current) {
          return;
        }

        detail = response;
        rating = response.exifInfo?.rating ?? null;
      })
      .catch((error) => {
        if (current) {
          handleError(error, $t('errors.failed_to_load_asset'));
        }
      });
    return () => {
      current = false;
    };
  });

  const duration = $derived(asset?.isVideo ? formatDuration(asset.duration) : null);
  /** The capture time in the zone it was taken in, when the EXIF zone is one the browser knows. */
  const formatCaptured = (value: string, timeZone: string | null | undefined) => {
    const date = new Date(value);
    const style = { dateStyle: 'medium', timeStyle: 'short' } as const;
    try {
      return date.toLocaleString(undefined, timeZone ? { ...style, timeZone } : style);
    } catch {
      return date.toLocaleString(undefined, style);
    }
  };

  const captured = $derived(
    detail?.exifInfo?.dateTimeOriginal
      ? formatCaptured(detail.exifInfo.dateTimeOriginal, detail.exifInfo.timeZone)
      : null,
  );
  const location = $derived(locationLabel(detail?.exifInfo));
  const people = $derived((detail?.people ?? []).filter((person) => !person.isHidden && person.name));
  const tags = $derived(detail?.tags ?? []);
  const canRate = $derived(
    !!detail &&
      authManager.authenticated &&
      !authManager.isSharedLink &&
      authManager.preferences.ratings.enabled &&
      detail.ownerId === authManager.user.id,
  );

  const rate = async (value: number) => {
    if (!detail || ratingBusy) {
      return;
    }
    const id = detail.id;
    const next = rating === value ? null : value;
    const previous = rating;
    rating = next;
    ratingBusy = true;
    try {
      await updateAsset({ id, updateAssetDto: { rating: next } });
    } catch (error) {
      if (detail?.id === id) {
        rating = previous;
      }
      handleError(error, $t('errors.unable_to_set_rating'));
    } finally {
      ratingBusy = false;
    }
  };
</script>

<section class="inspector" aria-labelledby="fl-work-inspector-title" data-testid="frameleaf-work-inspector">
  <div class="heading">
    <span id="fl-work-inspector-title">{$t('frameleaf_work_inspector_title')}</span>
    <button type="button" class="icon" aria-label={$t('frameleaf_work_inspector_close')} onclick={onClose}>
      <Icon icon={mdiClose} size="18" aria-hidden />
    </button>
  </div>

  {#if asset}
    <button
      type="button"
      class="preview"
      aria-label={$t('frameleaf_work_inspector_open')}
      onclick={() => onOpen(asset)}
    >
      <img src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail, cacheKey: asset.thumbhash })} alt="" />
      {#if asset.isVideo}
        <span class="play" aria-hidden="true"><Icon icon={mdiPlay} size="38" /></span>
        {#if duration}<span class="duration">{duration}</span>{/if}
      {/if}
    </button>
    <h2>{detail?.originalFileName ?? ' '}</h2>
    {#if selectedCount > 1}
      <p class="muted" aria-live="polite">
        {$t('frameleaf_work_inspector_selected', { values: { count: selectedCount } })}
      </p>
    {/if}

    <div class="tabbar" role="tablist" aria-label={$t('frameleaf_work_inspector_title')}>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'info'}
        class:current={tab === 'info'}
        onclick={() => (tab = 'info')}>{$t('frameleaf_work_inspector_tab_info')}</button
      >
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'people'}
        class:current={tab === 'people'}
        onclick={() => (tab = 'people')}>{$t('people')}</button
      >
    </div>

    {#if !detail}
      <p class="muted" role="status">{$t('loading')}</p>
    {:else if tab === 'info'}
      <dl>
        <dt>{$t('type')}</dt>
        <dd>{asset.isVideo ? $t('video') : $t('image')}</dd>
        {#if dimensionsLabel(detail)}
          <dt>{$t('resolution')}</dt>
          <dd>{dimensionsLabel(detail)}</dd>
        {/if}
        {#if duration}
          <dt>{$t('duration')}</dt>
          <dd>{duration}</dd>
        {/if}
      </dl>
      <dl>
        {#if captured}
          <dt>{$t('frameleaf_info_captured')}</dt>
          <dd>{captured}</dd>
        {/if}
        {#if cameraLabel(detail.exifInfo)}
          <dt>{$t('camera')}</dt>
          <dd>{cameraLabel(detail.exifInfo)}</dd>
        {/if}
        {#if location}
          <dt>{$t('location')}</dt>
          <dd>{location}</dd>
        {/if}
      </dl>
      {#if detail.exifInfo?.city || detail.exifInfo?.country}
        <div class="location">
          <Icon icon={mdiMapMarker} size="28" aria-hidden />
          <span>
            {detail.exifInfo.city ?? detail.exifInfo.country}
            <small>{[detail.exifInfo.state, detail.exifInfo.country].filter(Boolean).join(', ')}</small>
          </span>
        </div>
      {/if}

      <section class="part">
        <h3>{$t('people')}</h3>
        {#if people.length > 0}
          <ul class="chips">
            {#each people as person (person.id)}<li>{person.name}</li>{/each}
          </ul>
        {:else}
          <p class="muted">{$t('frameleaf_work_inspector_no_people')}</p>
        {/if}
      </section>

      {#if tags.length > 0}
        <section class="part">
          <h3>{$t('tags')}</h3>
          <ul class="chips">
            {#each tags as tag (tag.id)}<li>{tag.value}</li>{/each}
          </ul>
        </section>
      {/if}

      {#if canRate}
        <section class="part">
          <h3>{$t('rating')}</h3>
          <div class="rating" role="group" aria-label={$t('rating')}>
            {#each [1, 2, 3, 4, 5] as value (value)}
              <button
                type="button"
                aria-label={$t('rating_count', { values: { count: value } })}
                aria-pressed={rating === value}
                disabled={ratingBusy}
                onclick={() => void rate(value)}
              >
                <Icon icon={(rating ?? 0) >= value ? mdiStar : mdiStarOutline} size="18" aria-hidden />
              </button>
            {/each}
          </div>
        </section>
      {/if}
    {:else if people.length > 0}
      <ul class="chips people">
        {#each people as person (person.id)}<li>{person.name}</li>{/each}
      </ul>
    {:else}
      <p class="muted">{$t('frameleaf_work_inspector_no_people')}</p>
    {/if}
  {:else}
    <p class="muted empty">
      {$t(selectedCount > 1 ? 'frameleaf_work_inspector_many' : 'frameleaf_work_inspector_empty', {
        values: { count: selectedCount },
      })}
    </p>
  {/if}
</section>

<style>
  .inspector {
    padding: 20px 16px;
    color: var(--fl-text);
    font-size: 13px;
    animation: fl-inspector-in var(--fl-motion, 160ms) ease;
  }
  @keyframes fl-inspector-in {
    from {
      opacity: 0;
      transform: translateX(14px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .inspector {
      animation: none;
    }
  }
  .heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    font-weight: 600;
  }
  .icon {
    display: grid;
    place-items: center;
    min-width: 32px;
    min-height: 32px;
    border-radius: var(--fl-control-radius, 6px);
    color: var(--fl-muted);
  }
  .preview {
    position: relative;
    display: block;
    width: 100%;
    padding: 0;
    overflow: hidden;
    border-radius: 8px;
  }
  .preview img {
    display: block;
    width: 100%;
    aspect-ratio: 1.38;
    object-fit: cover;
  }
  .play {
    position: absolute;
    top: 50%;
    left: 50%;
    padding: 6px;
    border-radius: 8px;
    color: white;
    background: #17202a99;
    transform: translate(-50%, -50%);
  }
  .duration {
    position: absolute;
    right: 6px;
    bottom: 6px;
    padding: 2px 7px;
    border-radius: 999px;
    color: white;
    background: #111b;
    font-size: 12px;
  }
  h2 {
    margin: 9px 0;
    overflow-wrap: anywhere;
    font-size: 15px;
    font-weight: 600;
  }
  .tabbar {
    display: flex;
    height: 41px;
    margin-bottom: 10px;
    border-bottom: 1px solid var(--fl-border);
  }
  .tabbar button {
    flex: 1;
    color: var(--fl-muted);
  }
  .tabbar button.current {
    color: var(--fl-text);
    box-shadow: inset 0 -2px 0 var(--fl-accent);
  }
  dl {
    display: grid;
    grid-template-columns: 96px 1fr;
    gap: 6px 8px;
    margin: 0;
    padding: 19px 0;
    border-bottom: 1px solid var(--fl-border);
    color: var(--fl-muted);
  }
  dd {
    margin: 0;
    color: var(--fl-text);
    overflow-wrap: anywhere;
  }
  .location {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-top: 18px;
    padding: 16px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card, 10px);
  }
  .location :global(svg) {
    color: var(--fl-teal, var(--fl-accent));
  }
  .location small {
    display: block;
    color: var(--fl-muted);
    font-size: 12px;
  }
  .part {
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--fl-border);
  }
  h3 {
    margin-bottom: 10px;
    color: var(--fl-muted);
    font-size: 12px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .chips li {
    padding: 5px 13px;
    border: 1px solid var(--fl-border);
    border-radius: 999px;
    background: var(--fl-raised);
    font-size: 12px;
  }
  .rating {
    display: flex;
    gap: 2px;
  }
  .rating button {
    padding: 6px;
    color: var(--fl-muted);
  }
  .rating button[aria-pressed='true'] {
    color: var(--fl-text);
  }
  .muted {
    color: var(--fl-muted);
  }
  .empty {
    margin-top: 1rem;
  }
  button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
</style>
