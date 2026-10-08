<script lang="ts">
  /**
   * The photo-dominant library tile shared by the Timeline, Browse and Work layouts.
   *
   * Ported for FL-33 from `design/frameleaf/template/src/AssetTile.jsx`. The September 22, 2026
   * revision fixes what it must do: badges for what the item is, a hover scrub for video and a press
   * to play a Live Photo. The September 24 decisions set the variants per layout (`apple-style.css`
   * "grids per tab"): Browse is a square cell with no rating and no caption; Work always shows the
   * rating (and Rejected) and a caption under the photo whose file name shows on request, inset so
   * one tile's time never runs into the next tile's name; Timeline shows the rating on hover or
   * selection, as before, and a caption with the name and time (`TimelineLibrary.jsx`
   * `showCaption`). A Locked item's caption never names its file.
   *
   * Hovering (or focusing) a tile shows its quick actions — favorite, edit, share, more — in the
   * top corner (`AssetTile.jsx` `.at-actions`), except while a selection is in progress.
   *
   * Selection follows the prototype's inset-and-settle (`asset-tile.css` `.is-selected`): the photo
   * settles to 0.92 on an accent bed inside an accent ring, and the tick fills. The ring is drawn by
   * a pseudo-element above the photo: an outline on the tile or its button paints under their
   * positioned children, so it never showed. On touch, press and hold starts a selection, and
   * dragging on from there adds every tile the finger passes (`timeline/drag-select.ts`).
   *
   * Media sources are the production ones. The hover scrub plays the existing preview transcode
   * (`/assets/:id/video/playback`), never the original file, and a Live Photo plays its own motion
   * part. Nothing here downloads an original.
   */
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import TileJobState from '$lib/components/frameleaf/TileJobState.svelte';
  import { beginDragSelect, DRAG_SELECT_EVENT } from '$lib/components/timeline/drag-select';
  import { isRevealingLocks } from '$lib/components/timeline/lock-reveal';
  import Thumbhash from '$lib/components/Thumbhash.svelte';
  import { ProjectionType } from '$lib/constants';
  import { durableBulkTracker } from '$lib/frameleaf/durable-bulk-tracker.svelte';
  import type { TileLayout } from '$lib/frameleaf/library-grid';
  import type { TileQuickActions } from '$lib/frameleaf/tile-actions';
  import { lockBadgeLabelKey } from '$lib/frameleaf/locked-view';
  import { prefersReducedMotion } from '$lib/frameleaf/motion';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { getAssetMediaUrl, getAssetPlaybackUrl } from '$lib/utils';
  import { getAltText } from '$lib/utils/thumbnail-util';
  import { fromTimelinePlainDateTime } from '$lib/utils/timeline-util';
  import { AssetMediaSize, AssetVisibility } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCheck,
    mdiCloudOffOutline,
    mdiDotsHorizontal,
    mdiExportVariant,
    mdiHeart,
    mdiHeartOutline,
    mdiLayersOutline,
    mdiMotionPlayOutline,
    mdiPanoramaVariantOutline,
    mdiPencilOutline,
    mdiPlay,
    mdiShieldLockOutline,
    mdiStar,
  } from '@mdi/js';
  import { onDestroy, untrack, type Snippet } from 'svelte';
  import { DateTime } from 'luxon';
  import { locale, t } from 'svelte-i18n';

  type Props = {
    asset: TimelineAsset;
    width: number;
    height: number;
    selected?: boolean;
    /** True while a multi-select is in progress, so a plain click selects instead of opening. */
    selecting?: boolean;
    /** The layout the tile is drawn in; decides the rating and caption variants. */
    layout?: TileLayout;
    /** Rating override; by default the asset's own rating (from its time bucket or its details). */
    rating?: number | null;
    /** Marked sensitive. Metadata only — the asset is never relocated. */
    sensitive?: boolean;
    /** Offline override; by default the asset's own flag (its time bucket or its details). */
    offline?: boolean;
    /** Timeline and Work: space under the photo for the caption; `height` includes it. */
    captionHeight?: number;
    /** Work: show the file name in the caption (a per-device toggle, off by default). */
    showFileName?: boolean;
    onOpen?: (asset: TimelineAsset, event: MouseEvent | KeyboardEvent) => void;
    onToggleSelect?: (asset: TimelineAsset, event: MouseEvent | KeyboardEvent) => void;
    onFocus?: (asset: TimelineAsset) => void;
    tabindex?: number;
    /**
     * Extra chrome drawn over the thumbnail by the page that mounts the timeline — the geolocation
     * utility's GPS markers, for instance. It is decoration: pointer events stay with the tile.
     */
    overlay?: Snippet<[TimelineAsset]>;
    /** The hover quick actions this tile may offer; none are drawn without them. */
    quickActions?: TileQuickActions | null;
    /**
     * While set (the timeline's scrubber is being dragged), a tile drawn now waits for its thumbnail
     * until it is cleared, so a drag across the library does not fetch every tile it passes. A tile
     * whose thumbnail was already asked for keeps it.
     */
    deferImage?: boolean;
  };

  let {
    asset,
    width,
    height,
    selected = false,
    selecting = false,
    layout = 'timeline',
    rating,
    sensitive = false,
    offline,
    captionHeight = 0,
    showFileName = false,
    onOpen,
    onToggleSelect,
    onFocus,
    tabindex = 0,
    overlay,
    quickActions = null,
    deferImage = false,
  }: Props = $props();

  let imageRequested = $state(untrack(() => !deferImage));
  $effect(() => {
    if (!deferImage) {
      imageRequested = true;
    }
  });

  const PREVIEW_DELAY = 300;
  const PRESS_DELAY = 400;
  /** A press that travels further than this is a scroll, not a hold. */
  const PRESS_SLOP = 8;
  /** A thumbnail that arrives sooner than this was cached: it replaces its placeholder without a fade. */
  const INSTANT_LOAD_MS = 80;

  // The photo develops: its thumbhash shows at once, then dissolves into the thumbnail.
  let imageLoaded = $state(false);
  let fadeHash = $state(true);
  let requestedAt = 0;
  $effect(() => {
    if (imageRequested && !requestedAt) {
      requestedAt = performance.now();
    }
  });
  const onImageComplete = () => {
    // A tile painted during a scrub, or from the cache, swaps at once; a slow one crossfades.
    fadeHash = performance.now() - requestedAt > INSTANT_LOAD_MS;
    imageLoaded = true;
  };

  let previewMode = $state<'video' | 'live' | null>(null);
  let hovered = $state(false);
  let videoElement = $state<HTMLVideoElement>();
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let pressing = $state(false);
  let pressOrigin: { x: number; y: number } | null = null;
  let suppressClick = false;
  let endDragSelect: (() => void) | undefined;

  /**
   * A short tick under the finger where the device offers one. Read loosely: Safari has no
   * `navigator.vibrate`, and there the selection ring is the only feedback.
   */
  const buzz = () => {
    const vibrate: unknown = Reflect.get(navigator, 'vibrate');
    if (typeof vibrate === 'function') {
      Reflect.apply(vibrate, navigator, [8]);
    }
  };

  const coarsePointer = $derived(mediaQueryManager.pointerCoarse);
  const isLive = $derived(asset.isImage && !!asset.livePhotoVideoId);
  const isPanorama = $derived(!!asset.projectionType && asset.projectionType !== ProjectionType.NONE);
  const stackCount = $derived(asset.stack?.assetCount ?? 0);
  const isLocked = $derived(asset.visibility === AssetVisibility.Locked);
  // Decided once, as the tile is drawn: a Locked item that appears right after the PIN sharpens in.
  const revealing = untrack(() => asset.visibility === AssetVisibility.Locked && isRevealingLocks());
  // FL-34: `Locked` for an item from the old Locked folder, `Sensitive` for a mark or a detection
  const lockLabelKey = $derived(lockBadgeLabelKey(asset.lockReason));
  // T-17: the template draws no Archived badge (archiving takes an item out of the library), and the
  // Offline badge follows the asset's own flag (`AssetTile.jsx` `asset.isOffline`).
  const isOffline = $derived(offline ?? !!asset.isOffline);
  // Production stores durations in milliseconds on the timeline model, as the upstream thumbnail does.
  const durationSeconds = $derived(asset.duration ? Number(asset.duration) / 1000 : 0);
  const stars = $derived(typeof rating === 'number' ? rating : typeof asset.rating === 'number' ? asset.rating : 0);
  // Browse never shows ratings and Work always does (September 24); in the Timeline they are chrome,
  // not content, and show on hover or while the item is selected.
  const showRating = $derived(
    stars !== 0 && layout !== 'browse' && (layout === 'work' || hovered || selected || !!previewMode),
  );
  const title = $derived($getAltText(asset));
  const withCaption = $derived(layout !== 'browse' && captionHeight > 0);
  /** Template `assetTitle`: the file name without its extension. A Locked item's name is never shown. */
  const fileName = $derived(
    asset.originalFileName && !isLocked ? asset.originalFileName.replace(/\.[^.]+$/, '') : null,
  );
  /** The Timeline caption always names the item; Work names it only on request. */
  const captionName = $derived(layout === 'timeline' || showFileName ? fileName : null);
  const hasQuickActions = $derived(
    !!quickActions && !!(quickActions.onFavorite || quickActions.onEdit || quickActions.onShare || quickActions.onMore),
  );
  /** Run a quick action without also opening or selecting the tile under it. */
  const quick = (action: (() => void) | undefined) => (event: MouseEvent) => {
    event.stopPropagation();
    action?.();
  };
  /** Template `localCaptureTime`: the capture time on the photo's own clock. */
  const captureTime = $derived.by(() => {
    try {
      return fromTimelinePlainDateTime(asset.localDateTime).toLocaleString(DateTime.TIME_SIMPLE, {
        locale: $locale ?? undefined,
      });
    } catch {
      return null;
    }
  });
  /** The List view (S-15, template asset-tile.css `[data-layout="list"]`): a 96px 3:2 thumbnail and columns. */
  const listed = $derived(layout === 'list');
  const LIST_THUMB_WIDTH = 96;
  const LIST_THUMB_HEIGHT = 64;
  const imageWidth = $derived(listed ? LIST_THUMB_WIDTH : width);
  const imageHeight = $derived(listed ? LIST_THUMB_HEIGHT : withCaption ? Math.max(1, height - captionHeight) : height);
  /** The list's name column: the file name without its extension, never a Locked item's. */
  const listName = $derived(isLocked ? $t('frameleaf_library_list_locked_item') : (fileName ?? title));
  const listDate = $derived.by(() => {
    try {
      return fromTimelinePlainDateTime(asset.localDateTime).toLocaleString(DateTime.DATE_MED, {
        locale: $locale ?? undefined,
      });
    } catch {
      return '';
    }
  });
  /** Template: a video's duration, else the pixel size, else the file size. */
  const listDetail = $derived.by(() => {
    if (asset.isVideo) {
      return durationLabel(durationSeconds);
    }
    if (asset.width && asset.height) {
      return `${asset.width} × ${asset.height}`;
    }
    return asset.fileSizeInByte ? fileSizeLabel(asset.fileSizeInByte) : '';
  });
  // A durable bulk job working on this item (owner decision, September 22, 2026): a loader until
  // the job answers for it, then a failure mark if it did not work.
  const job = $derived(durableBulkTracker.stateOf(asset.id));
  const jobLabel = $derived(
    job
      ? job.state === 'pending'
        ? $t('frameleaf_bulk_tile_processing')
        : $t('frameleaf_bulk_tile_failed', { values: { reason: $t(job.reasonKey) } })
      : null,
  );

  /** The motion source for a hover scrub or a Live Photo press: always the preview transcode. */
  const previewSource = $derived.by(() => {
    if (asset.isVideo) {
      return getAssetPlaybackUrl({ id: asset.id, cacheKey: asset.thumbhash });
    }
    if (isLive && asset.livePhotoVideoId) {
      return getAssetPlaybackUrl({ id: asset.livePhotoVideoId, cacheKey: asset.thumbhash });
    }
    return null;
  });

  /** Template `fileSize`: megabytes, or gigabytes from 1 GB. */
  const fileSizeLabel = (bytes: number) =>
    bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;

  const durationLabel = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return '0:00';
    }
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const rest = String(whole % 60).padStart(2, '0');
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
  };

  const clearTimers = () => {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };

  const endPreview = () => {
    clearTimers();
    pressing = false;
    previewMode = null;
  };

  onDestroy(() => {
    clearTimers();
    endDragSelect?.();
  });

  /** Another tile's hold is being dragged across this one: join the selection (never leave it). */
  const dragSelected = (node: HTMLElement) => {
    const onDragSelect = (event: Event) => {
      if (!selected && event instanceof CustomEvent && event.detail?.assetId === asset.id) {
        onToggleSelect?.(asset, new MouseEvent('click'));
      }
    };
    node.addEventListener(DRAG_SELECT_EVENT, onDragSelect);
    return { destroy: () => node.removeEventListener(DRAG_SELECT_EVENT, onDragSelect) };
  };

  $effect(() => {
    if (previewMode && videoElement) {
      // Autoplay can be refused (a background tab, a power-saving mode); the still stays put.
      void videoElement.play?.()?.catch(() => {});
    }
  });

  const beginPreview = (mode: 'video' | 'live', delay: number) => {
    if (!previewSource || prefersReducedMotion()) {
      return;
    }
    clearTimers();
    hoverTimer = setTimeout(() => (previewMode = mode), delay);
  };

  const onPointerEnter = (event: PointerEvent) => {
    if (event.pointerType === 'touch') {
      return;
    }
    hovered = true;
    beginPreview(asset.isVideo ? 'video' : 'live', PREVIEW_DELAY);
  };

  /** Move across the tile to scrub the transcode; the pointer's x is the position in the clip. */
  const onPointerMove = (event: PointerEvent) => {
    if (pressing && pressOrigin && event.pointerType === 'touch') {
      if (Math.hypot(event.clientX - pressOrigin.x, event.clientY - pressOrigin.y) > PRESS_SLOP) {
        // The finger is scrolling the grid.
        clearTimers();
        pressing = false;
      }
      return;
    }
    if (previewMode !== 'video' || !videoElement) {
      return;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (!rect.width) {
      return;
    }
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const length =
      Number.isFinite(videoElement.duration) && videoElement.duration > 0 ? videoElement.duration : durationSeconds;
    if (length > 0) {
      videoElement.currentTime = fraction * length;
    }
  };

  const onPointerLeave = () => {
    hovered = false;
    endPreview();
  };

  /**
   * Press and hold on touch starts a selection with this item, as in every phone gallery. Once a
   * selection is in progress a tap toggles, so the hold goes back to playing a Live Photo; it also
   * does on a grid that offers no selection.
   */
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') {
      return;
    }
    // A hold whose click never came (the browser's own long-press took it) must not eat this tap.
    suppressClick = false;
    const playsLive = isLive && (selecting || !onToggleSelect);
    if (!playsLive && (selecting || !onToggleSelect)) {
      return;
    }
    pressing = true;
    pressOrigin = { x: event.clientX, y: event.clientY };
    const pressed = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
    clearTimers();
    pressTimer = setTimeout(() => {
      if (!pressing) {
        return;
      }
      suppressClick = true;
      if (playsLive) {
        previewMode = 'live';
        return;
      }
      pressing = false;
      buzz();
      onToggleSelect?.(asset, event);
      if (pressed) {
        // The finger is still down: moving on from here adds the tiles it passes.
        endDragSelect?.();
        endDragSelect = beginDragSelect(pressed, asset.id);
      }
    }, PRESS_DELAY);
  };

  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') {
      return;
    }
    endPreview();
  };

  const activate = (event: MouseEvent | KeyboardEvent) => {
    if (suppressClick) {
      // The press that played the Live Photo must not also open the viewer.
      suppressClick = false;
      event.preventDefault();
      return;
    }
    const modified = 'metaKey' in event && (event.metaKey || event.ctrlKey || event.shiftKey);
    if (modified || selecting) {
      onToggleSelect?.(asset, event);
      return;
    }
    onOpen?.(asset, event);
  };
</script>

<article
  class="fl-tile"
  class:has-caption={withCaption}
  class:is-selected={selected}
  class:is-selecting={selecting}
  class:is-previewing={!!previewMode}
  class:is-pressing={pressing && !previewMode}
  class:has-actions={hasQuickActions && !selecting}
  class:is-revealing={revealing}
  use:dragSelected
  aria-busy={job?.state === 'pending' ? true : undefined}
  data-asset-id={asset.id}
  data-layout={layout}
  data-testid="frameleaf-asset-tile"
  style:width="{width}px"
  style:height="{height}px"
>
  <button
    type="button"
    class="fl-tile-open fl-continuous-corners"
    style:height={withCaption || listed ? `${imageHeight}px` : undefined}
    style:width={listed ? `${imageWidth}px` : undefined}
    {tabindex}
    title={layout === 'work' && fileName && !showFileName ? (asset.originalFileName ?? undefined) : undefined}
    aria-label={jobLabel ? `${title}, ${jobLabel}` : title}
    aria-pressed={selecting ? selected : undefined}
    onclick={activate}
    onfocus={() => onFocus?.(asset)}
    onpointerenter={onPointerEnter}
    onpointermove={onPointerMove}
    onpointerleave={onPointerLeave}
    onpointerdown={onPointerDown}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    oncontextmenu={(event) => {
      if (pressing) {
        event.preventDefault();
      }
    }}
  >
    <span class="fl-tile-media">
      {#if imageRequested}
        <ImageThumbnail
          url={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail, cacheKey: asset.thumbhash })}
          altText={title}
          widthStyle="{imageWidth}px"
          heightStyle="{imageHeight}px"
          class="fl-tile-image"
          onComplete={onImageComplete}
        />
      {:else}
        <span class="fl-tile-image fl-tile-placeholder" aria-hidden="true"></span>
      {/if}
      {#if asset.thumbhash && !imageLoaded}
        <Thumbhash base64ThumbHash={asset.thumbhash} class="fl-tile-hash" fadeOut={fadeHash} aria-hidden="true" />
      {/if}
      {#if previewMode && previewSource}
        <video
          bind:this={videoElement}
          class="fl-tile-preview"
          src={previewSource}
          muted
          playsinline
          loop={previewMode === 'live'}
          preload="auto"
          aria-hidden="true"
          tabindex={-1}
        ></video>
      {/if}
      <span class="fl-tile-scrim" aria-hidden="true"></span>
      {#if overlay}
        <span class="fl-tile-overlay" aria-hidden="true">{@render overlay(asset)}</span>
      {/if}
      <span class="fl-tile-badges">
        {#if asset.isVideo}
          <span class="fl-badge">
            <Icon icon={mdiPlay} size="12" />
            {durationLabel(durationSeconds)}
          </span>
        {/if}
        {#if isLive}
          <span class="fl-badge" title={$t('frameleaf_library_badge_live_photo')}>
            <Icon icon={mdiMotionPlayOutline} size="13" />
            <span class="fl-sr">{$t('frameleaf_library_badge_live_photo')}</span>
          </span>
        {/if}
        {#if isPanorama}
          <span class="fl-badge fl-badge-icon" title={$t('frameleaf_library_badge_panorama')}>
            <Icon icon={mdiPanoramaVariantOutline} size="13" />
            <span class="fl-sr">{$t('frameleaf_library_badge_panorama')}</span>
          </span>
        {/if}
        {#if stackCount > 1}
          <span class="fl-badge" title={$t('stacked_assets_count', { values: { count: stackCount } })}>
            <Icon icon={mdiLayersOutline} size="12" />
            {stackCount}
            <span class="fl-sr">{$t('stacked_assets_count', { values: { count: stackCount } })}</span>
          </span>
        {/if}
        {#if isLocked || sensitive}
          {@const label = isLocked ? $t(lockLabelKey) : $t('frameleaf_library_badge_sensitive')}
          <span class="fl-badge fl-badge-icon" title={label}>
            <Icon icon={mdiShieldLockOutline} size="13" />
            <span class="fl-sr">{label}</span>
          </span>
        {/if}
        {#if isOffline}
          <span class="fl-badge fl-badge-icon" title={$t('asset_offline')}>
            <Icon icon={mdiCloudOffOutline} size="13" />
            <span class="fl-sr">{$t('asset_offline')}</span>
          </span>
        {/if}
        {#if asset.isFavorite}
          <span class="fl-badge fl-badge-icon fl-favorite" title={$t('favorite')}>
            <Icon icon={mdiHeart} size="12" />
            <span class="fl-sr">{$t('favorite')}</span>
          </span>
        {/if}
      </span>
      {#if job && jobLabel}
        <!-- The durable job's state keeps the tile's top-right corner. -->
        <span class="fl-tile-job-slot"><TileJobState {job} label={jobLabel} /></span>
      {/if}
      {#if showRating}
        <span
          class="fl-tile-rating"
          aria-label={stars === -1
            ? $t('frameleaf_library_rating_rejected')
            : $t('frameleaf_library_rating_stars', { values: { count: stars } })}
        >
          {#if stars === -1}
            {$t('frameleaf_library_rating_rejected')}
          {:else}
            {#each Array.from({ length: Math.min(5, stars) }, (_, index) => index) as index (index)}
              <Icon icon={mdiStar} size="11" />
            {/each}
          {/if}
        </span>
      {/if}
    </span>
    <!-- The selection and focus ring, above the photo (an outline on the button paints under it). -->
    <span class="fl-tile-ring fl-continuous-corners" aria-hidden="true"></span>
  </button>

  <label class="fl-tile-select" class:is-coarse={coarsePointer}>
    <input
      type="checkbox"
      checked={selected}
      aria-label={$t('frameleaf_library_select_item', { values: { title } })}
      onclick={(event) => {
        event.stopPropagation();
        onToggleSelect?.(asset, event);
      }}
    />
    <span aria-hidden="true">
      {#if selected}
        <!-- The mark unfurls, the brand's signature (BRAND.md decision 6); a fade under Reduce Motion. -->
        <i class="fl-tile-tick fl-unfurl"><Icon icon={mdiCheck} size="15" /></i>
      {/if}
    </span>
  </label>

  {#if quickActions && hasQuickActions && !selecting}
    <!-- Template `.at-actions`: hover and focus reveal them; a selection in progress hides them. -->
    <div class="fl-tile-actions" role="group" aria-label={$t('frameleaf_tile_actions', { values: { title } })}>
      {#if quickActions.onFavorite}
        <button
          type="button"
          class:is-favorite={asset.isFavorite}
          aria-pressed={asset.isFavorite}
          aria-label={asset.isFavorite
            ? $t('frameleaf_tile_unfavorite', { values: { title } })
            : $t('frameleaf_tile_favorite', { values: { title } })}
          title={asset.isFavorite ? $t('frameleaf_tile_remove_from_favorites') : $t('favorite')}
          onclick={quick(quickActions.onFavorite)}
        >
          <Icon icon={asset.isFavorite ? mdiHeart : mdiHeartOutline} size="16" />
        </button>
      {/if}
      {#if quickActions.onEdit}
        <button
          type="button"
          aria-label={$t('frameleaf_tile_edit', { values: { title } })}
          title={$t('edit')}
          onclick={quick(quickActions.onEdit)}
        >
          <Icon icon={mdiPencilOutline} size="16" />
        </button>
      {/if}
      {#if quickActions.onShare}
        <button
          type="button"
          aria-label={$t('frameleaf_tile_share', { values: { title } })}
          title={$t('share')}
          onclick={quick(quickActions.onShare)}
        >
          <Icon icon={mdiExportVariant} size="16" />
        </button>
      {/if}
      {#if quickActions.onMore}
        <button
          type="button"
          aria-label={$t('frameleaf_tile_more', { values: { title } })}
          title={$t('more')}
          onclick={quick(quickActions.onMore)}
        >
          <Icon icon={mdiDotsHorizontal} size="16" />
        </button>
      {/if}
    </div>
  {/if}

  {#if listed}
    <!-- Template `.at-list-name` and `.at-list-cell`: name, date, kind, then duration, size or bytes. -->
    <span class="fl-list-name" title={isLocked ? undefined : (asset.originalFileName ?? undefined)}>{listName}</span>
    <span class="fl-list-cell fl-list-date">{listDate}</span>
    <span class="fl-list-cell fl-list-kind"
      >{asset.isVideo ? $t('frameleaf_library_list_video') : $t('frameleaf_library_list_photo')}</span
    >
    <span class="fl-list-cell">{listDetail}</span>
  {/if}

  {#if withCaption}
    <!-- Template `.at-caption`: the name and the capture time, inset from the tile edges. -->
    <div class="fl-tile-caption" style:height="{captionHeight}px">
      {#if captionName}
        <span title={captionName}>{captionName}</span>
      {/if}
      {#if captureTime}
        <time datetime={fromTimelinePlainDateTime(asset.localDateTime).toISO({ includeOffset: false }) ?? undefined}
          >{captureTime}</time
        >
      {/if}
    </div>
  {/if}
</article>

<style>
  .fl-tile {
    /* The favourite mark is one colour on the badge and on the quick action. */
    --fl-tile-favorite: #ff7b8a;
    position: relative;
    display: block;
    overflow: hidden;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  /* Browse: the Photos-style dense grid has square corners (apple-style.css "grids per tab"). */
  .fl-tile[data-layout='browse'] {
    border-radius: 0;
  }
  /* Work: the caption sits under the photo, so the tile itself draws no surface. */
  .fl-tile.has-caption {
    overflow: visible;
    background: transparent;
    border-radius: 0;
  }
  .fl-tile.has-caption .fl-tile-open {
    overflow: hidden;
    bottom: auto;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .fl-tile-open {
    position: absolute;
    inset: 0;
    display: block;
    padding: 0;
    border: 0;
    min-height: 0;
    border-radius: inherit;
    background: transparent;
    cursor: pointer;
    -webkit-touch-callout: none;
  }
  /*
   * Everything drawn on the photo lives in one layer, so a selection can inset the photo with its
   * badges in a single compositor move.
   */
  .fl-tile-media {
    position: absolute;
    inset: 0;
    display: block;
    overflow: hidden;
    /* Square at rest (the tile clips its own corners); it rounds only as it insets. */
    border-radius: 0;
    transition:
      scale var(--fl-duration) var(--fl-spring),
      border-radius var(--fl-motion) var(--fl-ease);
  }
  .fl-tile :global(.fl-tile-image) {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    background: var(--fl-raised);
    transition: scale var(--fl-duration-hero) var(--fl-snappy);
  }
  /* The thumbhash covers the tile until the thumbnail lands, then dissolves (Thumbhash `fadeOut`). */
  .fl-tile :global(.fl-tile-hash) {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  @media (hover: hover) and (pointer: fine) {
    /*
     * apple-style.css:297-302: the photo eases in a touch under the pointer, as album covers do.
     * Only where tiles have room around them (Timeline and Work): in Browse's dense 2px grid a
     * zoom on every tile the pointer crosses reads as flicker, and a List row is not a picture.
     */
    .fl-tile:is([data-layout='timeline'], [data-layout='work']):not(.is-selected):hover :global(.fl-tile-image) {
      scale: 1.03;
    }
  }
  /*
   * Just unlocked (finding 90): a Locked item that comes into view because of the PIN arrives out
   * of focus and sharpens. The layer clips itself, so the blur never bleeds onto its neighbours.
   */
  .fl-tile.is-revealing .fl-tile-media {
    animation: fl-tile-reveal var(--fl-motion-slow) var(--fl-ease) both;
  }
  @keyframes fl-tile-reveal {
    from {
      filter: blur(12px);
      opacity: 0.6;
    }
  }
  .fl-tile-preview {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .fl-tile-overlay {
    position: absolute;
    inset: 0;
    display: block;
    pointer-events: none;
  }
  .fl-tile-scrim {
    position: absolute;
    inset: 0;
    background: linear-gradient(to bottom, rgb(0 0 0 / 35%), transparent 32%, transparent 68%, rgb(0 0 0 / 35%));
    opacity: 0;
    transition: opacity var(--fl-motion-fast) var(--fl-ease);
  }
  .fl-tile:hover .fl-tile-scrim,
  .fl-tile:focus-within .fl-tile-scrim,
  .fl-tile.is-selected .fl-tile-scrim {
    opacity: 1;
  }
  /*
   * Selected (asset-tile.css:64-72): the photo settles inward on an accent bed. The ring is its own
   * element, last in the button, so it paints above the photo; it also carries the keyboard focus
   * ring, which an outline on the button itself would draw under the photo.
   */
  .fl-tile-ring {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 3px var(--fl-accent);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--fl-motion-fast) var(--fl-ease);
  }
  .fl-tile.is-selected .fl-tile-open {
    background: color-mix(in srgb, var(--fl-accent) 18%, var(--fl-canvas));
  }
  .fl-tile.is-selected .fl-tile-ring {
    opacity: 1;
  }
  .fl-tile.is-pressing:not([data-layout='list']) .fl-tile-media {
    scale: 0.96;
  }
  .fl-tile.is-selected:not([data-layout='list']) .fl-tile-media {
    scale: 0.92;
    border-radius: var(--fl-radius-xs);
  }
  .fl-tile-open:focus-visible {
    outline: none;
  }
  .fl-tile-open:focus-visible .fl-tile-ring {
    opacity: 1;
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-inset);
    box-shadow: inset 0 0 0 4px var(--fl-canvas);
  }
  @media (forced-colors: active) {
    .fl-tile.is-selected .fl-tile-ring {
      outline: 3px solid Highlight;
      outline-offset: -3px;
    }
  }
  /* T-16 (asset-tile.css:177-237): badges sit bottom-left on 20px, 4px-radius plates; the rating
     sits bottom-right as plain stars over a drop shadow. */
  .fl-tile-badges {
    position: absolute;
    inset-inline-start: 6px;
    bottom: 6px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    max-width: calc(100% - 12px);
    pointer-events: none;
  }
  .fl-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 20px;
    padding: 0 6px;
    border-radius: var(--fl-radius-xs);
    background: rgb(0 0 0 / 58%);
    color: var(--fl-viewer-text);
    font-size: var(--fl-font-micro);
    font-weight: 500;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .fl-badge-icon {
    width: 20px;
    padding: 0;
    justify-content: center;
  }
  .fl-favorite {
    color: var(--fl-tile-favorite);
  }
  .fl-tile-rating {
    position: absolute;
    inset-inline-end: 8px;
    bottom: 8px;
    display: inline-flex;
    align-items: center;
    gap: 1px;
    color: var(--fl-viewer-text);
    font-size: var(--fl-font-micro);
    filter: drop-shadow(0 1px 2px rgb(0 0 0 / 70%));
    pointer-events: none;
  }
  .fl-tile-job-slot {
    position: absolute;
    inset-inline-end: 6px;
    top: 6px;
    pointer-events: none;
  }
  .fl-tile[data-layout='list'] .fl-tile-badges {
    inset-inline-start: 4px;
    bottom: 4px;
    gap: 2px;
  }
  .fl-tile[data-layout='list'] .fl-badge {
    height: 16px;
    padding: 0 4px;
    font-size: 10px;
  }
  .fl-tile[data-layout='list'] .fl-badge-icon {
    width: 16px;
    padding: 0;
  }
  /* Template asset-tile.css `.at-actions`: a dark capsule in the top corner, shown on hover and focus. */
  .fl-tile-actions {
    position: absolute;
    inset-inline-end: 6px;
    top: 6px;
    z-index: 2;
    display: flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid rgb(255 255 255 / 12%);
    border-radius: var(--fl-radius-sm);
    background: color-mix(in srgb, var(--fl-viewer-canvas) 86%, transparent);
    opacity: 0;
    transform: translateY(-4px);
    transition:
      opacity var(--fl-motion-fast) var(--fl-ease),
      transform var(--fl-motion-fast) var(--fl-ease);
  }
  .fl-tile:hover .fl-tile-actions,
  .fl-tile:focus-within .fl-tile-actions {
    opacity: 1;
    transform: none;
  }
  .fl-tile-actions button {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: var(--fl-radius-xs);
    background: transparent;
    color: var(--fl-viewer-text);
    cursor: pointer;
  }
  .fl-tile-actions button:hover,
  .fl-tile-actions button:focus-visible {
    background: rgb(255 255 255 / 14%);
  }
  .fl-tile-actions button.is-favorite {
    color: var(--fl-tile-favorite);
  }
  /* The actions take the top corner while they show; the job state there steps aside. */
  .fl-tile.has-actions:hover .fl-tile-job-slot,
  .fl-tile.has-actions:focus-within .fl-tile-job-slot {
    opacity: 0;
  }
  .fl-tile-select {
    position: absolute;
    inset-inline-start: 4px;
    top: 4px;
    z-index: 2;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    opacity: 0;
    transition: opacity var(--fl-motion-fast) var(--fl-ease);
  }
  .fl-tile:hover .fl-tile-select,
  .fl-tile:focus-within .fl-tile-select,
  .fl-tile.is-selecting .fl-tile-select,
  .fl-tile.is-selected .fl-tile-select {
    opacity: 1;
  }
  /*
   * Touch (asset-tile.css `@media (hover: none)`): no ring on every photograph. Press and hold
   * starts a selection; the rings then show with a full-size target.
   */
  .fl-tile-select.is-coarse {
    inset-inline-start: 0;
    top: 0;
    width: var(--fl-control-height);
    height: var(--fl-control-height);
    opacity: 0;
    pointer-events: none;
  }
  .fl-tile.is-selecting .fl-tile-select.is-coarse,
  .fl-tile.is-selected .fl-tile-select.is-coarse {
    opacity: 1;
    pointer-events: auto;
  }
  .fl-tile-select input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    margin: 0;
    /* Above the ring it sits on: the ring scales on hover, which would otherwise lift it over the
       input and take the click. */
    z-index: 1;
    opacity: 0;
    cursor: pointer;
  }
  .fl-tile-select > span {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border: 2px solid rgb(255 255 255 / 92%);
    border-radius: 50%;
    background: rgb(0 0 0 / 28%);
    box-shadow: 0 1px 3px rgb(0 0 0 / 45%);
    color: var(--fl-accent-text);
    transition:
      scale var(--fl-motion-fast) var(--fl-ease),
      background-color var(--fl-motion-fast) var(--fl-ease),
      border-color var(--fl-motion-fast) var(--fl-ease);
  }
  .fl-tile-select.is-coarse > span {
    width: 24px;
    height: 24px;
  }
  .fl-tile-select:hover > span {
    scale: 1.08;
  }
  /* A filled accent plate; the tick on it unfurls once as the photo settles. */
  .fl-tile.is-selected .fl-tile-select > span {
    border-color: var(--fl-accent);
    background: var(--fl-accent);
  }
  .fl-tile-tick {
    display: grid;
    place-items: center;
  }
  .fl-tile-select:has(input:focus-visible) > span {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  @media (hover: none) {
    /* Hover-only quick actions have no touch equivalent; the selection bar carries them. */
    .fl-tile-actions {
      display: none;
    }
  }
  /*
   * Template asset-tile.css `.at-caption`: inset from the tile edges so one tile's time never runs
   * into the next tile's name across the gutter.
   */
  .fl-tile-caption {
    position: absolute;
    inset-inline: 0;
    bottom: 0;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 6px 0;
    color: var(--fl-text);
    font-size: var(--fl-font-small);
    line-height: 1.4;
    pointer-events: none;
  }
  .fl-tile-caption span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fl-tile-caption time {
    flex: 0 0 auto;
    margin-inline-start: auto;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    font-variant-numeric: tabular-nums;
  }
  .fl-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  /* Template asset-tile.css "List layout". */
  .fl-tile[data-layout='list'] {
    display: grid;
    grid-template-columns: 96px minmax(140px, 1fr) 110px 70px 120px;
    gap: 14px;
    align-items: center;
    padding: 6px 8px;
    overflow: visible;
    border-radius: 0;
    border-bottom: 1px solid var(--fl-border);
    background: transparent;
  }
  .fl-tile[data-layout='list'] .fl-tile-open {
    position: relative;
    inset: auto;
    overflow: hidden;
    border-radius: var(--fl-radius-sm);
    background: var(--fl-raised);
  }
  .fl-tile[data-layout='list'] .fl-tile-actions {
    top: 50%;
    inset-inline-end: 10px;
    transform: translateY(-50%);
  }
  .fl-tile[data-layout='list']:hover .fl-tile-actions,
  .fl-tile[data-layout='list']:focus-within .fl-tile-actions {
    transform: translateY(-50%);
  }
  .fl-tile[data-layout='list'] .fl-tile-select {
    inset-inline-start: 12px;
    top: 10px;
  }
  .fl-list-name {
    min-width: 0;
    overflow: hidden;
    color: var(--fl-text);
    font-size: var(--fl-font-small);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fl-list-cell {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  @media (max-width: 700px) {
    .fl-tile[data-layout='list'] {
      grid-template-columns: 96px minmax(0, 1fr) 70px;
    }
    .fl-list-date,
    .fl-list-kind {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-tile-actions {
      transform: none;
    }
    .fl-tile-scrim,
    .fl-tile-select {
      transition: none;
    }
    /* Reduce Motion: nothing scales; the ring, tint and tick crossfade in. */
    .fl-tile.is-selected .fl-tile-media,
    .fl-tile.is-pressing .fl-tile-media {
      scale: none;
      border-radius: 0;
    }
    .fl-tile:hover :global(.fl-tile-image),
    .fl-tile-select:hover > span {
      scale: none;
    }
    /* The just-unlocked item crossfades in instead of sharpening. */
    .fl-tile.is-revealing .fl-tile-media {
      animation: fl-fade-in var(--fl-duration-reduced) var(--fl-ease) both !important;
    }
    .fl-tile-ring {
      transition: opacity var(--fl-duration-reduced) var(--fl-ease) !important;
    }
  }
</style>
