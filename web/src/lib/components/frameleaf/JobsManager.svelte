<script lang="ts">
  /**
   * The Job manager (FL-71): the design template's `JobsManager.jsx` (`jobs-manager.css`) in
   * Compute & jobs → Queues & jobs, on the server's real queues. It replaces Immich's queue cards
   * and queue page, keeping every command they had:
   *
   * - header: All queues (in a queue), Resume n paused, Concurrency (the central settings draft's
   *   Job settings, with its pending count), Enrichment tasks and the primary Create job;
   * - the four metrics, the search/category/status filters and the queue table with each queue's
   *   status, counts, workers and pause/resume;
   * - one queue (`?queue=<slug>`, `&tab=`): its pause/resume and start commands (run missing,
   *   reprocess all, refresh faces), the Active/Waiting/Failed/History job tabs listed from the
   *   server, Clear waiting jobs, Remove failed records, and the jobs-over-time graph.
   *
   * Queue commands go through the template's review (what it does, scope, affected now); the
   * destructive ones ask for an acknowledgement, which also covers the face reset confirmation.
   * The template's account filter, per-job account/worker/attempt/error columns, "Retry failed" and
   * the device-local action history have no server source and are not shown.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    isFeatureOff,
    isJobTab,
    JOB_QUEUE_CATEGORIES,
    JOB_QUEUE_STATUSES,
    JOB_QUEUES,
    JOB_TAB_STATUSES,
    JOB_TABS,
    jobCounts,
    jobQueueStatus,
    jobTabCount,
    matchesQueueFilters,
    searchTerms,
    startBlocked,
    sumJobCounts,
    type JobQueueDefinition,
    type JobQueueStatus,
    type JobTab,
  } from '$lib/frameleaf/job-queues';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { queueManager } from '$lib/managers/queue-manager.svelte';
  import { fromQueueSlug, Route } from '$lib/route';
  import { getQueueActions, getQueuesActions, handlePauseQueue, handleResumeQueue } from '$lib/services/queue.service';
  import { locale } from '$lib/stores/preferences.store';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import QueueStorageMigrationDescription from '../../../routes/admin/queues/QueueStorageMigrationDescription.svelte';
  import QueueGraph from '../../../routes/admin/queues/[name]/QueueGraph.svelte';
  import {
    emptyQueue,
    getQueueJobs,
    QueueCommand,
    QueueName,
    runQueueCommandLegacy,
    type QueueJobResponseDto,
    type QueueJobStatus,
    type QueueResponseDto,
  } from '@immich/sdk';
  import { CommandPaletteDefaultProvider, Icon } from '@immich/ui';
  import {
    mdiAccountMultipleOutline,
    mdiAlertCircleOutline,
    mdiArrowLeft,
    mdiCheckCircleOutline,
    mdiChevronRight,
    mdiClockOutline,
    mdiClose,
    mdiCogOutline,
    mdiImageSearchOutline,
    mdiMagnify,
    mdiPause,
    mdiPlay,
    mdiPlus,
    mdiShieldCheckOutline,
    mdiTuneVariant,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  onMount(() => queueManager.listen());

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

  const counts = $derived(selected ? jobCounts(selected.queue.statistics) : sumJobCounts(queues));
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

  const { CreateJob, ManageConcurrency, EnrichmentTasks } = $derived(getQueuesActions($t, queues));

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

  // ---- the template's review of a queue command --------------------------------------------------

  type Command = 'pause' | 'resume' | 'clear-waiting' | 'remove-failed' | 'run' | 'force' | 'refresh' | 'resume-all';
  type Review = {
    command: Command;
    name?: QueueName;
    title: string;
    detail: string;
    affected: number;
    dangerous: boolean;
  };
  let review = $state<Review | null>(null);
  let reviewOpen = $state(false);
  let acknowledged = $state(false);
  let working = $state(false);

  const runLabel = (definition: JobQueueDefinition) => $t(`frameleaf_jobs_run_${definition.run}` as Translations);
  const forceLabel = (definition: JobQueueDefinition) => $t(`frameleaf_jobs_force_${definition.force}` as Translations);

  const request = (command: Command, row?: { definition: JobQueueDefinition; queue: QueueResponseDto }) => {
    const queueCounts = row ? jobCounts(row.queue.statistics) : undefined;
    const faces = row?.definition.force === 'reset';
    const reviews: Record<Command, Omit<Review, 'command' | 'name'>> = {
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
        affected: queueCounts?.failed ?? 0,
        dangerous: true,
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
    };
    review = { command, name: row?.definition.name, ...reviews[command] };
    acknowledged = false;
    reviewOpen = true;
  };

  const perform = async ({ command, name }: Review) => {
    if (command === 'resume-all') {
      for (const { queue } of pausedQueues) {
        await runQueueCommandLegacy({
          name: queue.name,
          queueCommandDto: { command: QueueCommand.Resume, force: false },
        });
      }
      return;
    }
    if (!name) {
      return;
    }
    switch (command) {
      case 'pause':
      case 'resume': {
        const queue = byName.get(name);
        if (queue) {
          await (command === 'pause' ? handlePauseQueue(queue) : handleResumeQueue(queue));
        }
        return;
      }
      case 'clear-waiting': {
        await emptyQueue({ name, queueDeleteDto: { failed: false } });
        return;
      }
      case 'remove-failed': {
        await runQueueCommandLegacy({ name, queueCommandDto: { command: QueueCommand.ClearFailed, force: false } });
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
    if (!review || working || (review.dangerous && !acknowledged)) {
      return;
    }
    const current = review;
    working = true;
    error = '';
    try {
      await perform(current);
      notice = $t('frameleaf_jobs_notice_done', { values: { title: current.title } });
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
  const tabCount = $derived(selected ? jobTabCount(tab, jobCounts(selected.queue.statistics)) : 0);
  let lastLoad = 0;
  $effect(() => {
    const name = selected?.definition.name;
    const statuses = JOB_TAB_STATUSES[tab];
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
          getQueueJobs({ name, status: [status] }).then((list) =>
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

  const humanize = (name: string) => {
    const words = name.replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  };
  const subject = (job: QueueJobResponseDto) => {
    const id = job.data?.id;
    return typeof id === 'string' ? id : '';
  };
  const matchingJobs = $derived(
    jobs.filter((job) => {
      const terms = searchTerms(query);
      const haystack =
        `${job.name} ${humanize(job.name)} ${job.id ?? ''} ${JSON.stringify(job.data ?? {})}`.toLowerCase();
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
</script>

<CommandPaletteDefaultProvider name={$t('admin.queues')} actions={[CreateJob, ManageConcurrency, EnrichmentTasks]} />
{#if selected}
  {@const { Pause, Resume, Empty, RemoveFailedJobs } = getQueueActions($t, selected.queue)}
  <CommandPaletteDefaultProvider name={title(selected.definition)} actions={[Pause, Resume, Empty, RemoveFailedJobs]} />
{/if}

<section class="jobs-manager" aria-label={$t('frameleaf_jobs_label')} bind:this={main}>
  <header class="jm-header">
    <div>
      <p class="jm-eyebrow">{$t('frameleaf_jobs_eyebrow')}</p>
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
      <Button onclick={() => void ManageConcurrency.onAction(ManageConcurrency)}>
        <Icon icon={mdiTuneVariant} size="1rem" aria-hidden={true} />
        {pendingConcurrency > 0
          ? $t('frameleaf_jobs_concurrency_pending', { values: { count: pendingConcurrency } })
          : $t('frameleaf_jobs_concurrency')}
      </Button>
      <Button onclick={() => void EnrichmentTasks.onAction(EnrichmentTasks)}>
        <Icon icon={mdiImageSearchOutline} size="1rem" aria-hidden={true} />
        {$t('frameleaf_jobs_enrichment_tasks')}
      </Button>
      <Button variant="primary" onclick={() => void CreateJob.onAction(CreateJob)}>
        <Icon icon={mdiPlus} size="1rem" aria-hidden={true} />
        {$t('frameleaf_jobs_create_job')}
      </Button>
    </div>
  </header>

  <div class="jm-metrics">
    {#each metrics as metric (metric.label)}
      <div class="jm-metric" class:warning={metric.warning}>
        <Icon icon={metric.icon} size="22px" aria-hidden={true} />
        <div>
          <span>{metric.label}</span>
          <strong>{number(metric.value)}</strong>
        </div>
      </div>
    {/each}
  </div>

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
    {$t('frameleaf_jobs_account_scope')}
  </p>

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
            {@const rowCounts = jobCounts(queue.statistics)}
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
              <td>{number(rowCounts.active)}</td>
              <td>{number(rowCounts.pending)}</td>
              <td>
                <button
                  type="button"
                  class={rowCounts.failed ? 'jm-error-count' : 'jm-count'}
                  disabled={!rowCounts.failed}
                  onclick={() => void open(definition.name, 'failed')}
                >
                  {number(rowCounts.failed)}
                </button>
              </td>
              <td>
                <button
                  type="button"
                  class="jm-workers"
                  aria-label={$t('frameleaf_jobs_queue_workers', {
                    values: { name, count: workersOf(definition.name) },
                  })}
                  onclick={() => void ManageConcurrency.onAction(ManageConcurrency)}
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
    {@const queueCounts = jobCounts(queue.statistics)}
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
          <span>{number(jobTabCount(item, queueCounts))}</span>
        </button>
      {/each}
    </div>
    <div class="jm-tab-actions">
      <p>{$t(`frameleaf_jobs_tab_help_${tab}` as Translations)}</p>
      {#if tab === 'failed'}
        <div>
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
                  {humanize(job.name)}
                  {#if subject(job)}
                    <small>{subject(job)}</small>
                  {/if}
                </button>
              </th>
              <td>{@render queueStatus(job.status)}</td>
              <td><time datetime={new Date(job.timestamp).toISOString()}>{timestamp(job.timestamp)}</time></td>
              <td class="jm-row-actions">
                <button
                  type="button"
                  class="jm-icon-button"
                  aria-label={$t('frameleaf_jobs_details_for', { values: { name: humanize(job.name) } })}
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
          <p>{$t('frameleaf_jobs_empty_help')}</p>
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
</section>

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
          disabled={working || (review.dangerous && !acknowledged)}
          onclick={() => void confirm()}
        >
          {review.title}
        </Button>
      </footer>
    </div>
  {/if}
</Dialog>

<Dialog title={detail ? humanize(detail.name) : ''} closeLabel={$t('close')} bind:open={detailOpen}>
  {#if detail}
    <div class="jm-job-detail">
      {@render queueStatus(detail.status)}
      <dl>
        <div>
          <dt>{$t('frameleaf_jobs_detail_job')}</dt>
          <dd>{humanize(detail.name)}</dd>
        </div>
        <div>
          <dt>{$t('frameleaf_jobs_detail_created')}</dt>
          <dd>{timestamp(detail.timestamp)}</dd>
        </div>
      </dl>
      {#if detail.status === 'failed'}
        <Button onclick={() => void goto(Route.systemWorkers())}>{$t('frameleaf_jobs_check_workers')}</Button>
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
  .jm-header .jm-eyebrow {
    font-size: 10px;
    letter-spacing: 1.6px;
    color: var(--jm-green);
    font-weight: 700;
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
    border-radius: 9px;
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
    border-radius: 5px;
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
    border-radius: 5px;
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
    border-radius: 7px;
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
    border-radius: 7px;
    color: var(--fl-muted);
  }
  .jm-error-count {
    color: var(--jm-red);
    background: color-mix(in srgb, var(--jm-red) 13%, transparent);
    border-radius: 4px;
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
    border-radius: 4px;
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
    border-radius: 6px;
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
    min-width: min(28rem, 80vw);
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
    border-radius: 6px;
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
    border-radius: 6px;
    font-size: 12px;
  }
  .jm-confirm input {
    margin-top: 5px;
    accent-color: var(--jm-green);
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
