<script lang="ts">
  import type { Translations } from 'svelte-i18n';
  /**
   * Library Care: Missing media and Damaged media (FL-69).
   *
   * Ported from the September 22, 2026 prototype's `UtilitiesManager` missing-media and
   * corrupt-media tools: a scan bar with the last scan and the running one, the account, search
   * and "needs attention" filters, a findings table with an evidence inspector, a fixed-set review
   * before anything changes, and the recovery dialog (`LibraryCareRecoveryDialog`).
   *
   * Everything here is a view of server state:
   *
   * - A scan or a search for originals is a durable job: it can be paused, resumed or cancelled
   *   from here or from Activity, survives the tab closing and is retried once by itself.
   * - Relinking, recovering from a verified copy and moving confirmed damage to the trash are
   *   durable bulk jobs too. Each affected row keeps a small loader until the job has answered for
   *   it, and a refusal is shown on the row rather than the row silently disappearing.
   * - Unsupported RAW and suspected damage are never offered for replacement or the trash.
   * - Another account's findings are an administrator's to review; their Locked media is never
   *   listed, and their thumbnails are not shown (the viewer has no access to them).
   * - The notice after a change offers Undo where the server can take the change back
   *   (UtilitiesManager.jsx:295-320): a dismissal is reopened, a queued scan or search cancelled, a
   *   pause resumed, and the viewer's own damage moved to the trash restored and reopened. A relink
   *   or recovery changed the original itself; putting the old path back is not a status change, so
   *   those notices offer none.
   */
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import LibraryCareRecoveryDialog from '$lib/components/frameleaf/LibraryCareRecoveryDialog.svelte';
  import TileJobState from '$lib/components/frameleaf/TileJobState.svelte';
  import { durableItemStates } from '$lib/frameleaf/bulk-operations';
  import {
    accountOptions,
    canRecover,
    canRelink,
    evidenceKey,
    filterRows,
    formatBytes,
    isActiveOperation,
    LIBRARY_CARE_POLL_MS,
    locatable,
    ownerScope,
    relinkCandidate,
    scanState,
    STATUS_LABEL_KEY,
    statusTone,
    toRows,
    trashable,
    trashUndoable,
    type LibraryCareRow,
    libraryCareActivityKey,
  } from '$lib/frameleaf/library-care';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { utilitiesUrl } from '$lib/frameleaf/utilities';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    cancelMediaOperation,
    chooseCandidates,
    deleteCorrupt,
    dismiss as dismissFindings,
    getAuthStatus,
    getMediaOperation,
    getSummary,
    list as listMediaHealth,
    locateMissing,
    MediaHealthCategory,
    MediaHealthOperationMode,
    MediaHealthRootKind,
    MediaHealthStatus,
    MediaOperationStatus,
    pauseMediaOperation,
    recoverDamaged,
    relinkMissing,
    reopen as reopenFindings,
    restoreAssets,
    resumeMediaOperation,
    startCorruptScan,
    startMissingScan,
    type MediaHealthListResponseDto,
    type MediaHealthRootDto,
    type MediaHealthSummaryResponseDto,
    type MediaOperationDetailDto,
    type UserAdminResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiCheckCircleOutline, mdiClose, mdiImageOffOutline, mdiUndo } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  const DELETE_CONFIRM_TEXT = 'MOVE CORRUPT MEDIA TO TRASH';
  /** Teal and blue carry status, per the September 22 revision; danger is kept for loss. */
  const BADGE_TONE = {
    danger: 'danger',
    warning: 'warning',
    success: 'teal',
    info: 'blue',
    neutral: 'neutral',
  } as const;
  const PAGE_SIZE = 200;

  let {
    category,
    initial,
    initialSummary,
    initialStatus,
    roots,
    users,
    initialOwner,
  }: {
    category: MediaHealthCategory;
    initial: MediaHealthListResponseDto;
    initialSummary: MediaHealthSummaryResponseDto;
    /** A link to one status (the iCloud Photos tool links to resolved findings) shows all results of it. */
    initialStatus?: MediaHealthStatus;
    roots: MediaHealthRootDto[];
    /** Every account, for an administrator's account filter. Empty for everyone else. */
    users: UserAdminResponseDto[];
    /** Whose findings were loaded: `all` or one account's id (UT-13). The reader's own by default. */
    initialOwner?: string;
  } = $props();

  const isMissing = $derived(category === MediaHealthCategory.Missing);
  const isAdmin = $derived(authManager.user.isAdmin);
  const selfId = $derived(authManager.user.id);

  let list = $state(initial);
  let summary = $state(initialSummary);
  let owner = $state<string>(initialOwner ?? authManager.user.id);
  let query = $state('');
  let statusFilter = $state<MediaHealthStatus | undefined>(initialStatus);
  let show = $state<'open' | 'all'>(initialStatus ? 'all' : 'open');
  let selected = $state<string[]>([]);
  let notice = $state('');
  /** How to take the last change back, when the server can (UT-2); resolves true when all of it was. */
  let undo = $state<(() => Promise<boolean>) | null>(null);
  let busy = $state(false);

  let inspect = $state<LibraryCareRow | null>(null);
  let inspectOpen = $state(false);

  type ReviewAction = 'relink' | 'dismiss' | 'trash';
  let review = $state<{ action: ReviewAction; rows: LibraryCareRow[] } | null>(null);
  let reviewOpen = $state(false);
  let confirmation = $state('');

  let recovery = $state<{ mode: 'locate' | 'replace'; ids: string[] } | null>(null);
  let recoveryOpen = $state(false);

  /** Durable bulk jobs this page started: operation id → asset ids, in the job's order. */
  let jobs = $state(new Map<string, string[]>());
  /** Per-asset state from those jobs: pending loaders and refusals. */
  let itemStates = $state(new Map<string, { state: 'pending' } | { state: 'failed'; reasonKey: Translations }>());

  const rows = $derived(toRows(list));
  /** Accounts by name, the reader's own included, as the template's `ownerName` (UT-13). */
  const nameOf = (ownerId: string) =>
    ownerId === selfId ? authManager.user.name : (users.find((user) => user.id === ownerId)?.name ?? ownerId);
  const owners = $derived(accountOptions(users, { id: selfId, name: authManager.user.name }, isAdmin));
  const describe = (row: LibraryCareRow) => `${row.name} ${$t(STATUS_LABEL_KEY[row.status])} ${nameOf(row.ownerId)}`;
  const visible = $derived(filterRows(rows, query, describe));
  const editable = $derived(visible.filter((row) => itemStates.get(row.assetId)?.state !== 'pending'));
  const chosen = $derived(visible.filter((row) => selected.includes(row.id)));
  const allSelected = $derived(editable.length > 0 && editable.every((row) => selected.includes(row.id)));
  const scan = $derived(scanState(summary, category));
  const operation = $derived(summary.operation);
  const active = $derived(isActiveOperation(operation));
  const recoveryRows = $derived(recovery ? rows.filter((row) => recovery!.ids.includes(row.id)) : []);
  const searchingForRecovery = $derived(active && operation?.mode === MediaHealthOperationMode.Locate);
  const trashRows = $derived(trashable(chosen));
  const locatableRows = $derived(locatable(chosen, { rawRecovery: summary.care?.rawRecovery ?? true }));

  const scope = $derived(ownerScope(owner, selfId));

  const time = (value: string | null | undefined) =>
    value ? DateTime.fromISO(value).toLocaleString(DateTime.DATETIME_MED) : '';

  const refresh = async () => {
    try {
      const [nextList, nextSummary] = await Promise.all([
        listMediaHealth({
          category,
          size: PAGE_SIZE,
          status: statusFilter,
          needsAttention: statusFilter ? undefined : show === 'open',
          ...scope,
        }),
        getSummary(scope),
      ]);
      list = nextList;
      summary = nextSummary;
      const available = new Set(toRows(nextList).map(({ id }) => id));
      selected = selected.filter((id) => available.has(id));
    } catch (error) {
      handleError(error, $t('library_care_unable_to_load'));
    }
  };

  /* ---------------------------------------------------------------- */
  /* Following durable work                                            */
  /* ---------------------------------------------------------------- */

  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer === null && (active || jobs.size > 0)) {
      timer = setTimeout(() => {
        timer = null;
        void poll().then(schedule);
      }, LIBRARY_CARE_POLL_MS);
    }
  };
  onDestroy(() => {
    if (timer !== null) {
      clearTimeout(timer);
    }
  });

  const FINISHED: ReadonlySet<MediaOperationStatus> = new Set([
    MediaOperationStatus.Completed,
    MediaOperationStatus.Cancelled,
    MediaOperationStatus.Failed,
  ]);

  const poll = async () => {
    const wasActive = active;
    let settled = false;
    for (const [operationId, ids] of jobs) {
      let detail: MediaOperationDetailDto;
      try {
        detail = await getMediaOperation({ id: operationId });
      } catch {
        continue;
      }
      const states = durableItemStates(ids, detail);
      const next = new Map(itemStates);
      for (const id of ids) {
        const item = states.get(id);
        if (item?.state === 'pending') {
          next.set(id, { state: 'pending' });
        } else if (item?.state === 'failed') {
          next.set(id, { state: 'failed', reasonKey: item.reasonKey });
        } else {
          next.delete(id);
        }
      }
      itemStates = next;
      if (FINISHED.has(detail.status)) {
        const remaining = new Map(jobs);
        remaining.delete(operationId);
        jobs = remaining;
        settled = true;
      }
    }

    try {
      summary = await getSummary(scope);
    } catch {
      // The next poll asks again; the job is unaffected by this tab.
    }
    if (settled || (wasActive && !isActiveOperation(summary.operation))) {
      await refresh();
    }
  };

  const follow = (operationId: string | null | undefined, assetIds: string[]) => {
    if (operationId && assetIds.length > 0) {
      jobs = new Map(jobs).set(operationId, assetIds);
      const next = new Map(itemStates);
      for (const id of assetIds) {
        next.set(id, { state: 'pending' });
      }
      itemStates = next;
    }
    schedule();
  };

  $effect(() => {
    if (active) {
      schedule();
    }
  });

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */

  /** Show what changed, with Undo when `revert` can take it back (UtilitiesManager.jsx:80-95). */
  const announce = (message: string, revert: (() => Promise<boolean>) | null = null) => {
    notice = message;
    undo = revert;
  };

  const undoLast = () =>
    run(async () => {
      const revert = undo;
      if (!revert) {
        return;
      }
      undo = null;
      const complete = await revert();
      notice = complete ? $t('library_care_undone') : $t('library_care_undo_partial');
      await refresh();
    });

  const allReopened = async (ids: string[]) => {
    const { results } = await reopenFindings({ mediaHealthBulkActionDto: { ids } });
    return results.every(({ success }) => success);
  };

  /** Stop following a job whose change was taken back. */
  const unfollow = (operationId: string, assetIds: string[]) => {
    const remaining = new Map(jobs);
    remaining.delete(operationId);
    jobs = remaining;
    const next = new Map(itemStates);
    for (const id of assetIds) {
      next.delete(id);
    }
    itemStates = next;
  };

  const run = async (action: () => Promise<void>) => {
    busy = true;
    try {
      await action();
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      busy = false;
    }
  };

  const startScan = () =>
    run(async () => {
      const { operationId } = await (isMissing ? startMissingScan() : startCorruptScan());
      announce(
        $t('library_care_scan_queued'),
        operationId
          ? async () => {
              await cancelMediaOperation({ id: operationId });
              return true;
            }
          : null,
      );
      summary = await getSummary(scope);
      schedule();
    });

  const pauseOrResume = () =>
    run(async () => {
      if (!operation) {
        return;
      }
      const paused = operation.status === MediaOperationStatus.Paused || !!operation.pauseRequestedAt;
      const id = operation.id;
      await (paused ? resumeMediaOperation({ id }) : pauseMediaOperation({ id }));
      announce(paused ? $t('library_care_scan_resumed') : $t('library_care_scan_paused'), async () => {
        await (paused ? pauseMediaOperation({ id }) : resumeMediaOperation({ id }));
        return true;
      });
      summary = await getSummary(scope);
      schedule();
    });

  const cancelScan = () =>
    run(async () => {
      if (!operation) {
        return;
      }
      await cancelMediaOperation({ id: operation.id });
      // A cancelled job cannot be started again where it stopped: no Undo.
      announce($t('library_care_scan_cancelled'));
      summary = await getSummary(scope);
    });

  const toggle = (id: string) => {
    selected = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
  };

  const toggleAll = () => {
    selected = allSelected ? [] : editable.map(({ id }) => id);
  };

  const openReview = async (action: ReviewAction, targets: LibraryCareRow[]) => {
    if (targets.length === 0) {
      return;
    }
    if (action === 'trash') {
      // Moving damage to the trash needs the PIN when the account has one, as it always has.
      const status = await getAuthStatus();
      if (status.pinCode && !status.isElevated) {
        await goto(Route.pinPrompt({ continue: page.url.pathname + page.url.search }));
        return;
      }
    }
    confirmation = '';
    review = { action, rows: targets.map((row) => ({ ...row })) };
    reviewOpen = true;
  };

  const applyReview = () =>
    run(async () => {
      if (!review) {
        return;
      }
      const { action, rows: targets } = review;
      const ids = targets.map(({ id }) => id);
      reviewOpen = false;

      if (action === 'dismiss') {
        await dismissFindings({ mediaHealthBulkActionDto: { ids } });
        announce($t('library_care_items_updated', { values: { count: ids.length } }), () => allReopened(ids));
        selected = [];
        await refresh();
        return;
      }

      const response =
        action === 'relink'
          ? await relinkMissing({ mediaHealthBulkActionDto: { ids } })
          : await deleteCorrupt({ mediaHealthDeleteCorruptDto: { ids, confirmText: DELETE_CONFIRM_TEXT } });
      const accepted = new Set(response.results.filter(({ success }) => success).map(({ id }) => id));
      const moved = targets.filter(({ id }) => accepted.has(id));
      const assetIds = moved.map(({ assetId }) => assetId);
      follow(response.operationId, assetIds);
      const refused = response.results.length - accepted.size;
      const operationId = response.operationId;
      if (action === 'relink') {
        // A relink points the original at another file; putting the old path back is not offered.
        announce($t('library_care_relink_queued', { values: { count: accepted.size, refused } }));
      } else {
        announce(
          $t('library_care_trash_queued', { values: { count: accepted.size, refused } }),
          // The trash is recoverable: the viewer's own items come back out and are reviewed again.
          operationId && trashUndoable(moved, selfId)
            ? async () => {
                await cancelMediaOperation({ id: operationId }).catch(() => {});
                unfollow(operationId, assetIds);
                await restoreAssets({ bulkIdsDto: { ids: assetIds } });
                return allReopened(moved.map(({ id }) => id));
              }
            : null,
        );
      }
      selected = [];
    });

  const openRecovery = (mode: 'locate' | 'replace', targets: LibraryCareRow[]) => {
    if (targets.length === 0) {
      return;
    }
    recovery = { mode, ids: targets.map(({ id }) => id) };
    recoveryOpen = true;
  };

  const searchLocations = (rootIds: string[]) =>
    run(async () => {
      if (!recovery) {
        return;
      }
      const { operationId } = await locateMissing({ mediaHealthLocateDto: { ids: recovery.ids, rootIds } });
      announce(
        $t('library_care_search_queued'),
        operationId
          ? async () => {
              await cancelMediaOperation({ id: operationId });
              return true;
            }
          : null,
      );
      summary = await getSummary(scope);
      schedule();
    });

  const commitRecovery = (choices: Record<string, string>) =>
    run(async () => {
      if (!recovery) {
        return;
      }
      const picked = recovery.ids
        .filter((id) => choices[id])
        .map((findingId) => ({ findingId, candidateId: choices[findingId] }));
      if (recovery.mode === 'locate') {
        await chooseCandidates({ mediaHealthChooseCandidatesDto: { choices: picked } });
        announce($t('library_care_choices_saved'));
        recoveryOpen = false;
        await refresh();
        return;
      }

      const response = await recoverDamaged({ mediaHealthRecoverDto: { choices: picked, confirmed: true } });
      const accepted = new Set(response.results.filter(({ success }) => success).map(({ id }) => id));
      follow(
        response.operationId,
        recoveryRows.filter(({ id }) => accepted.has(id)).map(({ assetId }) => assetId),
      );
      // A recovery published a new original; the damaged file is kept, but this is not undone here.
      announce(
        $t('library_care_recovery_queued', {
          values: { count: accepted.size, refused: response.results.length - accepted.size },
        }),
      );
      recoveryOpen = false;
      selected = [];
    });

  const changeScope = async (value: string) => {
    owner = value;
    selected = [];
    await refresh();
  };

  const changeShow = async (value: 'open' | 'all') => {
    show = value;
    statusFilter = undefined;
    selected = [];
    await refresh();
  };

  $effect(() => {
    if (!recoveryOpen) {
      recovery = null;
    }
  });

  /* ---------------------------------------------------------------- */
  /* Words                                                             */
  /* ---------------------------------------------------------------- */

  const scanLine = $derived.by(() => {
    switch (scan.kind) {
      case 'never': {
        return $t('library_care_scan_never');
      }
      case 'queued': {
        return $t('library_care_scan_waiting');
      }
      case 'running': {
        if (scan.operation.mode === MediaHealthOperationMode.Locate) {
          return $t('library_care_search_running');
        }
        return scan.total
          ? $t('library_care_scan_running_count', { values: { done: scan.done, total: scan.total } })
          : $t('library_care_scan_running');
      }
      case 'interrupted': {
        return $t('library_care_scan_interrupted', { values: { time: time(scan.at) } });
      }
      case 'pausing': {
        return $t('library_care_scan_pausing');
      }
      case 'paused': {
        return $t('library_care_scan_paused_line');
      }
      case 'retrying': {
        return $t('library_care_scan_retrying');
      }
      case 'failed': {
        return $t('library_care_scan_failed', { values: { time: time(scan.at) } });
      }
      case 'cancelled': {
        return $t('library_care_scan_cancelled_line', { values: { time: time(scan.at) } });
      }
      default: {
        // The latest job was a search for originals: its run is the one this bar reports.
        return lastWasSearch(scan.at)
          ? $t('library_care_search_last', { values: { time: time(scan.at) } })
          : $t('library_care_scan_last', { values: { time: time(scan.at) } });
      }
    }
  });

  /** The run the bar reports ended with the latest job, and that job was a search for originals. */
  const lastWasSearch = (at: string | null) =>
    operation?.mode === MediaHealthOperationMode.Locate &&
    !!operation.finishedAt &&
    !!at &&
    Math.abs(Date.parse(operation.finishedAt) - Date.parse(at)) < 60_000;

  const activityLabel = (action: string) => $t(libraryCareActivityKey(action));

  const reviewTitle = (action: ReviewAction) =>
    action === 'relink'
      ? $t('library_care_review_relink')
      : action === 'trash'
        ? $t('library_care_review_trash')
        : $t('library_care_review_dismiss');

  const thumb = (row: LibraryCareRow) =>
    row.ownerId === selfId
      ? getAssetMediaUrl({ id: row.assetId, size: AssetMediaSize.Thumbnail, cacheKey: row.thumbhash })
      : null;

  const candidateSummary = (row: LibraryCareRow) => {
    const candidate = relinkCandidate(row);
    if (candidate) {
      return $t('library_care_candidate_ready');
    }
    const count = row.candidates.length;
    return count > 0 ? $t('library_care_candidate_count', { values: { count } }) : '';
  };
</script>

<div class="care">
  {#if notice}
    <!-- UtilitiesManager.jsx:295-320: the notice, Undo while the last change can be taken back, and close. -->
    <div role="status" class="message">
      <span>{notice}</span>
      {#if undo}
        <Button disabled={busy} onclick={undoLast}>
          <span class="with-icon"><Icon icon={mdiUndo} size="1rem" aria-hidden={true} />{$t('undo')}</span>
        </Button>
      {/if}
      <IconButton
        label={$t('library_care_dismiss_message')}
        onclick={() => {
          notice = '';
          undo = null;
        }}
      >
        <Icon icon={mdiClose} size="1rem" />
      </IconButton>
    </div>
  {/if}

  <div class="scan">
    <span>
      <strong>{$t('library_care_findings', { values: { count: list.total } })}</strong>
      <small>{scanLine}</small>
      {#if scan.kind === 'failed' && scan.error}
        <small class="error">{scan.error}</small>
      {/if}
    </span>
    <Button disabled={active || busy} onclick={startScan}>{$t('library_care_scan_again')}</Button>
    {#if active && operation}
      <Button disabled={busy || operation.status === MediaOperationStatus.Cancelling} onclick={pauseOrResume}>
        {operation.status === MediaOperationStatus.Paused || operation.pauseRequestedAt
          ? $t('library_care_resume_scan')
          : $t('library_care_pause_scan')}
      </Button>
      <Button disabled={busy || !!operation.cancelRequestedAt} onclick={cancelScan}>
        {operation.mode === MediaHealthOperationMode.Locate
          ? $t('library_care_cancel_search')
          : $t('library_care_cancel_scan')}
      </Button>
    {/if}
    <!-- UT-14: the Job manager, as the template's onNavigate("processing", "queues") (UtilitiesManager.jsx:552). -->
    <Button onclick={() => goto(Route.queues())}>{$t('library_care_view_jobs')}</Button>
  </div>

  {#if active && operation && operation.totalUnits}
    <progress class="progress" max="100" value={operation.progress} aria-label={$t('library_care_scan_progress')}
    ></progress>
  {/if}

  <!-- Queues the other tools work through (FL-69; the template's queue list, CommandCenter.jsx:2061-2097). -->
  <section class="queues" aria-label={$t('library_care_other_queues')}>
    <div>
      <span>
        <strong>{$t('library_care_queue_duplicates')}</strong>
        <small>
          {summary.care && !summary.care.duplicateReview
            ? $t('library_care_queue_duplicates_off')
            : $t('library_care_queue_groups', { values: { count: summary.queues.duplicates } })}
        </small>
      </span>
      <Button onclick={() => goto(utilitiesUrl('duplicates'))}>{$t('library_care_queue_review')}</Button>
    </div>
    {#if summary.queues.importReview !== null}
      <div>
        <span>
          <strong>{$t('library_care_queue_import')}</strong>
          <small>{$t('library_care_queue_items', { values: { count: summary.queues.importReview } })}</small>
        </span>
        <Button onclick={() => goto(utilitiesUrl('icloud'))}>{$t('library_care_queue_review')}</Button>
      </div>
    {/if}
    <div>
      <span>
        <strong>{$t('library_care_queue_enrichment')}</strong>
        <small>{$t('library_care_queue_waiting', { values: { count: summary.queues.enrichmentPending } })}</small>
      </span>
      <Button onclick={() => goto(Route.queues())}>{$t('library_care_view_jobs')}</Button>
    </div>
  </section>

  <div class="toolbar">
    <!-- UT-13: "All accounts", then every account by name (UtilitiesManager.jsx:158-172). -->
    <label>
      {$t('library_care_account')}
      <select value={owner} onchange={(event) => changeScope(event.currentTarget.value)}>
        {#each owners as option (option.value)}
          <option value={option.value}>{option.name ?? $t('library_care_account_all')}</option>
        {/each}
      </select>
    </label>
    <label>
      {$t('library_care_find_items')}
      <input type="search" bind:value={query} placeholder={$t('library_care_find_placeholder')} />
    </label>
    <label>
      {$t('library_care_show')}
      <select value={show} onchange={(event) => changeShow(event.currentTarget.value === 'all' ? 'all' : 'open')}>
        <option value="open">{$t('library_care_show_open')}</option>
        <option value="all">{$t('library_care_show_all')}</option>
      </select>
    </label>
  </div>

  <div class="toolbar actions">
    {#if isMissing}
      <Button disabled={busy || locatableRows.length === 0} onclick={() => openRecovery('locate', locatableRows)}>
        {$t('library_care_locate')}
      </Button>
      <Button variant="primary" disabled={busy || !canRelink(chosen)} onclick={() => openReview('relink', chosen)}>
        {$t('library_care_relink')}
      </Button>
    {:else}
      <Button disabled={busy || trashRows.length === 0} onclick={() => openReview('trash', trashRows)}>
        {$t('library_care_trash_confirmed')}
      </Button>
    {/if}
    <Button disabled={busy || chosen.length === 0} onclick={() => openReview('dismiss', chosen)}>
      {$t('library_care_dismiss')}
    </Button>
    {#if !isMissing}
      <Button disabled={busy || !canRecover(chosen)} onclick={() => openRecovery('replace', chosen)}>
        {$t('library_care_recover')}
      </Button>
    {/if}
  </div>

  {#if !isMissing}
    <p class="policy">{$t('library_care_damage_policy')}</p>
  {/if}
  {#if summary.care && !summary.care.rawRecovery}
    <p class="policy">{$t('library_care_raw_search_off')}</p>
  {/if}

  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th scope="col">
            <input
              type="checkbox"
              aria-label={$t('library_care_select_all')}
              checked={allSelected}
              disabled={editable.length === 0}
              onchange={toggleAll}
            />
          </th>
          <th scope="col">{$t('library_care_column_original')}</th>
          <th scope="col">{$t('library_care_column_account')}</th>
          <th scope="col">{$t('library_care_column_finding')}</th>
          <th scope="col">{$t('library_care_column_review')}</th>
        </tr>
      </thead>
      <tbody>
        {#each visible as row (row.id)}
          {@const job = itemStates.get(row.assetId)}
          {@const src = thumb(row)}
          <tr>
            <td>
              <input
                type="checkbox"
                aria-label={$t('library_care_select_item', { values: { name: row.name } })}
                disabled={job?.state === 'pending'}
                checked={selected.includes(row.id)}
                onchange={() => toggle(row.id)}
              />
            </td>
            <td>
              <div class="file">
                <span class="thumb">
                  {#if src}
                    <img {src} alt="" loading="lazy" />
                  {:else}
                    <Icon icon={mdiImageOffOutline} size="1.25rem" aria-hidden={true} />
                  {/if}
                  {#if job}
                    <span class="job">
                      <TileJobState
                        {job}
                        label={job.state === 'pending'
                          ? $t('frameleaf_bulk_tile_processing')
                          : $t('frameleaf_bulk_tile_failed', { values: { reason: $t(job.reasonKey) } })}
                      />
                    </span>
                  {/if}
                </span>
                <span class="name">
                  <strong title={row.name}>{row.name}</strong>
                  <small title={row.path}>{row.path}</small>
                  {#if job?.state === 'failed'}
                    <small class="error">
                      {$t('frameleaf_bulk_tile_failed', { values: { reason: $t(job.reasonKey) } })}
                    </small>
                  {/if}
                </span>
              </div>
            </td>
            <td>{nameOf(row.ownerId)}</td>
            <td>
              <span class="finding">
                <Badge
                  value={$t(STATUS_LABEL_KEY[row.status])}
                  label={$t(STATUS_LABEL_KEY[row.status])}
                  tone={BADGE_TONE[statusTone(row.status)]}
                />
                {#if isMissing && candidateSummary(row)}
                  <small>{candidateSummary(row)}</small>
                {/if}
              </span>
            </td>
            <td>
              <Button
                onclick={() => {
                  inspect = row;
                  inspectOpen = true;
                }}
              >
                {$t('library_care_inspect')}
              </Button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if visible.length === 0}
      <div class="empty">
        <Icon icon={mdiCheckCircleOutline} size="1.75rem" aria-hidden={true} />
        <h3>{$t('library_care_empty_title')}</h3>
        <p>
          {list.total === 0 && !query
            ? isMissing
              ? $t('library_care_empty_missing')
              : $t('library_care_empty_damaged')
            : $t('library_care_empty_filtered')}
        </p>
      </div>
    {/if}
    {#if list.total > rows.length}
      <p class="more">{$t('library_care_showing', { values: { shown: rows.length, total: list.total } })}</p>
    {/if}
  </div>

  {#if summary.recent.length > 0}
    <details class="history">
      <summary>{$t('library_care_recent_activity')}</summary>
      {#each summary.recent as item (item.id)}
        <p>
          <span>
            {activityLabel(item.action)} · {$t('library_care_activity_items', { values: { count: item.items } })}
            · {$t(`frameleaf_activity_status_${item.status}`)}
          </span>
          <time datetime={item.finishedAt ?? item.createdAt}>{time(item.finishedAt ?? item.createdAt)}</time>
        </p>
      {/each}
    </details>
  {/if}
</div>

{#if inspect}
  {@const row = inspect}
  {@const src = thumb(row)}
  {@const reason = evidenceKey(row.item)}
  <Dialog title={row.name} closeLabel={$t('done')} bind:open={inspectOpen}>
    <div class="evidence">
      <span class="preview">
        {#if src}
          <img {src} alt={row.name} />
        {:else}
          <Icon icon={mdiImageOffOutline} size="2rem" aria-hidden={true} />
        {/if}
      </span>
      <dl>
        <dt>{$t('library_care_column_account')}</dt>
        <dd>{nameOf(row.ownerId)}</dd>
        {#if row.sizeInBytes}
          <dt>{$t('library_care_original_size')}</dt>
          <dd>{formatBytes(row.sizeInBytes)}</dd>
        {/if}
        <dt>{$t('library_care_status')}</dt>
        <dd>{$t(STATUS_LABEL_KEY[row.status])}</dd>
        <dt>{$t('library_care_original_path')}</dt>
        <dd><code>{row.path}</code></dd>
        {#if reason || row.evidence}
          <dt>{$t('library_care_evidence')}</dt>
          <dd>{reason ? $t(reason) : row.evidence}</dd>
        {/if}
        <dt>{$t('library_care_checked')}</dt>
        <dd>{time(row.item.checkedAt)}</dd>
        {#each row.item.expectedChecksums ?? [] as checksum (checksum.algorithm)}
          <dt>{$t('library_care_recorded_checksum', { values: { algorithm: checksum.algorithm.toUpperCase() } })}</dt>
          <dd><code>{checksum.value}</code></dd>
        {/each}
        {#if row.item.provenance}
          {@const provenance = row.item.provenance}
          <dt>
            {provenance.action === 'recovered'
              ? $t('library_care_provenance_recovered')
              : $t('library_care_provenance_relinked')}
          </dt>
          <dd>
            {$t('library_care_provenance_detail', {
              values: {
                name: provenance.userId ? nameOf(provenance.userId) : '',
                location:
                  provenance.rootKind === MediaHealthRootKind.Managed
                    ? $t('library_care_root_managed')
                    : (provenance.rootLabel ?? ''),
                time: time(provenance.at),
              },
            })}
          </dd>
          {#if provenance.previousPath}
            <dt>{$t('library_care_previous_path')}</dt>
            <dd><code>{provenance.previousPath}</code></dd>
          {/if}
          {#if provenance.sourcePath}
            <dt>{$t('library_care_copy_used')}</dt>
            <dd><code>{provenance.sourcePath}</code></dd>
          {/if}
        {/if}
        {#each row.candidates as candidate (candidate.id)}
          <dt>
            {candidate.chosen ? $t('library_care_candidate_chosen') : $t('library_care_candidate')}
            {#if candidate.rootKind}
              <small>
                {candidate.rootKind === MediaHealthRootKind.Managed
                  ? $t('library_care_root_managed')
                  : (roots.find((root) => root.id === candidate.rootId)?.label ?? '')}
              </small>
            {/if}
          </dt>
          <dd>
            <code>{candidate.candidatePath}</code>
            <small>
              {$t('library_care_checksum')}: {candidate.checksumMatch
                ? $t('library_care_checksum_exact')
                : $t('library_care_checksum_different')} · {$t('library_care_decode')}: {candidate.decodeValid
                ? $t('library_care_decode_validated')
                : $t('library_care_decode_not_validated')} · {$t(STATUS_LABEL_KEY[candidate.status])}
            </small>
            {#each candidate.checksums ?? [] as checksum (checksum.algorithm)}
              <small>{checksum.algorithm.toUpperCase()} <code>{checksum.value}</code></small>
            {/each}
          </dd>
        {/each}
      </dl>
    </div>
    <footer>
      <Button onclick={() => (inspectOpen = false)}>{$t('done')}</Button>
    </footer>
  </Dialog>
{/if}

{#if review}
  {@const current = review}
  <Dialog title={reviewTitle(current.action)} closeLabel={$t('cancel')} bind:open={reviewOpen}>
    <div class="review">
      <p>{$t('library_care_review_fixed')}</p>
      <div class="review-rows">
        {#each current.rows as row (row.id)}
          <div>
            <strong>{row.name}</strong>
            <span>
              {nameOf(row.ownerId)} ·
              {current.action === 'relink'
                ? (relinkCandidate(row)?.candidatePath ?? $t(STATUS_LABEL_KEY[row.status]))
                : $t(STATUS_LABEL_KEY[row.status])}
            </span>
          </div>
        {/each}
      </div>
      {#if current.action === 'trash'}
        <label class="confirm">
          {$t('library_care_type_confirm', { values: { phrase: DELETE_CONFIRM_TEXT } })}
          <input autocomplete="off" bind:value={confirmation} />
          <small>{$t('library_care_trash_identity')}</small>
        </label>
      {/if}
      <p class="policy">
        {current.action === 'trash' ? $t('library_care_trash_policy') : $t('library_care_retained_policy')}
      </p>
      <footer>
        <Button onclick={() => (reviewOpen = false)}>{$t('cancel')}</Button>
        <Button
          variant="primary"
          disabled={busy || (current.action === 'trash' && confirmation !== DELETE_CONFIRM_TEXT)}
          onclick={applyReview}
        >
          {$t('library_care_confirm_items', { values: { count: current.rows.length } })}
        </Button>
      </footer>
    </div>
  </Dialog>
{/if}

{#if recovery && recoveryOpen}
  <LibraryCareRecoveryDialog
    bind:open={recoveryOpen}
    mode={recovery.mode}
    rows={recoveryRows}
    roots={recovery.mode === 'replace' ? roots.filter((root) => root.kind !== MediaHealthRootKind.Library) : roots}
    ownerName={nameOf}
    {busy}
    searching={searchingForRecovery}
    onSearch={searchLocations}
    onCommit={commitRecovery}
  />
{/if}

<style>
  .care {
    display: grid;
    gap: 0.875rem;
    color: var(--fl-text);
    font-size: var(--fl-font-size, 0.875rem);
  }
  .message {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--fl-border);
    border-left: 3px solid var(--fl-teal);
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .message > span {
    flex: 1;
  }
  .with-icon {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
  .queues {
    display: grid;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .queues > div {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.625rem 0.75rem;
  }
  .queues > div + div {
    border-top: 1px solid var(--fl-border);
  }
  .queues span {
    display: grid;
    gap: 0.125rem;
  }
  .queues strong {
    font-weight: 500;
  }
  .queues small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 0.75rem);
  }
  .scan {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .scan > span {
    display: grid;
    gap: 0.125rem;
    flex: 1 1 14rem;
    min-width: 0;
  }
  .scan small,
  .policy,
  .more {
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 0.75rem);
  }
  .error {
    color: var(--fl-danger-text, var(--fl-danger));
  }
  .progress {
    width: 100%;
    height: 0.375rem;
    accent-color: var(--fl-teal);
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.5rem 0.75rem;
  }
  .toolbar label {
    display: grid;
    gap: 0.25rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 0.75rem);
  }
  .toolbar select,
  .toolbar input,
  .confirm input {
    min-height: 2.25rem;
    padding: 0.375rem 0.625rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font-size: var(--fl-font-size, 0.875rem);
  }
  .toolbar input[type='search'] {
    min-width: min(18rem, 100%);
  }
  .policy {
    margin: 0;
  }
  .table-scroll {
    overflow-x: auto;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    padding: 0.5rem 0.75rem;
    text-align: left;
    vertical-align: middle;
    border-bottom: 1px solid var(--fl-border);
  }
  th {
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 0.75rem);
    font-weight: 600;
  }
  input[type='checkbox'] {
    accent-color: var(--fl-accent);
  }
  .file {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    min-width: 14rem;
  }
  .thumb {
    position: relative;
    display: grid;
    place-items: center;
    flex: none;
    width: 3rem;
    height: 3rem;
    overflow: hidden;
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .job {
    position: absolute;
    top: 0.125rem;
    right: 0.125rem;
  }
  .name {
    display: grid;
    gap: 0.125rem;
    min-width: 0;
  }
  .name strong,
  .name small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 28rem;
  }
  .name small,
  .finding small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 0.75rem);
  }
  .name small.error {
    color: var(--fl-danger-text, var(--fl-danger));
    white-space: normal;
  }
  .finding {
    display: grid;
    gap: 0.25rem;
    justify-items: start;
  }
  .empty {
    display: grid;
    justify-items: center;
    gap: 0.375rem;
    padding: 2rem 1rem;
    text-align: center;
    color: var(--fl-muted);
  }
  .empty h3 {
    color: var(--fl-text);
    font-size: 0.9375rem;
  }
  .more {
    padding: 0.5rem 0.75rem;
  }
  .history {
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    padding: 0.5rem 0.75rem;
    background: var(--fl-panel);
  }
  .history summary {
    cursor: pointer;
    color: var(--fl-muted);
  }
  .history p {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    margin: 0.375rem 0 0;
  }
  .history time {
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 0.75rem);
    white-space: nowrap;
  }
  .evidence {
    display: grid;
    grid-template-columns: minmax(0, 10rem) minmax(0, 1fr);
    gap: 1rem;
    margin-top: 0.75rem;
    min-width: min(36rem, 100%);
  }
  .preview {
    display: grid;
    place-items: center;
    aspect-ratio: 1;
    overflow: hidden;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .preview img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 0.375rem 0.75rem;
    margin: 0;
  }
  dt {
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 0.75rem);
  }
  dt small {
    display: block;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  dd small {
    display: block;
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 0.75rem);
  }
  code {
    font-size: 0.75rem;
  }
  .review {
    display: grid;
    gap: 0.75rem;
    margin-top: 0.75rem;
    min-width: min(32rem, 100%);
  }
  .review p {
    margin: 0;
  }
  .review-rows {
    display: grid;
    gap: 0.375rem;
    max-height: 18rem;
    overflow-y: auto;
  }
  .review-rows div {
    display: grid;
    gap: 0.125rem;
    padding: 0.375rem 0.5rem;
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
  }
  .review-rows span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 0.75rem);
    overflow-wrap: anywhere;
  }
  .confirm {
    display: grid;
    gap: 0.25rem;
    font-size: 0.8125rem;
  }
  .confirm small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 0.75rem);
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  @media (max-width: 640px) {
    .evidence {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
