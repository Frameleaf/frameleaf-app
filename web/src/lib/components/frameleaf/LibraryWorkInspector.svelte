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
   * For a picture there it also shows its annotations (FL-652): drawn over the preview, an
   * Annotations section under the name, and "View large" opening the Boards viewer to annotate.
   * Inside the font viewer (`font`, FL-1359) it is that viewer's Details: the font's own facts first,
   * and no preview, colours or "Show in Photos too" (a font stays in Boards).
   */
  import BrokenAsset from '$lib/components/assets/BrokenAsset.svelte';
  import AssetPalette from '$lib/components/frameleaf/AssetPalette.svelte';
  import AssetSources from '$lib/components/frameleaf/AssetSources.svelte';
  import BoardsRating from '$lib/components/frameleaf/BoardsRating.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import {
    acquireAnnotations,
    releaseAnnotations,
    type BoardsAnnotationsState,
  } from '$lib/frameleaf/boards-annotations-store.svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { onDestroy, untrack } from 'svelte';
  import { getExifRating } from '$lib/frameleaf/rating';
  import { formatDuration, cameraLabel, dimensionsLabel } from '$lib/frameleaf/viewer-headline';
  import { locationLabel } from '$lib/frameleaf/info-panel';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    AssetTypeEnum,
    getAssetInfo,
    LibraryScope,
    LibraryViewScope,
    updateAsset,
    type AssetFontResponseDto,
    type AssetResponseDto,
    type ColorFilter,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiArrowExpand, mdiClose, mdiDownload, mdiMapMarker, mdiPlay, mdiTrashCanOutline } from '@mdi/js';
  import { downloadAssetFile } from '$lib/utils/asset-utils';
  import { locale, t } from 'svelte-i18n';

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
    /** Boards' "Move to trash" at the foot of Details (prototype `.pro-inspector-actions`); the owner's only. */
    onTrash?: (asset: TimelineAsset) => void;
    /** Set by the font viewer: the font's facts (null while they load). The viewer has its own close and download. */
    font?: AssetFontResponseDto | null;
  };

  let { asset, selectedCount = 0, onOpen, onClose, onChooseColor, boards = false, onTrash, font }: Props = $props();
  const fontMode = $derived(font !== undefined);
  const originalOnly = $derived(boards && asset && !asset.isImage && !asset.isVideo && !fontMode);
  const weightAxis = $derived(font?.axes.find((axis) => axis.tag === 'wght'));
  /** The licence link a font file carries is shown only when it is a web address. */
  const licenceLink = $derived(font?.licenseUrl && /^https?:\/\//i.test(font.licenseUrl) ? font.licenseUrl : null);
  /** The item whose preview could not be loaded; another item tries its own. */
  let previewFailed = $state<string | null>(null);
  // A failed preview is retried when the selection or its thumbnail changes.
  const previewKey = $derived(asset ? `${asset.id}:${asset.thumbhash ?? ''}` : null);
  $effect(() => {
    void previewKey;
    previewFailed = null;
  });

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
    detail?.localDateTime
      ? formatCaptured(detail.localDateTime, 'UTC')
      : detail?.exifInfo?.dateTimeOriginal
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

  // FL-652: a Boards picture's annotations, shared by the preview, the section and the viewer.
  const annotatedId = $derived(boardsMode && detail?.type === AssetTypeEnum.Image ? detail.id : null);
  let annotations = $state<BoardsAnnotationsState | null>(null);
  let showAnnotations = $state(true);
  let viewer = $state<'view' | 'annotate' | null>(null);
  $effect(() => {
    const id = annotatedId;
    viewer = null;
    if (!id) {
      annotations = null;
      return;
    }
    // Shared with every other view of this picture, so a save that failed earlier shows here with
    // Retry. Untracked: reading the annotations reads their status, and this effect must run again
    // only when the picture changes, never because a read finished or failed.
    const next = untrack(() => {
      const state = acquireAnnotations(id);
      void state.load();
      return state;
    });
    annotations = next;
    return () => void releaseAnnotations(next);
  });

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

{#snippet boardsActions(item: AssetResponseDto)}
  <!-- Prototype `.pro-inspector-actions`: Download original, and the owner's Move to trash. -->
  <div class="actions">
    {#if !fontMode}<button
        type="button"
        class="action fl-control"
        onclick={() =>
          void downloadAssetFile({
            id: item.id,
            filename: item.originalFileName,
            edited: false,
            size: item.exifInfo?.fileSizeInByte ?? undefined,
          })}
      >
        <Icon icon={mdiDownload} size="18" aria-hidden />{$t('download_original')}
      </button>{/if}
    {#if isOwner && onTrash && asset}
      {@const shown = asset}
      <button type="button" class="action danger fl-control" onclick={() => onTrash(shown)}>
        <Icon icon={mdiTrashCanOutline} size="18" aria-hidden />{$t('frameleaf_boards_move_to_trash')}
      </button>
    {/if}
  </div>
{/snippet}

{#snippet boardsDetails(item: AssetResponseDto)}
  {#if annotations}
    {@const current = annotations}
    <section class="part first">
      {#await import('$lib/components/frameleaf/BoardsAnnotationsSection.svelte') then { default: BoardsAnnotationsSection }}<BoardsAnnotationsSection
          annotations={current}
          show={showAnnotations}
          onShowChange={(show) => (showAnnotations = show)}
          onAnnotate={() => (viewer = 'annotate')}
        />{/await}
    </section>
  {/if}
  {#if font}
    <section class="part first" aria-labelledby={`${tabId}-font`}>
      <h3 id={`${tabId}-font`}>{$t('frameleaf_boards_font')}</h3>
      <dl class="facts">
        <dt>{$t('frameleaf_boards_font_family')}</dt>
        <dd>{font.family}</dd>
        <dt>{$t('frameleaf_boards_font_style')}</dt>
        <dd>{font.style}</dd>
        {#if weightAxis}
          <dt>{$t('frameleaf_boards_font_weight')}</dt>
          <dd>{$t('frameleaf_boards_font_weight_range', { values: { min: weightAxis.min, max: weightAxis.max } })}</dd>
        {:else if font.weight}
          <dt>{$t('frameleaf_boards_font_weight')}</dt>
          <dd>{font.weight}</dd>
        {/if}
        {#if font.glyphCount > 0}
          <dt>{$t('frameleaf_boards_font_glyphs')}</dt>
          <dd>{font.glyphCount.toLocaleString($locale ?? undefined)}</dd>
        {/if}
        {#if font.scripts.length > 0}
          <dt>{$t('frameleaf_boards_font_scripts')}</dt>
          <dd>
            {font.scripts.map((script) => $t('frameleaf_boards_font_script', { values: { script } })).join(', ')}
          </dd>
        {/if}
        {#if font.license || licenceLink}
          <dt>{$t('frameleaf_boards_font_licence')}</dt>
          <dd class="licence">
            {#if font.license}<span>{font.license.length > 240 ? `${font.license.slice(0, 240)}…` : font.license}</span
              >{/if}
            {#if licenceLink}<a href={licenceLink} target="_blank" rel="noreferrer noopener">{licenceLink}</a>{/if}
          </dd>
        {/if}
      </dl>
    </section>
    {#if font.faces.length > 1}
      <section class="part" aria-labelledby={`${tabId}-faces`}>
        <h3 id={`${tabId}-faces`}>
          {$t('frameleaf_boards_font_faces', { values: { count: font.faces.length } })}
        </h3>
        <ul class="faces">
          {#each font.faces as face, index (index)}<li>{face.family} {face.style}</li>{/each}
        </ul>
      </section>
    {/if}
  {:else if !fontMode}
    <section class="part" class:first={!annotations}>
      <AssetPalette assetId={item.id} canRetry={isOwner} onChoose={onChooseColor} limit={5} />
    </section>
  {/if}
  {#if canRate}
    <section class="part" aria-labelledby={`${tabId}-rating`}>
      <h3 id={`${tabId}-rating`}>{$t('frameleaf_boards_rating')}</h3>
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
      <dd>
        {item.imageEncoding?.variant === 'fireworks-png'
          ? $t('frameleaf_info_fireworks_png')
          : (item.originalMimeType ?? (asset?.isVideo ? $t('video') : $t('image')))}
      </dd>
      {#if item.imageEncoding?.pages}
        <dt>{$t('frameleaf_info_pages')}</dt>
        <dd>{item.imageEncoding.pages}</dd>
      {/if}
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
  {#if isOwner && !fontMode && !originalOnly}
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

<section
  class="inspector"
  class:is-boards={boardsMode}
  aria-labelledby="fl-work-inspector-title"
  data-testid="frameleaf-work-inspector"
>
  <div class="heading">
    <!-- Boards' inspector is "Details" (prototype ProWorkspace.jsx `Inspector`); Work's is "Information". -->
    <span id="fl-work-inspector-title"
      >{boardsMode ? $t('frameleaf_boards_details') : $t('frameleaf_work_inspector_title')}</span
    >
    {#if fontMode}
      <!-- The font viewer's bar closes it. -->
    {:else if boardsMode}
      <!-- Prototype `.pro-inspector-head`: a bordered square icon button at the app's 44px control height. -->
      <IconButton variant="default" label={$t('frameleaf_work_inspector_close')} onclick={onClose}>
        <Icon icon={mdiClose} size="18" aria-hidden />
      </IconButton>
    {:else}
      <button type="button" class="icon fl-control" aria-label={$t('frameleaf_work_inspector_close')} onclick={onClose}>
        <Icon icon={mdiClose} size="18" aria-hidden />
      </button>
    {/if}
  </div>

  {#if asset}
    {#if fontMode}
      <!-- The specimen is the viewer's stage. -->
    {:else if originalOnly}
      {#if detail && /\.(?:aac|flac|m4a|mp3|ogg|wav)$/i.test(detail.originalFileName)}
        <audio
          controls
          preload="none"
          aria-label={detail.originalFileName}
          src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Original, edited: false })}
        ></audio>
      {:else if asset.thumbhash && previewFailed !== previewKey}
        <a
          class="preview"
          href={/\.(?:docx?|html|key|numbers|pages|potx|pptx?|txt|xlsx?)$/i.test(
            asset.originalFileName ?? detail?.originalFileName ?? '',
          )
            ? getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Original, format: 'document-pdf', edited: false })
            : getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Fullsize, cacheKey: asset.thumbhash })}
          target="_blank"
          rel="noopener"
          aria-label={$t('frameleaf_work_inspector_open')}
        >
          <img
            src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash })}
            alt=""
            onerror={() => (previewFailed = previewKey)}
          />
        </a>
      {/if}
    {:else if annotations && detail}
      {@const current = annotations}
      <figure class="preview annotated">
        {#await import('$lib/components/frameleaf/BoardsAnnotatedImage.svelte')}
          <img
            src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail, cacheKey: asset.thumbhash })}
            alt=""
          />
        {:then { default: BoardsAnnotatedImage }}
          <BoardsAnnotatedImage
            src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail, cacheKey: asset.thumbhash })}
            name={detail.originalFileName}
            items={current.items}
            show={showAnnotations}
            selected={current.selected}
            maxHeight="260px"
          />
        {/await}
        <button
          type="button"
          class="open-large"
          aria-label={$t('frameleaf_boards_viewer_view_large_name', { values: { name: detail.originalFileName } })}
          title={$t('frameleaf_boards_viewer_view_large')}
          onclick={() => (viewer = 'view')}
        >
          <Icon icon={mdiArrowExpand} size="18" aria-hidden />
        </button>
      </figure>
    {:else}
      <button
        type="button"
        class="preview"
        disabled={!detail}
        aria-label={$t('frameleaf_work_inspector_open')}
        onclick={() => onOpen(asset)}
      >
        {#if detail && previewFailed === previewKey}
          <!-- No preview yet (a RAW file before its thumbnail exists): the grid's quiet placeholder. -->
          <BrokenAsset class="preview-missing" hideMessage />
        {:else if detail}<img
            src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail, cacheKey: asset.thumbhash })}
            alt=""
            onerror={() => (previewFailed = previewKey)}
          />
          {#if asset.isVideo}
            <span class="play" aria-hidden="true"><Icon icon={mdiPlay} size="38" /></span>
            {#if duration}<span class="duration">{duration}</span>{/if}
          {/if}
        {/if}
      </button>
    {/if}
    <h2>{font?.family ?? detail?.originalFileName ?? ' '}</h2>
    {#if font && detail}<p class="muted file-name">{detail.originalFileName}</p>{/if}
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
      {#if detail}{@render boardsActions(detail)}{/if}
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
            <dd>
              {asset.isVideo
                ? $t('video')
                : detail.imageEncoding?.variant === 'fireworks-png'
                  ? $t('frameleaf_info_fireworks_png')
                  : $t('image')}
            </dd>
            {#if detail.imageEncoding?.pages}
              <dt>{$t('frameleaf_info_pages')}</dt>
              <dd>{detail.imageEncoding.pages}</dd>
            {/if}
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
    {#if viewer && annotations && detail}
      {@const current = annotations}
      {#await import('$lib/components/frameleaf/BoardsViewer.svelte') then { default: BoardsViewer }}<BoardsViewer
          name={detail.originalFileName}
          src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash })}
          annotations={current}
          startMode={viewer}
          show={showAnnotations}
          onShowChange={(show) => (showAnnotations = show)}
          onClose={() => (viewer = null)}
        />{/await}
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
  .preview :global(.preview-missing) {
    width: 100%;
    aspect-ratio: 1.38;
  }
  .preview.annotated {
    display: grid;
    place-items: center;
    margin: 0;
    min-height: 120px;
    background: var(--fl-viewer-canvas);
  }
  .preview.annotated > img {
    width: auto;
    max-width: 100%;
    max-height: 260px;
    aspect-ratio: auto;
    object-fit: contain;
  }
  .open-large {
    position: absolute;
    top: 8px;
    right: 8px;
    display: grid;
    place-items: center;
    min-width: 32px;
    min-height: 32px;
    border-radius: var(--fl-radius-sm);
    color: white;
    background: rgb(0 0 0 / 0.55);
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
  .file-name {
    margin: 0 0 16px;
    overflow-wrap: anywhere;
    font-size: var(--fl-font-small);
  }
  .licence {
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow-wrap: anywhere;
  }
  .licence a {
    color: var(--fl-accent);
  }
  .faces {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--fl-font-small);
  }
  .empty {
    margin-top: 1rem;
  }
  button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  /*
   * Boards (prototype .pro-inspector): a headed panel with a hairline under "Details", a 24px inset,
   * sections 24px apart with no rules between them, and uppercase eyebrow labels ("COLOURS").
   */
  .inspector.is-boards {
    padding: 0 0 var(--fl-space-6);
  }
  /* Stays put while the body scrolls, as the prototype's fixed `.pro-inspector-head`. */
  .is-boards .heading {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--fl-panel);
    margin-bottom: var(--fl-space-4);
    padding: var(--fl-space-3) var(--fl-space-3) var(--fl-space-3) var(--fl-space-6);
    border-bottom: 1px solid var(--fl-border);
    font-size: 15px;
  }
  .is-boards > :not(.heading) {
    margin-inline: var(--fl-space-6);
  }
  .is-boards > .preview,
  .is-boards > .preview.annotated {
    width: auto;
  }
  .is-boards h2 {
    margin: var(--fl-space-3) var(--fl-space-6) 0;
    font-size: 15px;
  }
  .is-boards .boards .part {
    margin-top: var(--fl-space-6);
    padding-top: 0;
    border-top: 0;
  }
  .is-boards .boards .part.first {
    margin-top: var(--fl-space-6);
  }
  /* Pinned to the foot of the panel as it scrolls (prototype `.pro-inspector-actions`). */
  .is-boards > .actions {
    position: sticky;
    bottom: 0;
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-2);
    margin: var(--fl-space-6) 0 calc(-1 * var(--fl-space-6));
    padding: var(--fl-space-3) var(--fl-space-6);
    background: var(--fl-panel);
    border-top: 1px solid var(--fl-border);
  }
  .action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-2);
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .action.danger {
    color: var(--fl-danger);
  }
  .is-boards .boards :global(h3) {
    margin: 0 0 var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
</style>
