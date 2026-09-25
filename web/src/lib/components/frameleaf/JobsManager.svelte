<script lang="ts">
  /**
   * The Job manager (FL-71): the design template's `JobsManager.jsx` (`jobs-manager.css`) in
   * Compute & jobs → Queues & jobs, on the server's real queues. It replaces Immich's queue cards
   * and queue page, keeping every command they had:
   *
   * - header: All queues (in a queue), Resume n paused, Concurrency (the template's concurrency
   *   dialog on the central settings draft, with its pending count), Enrichment tasks and the
   *   primary Create job (the template's maintenance job dialog);
   * - the four metrics, the search/category/status filters and the queue table with each queue's
   *   status, counts, workers and pause/resume;
   * - one queue (`?queue=<slug>`, `&tab=`): its pause/resume and start commands (run missing,
   *   reprocess all, refresh faces), the Active/Waiting/Failed/History job tabs listed from the
   *   server with each job's attempts and last error, Clear waiting jobs, Remove failed records,
   *   and the jobs-over-time graph;
   * - the template's "Queue action history": the commands sent from this device.
   *
   * Every queue command, from the page or the command palette, goes through the template's review
   * (what it does, scope, affected now); the destructive ones ask for an acknowledgement, which
   * also covers the face reset confirmation. The failed tab has "Retry failed" (`JobsManager.jsx`
   * 715-727) and each job names its Account and Worker (758-796, 941-948) from the server. The
   * Account filter (341-355, 398-401, 838-840) narrows the counts and the job list to one account's
   * items: the server counts up to 1,000 jobs of each state per queue, and the page says when a count
   * is a lower bound. Queue controls and concurrency still affect every account.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import SettingsOverline from '$lib/components/frameleaf/settings/SettingsOverline.svelte';
  import JobsConcurrencyDialog from '$lib/components/frameleaf/jobs/JobsConcurrencyDialog.svelte';
  import JobsCreateDialog from '$lib/components/frameleaf/jobs/JobsCreateDialog.svelte';
  import JobsEnrichmentDialog from '$lib/components/frameleaf/jobs/JobsEnrichmentDialog.svelte';
  import QueueGraph from '$lib/components/frameleaf/jobs/QueueGraph.svelte';
  import QueueStorageMigrationDescription from '$lib/components/frameleaf/jobs/QueueStorageMigrationDescription.svelte';
  import {
    historyFor,
    JOB_HISTORY_SHOWN,
    readJobHistory,
    recordJobHistory,
    type JobHistoryEntry,
  } from '$lib/frameleaf/job-history';
  import {
    FAILED_CLEAN_LIMIT,
    isFeatureOff,
    isJobTab,
    JOB_QUEUE_CATEGORIES,
    JOB_QUEUE_STATUSES,
    JOB_QUEUES,
    JOB_TAB_STATUSES,
    JOB_TABS,
    jobCounts,
    jobNameKey,
    jobQueue,
    jobQueueStatus,
    jobTabCount,
    matchesQueueFilters,
    searchTerms,
    startBlocked,
    sumJobCounts,
    manualJobKey,
    type JobQueueDefinition,
    type JobQueueStatus,
    type JobTab,
    type ManualJobDefinition,
  } from '$lib/frameleaf/job-queues';
  import type { EnrichmentTaskAction } from '$lib/frameleaf/enrichment-tasks';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { queueManager } from '$lib/managers/queue-manager.svelte';
  import { fromQueueSlug, Route } from '$lib/route';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import {
    handleClearFailedJobs,
    handleClearWaitingJobs,
    handlePauseQueue,
    handleResumeQueue,
    handleRetryFailedJobs,
  } from '$lib/services/queue.service';
  import { locale } from '$lib/stores/preferences.store';
  import { OpenQueryParam } from '$lib/constants';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    createJob,
    deferImageDescriptionRequeue,
    getImageDescriptionRequeueEstimate,
    getQueueJobs,
    getQueueOwnerStatistics,
    QueueCommand,
    QueueJobWorkerKind,
    QueueName,
    runQueueCommandLegacy,
    type JobName,
    type QueueJobResponseDto,
    type QueueJobStatus,
    type QueueOwnerStatisticsResponseDto,
    type QueueResponseDto,
    type QueueStatisticsDto,
    searchUsersAdmin,
    triggerImageDescriptionRequeue,
    triggerSmartAlbumReevaluate,
    type SmartAlbumBuiltInKind,
    type UserAdminResponseDto,
  } from '@immich/sdk';
  import { CommandPaletteDefaultProvider, Icon, type ActionItem } from '@immich/ui';
  import {
    mdiAccountMultipleOutline,
    mdiAlertCircleOutline,
    mdiArrowLeft,
    mdiCheckCircleOutline,
    mdiChevronRight,
    mdiClockOutline,
    mdiClose,
    mdiCloudOutline,
    mdiCogOutline,
    mdiDeleteSweepOutline,
    mdiDesktopTowerMonitor,
    mdiHistory,
    mdiImageSearchOutline,
    mdiMagnify,
    mdiPause,
    mdiPlay,
    mdiPlus,
    mdiRedo,
    mdiShieldCheckOutline,
    mdiTuneVariant,
  } from '@mdi/js';
  import { onMount, untrack } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  onMount(() => queueManager.listen());

  // ---- the template's Account filter (JobsManager.jsx 341-355) ----------------------------------

  let owner = $state('all');
  let accounts = $state<UserAdminResponseDto[]>([]);
  let ownerStats = $state(new Map<QueueName, QueueOwnerStatisticsResponseDto>());
  onMount(() => {
    searchUsersAdmin({})
      .then((users) => (accounts = [...users].sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {
        // Without the account list the filter offers All accounts only.
      });
  });
  const ownerName = $derived(
    owner === 'all'
      ? $t('frameleaf_jobs_review_all_accounts')
      : (accounts.find(({ id }) => id === owner)?.name ?? $t('frameleaf_jobs_selected_account')),
  );
  /** A queue's statistics as the Account filter sees them; undefined while an account's are loading. */
  const statsOf = (queue: QueueResponseDto): QueueStatisticsDto | undefined =>
    owner === 'all' ? queue.statistics : ownerStats.get(queue.name);
  const NO_STATS: QueueStatisticsDto = { active: 0, completed: 0, delayed: 0, failed: 0, paused: 0, waiting: 0 };
  const isTruncated = (stats: Map<QueueName, QueueOwnerStatisticsResponseDto>) => {
    for (const { truncated } of stats.values()) {
      if (truncated) {
        return true;
      }
    }
    return false;
  };
  const truncated = $derived(owner !== 'all' && isTruncated(ownerStats));
  /** The account whose counts `ownerStats` holds; until it is the chosen one, counts are loading. */
  let statsOwner = $state<string>();
  const countsLoading = $derived(owner !== 'all' && statsOwner !== owner);
  /** A count as the page shows it: a dash while an account's counts load, never a false 0. */
  /** Queues whose counts for the chosen account could not be read: shown as unknown, never as 0. */
  let failedStats = $state(new Set<QueueName>());
  const countsUnknown = (name?: QueueName) =>
    countsLoading || (owner !== 'all' && (name ? failedStats.has(name) : failedStats.size > 0));
  const count = (value: number, name?: QueueName) => (countsUnknown(name) ? '—' : number(value));

  const flags = $derived(featureFlagsManager.value);
  const draft = getSystemConfigDraft();

  const queues = $derived(queueManager.queues);
  const byName = $derived(new Map(queues.map((queue) => [queue.name, queue])));
  /** The catalogue's queues the server reports, in the template's order. */
  const rows = $derived(
    JOB_QUEUES.flatMap((definition) => {
      const queue = byName.get(definition.name);
      return queue ? [{ definition, queue }] : [];
    }),
  );

  const selectedName = $derived(fromQueueSlug(page.url.searchParams.get('queue') ?? ''));
  const selected = $derived(rows.find((row) => row.definition.name === selectedName));
  const requestedTab = $derived(page.url.searchParams.get('tab'));
  const tab: JobTab = $derived(isJobTab(requestedTab) ? requestedTab : 'active');

  const counts = $derived(
    selected
      ? jobCounts(statsOf(selected.queue) ?? NO_STATS)
      : owner === 'all'
        ? sumJobCounts(queues)
        : sumJobCounts(queues.map((queue) => ({ ...queue, statistics: statsOf(queue) ?? NO_STATS }))),
  );

  // An account's counts: the open queue's, or every listed queue's; again after each command.
  $effect(() => {
    const account = owner;
    const name = selected?.definition.name;
    void jobsReload;
    if (account === 'all') {
      ownerStats = new Map();
      failedStats = new Set();
      statsOwner = undefined;
      return;
    }
    if (untrack(() => statsOwner) !== account) {
      ownerStats = new Map();
    }
    const names = name ? [name] : untrack(() => rows.map((row) => row.definition.name));
    let cancelled = false;
    void Promise.all(
      names.map((queueName) =>
        getQueueOwnerStatistics({ name: queueName, ownerId: account })
          .then((stats) => [queueName, stats] as const)
          .catch(() => undefined),
      ),
    ).then((entries) => {
      if (cancelled) {
        return;
      }

      ownerStats = new Map(entries.filter((entry) => entry !== undefined));
      failedStats = new Set(names.filter((_, index) => entries[index] === undefined));
      statsOwner = account;
    });
    return () => {
      cancelled = true;
    };
  });
  const metrics = $derived([
    { label: $t('frameleaf_jobs_metric_processing'), value: counts.active, icon: mdiPlay, warning: false },
    { label: $t('frameleaf_jobs_metric_waiting'), value: counts.pending, icon: mdiClockOutline, warning: false },
    {
      label: $t('frameleaf_jobs_metric_failed'),
      value: counts.failed,
      icon: mdiAlertCircleOutline,
      warning: counts.failed > 0,
    },
    {
      label: $t('frameleaf_jobs_metric_completed'),
      value: counts.completed,
      icon: mdiCheckCircleOutline,
      warning: false,
    },
  ]);
  const pausedQueues = $derived(rows.filter(({ queue, definition }) => queue.isPaused && definition.canPause));

  let concurrencyOpen = $state(false);
  let createOpen = $state(false);
  let enrichmentOpen = $state(false);
  const openEnrichmentTasks = () => (enrichmentOpen = true);
  /**
   * "Remind me later" on Regenerate descriptions (the template's `descriptionDeferred`, `JobsManager.jsx`
   * 402-408): the server keeps `pendingRequeueAt` until a regeneration is queued.
   */
  let reminderDeferred = $state<boolean | undefined>();
  const descriptionReminder = $derived(
    reminderDeferred ?? !!draft?.baseline.machineLearning?.imageDescription?.pendingRequeueAt,
  );

  /** Concurrency as the settings draft has it; a queue the settings do not list runs one job at a time. */
  type JobSettings = Record<string, { concurrency: number } | undefined>;
  const concurrencyOf = (name: QueueName, source: 'draft' | 'baseline' = 'draft') =>
    ((draft?.[source]?.job as JobSettings | undefined)?.[name]?.concurrency ?? null) as number | null;
  const isFixed = (name: QueueName) => draft !== undefined && concurrencyOf(name) === null;
  const workersOf = (name: QueueName) => concurrencyOf(name) ?? 1;
  const isPendingConcurrency = (name: QueueName) =>
    draft !== undefined && concurrencyOf(name, 'baseline') !== concurrencyOf(name);
  const pendingConcurrency = $derived(
    draft ? draft.changes.filter((change) => change.path.startsWith('job.')).length : 0,
  );

  let query = $state('');
  let category = $state('all');
  let status = $state('all');
  let notice = $state('');
  let error = $state('');

  const title = (definition: JobQueueDefinition) => $t(`frameleaf_jobs_queue_${definition.key}` as Translations);
  const description = (definition: JobQueueDefinition) =>
    $t(`frameleaf_jobs_queue_${definition.key}_description` as Translations);
  const number = (value: number) => value.toLocaleString($locale);
  const statusLabel = (value: JobQueueStatus | QueueJobStatus) => $t(`frameleaf_jobs_status_${value}` as Translations);

  const visibleRows = $derived(
    rows.filter(({ queue, definition }) =>
      matchesQueueFilters(queue, definition, {
        terms: searchTerms(query),
        title: title(definition),
        description: description(definition),
        category,
        status,
      }),
    ),
  );

  const open = async (name?: QueueName, next?: JobTab) => {
    query = '';
    await goto(name ? Route.viewQueue({ name, tab: next }) : Route.queues(), { keepFocus: true, noScroll: !name });
    if (name) {
      main?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  };
  let main: HTMLElement | undefined = $state();

  // ---- the template's "Queue action history": the commands sent from this device -----------------

  let history = $state<JobHistoryEntry[]>(readJobHistory());
  const shownHistory = $derived(historyFor(history, selected?.definition.name));
  const historyDetail = (entry: JobHistoryEntry) => {
    const definition = jobQueue(entry.queue);
    // The template's detail: `${queue title || "Server"} · N items · all accounts`.
    return [
      definition ? title(definition) : $t('frameleaf_jobs_history_server'),
      $t('frameleaf_jobs_review_affected_count', { values: { count: entry.affected } }),
      $t('frameleaf_jobs_history_all_accounts'),
    ].join(' · ');
  };

  // ---- the template's review of a queue command --------------------------------------------------

  type Command =
    | 'pause'
    | 'resume'
    | 'clear-waiting'
    | 'remove-failed'
    | 'retry-failed'
    | 'run'
    | 'force'
    | 'refresh'
    | 'resume-all'
    | 'manual'
    | 'description-requeue'
    | 'description-defer'
    | 'smart-album';
  /** The commands `request` reviews; the enrichment tasks are reviewed by `requestEnrichment` (CC-42). */
  type QueueCommand = Exclude<Command, 'description-requeue' | 'description-defer' | 'smart-album'>;
  type Review = {
    command: Command;
    name?: QueueName;
    manual?: ManualJobDefinition;
    title: string;
    detail: string;
    /** A limit the server applies to this command, stated in the review. */
    note?: string;
    affected: number;
    dangerous: boolean;
    /** Why the command cannot run now (the template's review `error`); the confirm stays disabled. */
    error?: string;
    /** The smart-album category a re-evaluation is limited to. */
    kind?: SmartAlbumBuiltInKind;
  };
  let review = $state<Review | null>(null);
  let reviewOpen = $state(false);
  let acknowledged = $state(false);
  let working = $state(false);

  const runLabel = (definition: JobQueueDefinition) => $t(`frameleaf_jobs_run_${definition.run}` as Translations);
  const forceLabel = (definition: JobQueueDefinition) => $t(`frameleaf_jobs_force_${definition.force}` as Translations);

  const request = (
    command: QueueCommand,
    row?: { definition: JobQueueDefinition; queue: QueueResponseDto },
    manual?: ManualJobDefinition,
  ) => {
    const queueCounts = row ? jobCounts(row.queue.statistics) : undefined;
    const faces = row?.definition.force === 'reset';
    const failed = queueCounts?.failed ?? 0;
    const reviews: Record<QueueCommand, Omit<Review, 'command' | 'name' | 'manual'>> = {
      pause: {
        title: $t('frameleaf_jobs_pause_queue'),
        detail: $t('frameleaf_jobs_review_pause'),
        affected: row ? row.queue.statistics.waiting : 0,
        dangerous: false,
      },
      resume: {
        title: $t('frameleaf_jobs_resume_queue'),
        detail: $t('frameleaf_jobs_review_resume'),
        affected: queueCounts?.paused ?? 0,
        dangerous: false,
      },
      'clear-waiting': {
        title: $t('frameleaf_jobs_clear_waiting'),
        detail: $t('frameleaf_jobs_review_clear_waiting'),
        affected: row ? row.queue.statistics.waiting + row.queue.statistics.paused : 0,
        dangerous: true,
      },
      'remove-failed': {
        title: $t('frameleaf_jobs_remove_failed'),
        detail: $t('frameleaf_jobs_review_remove_failed'),
        // The server removes at most 1,000 failed records per request.
        affected: Math.min(failed, FAILED_CLEAN_LIMIT),
        note:
          failed > FAILED_CLEAN_LIMIT
            ? $t('frameleaf_jobs_review_remove_failed_limit', { values: { limit: FAILED_CLEAN_LIMIT, total: failed } })
            : undefined,
        dangerous: true,
      },
      // The template's retry review (`jobs-data.mjs` 906-919): not destructive, every failed job.
      'retry-failed': {
        title: $t('frameleaf_jobs_retry_failed_title'),
        detail: $t('frameleaf_jobs_review_retry_failed'),
        affected: failed,
        dangerous: false,
      },
      run: {
        title: row ? runLabel(row.definition) : '',
        detail: $t('frameleaf_jobs_review_run'),
        affected: 1,
        dangerous: false,
      },
      force: {
        title: row ? forceLabel(row.definition) : '',
        detail: faces ? $t('frameleaf_jobs_review_force_faces') : $t('frameleaf_jobs_review_force'),
        affected: 1,
        dangerous: true,
      },
      refresh: {
        title: $t('frameleaf_jobs_review_refresh_title'),
        detail: $t('frameleaf_jobs_review_refresh'),
        affected: 1,
        dangerous: false,
      },
      'resume-all': {
        title: $t('frameleaf_jobs_review_resume_all_title'),
        detail: $t('frameleaf_jobs_review_resume_all'),
        affected: pausedQueues.length,
        dangerous: false,
      },
      manual: {
        title: manual ? $t(manualJobKey(manual.name) as Translations) : '',
        detail: manual ? $t(`${manualJobKey(manual.name)}_description` as Translations) : '',
        affected: 1,
        dangerous: manual?.dangerous ?? false,
      },
    };
    review = { command, name: manual?.queue ?? row?.definition.name, manual, ...reviews[command] };
    acknowledged = false;
    reviewOpen = true;
  };

  // The template's review of an enrichment task (`jobs-data.mjs` 819-864).
  const formatSeconds = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.max(1, Math.round((seconds % 3600) / 60));
    return hours > 0
      ? $t('frameleaf_jobs_review_duration_hours', { values: { hours, minutes } })
      : $t('frameleaf_jobs_review_duration_minutes', { values: { minutes } });
  };
  const requestEnrichment = (action: EnrichmentTaskAction) => {
    const description = byName.get(QueueName.ImageDescription)?.statistics;
    const busy = !!description && description.active + description.waiting + description.paused > 0;
    const disabled = draft?.baseline.machineLearning?.imageDescription?.enabled === false;
    switch (action.type) {
      case 'description-requeue': {
        review = {
          command: action.type,
          title: $t('frameleaf_jobs_review_descriptions_title'),
          detail: $t('frameleaf_jobs_review_descriptions'),
          affected: 1,
          dangerous: false,
          error: disabled
            ? $t('frameleaf_jobs_review_descriptions_disabled')
            : busy
              ? $t('frameleaf_jobs_review_descriptions_busy')
              : undefined,
        };
        // The saved model's estimate for every eligible item, read from the server.
        const current = review;
        getImageDescriptionRequeueEstimate()
          .then(({ totalAssets, estimatedTotalSeconds }) => {
            if (review === current) {
              review = {
                ...current,
                note: $t('frameleaf_jobs_review_descriptions_estimate', {
                  values: { count: totalAssets, duration: formatSeconds(estimatedTotalSeconds) },
                }),
              };
            }
          })
          .catch(() => {
            // The review still runs without an estimate.
          });
        break;
      }
      case 'description-defer': {
        review = {
          command: action.type,
          title: $t('frameleaf_jobs_review_descriptions_defer_title'),
          detail: $t('frameleaf_jobs_review_descriptions_defer'),
          affected: 0,
          dangerous: false,
          error: disabled ? $t('frameleaf_jobs_review_descriptions_disabled') : undefined,
        };
        break;
      }
      case 'smart-album': {
        review = {
          command: action.type,
          kind: action.kind,
          title: $t('frameleaf_jobs_review_smart_albums_title'),
          detail: action.kind
            ? $t('frameleaf_jobs_review_smart_albums_kind', {
                values: { kind: $t(`admin.smart_albums_kind_${action.kind}` as const) },
              })
            : $t('frameleaf_jobs_review_smart_albums_all'),
          affected: 1,
          dangerous: false,
        };
        break;
      }
    }
    acknowledged = false;
    reviewOpen = true;
  };

  /** Runs a reviewed command; a returned message replaces the done notice. */
  const perform = async ({ command, name, manual, kind }: Review): Promise<string | undefined> => {
    if (command === 'resume-all') {
      for (const { queue } of pausedQueues) {
        await handleResumeQueue(queue);
      }
      return;
    }
    if (command === 'manual') {
      if (manual) {
        const dto = { name: manual.name };
        await createJob({ jobCreateDto: dto });
        eventManager.emit('JobCreate', { dto });
      }
      return;
    }
    if (command === 'description-requeue') {
      const { queued } = await triggerImageDescriptionRequeue();
      reminderDeferred = false;
      return queued ? undefined : $t('frameleaf_jobs_notice_descriptions_already_queued');
    }
    if (command === 'description-defer') {
      await deferImageDescriptionRequeue();
      reminderDeferred = true;
      return;
    }
    if (command === 'smart-album') {
      const { queued } = await triggerSmartAlbumReevaluate({ smartAlbumReevaluateRequestDto: kind ? { kind } : {} });
      return queued ? undefined : $t('frameleaf_jobs_notice_smart_albums_already_queued');
    }
    if (!name) {
      return;
    }
    switch (command) {
      case 'pause': {
        await handlePauseQueue({ name });
        return;
      }
      case 'resume': {
        await handleResumeQueue({ name });
        return;
      }
      case 'clear-waiting': {
        await handleClearWaitingJobs({ name });
        return;
      }
      case 'remove-failed': {
        await handleClearFailedJobs({ name });
        return;
      }
      case 'retry-failed': {
        await handleRetryFailedJobs({ name });
        return;
      }
      case 'run':
      case 'force':
      case 'refresh': {
        // Refresh faces starts face detection without `force`, as the old queue card did.
        const force = command === 'run' ? false : command === 'force' ? true : undefined;
        await runQueueCommandLegacy({ name, queueCommandDto: { command: QueueCommand.Start, force } });
        return;
      }
    }
  };

  const confirm = async () => {
    if (!review || working || review.error || (review.dangerous && !acknowledged)) {
      return;
    }
    const current = review;
    working = true;
    error = '';
    try {
      const message = await perform(current);
      notice = message ?? $t('frameleaf_jobs_notice_done', { values: { title: current.title } });
      history = recordJobHistory({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        title: current.title,
        queue: current.command === 'resume-all' ? undefined : current.name,
        affected: current.affected,
      });
      reviewOpen = false;
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('errors.something_went_wrong');
      reviewOpen = false;
    } finally {
      working = false;
      await queueManager.refresh();
      jobsReload++;
    }
  };

  // ---- one queue's jobs ---------------------------------------------------------------------------

  type JobRow = QueueJobResponseDto & { status: QueueJobStatus; key: string };
  const PAGE_SIZE = 12;
  let jobs = $state<JobRow[]>([]);
  let jobsLoaded = $state(false);
  let jobsFailed = $state(false);
  let shown = $state(PAGE_SIZE);
  let jobsReload = $state(0);
  let detail = $state<JobRow | null>(null);
  /** The jobs-over-time graph draws only while its disclosure is open. */
  let trendOpen = $state(false);
  let detailOpen = $state(false);

  // A new queue or tab starts from its first page with its own list.
  $effect(() => {
    void selected?.definition.name;
    void tab;
    shown = PAGE_SIZE;
    jobsLoaded = false;
    lastLoad = 0;
    detailOpen = false;
  });

  // The tab's count changes as the queue works; the list follows it, at most every few seconds.
  const tabCount = $derived(selected ? jobTabCount(tab, jobCounts(statsOf(selected.queue) ?? NO_STATS)) : 0);
  let lastLoad = 0;
  $effect(() => {
    const name = selected?.definition.name;
    const statuses = JOB_TAB_STATUSES[tab];
    const ownerId = owner === 'all' ? undefined : owner;
    void jobsReload;
    void tabCount;
    if (!name) {
      jobs = [];
      return;
    }
    let cancelled = false;
    const wait = Math.max(0, lastLoad + 5000 - Date.now());
    const timer = setTimeout(() => {
      lastLoad = Date.now();
      void Promise.all(
        statuses.map((status) =>
          getQueueJobs({ name, status: [status], ownerId }).then((list) =>
            list.map((job, index) => ({ ...job, status, key: `${status}:${job.id ?? index}` })),
          ),
        ),
      )
        .then((lists) => {
          if (cancelled) {
            return;
          }
          jobs = lists.flat().sort((a, b) => b.timestamp - a.timestamp);
          jobsLoaded = true;
          jobsFailed = false;
        })
        .catch(() => {
          if (!cancelled) {
            jobsFailed = true;
          }
        });
    }, wait);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });

  const jobTitle = (name: JobName) => $t(jobNameKey(name) as Translations);
  /** The template's `ownerName` / `destinationName` (`JobsManager.jsx` 37-40), from the server's job data. */
  const accountName = (job: QueueJobResponseDto) => job.account?.name ?? $t('frameleaf_jobs_account_none');
  const workerLabel = (job: QueueJobResponseDto) =>
    $t(
      `frameleaf_jobs_worker_${job.worker.kind === QueueJobWorkerKind.Lan ? 'local' : job.worker.kind}` as Translations,
    );
  const subject = (job: QueueJobResponseDto) => {
    const id = job.data?.id;
    return typeof id === 'string' ? id : '';
  };
  const matchingJobs = $derived(
    jobs.filter((job) => {
      const terms = searchTerms(query);
      const haystack =
        `${job.name} ${jobTitle(job.name)} ${job.id ?? ''} ${JSON.stringify(job.data ?? {})}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    }),
  );
  const shownJobs = $derived(matchingJobs.slice(0, shown));
  const timestamp = (value: number) =>
    new Date(value).toLocaleString($locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const selectTab = (next: JobTab) => {
    if (selected) {
      void goto(Route.viewQueue({ name: selected.definition.name, tab: next }), { keepFocus: true, noScroll: true });
    }
  };
  const onTabKey = (event: KeyboardEvent) => {
    const index = JOB_TABS.indexOf(tab);
    const next =
      event.key === 'ArrowRight'
        ? JOB_TABS[(index + 1) % JOB_TABS.length]
        : event.key === 'ArrowLeft'
          ? JOB_TABS[(index + JOB_TABS.length - 1) % JOB_TABS.length]
          : event.key === 'Home'
            ? JOB_TABS[0]
            : event.key === 'End'
              ? JOB_TABS.at(-1)
              : undefined;
    if (next) {
      event.preventDefault();
      selectTab(next);
      document.querySelector<HTMLElement>(`#jm-tab-${next}`)?.focus();
    }
  };

  const blockedReason = (row: { definition: JobQueueDefinition; queue: QueueResponseDto }) => {
    const reason = startBlocked(row.queue, row.definition, flags);
    return reason === 'feature-off'
      ? $t('frameleaf_jobs_start_feature_off')
      : reason === 'busy'
        ? $t('frameleaf_jobs_start_busy')
        : '';
  };

  const selectManual = (job: ManualJobDefinition) => {
    // As in the template, physical deduplication is prepared and reviewed on its Storage page.
    if (job.opensDeduplication) {
      void goto(Route.physicalDeduplication());
      return;
    }
    request('manual', undefined, job);
  };

  // The command palette offers the page's own commands, with its labels, through the same review.
  const pageActions: ActionItem[] = $derived([
    {
      title: $t('frameleaf_jobs_create_job'),
      icon: mdiPlus,
      shortcuts: { shift: true, key: 'n' },
      onAction: () => (createOpen = true),
    },
    { title: $t('frameleaf_jobs_concurrency'), icon: mdiTuneVariant, onAction: () => (concurrencyOpen = true) },
    { title: $t('frameleaf_jobs_enrichment_tasks'), icon: mdiImageSearchOutline, onAction: openEnrichmentTasks },
    {
      title: $t('frameleaf_jobs_resume_paused', { values: { count: pausedQueues.length } }),
      icon: mdiPlay,
      $if: () => pausedQueues.length > 0,
      onAction: () => request('resume-all'),
    },
  ]);
  const queueActions: ActionItem[] = $derived(
    selected
      ? [
          {
            title: $t('frameleaf_jobs_pause_queue'),
            icon: mdiPause,
            $if: () => !!selected && selected.definition.canPause && !selected.queue.isPaused,
            onAction: () => selected && request('pause', selected),
          },
          {
            title: $t('frameleaf_jobs_resume_queue'),
            icon: mdiPlay,
            $if: () => !!selected?.queue.isPaused,
            onAction: () => selected && request('resume', selected),
          },
          {
            title: $t('frameleaf_jobs_clear_waiting'),
            icon: mdiClose,
            $if: () => !!selected && selected.queue.statistics.waiting + selected.queue.statistics.paused > 0,
            onAction: () => selected && request('clear-waiting', selected),
          },
          {
            title: $t('frameleaf_jobs_retry_failed'),
            icon: mdiRedo,
            $if: () => !!selected && selected.queue.statistics.failed > 0,
            onAction: () => selected && request('retry-failed', selected),
          },
          {
            title: $t('frameleaf_jobs_remove_failed'),
            icon: mdiDeleteSweepOutline,
            $if: () => !!selected && selected.queue.statistics.failed > 0,
            onAction: () => selected && request('remove-failed', selected),
          },
        ]
      : [],
  );
</script>

<CommandPaletteDefaultProvider name={$t('frameleaf_jobs_title')} actions={pageActions} />
{#if selected}
  <CommandPaletteDefaultProvider name={title(selected.definition)} actions={queueActions} />
{/if}

<section class="jobs-manager" aria-label={$t('frameleaf_jobs_label')} bind:this={main}>
  <header class="jm-header">
    <div>
      <SettingsOverline>{$t('frameleaf_jobs_eyebrow')}</SettingsOverline>
      <h1>{selected ? title(selected.definition) : $t('frameleaf_jobs_title')}</h1>
      <p>{selected ? description(selected.definition) : $t('frameleaf_jobs_description')}</p>
    </div>
    <div class="jm-header-actions">
      {#if selected}
        <Button onclick={() => void open()}>
          <Icon icon={mdiArrowLeft} size="1rem" aria-hidden={true} />
          {$t('frameleaf_jobs_all_queues')}
        </Button>
      {/if}
      {#if pausedQueues.length > 0}
        <Button onclick={() => request('resume-all')}>
          <Icon icon={mdiPlay} size="1rem" aria-hidden={true} />
          {$t('frameleaf_jobs_resume_paused', { values: { count: pausedQueues.length } })}
        </Button>
      {/if}
      <Button onclick={() => (concurrencyOpen = true)}>
        <Icon icon={mdiTuneVariant} size="1rem" aria-hidden={true} />
        {pendingConcurrency > 0
          ? $t('frameleaf_jobs_concurrency_pending', { values: { count: pendingConcurrency } })
          : $t('frameleaf_jobs_concurrency')}
      </Button>
      <Button onclick={openEnrichmentTasks}>
        <Icon icon={mdiImageSearchOutline} size="1rem" aria-hidden={true} />
        {$t('frameleaf_jobs_enrichment_tasks')}
      </Button>
      <Button variant="primary" onclick={() => (createOpen = true)}>
        <Icon icon={mdiPlus} size="1rem" aria-hidden={true} />
        {$t('frameleaf_jobs_create_job')}
      </Button>
    </div>
  </header>

  <div class="jm-metrics" aria-busy={countsLoading}>
    {#each metrics as metric (metric.label)}
      <div class="jm-metric" class:warning={metric.warning}>
        <Icon icon={metric.icon} size="22px" aria-hidden={true} />
        <div>
          <span>{metric.label}</span>
          <strong>{count(metric.value)}</strong>
        </div>
      </div>
    {/each}
  </div>

  {#if descriptionReminder}
    <div class="jm-message">
      <Icon icon={mdiClockOutline} size="16px" aria-hidden={true} />
      {$t('frameleaf_jobs_description_reminder')}
      <Button onclick={openEnrichmentTasks}>{$t('frameleaf_jobs_description_reminder_review')}</Button>
    </div>
  {/if}
  {#if error}
    <div class="jm-message jm-error" role="alert">
      <Icon icon={mdiAlertCircleOutline} size="16px" aria-hidden={true} />
      {error}
      <Button variant="quiet" label={$t('frameleaf_jobs_dismiss_error')} onclick={() => (error = '')}>
        <Icon icon={mdiClose} size="1rem" aria-hidden={true} />
      </Button>
    </div>
  {/if}
  {#if notice}
    <div class="jm-message" role="status">
      <Icon icon={mdiCheckCircleOutline} size="16px" aria-hidden={true} />
      {notice}
      <Button variant="quiet" label={$t('frameleaf_jobs_dismiss_notice')} onclick={() => (notice = '')}>
        <Icon icon={mdiClose} size="1rem" aria-hidden={true} />
      </Button>
    </div>
  {/if}

  <div class="jm-filterbar">
    <label class="jm-search">
      <Icon icon={mdiMagnify} size="16px" aria-hidden={true} />
      <span class="jm-sr">{selected ? $t('frameleaf_jobs_search_jobs') : $t('frameleaf_jobs_search_queues')}</span>
      <input
        type="search"
        maxlength="200"
        placeholder={selected
          ? $t('frameleaf_jobs_search_jobs_placeholder')
          : $t('frameleaf_jobs_search_queues_placeholder')}
        bind:value={query}
      />
    </label>
    <label>
      <span>{$t('frameleaf_jobs_account')}</span>
      <select aria-label={$t('frameleaf_jobs_account_filter')} bind:value={owner}>
        <option value="all">{$t('frameleaf_jobs_review_all_accounts')}</option>
        {#each accounts as account (account.id)}
          <option value={account.id}>{account.name}</option>
        {/each}
      </select>
    </label>
    {#if !selected}
      <label>
        <span>{$t('frameleaf_jobs_category')}</span>
        <select bind:value={category}>
          <option value="all">{$t('frameleaf_jobs_category_all')}</option>
          {#each JOB_QUEUE_CATEGORIES as value (value)}
            <option {value}>{$t(`frameleaf_jobs_category_${value}` as Translations)}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>{$t('frameleaf_jobs_status')}</span>
        <select bind:value={status}>
          <option value="all">{$t('frameleaf_jobs_status_all')}</option>
          {#each JOB_QUEUE_STATUSES as value (value)}
            <option {value}>{statusLabel(value)}</option>
          {/each}
        </select>
      </label>
    {/if}
  </div>
  <p class="jm-scope">
    <Icon icon={mdiAccountMultipleOutline} size="15px" aria-hidden={true} />
    {$t('frameleaf_jobs_account_scope', { values: { name: ownerName } })}
  </p>
  {#if truncated}
    <p class="jm-scope">{$t('frameleaf_jobs_account_truncated')}</p>
  {/if}
  {#if !countsLoading && owner !== 'all' && failedStats.size > 0}
    <div class="jm-message jm-error" role="alert">
      <Icon icon={mdiAlertCircleOutline} size="16px" aria-hidden={true} />
      {$t('frameleaf_jobs_account_counts_failed', { values: { name: ownerName } })}
      <Button onclick={() => jobsReload++}>{$t('retry')}</Button>
    </div>
  {/if}

  {#if !selected}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (a scrollable region must be reachable by keyboard to scroll it) -->
    <div class="jm-table-wrap" tabindex="0" role="region" aria-label={$t('frameleaf_jobs_queues_label')}>
      <table class="jm-queues">
        <thead>
          <tr>
            <th scope="col">{$t('frameleaf_jobs_queue_column')}</th>
            <th scope="col">{$t('frameleaf_jobs_status')}</th>
            <th scope="col">{$t('frameleaf_jobs_active_column')}</th>
            <th scope="col">{$t('frameleaf_jobs_waiting_column')}</th>
            <th scope="col">{$t('frameleaf_jobs_failed_column')}</th>
            <th scope="col">{$t('frameleaf_jobs_workers_column')}</th>
            <th scope="col"><span class="jm-sr">{$t('frameleaf_jobs_actions')}</span></th>
          </tr>
        </thead>
        <tbody>
          {#each visibleRows as row (row.definition.name)}
            {@const { definition, queue } = row}
            {@const rowCounts = jobCounts(statsOf(queue) ?? NO_STATS)}
            {@const name = title(definition)}
            <tr>
              <th scope="row">
                <button type="button" class="jm-queue-name" onclick={() => void open(definition.name)}>
                  <span class="jm-queue-icon"><Icon icon={definition.icon} size="17px" aria-hidden={true} /></span>
                  <span>
                    {name}
                    <small>
                      {$t(`frameleaf_jobs_category_${definition.category}` as Translations)}{isFeatureOff(
                        definition,
                        flags,
                      )
                        ? ` · ${$t('frameleaf_jobs_feature_off_short')}`
                        : ''}
                    </small>
                  </span>
                </button>
              </th>
              <td>{@render queueStatus(jobQueueStatus(queue))}</td>
              <td>{count(rowCounts.active, definition.name)}</td>
              <td>{count(rowCounts.pending, definition.name)}</td>
              <td>
                <button
                  type="button"
                  class={rowCounts.failed ? 'jm-error-count' : 'jm-count'}
                  disabled={!rowCounts.failed}
                  onclick={() => void open(definition.name, 'failed')}
                >
                  {count(rowCounts.failed, definition.name)}
                </button>
              </td>
              <td>
                <button
                  type="button"
                  class="jm-workers"
                  aria-label={$t('frameleaf_jobs_queue_workers', {
                    values: { name, count: workersOf(definition.name) },
                  })}
                  onclick={() => (concurrencyOpen = true)}
                >
                  <strong>{workersOf(definition.name)}</strong>
                  {#if isFixed(definition.name)}
                    <span>{$t('frameleaf_jobs_fixed')}</span>
                  {:else if isPendingConcurrency(definition.name)}
                    <span class="jm-pending">{$t('frameleaf_jobs_pending')}</span>
                  {/if}
                </button>
              </td>
              <td class="jm-row-actions">
                <button
                  type="button"
                  class="jm-icon-button"
                  disabled={!definition.canPause}
                  title={definition.canPause
                    ? queue.isPaused
                      ? $t('frameleaf_jobs_resume_queue')
                      : $t('frameleaf_jobs_pause_queue')
                    : $t('frameleaf_jobs_pause_unavailable')}
                  aria-label={queue.isPaused
                    ? $t('frameleaf_jobs_resume_named', { values: { name } })
                    : $t('frameleaf_jobs_pause_named', { values: { name } })}
                  onclick={() => request(queue.isPaused ? 'resume' : 'pause', row)}
                >
                  <Icon icon={queue.isPaused ? mdiPlay : mdiPause} size="1rem" aria-hidden={true} />
                </button>
                <button
                  type="button"
                  class="jm-icon-button"
                  aria-label={$t('frameleaf_jobs_open_queue', { values: { name } })}
                  onclick={() => void open(definition.name)}
                >
                  <Icon icon={mdiChevronRight} size="1rem" aria-hidden={true} />
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if visibleRows.length === 0}
        <div class="jm-empty">
          <Icon icon={mdiMagnify} size="28px" aria-hidden={true} />
          <h3>{$t('frameleaf_jobs_no_queues')}</h3>
          <p>{$t('frameleaf_jobs_no_queues_help')}</p>
          <Button
            onclick={() => {
              query = '';
              category = 'all';
              status = 'all';
            }}>{$t('frameleaf_jobs_clear_filters')}</Button
          >
        </div>
      {/if}
    </div>
    <div class="jm-footer-note">
      <span>{$t('frameleaf_jobs_queue_count', { values: { shown: visibleRows.length, total: rows.length } })}</span>
      <Button onclick={() => void goto(commandCenterUrl('care'))}>
        <Icon icon={mdiShieldCheckOutline} size="1rem" aria-hidden={true} />
        {$t('frameleaf_jobs_open_library_care')}
      </Button>
    </div>
  {:else}
    {@const { definition, queue } = selected}
    {@const queueCounts = jobCounts(statsOf(queue) ?? NO_STATS)}
    {@const blocked = blockedReason(selected)}
    <div class="jm-queue-actions">
      <div>
        {@render queueStatus(jobQueueStatus(queue))}
        <span>
          {$t('frameleaf_jobs_active_across', {
            values: { count: number(queueCounts.active), workers: workersOf(definition.name) },
          })}{isFixed(definition.name) ? ` · ${$t('frameleaf_jobs_fixed')}` : ''}
        </span>
      </div>
      <div>
        <span title={definition.canPause ? undefined : $t('frameleaf_jobs_pause_unavailable')}>
          <Button
            disabled={!definition.canPause}
            onclick={() => request(queue.isPaused ? 'resume' : 'pause', selected)}
          >
            <Icon icon={queue.isPaused ? mdiPlay : mdiPause} size="1rem" aria-hidden={true} />
            {queue.isPaused ? $t('frameleaf_jobs_resume') : $t('frameleaf_jobs_pause')}
          </Button>
        </span>
        {#if definition.run}
          <span title={blocked || undefined}>
            <Button variant="primary" disabled={!!blocked} onclick={() => request('run', selected)}>
              <Icon icon={mdiPlay} size="1rem" aria-hidden={true} />
              {runLabel(definition)}
            </Button>
          </span>
        {/if}
        {#if definition.refresh}
          <span title={blocked || undefined}>
            <Button disabled={!!blocked} onclick={() => request('refresh', selected)}>
              {$t('frameleaf_jobs_refresh_faces')}
            </Button>
          </span>
        {/if}
        {#if definition.force}
          <span title={blocked || undefined}>
            <Button disabled={!!blocked} onclick={() => request('force', selected)}>{forceLabel(definition)}</Button>
          </span>
        {/if}
      </div>
    </div>
    {#if isFeatureOff(definition, flags)}
      <div class="jm-message">
        <Icon icon={mdiCogOutline} size="16px" aria-hidden={true} />
        {$t('frameleaf_jobs_feature_off')}
        <Button onclick={() => void goto(commandCenterUrl('intelligence', definition.feature?.section))}>
          {$t('frameleaf_jobs_feature_settings')}
        </Button>
      </div>
    {/if}
    {#if definition.name === QueueName.StorageTemplateMigration}
      <div class="jm-message">
        <Icon icon={mdiCogOutline} size="16px" aria-hidden={true} />
        <span><QueueStorageMigrationDescription /></span>
      </div>
    {/if}

    <div class="jm-tabs" role="tablist" aria-label={$t('frameleaf_jobs_state_label')}>
      {#each JOB_TABS as item (item)}
        <button
          type="button"
          id="jm-tab-{item}"
          role="tab"
          aria-selected={tab === item}
          aria-controls="jm-jobs-panel"
          tabindex={tab === item ? 0 : -1}
          onkeydown={onTabKey}
          onclick={() => selectTab(item)}
        >
          {$t(`frameleaf_jobs_tab_${item}` as Translations)}
          <span>{count(jobTabCount(item, queueCounts), definition.name)}</span>
        </button>
      {/each}
    </div>
    <div class="jm-tab-actions">
      <p>{$t(`frameleaf_jobs_tab_help_${tab}` as Translations)}</p>
      {#if tab === 'failed'}
        <div>
          <Button disabled={!queueCounts.failed} onclick={() => request('retry-failed', selected)}>
            <Icon icon={mdiRedo} size="1rem" aria-hidden={true} />
            {$t('frameleaf_jobs_retry_failed')}
          </Button>
          <Button disabled={!queueCounts.failed} onclick={() => request('remove-failed', selected)}>
            {$t('frameleaf_jobs_remove_failed')}
          </Button>
        </div>
      {:else if tab === 'waiting'}
        <Button
          disabled={!queue.statistics.waiting && !queue.statistics.paused}
          onclick={() => request('clear-waiting', selected)}
        >
          {$t('frameleaf_jobs_clear_waiting')}
        </Button>
      {/if}
    </div>
    <div
      id="jm-jobs-panel"
      role="tabpanel"
      aria-labelledby="jm-tab-{tab}"
      tabindex="0"
      class="jm-table-wrap"
      aria-busy={!jobsLoaded}
    >
      <table class="jm-jobs">
        <thead>
          <tr>
            <th scope="col">{$t('frameleaf_jobs_column_job')}</th>
            <th scope="col">{$t('frameleaf_jobs_column_account')}</th>
            <th scope="col">{$t('frameleaf_jobs_column_worker')}</th>
            <th scope="col">{$t('frameleaf_jobs_column_status')}</th>
            <th scope="col">{$t('frameleaf_jobs_column_created')}</th>
            <th scope="col"><span class="jm-sr">{$t('frameleaf_jobs_column_details')}</span></th>
          </tr>
        </thead>
        <tbody>
          {#each shownJobs as job (job.key)}
            <tr>
              <th scope="row">
                <button
                  type="button"
                  class="jm-job-name"
                  onclick={() => {
                    detail = job;
                    detailOpen = true;
                  }}
                >
                  {jobTitle(job.name)}
                  {#if subject(job)}
                    <small>{subject(job)}</small>
                  {/if}
                  {#if job.status === 'failed' && job.failedReason}
                    <span class="jm-job-error">{job.failedReason}</span>
                  {/if}
                </button>
              </th>
              <td>{accountName(job)}</td>
              <td>{@render worker(job)}</td>
              <td>{@render queueStatus(job.status)}</td>
              <td><time datetime={new Date(job.timestamp).toISOString()}>{timestamp(job.timestamp)}</time></td>
              <td class="jm-row-actions">
                <button
                  type="button"
                  class="jm-icon-button"
                  aria-label={$t('frameleaf_jobs_details_for', { values: { name: jobTitle(job.name) } })}
                  onclick={() => {
                    detail = job;
                    detailOpen = true;
                  }}
                >
                  <Icon icon={mdiChevronRight} size="1rem" aria-hidden={true} />
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if jobsFailed}
        <p class="jm-empty" role="alert">{$t('frameleaf_jobs_jobs_load_failed')}</p>
      {:else if jobsLoaded && matchingJobs.length === 0}
        <div class="jm-empty">
          <Icon icon={tab === 'failed' ? mdiCheckCircleOutline : mdiClockOutline} size="28px" aria-hidden={true} />
          <h3>
            {tab === 'failed'
              ? $t('frameleaf_jobs_empty_failed')
              : $t('frameleaf_jobs_empty_state', {
                  values: { state: $t(`frameleaf_jobs_empty_state_${tab}` as Translations) },
                })}
          </h3>
          <p>
            {owner === 'all'
              ? $t('frameleaf_jobs_empty_help')
              : $t('frameleaf_jobs_empty_help_account', { values: { name: ownerName } })}
          </p>
        </div>
      {/if}
    </div>
    {#if matchingJobs.length > shownJobs.length}
      <div class="jm-load-more">
        <Button onclick={() => (shown += PAGE_SIZE)}>
          {$t('frameleaf_jobs_show_more', { values: { count: matchingJobs.length - shownJobs.length } })}
        </Button>
      </div>
    {/if}

    <details class="jm-history" bind:open={trendOpen}>
      <summary>
        <Icon icon={mdiClockOutline} size="16px" aria-hidden={true} />
        {$t('frameleaf_jobs_trend')}
      </summary>
      <p>{$t('frameleaf_jobs_trend_help')}</p>
      {#if trendOpen}
        <QueueGraph {queue} class="h-[300px]" />
      {/if}
    </details>
  {/if}

  <details class="jm-history">
    <summary>
      <Icon icon={mdiHistory} size="16px" aria-hidden={true} />
      {$t('frameleaf_jobs_history')} <span>{shownHistory.length}</span>
    </summary>
    <p>{$t('frameleaf_jobs_history_help')}</p>
    {#if shownHistory.length === 0}
      <p class="jm-muted">{$t('frameleaf_jobs_history_empty')}</p>
    {:else}
      <ol>
        {#each shownHistory.slice(0, JOB_HISTORY_SHOWN) as entry (entry.id)}
          <li>
            <div>
              <strong>{entry.title}</strong>
              <span>{historyDetail(entry)}</span>
            </div>
            <time datetime={entry.at}>{timestamp(Date.parse(entry.at))}</time>
          </li>
        {/each}
      </ol>
    {/if}
  </details>
</section>

{#snippet worker(job: QueueJobResponseDto)}
  <span class="jm-destination" title={job.worker.name ?? undefined}>
    <Icon
      icon={job.worker.kind === QueueJobWorkerKind.Runpod ? mdiCloudOutline : mdiDesktopTowerMonitor}
      size="15px"
      aria-hidden={true}
    />
    {workerLabel(job)}
  </span>
{/snippet}

{#snippet queueStatus(value: JobQueueStatus | QueueJobStatus)}
  <span class="jm-status" data-status={value}><i></i>{statusLabel(value)}</span>
{/snippet}

<Dialog title={review?.title ?? ''} closeLabel={$t('close')} bind:open={reviewOpen}>
  {#if review}
    <div class="jm-review">
      <p>{review.detail}</p>
      <dl>
        <div>
          <dt>{$t('frameleaf_jobs_review_scope')}</dt>
          <dd>{$t('frameleaf_jobs_review_all_accounts')}</dd>
        </div>
        <div>
          <dt>{$t('frameleaf_jobs_review_affected')}</dt>
          <dd>{$t('frameleaf_jobs_review_affected_count', { values: { count: review.affected } })}</dd>
        </div>
      </dl>
      {#if review.note}
        <p class="jm-muted">{review.note}</p>
      {/if}
      {#if review.error}
        <p class="jm-review-error" role="alert">{review.error}</p>
      {/if}
      <p class="jm-muted">{$t('frameleaf_jobs_review_filter_note')}</p>
      {#if review.dangerous}
        <label class="jm-confirm">
          <input type="checkbox" bind:checked={acknowledged} />
          {$t('frameleaf_jobs_review_acknowledge')}
        </label>
      {/if}
      <footer>
        <Button variant="quiet" onclick={() => (reviewOpen = false)}>{$t('frameleaf_jobs_review_keep')}</Button>
        <Button
          variant="primary"
          disabled={working || !!review.error || (review.dangerous && !acknowledged)}
          onclick={() => void confirm()}
        >
          {review.title}
        </Button>
      </footer>
    </div>
  {/if}
</Dialog>

<Dialog title={detail ? jobTitle(detail.name) : ''} closeLabel={$t('close')} bind:open={detailOpen}>
  {#if detail}
    <div class="jm-job-detail">
      {@render queueStatus(detail.status)}
      <dl>
        <div>
          <dt>{$t('frameleaf_jobs_detail_job')}</dt>
          <dd>{jobTitle(detail.name)}</dd>
        </div>
        <div>
          <dt>{$t('frameleaf_jobs_detail_account')}</dt>
          <dd>{accountName(detail)}</dd>
        </div>
        <div>
          <dt>{$t('frameleaf_jobs_detail_worker')}</dt>
          <dd>{workerLabel(detail)}{detail.worker.name ? ` · ${detail.worker.name}` : ''}</dd>
        </div>
        {#if detail.attemptsMade !== undefined}
          <div>
            <dt>{$t('frameleaf_jobs_detail_attempt')}</dt>
            <dd>{number(detail.attemptsMade)}</dd>
          </div>
        {/if}
        <div>
          <dt>{$t('frameleaf_jobs_detail_created')}</dt>
          <dd>{timestamp(detail.timestamp)}</dd>
        </div>
      </dl>
      {#if detail.status === 'failed'}
        <div class="jm-failure">
          <h3>{$t('frameleaf_jobs_detail_error')}</h3>
          <p>{detail.failedReason || $t('frameleaf_jobs_detail_error_none')}</p>
          <Button onclick={() => void goto(Route.systemWorkers())}>{$t('frameleaf_jobs_check_workers')}</Button>
        </div>
      {/if}
      <details>
        <summary>{$t('frameleaf_jobs_detail_technical')}</summary>
        <dl>
          <div>
            <dt>{$t('frameleaf_jobs_detail_id')}</dt>
            <dd><code>{detail.id ?? '—'}</code></dd>
          </div>
          <div>
            <dt>{$t('frameleaf_jobs_detail_handler')}</dt>
            <dd><code>{detail.name}</code></dd>
          </div>
        </dl>
        <pre>{JSON.stringify(detail.data ?? {}, null, 2)}</pre>
      </details>
      <footer>
        <Button variant="primary" onclick={() => (detailOpen = false)}>{$t('frameleaf_jobs_detail_done')}</Button>
      </footer>
    </div>
  {/if}
</Dialog>

{#if draft}
  <JobsConcurrencyDialog bind:open={concurrencyOpen} store={draft} disabled={flags.configFile} {title} />
{/if}
<JobsCreateDialog
  bind:open={createOpen}
  queueTitle={(name) => {
    const definition = jobQueue(name);
    return definition ? title(definition) : name;
  }}
  onSelect={selectManual}
/>
<JobsEnrichmentDialog
  bind:open={enrichmentOpen}
  store={draft}
  onReview={requestEnrichment}
  onReviewSettings={() => void goto(Route.systemSettings({ isOpen: OpenQueryParam.IMAGE_DESCRIPTION }))}
/>

<style>
  /* The template's `jobs-manager.css`, on the Frameleaf tokens. */
  .jobs-manager {
    --jm-green: var(--fl-accent);
    --jm-red: var(--fl-danger, #bc7765);
    --jm-amber: var(--fl-warning, #b89c65);
    color: var(--fl-text);
    min-width: 0;
    padding: 4px 0 20px;
    font-size: 13px;
    line-height: 1.5;
  }
  .jobs-manager button,
  .jobs-manager input,
  .jobs-manager select {
    font: inherit;
  }
  .jm-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .jm-header {
    display: flex;
    gap: 20px;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 22px;
  }
  .jm-header h1 {
    font-size: 24px;
    font-weight: 600;
    letter-spacing: -0.6px;
    margin: 2px 0 6px;
  }
  .jm-header p {
    margin: 0;
    color: var(--fl-muted);
    max-width: 610px;
  }
  .jm-header-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    justify-content: flex-end;
    padding-top: 8px;
  }
  .jm-metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    overflow: hidden;
    margin-bottom: 22px;
    background: var(--fl-panel);
  }
  .jm-metric {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 18px 20px;
    color: var(--fl-muted);
  }
  .jm-metric + .jm-metric {
    border-left: 1px solid var(--fl-border);
  }
  .jm-metric.warning,
  .jm-metric.warning strong {
    color: var(--jm-red);
  }
  .jm-metric span {
    display: block;
    color: var(--fl-muted);
    font-size: 11px;
  }
  .jm-metric strong {
    display: block;
    color: var(--fl-text);
    font-size: 25px;
    font-weight: 600;
    line-height: 1.4;
    font-variant-numeric: tabular-nums;
  }
  .jm-filterbar {
    display: flex;
    gap: 10px;
    align-items: end;
    margin: 14px 0 10px;
    flex-wrap: wrap;
  }
  .jm-filterbar > label:not(.jm-search) {
    display: flex;
    gap: 6px;
    flex-direction: column;
  }
  .jm-filterbar > label > span {
    font-size: 11px;
    color: var(--fl-muted);
    font-weight: 600;
  }
  .jobs-manager select,
  .jobs-manager input:not([type='checkbox']) {
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    min-height: 35px;
    padding: 6px 9px;
    outline-offset: 3px;
  }
  .jm-search {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    padding: 0 11px;
    min-width: 200px;
    flex: 1;
    color: var(--fl-muted);
  }
  .jobs-manager .jm-search input {
    border: 0;
    background: transparent;
    min-width: 0;
    width: 100%;
    padding: 8px 0;
    outline-offset: 0;
  }
  .jm-search:focus-within {
    outline: 2px solid var(--jm-green);
    outline-offset: 2px;
  }
  .jm-search input:focus-visible {
    outline: 0;
  }
  .jm-scope {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 11px;
    color: var(--fl-muted);
    margin: 10px 0 17px;
  }
  .jm-table-wrap {
    overflow-x: auto;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .jobs-manager table {
    border-collapse: collapse;
    width: 100%;
    text-align: left;
    min-width: 640px;
  }
  .jobs-manager th,
  .jobs-manager td {
    padding: 12px 15px;
    border-bottom: 1px solid var(--fl-border);
    vertical-align: middle;
  }
  .jobs-manager th {
    font-weight: 500;
  }
  .jobs-manager thead th {
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.4px;
    color: var(--fl-muted);
    background: var(--fl-panel);
    white-space: nowrap;
  }
  .jobs-manager tbody tr:last-child > * {
    border-bottom: 0;
  }
  .jobs-manager tbody tr:hover {
    background: color-mix(in srgb, var(--fl-muted) 5%, transparent);
  }
  .jm-queues td {
    font-variant-numeric: tabular-nums;
  }
  .jm-row-actions {
    white-space: nowrap;
    text-align: right;
  }
  .jm-icon-button,
  .jm-queue-name,
  .jm-job-name,
  .jm-workers,
  .jm-count,
  .jm-error-count {
    appearance: none;
    color: inherit;
    background: none;
    border: 0;
    text-align: left;
    padding: 0;
    cursor: pointer;
  }
  .jm-icon-button {
    display: inline-grid;
    place-items: center;
    padding: 6px;
    border-radius: var(--fl-radius-control);
  }
  .jm-icon-button:hover:not(:disabled) {
    background: var(--fl-raised);
  }
  .jm-icon-button:disabled {
    color: var(--fl-muted);
    cursor: not-allowed;
  }
  .jm-queue-name {
    display: flex;
    align-items: center;
    gap: 11px;
    min-width: 205px;
    font-weight: 550;
  }
  .jm-queue-name small,
  .jm-job-name small {
    display: block;
    font-size: 11px;
    color: var(--fl-muted);
    font-weight: 400;
    margin-top: 2px;
  }
  .jm-queue-icon {
    height: 33px;
    width: 33px;
    display: grid;
    place-items: center;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    color: var(--fl-muted);
  }
  .jm-error-count {
    color: var(--jm-red);
    background: color-mix(in srgb, var(--jm-red) 13%, transparent);
    border-radius: var(--fl-radius-pill);
    padding: 2px 7px;
    font-weight: 650;
  }
  .jm-count:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .jm-workers {
    display: flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
  .jm-workers span {
    font-size: 11px;
    color: var(--fl-muted);
  }
  .jm-workers .jm-pending {
    color: var(--jm-amber);
  }
  .jm-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    font-size: 11px;
    color: var(--fl-muted);
  }
  .jm-status i {
    display: block;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
  }
  .jm-status:is([data-status='active'], [data-status='completed']) {
    color: var(--jm-green);
  }
  .jm-status[data-status='failed'] {
    color: var(--jm-red);
  }
  .jm-status:is([data-status='paused'], [data-status='delayed']) {
    color: var(--jm-amber);
  }
  .jm-footer-note {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 10px;
    gap: 10px;
    color: var(--fl-muted);
    font-size: 11px;
  }
  .jm-queue-actions {
    display: flex;
    justify-content: space-between;
    gap: 15px;
    padding: 16px 0;
    border-top: 1px solid var(--fl-border);
  }
  .jm-queue-actions > div {
    display: flex;
    align-items: center;
    gap: 9px;
    flex-wrap: wrap;
  }
  .jm-queue-actions > div > span:not(.jm-status, [title]) {
    color: var(--fl-muted);
    font-size: 11px;
  }
  .jm-tabs {
    display: flex;
    gap: 19px;
    border-bottom: 1px solid var(--fl-border);
    margin-top: 4px;
  }
  .jm-tabs button {
    background: none;
    color: var(--fl-muted);
    border: 0;
    border-bottom: 2px solid transparent;
    padding: 10px 1px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .jm-tabs button[aria-selected='true'] {
    border-bottom-color: var(--jm-green);
    color: var(--fl-text);
  }
  .jm-tabs button span {
    font-size: 11px;
    background: var(--fl-panel);
    border-radius: var(--fl-radius-pill);
    padding: 1px 5px;
    font-variant-numeric: tabular-nums;
  }
  .jm-tab-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    justify-content: space-between;
    min-height: 64px;
    padding: 10px 0;
  }
  .jm-tab-actions p {
    font-size: 11px;
    color: var(--fl-muted);
    margin: 0;
  }
  .jm-tab-actions > div {
    display: flex;
    gap: 7px;
  }
  .jm-job-name {
    max-width: 360px;
    overflow-wrap: anywhere;
  }
  .jm-job-name small {
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .jm-jobs td {
    font-size: 12px;
  }
  /* jobs-manager.css `.jm-destination` (the Worker column). */
  .jm-destination {
    display: flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
  .jm-destination :global(svg) {
    color: var(--fl-muted);
  }
  .jm-empty {
    text-align: center;
    padding: 34px;
    color: var(--fl-muted);
  }
  .jm-empty h3 {
    font-size: 14px;
    color: var(--fl-text);
    margin: 5px 0;
  }
  .jm-empty p {
    font-size: 12px;
    margin: 7px auto 13px;
    max-width: 440px;
  }
  .jm-load-more {
    display: flex;
    justify-content: center;
    margin: 14px auto;
  }
  .jm-message {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 11px 13px;
    margin: 10px 0;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    font-size: 12px;
    background: var(--fl-panel);
    color: var(--fl-muted);
  }
  .jm-message > :global(:first-child) {
    flex: none;
    color: var(--jm-green);
  }
  .jm-message > :global(:last-child:is(button)) {
    margin-left: auto;
  }
  .jm-message.jm-error {
    color: var(--jm-red);
    border-color: color-mix(in srgb, var(--jm-red) 40%, transparent);
  }
  .jm-message.jm-error > :global(:first-child) {
    color: inherit;
  }
  .jm-history {
    border-top: 1px solid var(--fl-border);
    margin-top: 24px;
    padding-top: 15px;
  }
  .jm-history summary > span {
    font-size: 11px;
    background: var(--fl-panel);
    padding: 1px 5px;
    border-radius: var(--fl-radius-pill);
  }
  .jm-history ol {
    padding: 0;
    list-style: none;
  }
  .jm-history li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 15px;
    padding: 10px 0;
    border-bottom: 1px solid var(--fl-border);
  }
  .jm-history li strong {
    display: block;
    font-size: 12px;
    font-weight: 500;
  }
  .jm-history li span,
  .jm-history time {
    font-size: 11px;
    color: var(--fl-muted);
  }
  .jm-history time {
    white-space: nowrap;
  }
  .jm-job-error {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    color: var(--jm-red);
    font-size: 11px;
    margin-top: 7px;
    max-width: 350px;
    line-height: 1.5;
  }
  .jm-failure {
    margin: 14px 0;
    padding: 13px;
    border: 1px solid color-mix(in srgb, var(--jm-red) 40%, transparent);
    border-radius: var(--fl-radius-card);
  }
  .jm-failure h3 {
    margin: 0 0 4px;
    font-size: 13px;
    color: var(--jm-red);
  }
  .jm-failure p {
    margin: 0 0 10px;
    overflow-wrap: anywhere;
  }
  .jm-history summary {
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 550;
  }
  .jm-history > p {
    font-size: 11px;
    color: var(--fl-muted);
  }
  .jm-review,
  .jm-job-detail {
    font-size: 13px;
    line-height: 1.6;
    min-width: min(28rem, 100%);
  }
  .jm-review dl,
  .jm-job-detail dl {
    margin: 17px 0;
  }
  .jm-review dl > div,
  .jm-job-detail dl > div {
    display: flex;
    justify-content: space-between;
    gap: 18px;
    padding: 7px 0;
    border-bottom: 1px solid var(--fl-border);
  }
  .jm-review dt,
  .jm-job-detail dt {
    color: var(--fl-muted);
  }
  .jm-review dd,
  .jm-job-detail dd {
    margin: 0;
    text-align: right;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .jm-job-detail pre {
    max-height: 16rem;
    overflow: auto;
    font-size: 12px;
    padding: 10px;
    background: var(--fl-canvas);
    border-radius: var(--fl-radius-control);
  }
  .jm-muted {
    color: var(--fl-muted);
    font-size: 12px;
  }
  .jm-confirm {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 13px;
    background: color-mix(in srgb, var(--jm-red) 8%, transparent);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    font-size: 12px;
  }
  .jm-confirm input {
    margin-top: 5px;
    accent-color: var(--jm-green);
  }
  .jm-review-error {
    color: var(--fl-danger);
  }
  .jm-review footer,
  .jm-job-detail footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 18px;
  }
  @media (max-width: 1150px) {
    .jm-header {
      flex-direction: column;
      gap: 10px;
    }
    .jm-header-actions {
      justify-content: flex-start;
    }
    .jm-metric {
      padding: 15px 12px;
      gap: 9px;
    }
    .jm-metric strong {
      font-size: 23px;
    }
    .jm-queue-actions {
      flex-direction: column;
      gap: 10px;
    }
  }
  @media (max-width: 700px) {
    .jm-metrics {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .jm-metric:nth-child(3) {
      border-left: 0;
      border-top: 1px solid var(--fl-border);
    }
    .jm-metric:nth-child(4) {
      border-top: 1px solid var(--fl-border);
    }
    .jm-filterbar .jm-search {
      flex-basis: 100%;
    }
    .jm-filterbar > label:not(.jm-search) {
      flex: 1;
      min-width: 105px;
    }
    .jm-filterbar select {
      width: 100%;
    }
    .jm-tabs {
      gap: 15px;
      overflow: auto;
    }
    .jm-tab-actions {
      align-items: flex-start;
      flex-direction: column;
    }
    .jm-header h1 {
      font-size: 21px;
    }
  }
</style>
