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
   *
   * In Boards (`boards`, or any Boards-only item) the panel follows the approved Boards prototype's
   * `Inspector` instead: colours, rating with Rejected, editable tags, a note, the collections the
   * item is in with "Add to…", its source, file facts and the owner's "Show in Photos too" switch.
   */
  import AssetPalette from '$lib/components/frameleaf/AssetPalette.svelte';
  import AssetSources from '$lib/components/frameleaf/AssetSources.svelte';
  import BoardsRating from '$lib/components/frameleaf/BoardsRating.svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { onDestroy } from 'svelte';
  import { getExifRating } from '$lib/frameleaf/rating';
  import { formatDuration, cameraLabel, dimensionsLabel } from '$lib/frameleaf/viewer-headline';
  import { locationLabel } from '$lib/frameleaf/info-panel';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    getAssetInfo,
    LibraryScope,
    LibraryViewScope,
    updateAsset,
    type AssetResponseDto,
    type ColorFilter,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiClose, mdiMapMarker, mdiPlay } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    /** The selected item, when it is in the view. */
    asset: TimelineAsset | null;
    /** How many items are selected, for the heading when more than one is. */
    selectedCount?: number;
    onOpen: (asset: TimelineAsset) => void;
    onClose: () => void;
    onChooseColor?: (color: ColorFilter) => void;
    /** Shows the Boards details (the Boards workspace passes it; a Boards-only item gets them anyway). */
    boards?: boolean;
  };

  let { asset, selectedCount = 0, onOpen, onClose, onChooseColor, boards = false }: Props = $props();

  let tab = $state<'info' | 'people'>('info');
  const tabId = $props.id();
  const onTabKey = (event: KeyboardEvent, current: 'info' | 'people') => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const next =
      event.key === 'Home'
        ? 'info'
        : event.key === 'End'
          ? 'people'
          : event.key === 'ArrowLeft' || event.key === 'ArrowRight'
            ? current === 'info'
              ? 'people'
              : 'info'
            : null;
    if (next) {
      event.preventDefault();
      tab = next;
      document.querySelector<HTMLElement>(`#${tabId}-${next}`)?.focus();
    }
  };
  let detail = $state<AssetResponseDto | null>(null);
  let rating = $state<number | null>(null);
  let ratingBusy = $state(false);
  let generation = $state(0);
  let detailFailed = $state(false);
  /** The scope the item had when it was read, so flipping "Show in Photos too" keeps this layout. */
  let loadedScope = $state<LibraryScope | undefined>();
  onDestroy(
    onLibraryAccessChange(() => {
      detail = null;
      rating = null;
      generation++;
    }),
  );

  // The full record (EXIF, people, tags) is read per item; a newer selection wins over a slower answer.
  $effect(() => {
    const id = asset?.id;
    const version = generation;
    detailFailed = false;
    detail = null;
    rating = null;
    if (!id) {
      return;
    }
    let current = true;
    void getAssetInfo({ ...authManager.params, id })
      .then((response) => {
        if (!current || generation !== version || asset?.id !== id) {
          return;
        }

        detail = response;
        loadedScope = response.libraryScope;
        rating = getExifRating(response.exifInfo);
      })
      .catch((error) => {
        if (current && generation === version && asset?.id === id) {
          detailFailed = true;
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
  const isOwner = $derived(
    !!detail && authManager.authenticated && !authManager.isSharedLink && detail.ownerId === authManager.user.id,
  );
  const boardsMode = $derived(boards || (!!detail && loadedScope === LibraryScope.Design));
  const canRate = $derived(isOwner && (boardsMode || authManager.preferences.ratings.enabled));

  const rate = async (next: number | null) => {
    if (!detail || ratingBusy) {
      return;
    }
    const id = detail.id;
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

{#snippet boardsDetails(item: AssetResponseDto)}
  <section class="part first">
    <AssetPalette assetId={item.id} canRetry={isOwner} onChoose={onChooseColor} />
  </section>
  {#if canRate}
    <section class="part" aria-labelledby={`${tabId}-rating`}>
      <h3 id={`${tabId}-rating`}>{$t('rating')}</h3>
      <BoardsRating value={rating} disabled={ratingBusy} onChange={(next) => void rate(next)} />
    </section>
  {/if}
  {#if isOwner || tags.length > 0}
    <section class="part" aria-labelledby={`${tabId}-tags`}>
      <h3 id={`${tabId}-tags`}>{$t('tags')}</h3>
      {#await import('$lib/components/frameleaf/BoardsTagEditor.svelte') then { default: BoardsTagEditor }}<BoardsTagEditor
          assetId={item.id}
          {tags}
          canEdit={isOwner}
          labelledBy={`${tabId}-tags`}
        />{/await}
    </section>
  {/if}
  {#if isOwner || item.exifInfo?.description}
    <section class="part" aria-labelledby={`${tabId}-note`}>
      <h3 id={`${tabId}-note`}>{$t('frameleaf_boards_note')}</h3>
      {#await import('$lib/components/frameleaf/BoardsNote.svelte') then { default: BoardsNote }}<BoardsNote
          assetId={item.id}
          value={item.exifInfo?.description ?? ''}
          canEdit={isOwner}
          labelledBy={`${tabId}-note`}
        />{/await}
    </section>
  {/if}
  <section class="part">
    {#await import('$lib/components/frameleaf/BoardsCollections.svelte') then { default: BoardsCollections }}<BoardsCollections
        assetId={item.id}
        scope={LibraryViewScope.Design}
        canAdd={isOwner}
      />{/await}
  </section>
  <section class="part">
    <AssetSources assetId={item.id} canRead={isOwner} added={item.createdAt} />
  </section>
  <section class="part" aria-labelledby={`${tabId}-file`}>
    <h3 id={`${tabId}-file`}>{$t('frameleaf_boards_file')}</h3>
    <dl class="facts">
      <dt>{$t('type')}</dt>
      <dd>{item.originalMimeType ?? (asset?.isVideo ? $t('video') : $t('image'))}</dd>
      {#if dimensionsLabel(item)}
        <dt>{$t('resolution')}</dt>
        <dd>{dimensionsLabel(item)}</dd>
      {/if}
      {#if duration}
        <dt>{$t('duration')}</dt>
        <dd>{duration}</dd>
      {/if}
    </dl>
  </section>
  {#if isOwner}
    <section class="part">
      {#await import('$lib/components/frameleaf/BoardsScopeSwitch.svelte') then { default: BoardsScopeSwitch }}<BoardsScopeSwitch
          assetId={item.id}
          scope={item.libraryScope}
          onChange={(scope) => {
            if (detail?.id === item.id) {
              detail = { ...detail, libraryScope: scope };
            }
          }}
        />{/await}
    </section>
  {/if}
{/snippet}

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
      disabled={!detail}
      aria-label={$t('frameleaf_work_inspector_open')}
      onclick={() => onOpen(asset)}
    >
      {#if detail}<img
          src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail, cacheKey: asset.thumbhash })}
          alt=""
        />
        {#if asset.isVideo}
          <span class="play" aria-hidden="true"><Icon icon={mdiPlay} size="38" /></span>
          {#if duration}<span class="duration">{duration}</span>{/if}
        {/if}
      {/if}
    </button>
    <h2>{detail?.originalFileName ?? ' '}</h2>
    {#if detail && selectedCount > 1}
      <p class="muted" aria-live="polite">
        {$t('frameleaf_work_inspector_selected', { values: { count: selectedCount } })}
      </p>
    {/if}

    {#if boardsMode}
      <div class="boards">
        {#if !detail}
          <p class="muted" role="status">
            {detailFailed ? $t('frameleaf_item_details_unavailable') : $t('loading')}
          </p>
        {:else}
          {@render boardsDetails(detail)}
        {/if}
      </div>
    {:else}
      <div class="tabbar" role="tablist" aria-label={$t('frameleaf_work_inspector_title')}>
        <button
          type="button"
          role="tab"
          id={`${tabId}-info`}
          aria-controls={`${tabId}-panel`}
          aria-selected={tab === 'info'}
          tabindex={tab === 'info' ? 0 : -1}
          class:current={tab === 'info'}
          onkeydown={(event) => onTabKey(event, 'info')}
          onclick={() => (tab = 'info')}>{$t('frameleaf_work_inspector_tab_info')}</button
        >
        <button
          type="button"
          role="tab"
          id={`${tabId}-people`}
          aria-controls={`${tabId}-panel`}
          aria-selected={tab === 'people'}
          tabindex={tab === 'people' ? 0 : -1}
          class:current={tab === 'people'}
          onkeydown={(event) => onTabKey(event, 'people')}
          onclick={() => (tab = 'people')}>{$t('people')}</button
        >
      </div>

      <div id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${tab}`} tabindex="0">
        {#if !detail}
          <p class="muted" role="status">{detailFailed ? $t('frameleaf_item_details_unavailable') : $t('loading')}</p>
        {:else if tab === 'info'}
          <section class="part">
            <AssetPalette assetId={asset.id} canRetry={isOwner} onChoose={onChooseColor} />
          </section>
          <section class="part"><AssetSources assetId={asset.id} canRead={isOwner} /></section>
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
              <BoardsRating value={rating} disabled={ratingBusy} onChange={(next) => void rate(next)} />
            </section>
          {/if}
        {:else if people.length > 0}
          <ul class="chips people">
            {#each people as person (person.id)}<li>{person.name}</li>{/each}
          </ul>
        {:else}
          <p class="muted">{$t('frameleaf_work_inspector_no_people')}</p>
        {/if}
      </div>
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
    animation: fl-inspector-in var(--fl-motion) var(--fl-ease);
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
    border-radius: var(--fl-radius-sm);
    color: var(--fl-muted);
  }
  .preview {
    position: relative;
    display: block;
    width: 100%;
    padding: 0;
    overflow: hidden;
    border-radius: var(--fl-radius-control-compact);
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
    border-radius: var(--fl-radius-control-compact);
    color: var(--fl-viewer-text);
    background: color-mix(in srgb, var(--fl-viewer-panel) 60%, transparent);
    transform: translate(-50%, -50%);
  }
  .duration {
    position: absolute;
    right: 6px;
    bottom: 6px;
    padding: 2px 7px;
    border-radius: var(--fl-radius-pill);
    color: var(--fl-viewer-text);
    background: color-mix(in srgb, var(--fl-viewer-canvas) 73%, transparent);
    font-size: 12px;
  }
  h2 {
    margin: 9px 0;
    overflow-wrap: anywhere;
    font-size: 15px;
    font-weight: 600;
  }
  /* As tall as its tabs, so the current tab's underline lies on the bar's hairline. */
  .tabbar {
    display: flex;
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
    border-radius: var(--fl-radius-card);
  }
  .location :global(svg) {
    color: var(--fl-teal);
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
    gap: var(--fl-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .chips li {
    padding: 5px 13px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    font-size: 12px;
  }
  .boards .part.first {
    margin-top: 4px;
    padding-top: 0;
    border-top: 0;
  }
  .facts {
    padding: 0;
    border-bottom: 0;
    font-size: var(--fl-font-small);
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
