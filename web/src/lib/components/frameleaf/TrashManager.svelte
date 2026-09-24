<script lang="ts">
  /**
   * Your trash (FL-47), ported from the design template's `TrashManager.jsx`.
   *
   * An owner-only asset browser over the real trash: summary, retention, search, media and sort
   * filters, selection, quick restore, a preview, and permanent deletion behind a typed
   * confirmation. The template kept a sample trash in localStorage; this page reads the server's
   * own view of the trash (`getTrashSummary`, `getTrashItems`) and changes it only through a review
   * (`reviewTrash`) and an apply of that review (`applyTrashReview`), which the server refuses with
   * 409 when anything changed in between.
   *
   * What the page may show is the server's decision: Locked media only while this session is
   * unlocked, never another account's items, and nothing the owner's privacy filters hide. The page
   * reloads when the session is locked or unlocked, and when another tab, the viewer or a background
   * job trashes, restores or removes something.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { OpenQueryParam } from '$lib/constants';
  import { formatBytes } from '$lib/frameleaf/physical-dedup';
  import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
  import {
    allSelected,
    deleteConfirmationPhrase,
    isStaleReview,
    matchesDeleteConfirmation,
    mergeTrashPage,
    pruneSelection,
    remainingNames,
    toggleSelection,
    TRASH_MAX_PAGE_SIZE,
    TRASH_PAGE_SIZE,
    TRASH_SELECTION_LIMIT,
    trashAgeLabel,
    trashTypeFilter,
    withoutIds,
    type TrashMediaFilter,
  } from '$lib/frameleaf/trash';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { Route } from '$lib/route';
  import { websocketEvents } from '$lib/stores/websocket';
  import { getAssetMediaUrl } from '$lib/utils';
  import {
    applyTrashReview,
    AssetMediaSize,
    AssetTypeEnum,
    getTrashItems,
    getTrashSummary,
    reviewTrash,
    TrashItemSort,
    TrashReviewAction,
    type TrashItemResponseDto,
    type TrashReviewResponseDto,
    type TrashSummaryResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiBackupRestore,
    mdiCheckCircleOutline,
    mdiClose,
    mdiDeleteOutline,
    mdiMagnify,
    mdiMovieOpenOutline,
  } from '@mdi/js';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    /** The rows on the page, for the viewer's next and previous item. */
    items?: TrashItemResponseDto[];
  };

  let { items = $bindable([]) }: Props = $props();

  type Review = TrashReviewResponseDto & { ids?: string[] };

  let summary = $state<TrashSummaryResponseDto | null>(null);
  let total = $state(0);
  let nextPage = $state<string | null>(null);
  let pageSize = $state(TRASH_PAGE_SIZE);
  let loading = $state(true);
  let loadFailed = $state(false);

  let query = $state('');
  let appliedQuery = $state('');
  let media = $state<TrashMediaFilter>('all');
  let sort = $state<TrashItemSort>(TrashItemSort.Recent);

  let selected = $state<string[]>([]);
  let notice = $state('');
  let error = $state('');
  let busy = $state(false);

  let review = $state<Review | null>(null);
  let reviewOpen = $state(false);
  let reviewError = $state('');
  let confirmation = $state('');

  let inspect = $state<TrashItemResponseDto | null>(null);
  let inspectOpen = $state(false);

  /** Discards answers to requests a newer one has replaced. */
  let generation = 0;
  let queryTimer: ReturnType<typeof setTimeout> | undefined;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;

  const trashEnabled = $derived(featureFlagsManager.value.trash);
  const days = $derived(serverConfigManager.value.trashDays);
  const available = $derived(summary?.count ?? 0);
  /** Missing external-library originals are listed but managed by the library scan, not from here. */
  const actionable = $derived(Math.max(0, available - (summary?.offline ?? 0)));
  const selectable = $derived(items.filter((row) => !row.isOffline));
  const filtered = $derived(appliedQuery.trim() !== '' || media !== 'all');
  const chosen = $derived(selectable.filter((row) => selected.includes(row.id)));
  const everythingChosen = $derived(allSelected(selected, selectable) && nextPage === null);
  const canConfirm = $derived(!!review && matchesDeleteConfirmation(review, confirmation) && !busy);
  const retentionValue = $derived(
    trashEnabled ? $t('frameleaf_trash_summary_days', { values: { count: days } }) : $t('frameleaf_trash_disabled'),
  );
  const retentionLabel = $derived(
    trashEnabled ? $t('frameleaf_trash_summary_retention') : $t('frameleaf_trash_summary_disabled'),
  );

  const fetchPage = (page: number, size: number) =>
    getTrashItems({
      page,
      size,
      sort,
      ...(appliedQuery.trim() && { query: appliedQuery.trim() }),
      ...(trashTypeFilter(media) && { $type: trashTypeFilter(media) }),
    });

  /**
   * Load the summary and the list from the first page, until `target` rows are shown or the trash
   * runs out. Every page of one load has the same size, so "Show more" continues where it ended.
   */
  const loadRows = async (target: number): Promise<boolean> => {
    const run = ++generation;
    const size = target <= TRASH_MAX_PAGE_SIZE ? Math.max(TRASH_PAGE_SIZE, target) : TRASH_MAX_PAGE_SIZE;
    loading = true;
    try {
      const [nextSummary, first] = await Promise.all([getTrashSummary(), fetchPage(1, size)]);
      let answer = first;
      let rows = mergeTrashPage([], answer.items, true);
      let page = 1;
      while (answer.nextPage && rows.length < target && rows.length < TRASH_SELECTION_LIMIT) {
        if (run !== generation) {
          return false;
        }
        page++;
        answer = await fetchPage(page, size);
        rows = mergeTrashPage(rows, answer.items, false);
      }
      if (run !== generation) {
        return false;
      }
      summary = nextSummary;
      items = rows;
      total = answer.total;
      nextPage = answer.nextPage;
      pageSize = size;
      selected = pruneSelection(selected, rows);
      loadFailed = false;
      return true;
    } catch {
      if (run === generation) {
        loadFailed = true;
      }
      return false;
    } finally {
      if (run === generation) {
        loading = false;
      }
    }
  };

  /** Reload, keeping as many rows as are shown so a refresh does not collapse a long list. */
  const refresh = ({ keep = true }: { keep?: boolean } = {}) => loadRows(keep ? items.length : TRASH_PAGE_SIZE);

  const showMore = async () => {
    if (!nextPage || loading) {
      return;
    }
    const run = ++generation;
    loading = true;
    try {
      const page = await fetchPage(Number(nextPage), pageSize);
      if (run !== generation) {
        return;
      }
      items = mergeTrashPage(items, page.items, false);
      total = page.total;
      nextPage = page.nextPage;
    } catch {
      if (run === generation) {
        loadFailed = true;
      }
    } finally {
      if (run === generation) {
        loading = false;
      }
    }
  };

  const toggleAll = async () => {
    if (everythingChosen) {
      selected = [];
      return;
    }
    // "Select all" means every matching item, not only the loaded pages
    if (nextPage !== null && !(await loadRows(TRASH_SELECTION_LIMIT))) {
      return;
    }
    selected = selectable.slice(0, TRASH_SELECTION_LIMIT).map((row) => row.id);
  };

  /** A filter change starts over: new list, no selection, no open review (as in the template). */
  const resetView = () => {
    selected = [];
    review = null;
    reviewOpen = false;
    inspectOpen = false;
    error = '';
    notice = '';
    void refresh({ keep: false });
  };

  const onQueryInput = () => {
    clearTimeout(queryTimer);
    queryTimer = setTimeout(() => {
      if (appliedQuery === query) {
        return;
      }

      appliedQuery = query;
      resetView();
    }, 300);
  };

  const clearFilters = () => {
    query = '';
    appliedQuery = '';
    media = 'all';
    resetView();
  };

  /** Coalesce bursts of lifecycle events (a large empty removes items one by one). */
  const scheduleRefresh = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void refresh(), 600);
  };

  const failureMessage = (cause: unknown) =>
    isStaleReview(cause) ? $t('frameleaf_trash_error_changed') : $t('frameleaf_trash_error_unavailable');

  /**
   * Restore goes straight through its review, without a confirmation (as in the template): nothing is
   * lost by it, and the apply still refuses if the items changed in between.
   */
  const restore = async (targets: string[] | null) => {
    if (busy || (targets !== null && targets.length === 0)) {
      return;
    }
    busy = true;
    error = '';
    try {
      const action = targets === null ? TrashReviewAction.RestoreAll : TrashReviewAction.Restore;
      const ids = targets ?? undefined;
      const reviewed = await reviewTrash({ trashReviewDto: { action, ids } });
      const { count } = await applyTrashReview({ trashApplyDto: { action, ids, token: reviewed.token } });
      items = targets === null ? [] : withoutIds(items, targets);
      selected = targets === null ? [] : selected.filter((id) => !targets.includes(id));
      inspectOpen = false;
      notice = $t('frameleaf_trash_restored', { values: { count } });
    } catch (error_) {
      error = failureMessage(error_);
    } finally {
      busy = false;
      void refresh();
    }
  };

  const restoreChosen = () => restore(chosen.map((row) => row.id));

  /** Freeze the set to delete and show it. Empty always covers the whole visible trash, whatever the filters. */
  const prepare = async (action: TrashReviewAction.Delete | TrashReviewAction.Empty) => {
    if (busy) {
      return;
    }
    const ids = action === TrashReviewAction.Delete ? chosen.map((row) => row.id) : undefined;
    if (ids && ids.length === 0) {
      return;
    }
    busy = true;
    error = '';
    try {
      const reviewed = await reviewTrash({ trashReviewDto: { action, ids } });
      review = { ...reviewed, ids };
      confirmation = '';
      reviewError = '';
      reviewOpen = true;
    } catch (error_) {
      error = failureMessage(error_);
      void refresh();
    } finally {
      busy = false;
    }
  };

  const remove = async () => {
    if (!review || !canConfirm) {
      return;
    }
    const current = review;
    busy = true;
    reviewError = '';
    try {
      const { count } = await applyTrashReview({
        trashApplyDto: { action: current.action, ids: current.ids, token: current.token },
      });
      const removed = current.ids;
      items = removed ? withoutIds(items, removed) : [];
      selected = removed ? selected.filter((id) => !removed.includes(id)) : [];
      reviewOpen = false;
      review = null;
      notice = $t('frameleaf_trash_deleted', { values: { count } });
    } catch (error_) {
      reviewError = failureMessage(error_);
    } finally {
      busy = false;
      void refresh();
    }
  };

  const openPreview = (row: TrashItemResponseDto) => {
    inspect = row;
    inspectOpen = true;
  };

  const ageText = (row: TrashItemResponseDto) => {
    const { key, values } = trashAgeLabel(row.trashedAt);
    return $t(key, { values });
  };

  const sizeText = (row: TrashItemResponseDto) =>
    row.fileSizeInByte === null ? $t('frameleaf_trash_size_unknown') : formatBytes(row.fileSizeInByte);

  const kindText = (row: TrashItemResponseDto) =>
    row.type === AssetTypeEnum.Video ? $t('frameleaf_trash_kind_video') : $t('frameleaf_trash_kind_photo');

  onMount(() => {
    void refresh({ keep: false });
    const unsubscribers = [
      // the viewer's own delete, and the server's trash and delete events (another tab, a job)
      eventManager.on({
        AssetsDelete: (ids) => {
          items = withoutIds(items, ids);
          selected = pruneSelection(selected, items);
          scheduleRefresh();
        },
      }),
      websocketEvents.on('on_asset_restore', (ids) => {
        items = withoutIds(items, ids);
        selected = pruneSelection(selected, items);
        scheduleRefresh();
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  });

  // Locking or unlocking the session changes what the trash may show.
  let lastElevated: boolean | undefined;
  $effect(() => {
    const elevated = sessionAccess.isElevated;
    if (lastElevated !== undefined && lastElevated !== elevated) {
      untrack(() => {
        // Locked media leaves the page at once, not when the reload answers.
        if (!elevated) {
          items = items.filter((row) => !row.isLocked);
          if (inspect?.isLocked) {
            inspect = null;
          }
        }
        resetView();
      });
    }
    lastElevated = elevated;
  });

  onDestroy(() => {
    clearTimeout(queryTimer);
    clearTimeout(reloadTimer);
  });
</script>

<section class="trash-manager" aria-label={$t('frameleaf_trash_label')}>
  <div class="tm-summary">
    <div>
      <strong>{available.toLocaleString()}</strong>
      <span>{$t('frameleaf_trash_summary_items')}</span>
    </div>
    <div>
      <strong>{formatBytes(summary?.bytes ?? 0)}</strong>
      <span>{$t('frameleaf_trash_summary_sizes')}</span>
    </div>
    <div>
      <strong>{retentionValue}</strong>
      <span>{retentionLabel}</span>
    </div>
  </div>

  <p class="tm-retention">
    {trashEnabled
      ? $t('frameleaf_trash_retention', { values: { count: days } })
      : $t('frameleaf_trash_retention_disabled')}
    {$t('frameleaf_trash_retention_sizes')}
    {#if (summary?.pendingDeletion ?? 0) > 0}
      {$t('frameleaf_trash_pending_deletion', { values: { count: summary?.pendingDeletion ?? 0 } })}
    {/if}
  </p>

  <div class="tm-toolbar">
    <label>
      {$t('frameleaf_trash_find')}
      <input
        type="search"
        bind:value={query}
        oninput={onQueryInput}
        placeholder={$t('frameleaf_trash_find_placeholder')}
        maxlength="255"
      />
    </label>
    <label>
      {$t('frameleaf_trash_media')}
      <select bind:value={media} onchange={resetView}>
        <option value="all">{$t('frameleaf_trash_media_all')}</option>
        <option value="image">{$t('frameleaf_trash_media_photos')}</option>
        <option value="video">{$t('frameleaf_trash_media_videos')}</option>
      </select>
    </label>
    <label>
      {$t('frameleaf_trash_sort')}
      <select bind:value={sort} onchange={resetView}>
        <option value={TrashItemSort.Recent}>{$t('frameleaf_trash_sort_recent')}</option>
        <option value={TrashItemSort.Size}>{$t('frameleaf_trash_sort_size')}</option>
        <option value={TrashItemSort.Name}>{$t('frameleaf_trash_sort_name')}</option>
      </select>
    </label>
    {#if authManager.user.isAdmin}
      <Button onclick={() => void goto(Route.systemSettings({ isOpen: OpenQueryParam.TRASH }))}>
        {$t('frameleaf_trash_retention_settings')}
      </Button>
    {/if}
  </div>

  {#if error && !reviewOpen}
    <p role="alert" class="tm-error">{error}</p>
  {/if}
  {#if loadFailed}
    <p role="alert" class="tm-error">
      {$t('frameleaf_trash_error_load')}
      <Button variant="quiet" onclick={() => void refresh()}>{$t('frameleaf_trash_try_again')}</Button>
    </p>
  {/if}
  {#if notice}
    <div class="tm-notice" role="status">
      <Icon icon={mdiCheckCircleOutline} size="1rem" aria-hidden={true} />
      <span>{notice}</span>
      <Button variant="quiet" label={$t('frameleaf_trash_dismiss')} onclick={() => (notice = '')}>
        <Icon icon={mdiClose} size="1rem" aria-hidden={true} />
      </Button>
    </div>
  {/if}

  <div class="tm-actions">
    <label>
      <input
        type="checkbox"
        aria-label={$t('frameleaf_trash_select_all')}
        checked={everythingChosen}
        disabled={selectable.length === 0 || busy}
        onchange={() => void toggleAll()}
      />
      {chosen.length > 0
        ? $t('frameleaf_trash_selected', { values: { count: chosen.length } })
        : $t('frameleaf_trash_matching', { values: { count: total } })}
    </label>
    <Button variant="primary" disabled={chosen.length === 0 || busy} onclick={() => void restoreChosen()}>
      {$t('frameleaf_trash_restore_selected', { values: { count: chosen.length } })}
    </Button>
    <span class="tm-danger">
      <Button disabled={chosen.length === 0 || busy} onclick={() => void prepare(TrashReviewAction.Delete)}>
        {$t('frameleaf_trash_delete_selected', { values: { count: chosen.length } })}
      </Button>
    </span>
    {#if selected.length > 0}
      <Button onclick={() => (selected = [])}>{$t('frameleaf_trash_clear_selection')}</Button>
    {/if}
  </div>

  <div class="tm-grid" aria-busy={loading}>
    {#each items as row (row.id)}
      <article class:selected={selected.includes(row.id)}>
        <div class="tm-photo">
          <button
            type="button"
            aria-label={$t('frameleaf_trash_preview', { values: { name: row.originalFileName } })}
            onclick={() => openPreview(row)}
          >
            <img
              src={getAssetMediaUrl({ id: row.id, size: AssetMediaSize.Thumbnail })}
              alt={row.originalFileName}
              loading="lazy"
              draggable="false"
            />
          </button>
          {#if !row.isOffline}
            <label>
              <input
                type="checkbox"
                aria-label={$t('frameleaf_trash_select_item', { values: { name: row.originalFileName } })}
                checked={selected.includes(row.id)}
                onchange={() => (selected = toggleSelection(selected, row.id))}
              />
            </label>
          {/if}
          {#if row.type === AssetTypeEnum.Video}
            <span>
              <Icon icon={mdiMovieOpenOutline} size="0.9375rem" aria-hidden={true} />
              {$t('frameleaf_trash_kind_video')}
            </span>
          {/if}
        </div>
        <div class="tm-detail">
          <strong>{row.originalFileName}</strong>
          <span>{sizeText(row)} · {kindText(row)}</span>
          <small>{ageText(row)}</small>
          {#if row.isOffline}
            <small>{$t('frameleaf_trash_offline')}</small>
          {:else}
            <Button disabled={busy} onclick={() => void restore([row.id])}>
              <Icon icon={mdiBackupRestore} size="1rem" aria-hidden={true} />
              {$t('frameleaf_trash_restore')}
            </Button>
          {/if}
        </div>
      </article>
    {/each}
  </div>

  {#if nextPage !== null}
    <div class="tm-more">
      <Button disabled={loading} onclick={() => void showMore()}>
        {$t('frameleaf_trash_show_more', { values: { shown: items.length, total } })}
      </Button>
    </div>
  {/if}

  {#if !loading && !loadFailed && items.length === 0}
    <div class="tm-empty">
      <Icon icon={available > 0 || filtered ? mdiMagnify : mdiDeleteOutline} size="2.125rem" aria-hidden={true} />
      <h2>{available > 0 || filtered ? $t('frameleaf_trash_no_matches') : $t('frameleaf_trash_empty_title')}</h2>
      <p>
        {available > 0 || filtered ? $t('frameleaf_trash_no_matches_help') : $t('frameleaf_trash_empty_help')}
      </p>
      {#if filtered}
        <Button onclick={clearFilters}>{$t('frameleaf_trash_clear_filters')}</Button>
      {/if}
    </div>
  {/if}

  <div class="tm-all">
    <div>
      <strong>{$t('frameleaf_trash_manage_all')}</strong>
      <p>
        {$t('frameleaf_trash_manage_all_help', { values: { count: actionable } })}
        {#if !sessionAccess.isElevated}
          {$t('frameleaf_trash_manage_all_locked')}
        {/if}
      </p>
    </div>
    <Button disabled={actionable === 0 || busy} onclick={() => void restore(null)}>
      {$t('frameleaf_trash_restore_all', { values: { count: actionable } })}
    </Button>
    <span class="tm-danger">
      <Button disabled={actionable === 0 || busy} onclick={() => void prepare(TrashReviewAction.Empty)}>
        {$t('frameleaf_trash_empty', { values: { count: actionable } })}
      </Button>
    </span>
  </div>
</section>

<Dialog title={inspect?.originalFileName ?? ''} closeLabel={$t('close')} bind:open={inspectOpen}>
  {#if inspect}
    <div class="tm-dialog">
      <img
        class="tm-preview"
        src={getAssetMediaUrl({ id: inspect.id, size: AssetMediaSize.Preview })}
        alt={inspect.originalFileName}
      />
      <p>{sizeText(inspect)} · {ageText(inspect)}</p>
      {#if inspect.isOffline}
        <p>{$t('frameleaf_trash_offline')}</p>
      {/if}
      <div class="tm-dialog-actions">
        <Button onclick={() => (inspectOpen = false)}>{$t('close')}</Button>
        <Button
          variant="primary"
          disabled={busy || inspect.isOffline}
          onclick={() => inspect && void restore([inspect.id])}
        >
          {$t('frameleaf_trash_restore_to_library')}
        </Button>
      </div>
    </div>
  {/if}
</Dialog>

<Dialog
  title={review?.action === TrashReviewAction.Empty
    ? $t('frameleaf_trash_review_empty_title')
    : $t('frameleaf_trash_review_delete_title')}
  closeLabel={$t('cancel')}
  bind:open={reviewOpen}
>
  {#if review}
    <div class="tm-dialog">
      <p>
        <strong>
          {$t('frameleaf_trash_review_count', { values: { count: review.count, size: formatBytes(review.bytes) } })}
        </strong>
      </p>
      <p>
        {$t('frameleaf_trash_review_permanent')}
        {review.action === TrashReviewAction.Empty
          ? $t('frameleaf_trash_review_scope_all')
          : $t('frameleaf_trash_review_scope_selected')}
      </p>
      <ul class="tm-delete-list">
        {#each review.names as name, index (index)}
          <li>{name}</li>
        {/each}
        {#if remainingNames(review) !== null}
          <li>{$t('frameleaf_trash_review_more', { values: { count: remainingNames(review) ?? 0 } })}</li>
        {/if}
      </ul>
      {#if review.retainedOriginals > 0}
        <p>
          {$t('frameleaf_trash_review_retained', {
            values: { count: review.retainedOriginals, size: formatBytes(review.retainedBytes) },
          })}
        </p>
      {/if}
      <label class="tm-confirm">
        {$t('frameleaf_trash_review_confirm', { values: { phrase: deleteConfirmationPhrase(review.count) } })}
        <input
          aria-label={$t('frameleaf_trash_review_confirm_label')}
          bind:value={confirmation}
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      {#if reviewError}
        <p role="alert" class="tm-error">{reviewError}</p>
      {/if}
      <div class="tm-dialog-actions">
        <Button
          onclick={() => {
            reviewOpen = false;
            reviewError = '';
          }}
        >
          {$t('cancel')}
        </Button>
        <span class="tm-danger">
          <Button disabled={!canConfirm} onclick={() => void remove()}>
            {$t('frameleaf_trash_review_submit', { values: { count: review.count } })}
          </Button>
        </span>
      </div>
    </div>
  {/if}
</Dialog>

<style>
  .trash-manager {
    min-width: 0;
    color: var(--fl-text);
  }
  .trash-manager p {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.6;
  }
  .tm-summary {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 20px;
    padding: 23px 0 10px;
  }
  .tm-summary strong {
    display: block;
    font-size: 25px;
    font-weight: 550;
    font-variant-numeric: tabular-nums;
  }
  .tm-summary span {
    display: block;
    margin-top: 7px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .trash-manager .tm-retention {
    max-width: 850px;
    margin: 8px 0 22px;
    font-size: var(--fl-font-micro);
  }
  .tm-toolbar {
    display: flex;
    align-items: end;
    gap: 12px;
    padding-block: 16px;
    border-block: 1px solid var(--fl-border);
  }
  .tm-toolbar > label {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 140px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .tm-toolbar > label:first-child {
    flex: 1;
  }
  .trash-manager input:not([type='checkbox']),
  .trash-manager select,
  .tm-confirm input {
    width: 100%;
    padding: 10px;
    font-size: var(--fl-font-small);
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  input[type='checkbox'] {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--fl-accent);
  }
  .tm-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 9px;
    padding: 16px 0;
  }
  .tm-actions > label {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-right: auto;
    font-size: var(--fl-font-small);
  }
  .tm-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 16px;
  }
  .tm-grid article {
    min-width: 0;
    overflow: hidden;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .tm-grid article.selected {
    border-color: var(--fl-accent);
  }
  .tm-photo {
    position: relative;
  }
  .tm-photo > button {
    display: block;
    width: 100%;
    padding: 0;
    aspect-ratio: 1.5;
    overflow: hidden;
    background: var(--fl-raised);
  }
  .tm-photo img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .tm-photo > label {
    position: absolute;
    top: 8px;
    left: 8px;
    padding: 7px;
    background: rgb(17 17 17 / 67%);
    border-radius: var(--fl-radius-control);
    cursor: pointer;
  }
  .tm-photo > span {
    position: absolute;
    right: 8px;
    bottom: 8px;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 6px;
    font-size: var(--fl-font-micro);
    color: #fff;
    background: rgb(17 17 17 / 73%);
    border-radius: var(--fl-radius-control);
  }
  .tm-detail {
    display: flex;
    flex-direction: column;
    align-items: start;
    gap: 8px;
    padding: 13px;
  }
  .tm-detail strong {
    font-size: var(--fl-font-small);
    font-weight: 550;
    overflow-wrap: anywhere;
  }
  .tm-detail span,
  .tm-detail small {
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .tm-more {
    display: flex;
    justify-content: center;
    padding: 20px 0 0;
  }
  .tm-all {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 26px;
    padding-top: 20px;
    border-top: 1px solid var(--fl-border);
  }
  .tm-all > div {
    flex: 1;
  }
  .tm-all strong {
    font-size: 13px;
    font-weight: 550;
  }
  .tm-all p {
    margin: 7px 0;
    font-size: var(--fl-font-micro);
  }
  .tm-empty {
    padding: 50px 20px;
    text-align: center;
    color: var(--fl-muted);
  }
  .tm-empty h2 {
    margin-top: 18px;
    font-size: 20px;
    font-weight: 500;
    color: var(--fl-text);
  }
  .tm-empty p {
    max-width: 500px;
    margin: 12px auto;
  }
  .tm-notice {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 16px;
    padding: 9px 12px;
    font-size: var(--fl-font-small);
    background: var(--fl-panel);
    border-left: 2px solid var(--fl-accent);
  }
  .tm-notice span {
    flex: 1;
  }
  .tm-error {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px;
    background: var(--fl-panel);
    border-left: 2px solid var(--fl-danger);
  }
  .tm-danger :global(button) {
    color: var(--fl-danger);
    border-color: color-mix(in srgb, var(--fl-danger) 35%, var(--fl-border));
  }
  .tm-dialog {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: min(32rem, 100%);
    margin-top: 12px;
    font-size: var(--fl-font-small);
  }
  .tm-dialog p {
    color: var(--fl-muted);
    line-height: 1.6;
  }
  .tm-dialog p strong {
    color: var(--fl-text);
  }
  .tm-preview {
    width: 100%;
    max-height: 60vh;
    object-fit: contain;
    background: var(--fl-canvas);
  }
  .tm-delete-list {
    padding: 12px 12px 12px 30px;
    list-style: disc;
    line-height: 1.8;
    overflow-wrap: anywhere;
    background: var(--fl-canvas);
  }
  .tm-confirm {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .tm-dialog-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  }
  @media (max-width: 700px) {
    .tm-summary {
      gap: 10px;
    }
    .tm-summary strong {
      font-size: 20px;
    }
    .tm-summary span {
      line-height: 1.5;
    }
    .tm-toolbar {
      flex-wrap: wrap;
    }
    .tm-toolbar > label:first-child {
      flex-basis: 100%;
    }
    .tm-toolbar > label {
      flex: 1;
      min-width: 0;
    }
    .tm-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .tm-actions > label {
      flex-basis: 100%;
      margin-bottom: 5px;
    }
    .tm-all {
      flex-wrap: wrap;
    }
    .tm-all > div {
      flex-basis: 100%;
    }
    .tm-detail {
      padding: 10px;
    }
  }
</style>
