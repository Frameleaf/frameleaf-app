<script lang="ts">
  import { locale } from '$lib/stores/preferences.store';
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
  import EmptyState from '$lib/components/frameleaf/EmptyState.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import TypedConfirmation from '$lib/components/frameleaf/settings/TypedConfirmation.svelte';
  import { matchesTyped } from '$lib/components/frameleaf/settings/typed-confirmation';
  import { animateFlip, canAnimate, dock, leave } from '$lib/frameleaf/motion';
  import { OpenQueryParam } from '$lib/constants';
  import { formatBytes } from '$lib/frameleaf/physical-dedup';
  import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
  import {
    allSelected,
    deleteConfirmationPhrase,
    isStaleReview,
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
  import { websocketEvents, type AssetLocalEffectsV1 } from '$lib/stores/websocket';
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
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
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
  /** What the last restore put back, so it can be undone while its notice is shown. */
  let undoIds = $state<string[] | null>(null);
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
  const localSequences = new Map<string, bigint>();
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
  /**
   * Two tiers of confirmation (design review finding 74). A bounded set of the account's own
   * selected items is confirmed with a clear summary and a danger button. Emptying the trash, or a
   * large selection, also asks for the count to be typed; capitals do not matter.
   */
  const TYPED_CONFIRMATION_FROM = 50;
  const typedConfirmation = $derived(
    !!review && (review.action === TrashReviewAction.Empty || review.count >= TYPED_CONFIRMATION_FROM),
  );
  const canConfirm = $derived(
    !!review && !busy && (!typedConfirmation || matchesTyped(deleteConfirmationPhrase(review.count), confirmation)),
  );
  let grid = $state<HTMLElement>();
  /** Above this many rows at once, they are simply removed: a move that large is noise. */
  const MOVING_ROWS_LIMIT = 24;
  /**
   * Takes rows off the page as one move: they fade, then the rest close the gap (design review
   * finding 76). Without the Web Animations API, or for a large set, the rows are just removed.
   * Under Reduce Motion the fade is the shared crossfade and nothing slides.
   */
  const removeRows = (ids: string[], apply: () => void) =>
    new Promise<void>((resolve) => {
      const rows = [...(grid?.querySelectorAll<HTMLElement>('article[data-row-id]') ?? [])];
      const leaving = rows.filter((row) => ids.includes(row.dataset.rowId ?? ''));
      const close = () => {
        animateFlip(grid, apply, { selector: 'article[data-row-id]' });
        resolve();
      };
      if (leaving.length === 0 || leaving.length > MOVING_ROWS_LIMIT || !canAnimate(leaving[0])) {
        close();
        return;
      }
      let pending = leaving.length;
      for (const row of leaving) {
        leave(row, 'pop', () => {
          if (--pending === 0) {
            close();
          }
        });
      }
    });

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
    undoIds = null;
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

  const onLocalEffects = (bundle: AssetLocalEffectsV1) => {
    if (!/^[1-9][0-9]{0,18}$/.test(bundle.sequence)) {
      return;
    }
    const sequence = BigInt(bundle.sequence);
    if ((localSequences.get(bundle.streamEpoch) ?? 0n) >= sequence) {
      return;
    }
    localSequences.set(bundle.streamEpoch, sequence);
    // Fence every currently awaited page/action before the debounce, then reconcile actual current state.
    generation++;
    scheduleRefresh();
  };

  const failureMessage = (cause: unknown) =>
    isStaleReview(cause) ? $t('frameleaf_trash_error_changed') : $t('frameleaf_trash_error_unavailable');

  /** Above this many items, restoring everything is not offered an Undo: listing them first would hold it up. */
  const RESTORE_ALL_UNDO_LIMIT = 5000;
  /**
   * Every item "Restore all" will put back, when that can be known cheaply: the rows on the page if
   * they are the whole trash, otherwise the trash read page by page. `null` when it cannot be known.
   */
  const everyRestorableId = async (onPage: string[], whole: boolean): Promise<string[] | null> => {
    if (whole) {
      return onPage;
    }
    if (actionable > RESTORE_ALL_UNDO_LIMIT) {
      return null;
    }
    try {
      const ids: string[] = [];
      for (let page = 1; ; page++) {
        const answer = await getTrashItems({ page, size: TRASH_MAX_PAGE_SIZE, sort: TrashItemSort.Recent });
        ids.push(...answer.items.filter((row) => !row.isOffline).map((row) => row.id));
        if (!answer.nextPage || ids.length > RESTORE_ALL_UNDO_LIMIT) {
          break;
        }
      }
      return ids.length > RESTORE_ALL_UNDO_LIMIT ? null : ids;
    } catch {
      return null;
    }
  };

  /**
   * Restore goes straight through its review, without a confirmation (as in the template): nothing is
   * lost by it, and the apply still refuses if the items changed in between.
   *
   * The items leave the page at once and come back, with the reason, if the restore fails (design
   * review finding 76); that holds for "Restore all" too. The notice that follows offers Undo, which
   * moves the same items back to the trash.
   */
  const restore = async (targets: string[] | null) => {
    if (busy || (targets !== null && targets.length === 0)) {
      return;
    }
    busy = true;
    error = '';
    const run = generation;
    notice = '';
    undoIds = null;
    const before = { items, selected };
    const leaving = targets ?? selectable.map((row) => row.id);
    // Read before the page is cleared: "Restore all" covers the whole trash, whatever is filtered.
    const restorable = targets ?? everyRestorableId(leaving, !filtered && nextPage === null);
    inspectOpen = false;
    await removeRows(leaving, () => {
      items = withoutIds(items, leaving);
      selected = targets === null ? [] : selected.filter((id) => !leaving.includes(id));
    });
    try {
      const restored = await restorable;
      const action = targets === null ? TrashReviewAction.RestoreAll : TrashReviewAction.Restore;
      const ids = targets ?? undefined;
      const reviewed = await reviewTrash({ trashReviewDto: { action, ids } });
      if (run !== generation) {
        return;
      }
      const { count } = await applyTrashReview({ trashApplyDto: { action, ids, token: reviewed.token } });
      if (run !== generation) {
        return;
      }
      notice = $t('frameleaf_trash_restored', { values: { count } });
      // Undo is offered only when the items it would move back are exactly the ones restored.
      undoIds = restored && restored.length === count && count > 0 ? restored : null;
    } catch (error_) {
      // A newer load has replaced the page; putting the old rows back would show stale items.
      if (run === generation) {
        items = before.items;
        selected = before.selected;
      }
      error = failureMessage(error_);
    } finally {
      busy = false;
      void refresh();
    }
  };

  /** Moves what the last restore put back into the trash again. */
  const undoRestore = async () => {
    const ids = undoIds;
    if (!ids || busy) {
      return;
    }
    busy = true;
    error = '';
    try {
      const action = TrashReviewAction.Trash;
      const reviewed = await reviewTrash({ trashReviewDto: { action, ids } });
      const { count } = await applyTrashReview({ trashApplyDto: { action, ids, token: reviewed.token } });
      undoIds = null;
      notice = $t('frameleaf_trash_restore_undone', { values: { count } });
    } catch {
      undoIds = null;
      notice = '';
      error = $t('frameleaf_trash_restore_undo_failed');
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
    const run = generation;
    try {
      const reviewed = await reviewTrash({ trashReviewDto: { action, ids } });
      if (run !== generation) {
        return;
      }
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
    const run = generation;
    busy = true;
    reviewError = '';
    try {
      const { count } = await applyTrashReview({
        trashApplyDto: { action: current.action, ids: current.ids, token: current.token },
      });
      if (run !== generation) {
        return;
      }
      const removed = current.ids;
      await removeRows(removed ?? [], () => {
        items = removed ? withoutIds(items, removed) : [];
        selected = removed ? selected.filter((id) => !removed.includes(id)) : [];
      });
      reviewOpen = false;
      review = null;
      notice = $t('frameleaf_trash_deleted', { values: { count } });
      undoIds = null;
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
      websocketEvents.on('AssetLocalEffectsV1', onLocalEffects),
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
      <strong>{available.toLocaleString($locale)}</strong>
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
    <InlineError
      compact
      message={$t('frameleaf_trash_error_load')}
      retryLabel={$t('frameleaf_trash_try_again')}
      retrying={loading}
      onRetry={() => void refresh()}
    />
  {/if}
  {#if notice}
    <div class="tm-notice" role="status" in:dock={{ y: -8 }}>
      <Icon icon={mdiCheckCircleOutline} size="1rem" aria-hidden={true} />
      <span>{notice}</span>
      {#if undoIds}
        <Button disabled={busy} onclick={() => void undoRestore()}>{$t('undo')}</Button>
      {/if}
      <Button
        variant="quiet"
        label={$t('frameleaf_trash_dismiss')}
        onclick={() => {
          notice = '';
          undoIds = null;
        }}
      >
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

  <div class="tm-grid" aria-busy={loading} bind:this={grid}>
    {#each items as row (row.id)}
      <article class:selected={selected.includes(row.id)} class:offline={row.isOffline} data-row-id={row.id}>
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
            <!-- No checkbox and no Restore here on purpose: the library scan owns this item. -->
            <span class="tm-badge">{$t('frameleaf_trash_offline_badge')}</span>
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
    {#if loading && items.length === 0 && !loadFailed}
      <!-- The grid's shape while the first page is read, so the page does not sit empty. -->
      {#each [0, 1, 2, 3, 4, 5, 6, 7] as tile (tile)}
        <div class="tm-placeholder">
          <Skeleton variant="tile" aspect="4 / 3" />
          <Skeleton variant="text" lines={2} />
        </div>
      {/each}
    {/if}
  </div>

  {#if nextPage !== null}
    <div class="tm-more">
      <Button disabled={loading} onclick={() => void showMore()}>
        {$t('frameleaf_trash_show_more', { values: { shown: items.length, total } })}
      </Button>
    </div>
  {/if}

  {#if !loading && !loadFailed && !busy && items.length === 0}
    <!-- An empty trash is a page with nothing on it, so it carries the brand's empty state; a
         search or filter with no matches stays plain and offers the way back. -->
    {#if available > 0 || filtered}
      <EmptyState
        compact
        icon={mdiMagnify}
        title={$t('frameleaf_trash_no_matches')}
        message={$t('frameleaf_trash_no_matches_help')}
        action={filtered ? { label: $t('frameleaf_trash_clear_filters'), onClick: clearFilters } : undefined}
      />
    {:else}
      <EmptyState
        icon={mdiDeleteOutline}
        title={$t('frameleaf_trash_empty_title')}
        message={$t('frameleaf_trash_empty_help')}
      />
    {/if}
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
      {#if typedConfirmation}
        <TypedConfirmation
          label={$t('frameleaf_trash_review_confirm', { values: { phrase: deleteConfirmationPhrase(review.count) } })}
          ariaLabel={$t('frameleaf_trash_review_confirm_label')}
          bind:value={confirmation}
        />
      {/if}
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
        <Button variant="danger" disabled={!canConfirm} onclick={() => void remove()}>
          {$t('frameleaf_trash_review_submit', { values: { count: review.count } })}
        </Button>
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
    font-variant-numeric: var(--fl-numeric);
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
  .trash-manager select {
    width: 100%;
    padding: 10px var(--fl-space-3);
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
    margin-inline-end: auto;
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
  /* An item the library scan manages reads as set aside, so its missing actions look intended. */
  .tm-grid article.offline .tm-photo img {
    opacity: 0.45;
  }
  .tm-badge {
    align-self: flex-start;
    padding: var(--fl-space-half) var(--fl-space-2);
    color: var(--fl-warning);
    background: color-mix(in srgb, var(--fl-warning) 12%, var(--fl-panel));
    border-radius: var(--fl-radius-pill);
    font-size: var(--fl-font-micro);
    font-weight: 600;
  }
  .tm-placeholder {
    display: grid;
    gap: var(--fl-space-3);
    padding-bottom: var(--fl-space-3);
    overflow: hidden;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .tm-placeholder > :global(.fl-skeleton-text) {
    padding-inline: var(--fl-space-3);
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
    inset-inline-start: 8px;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    background: color-mix(in srgb, var(--fl-viewer-canvas) 73%, transparent);
    border-radius: var(--fl-radius-control-compact);
    cursor: pointer;
  }
  .tm-photo > label input {
    margin: 0;
  }
  .tm-photo > span {
    position: absolute;
    right: 8px;
    bottom: 8px;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px var(--fl-space-2);
    font-size: var(--fl-font-micro);
    color: var(--fl-viewer-text);
    background: color-mix(in srgb, var(--fl-viewer-canvas) 73%, transparent);
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
  .tm-notice {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 16px;
    padding: 9px 12px;
    font-size: var(--fl-font-small);
    background: var(--fl-panel);
    border-inline-start: 2px solid var(--fl-accent);
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
    border-inline-start: 2px solid var(--fl-danger);
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
      padding: var(--fl-space-3);
    }
  }
</style>
