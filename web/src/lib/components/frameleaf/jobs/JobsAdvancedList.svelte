<script lang="ts">
  /**
   * Background work › Advanced, the list (approved design, 2026-11-12; prototype `JobsAdvancedV2.jsx`, FL-1486).
   * Three questions in order: what needs me (failures by what went wrong, across tasks, one thing to do each), what
   * the server is doing and why the rest is not running, and, folded away, every task with nothing to do. The Job
   * manager owns the queues, the review of every command and the dialogs; this reads the overview and draws the page.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import type { JobQueueDefinition, JobTab } from '$lib/frameleaf/job-queues';
  import { jobCounts } from '$lib/frameleaf/job-queues';
  import {
    actOnQueueProblem,
    getQueueOverview,
    QueueIdleReason,
    QueueProblemAction,
    QueueProblemCause,
    QueueProblemUnit,
    type QueueName,
    type QueueOverviewResponseDto,
    type QueueProblemDto,
    type QueueResponseDto,
    type QueueTaskDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiArrowRight,
    mdiCheckCircleOutline,
    mdiChevronDown,
    mdiChevronRight,
    mdiFileQuestionOutline,
    mdiFolderLockOutline,
    mdiHarddiskRemove,
    mdiImageBrokenVariant,
    mdiImageSearchOutline,
    mdiMagnify,
    mdiPause,
    mdiPlay,
    mdiPlus,
    mdiServerNetworkOff,
    mdiTimerSandComplete,
    mdiTuneVariant,
  } from '@mdi/js';
  import { untrack } from 'svelte';
  import { locale, t, type Translations } from 'svelte-i18n';

  type Row = { definition: JobQueueDefinition; queue: QueueResponseDto };

  let {
    rows,
    unknown,
    refreshToken,
    initialQuery = '',
    pendingConcurrency = 0,
    canChangeWorkers = true,
    title,
    featureName,
    workersOf,
    careHref,
    activityHref,
    onOpen,
    onCommand,
    onPauseAll,
    onResumeAll,
    onConcurrency,
    onEnrichment,
    onCreate,
    onChanged,
  }: {
    /** Every task the server reports, with the counts the page is filtered to. */
    rows: Row[];
    /** Tasks whose counts for the chosen account are not known (still loading, or unreadable): a dash, never 0. */
    unknown?: ReadonlySet<QueueName> | 'all';
    /** Changes when the failures or the reasons may have: the overview is read again. */
    refreshToken: unknown;
    /** A feature's name, when the page was opened for one feature's tasks. */
    initialQuery?: string;
    pendingConcurrency?: number;
    canChangeWorkers?: boolean;
    title: (definition: JobQueueDefinition) => string;
    featureName: (name: QueueName) => string;
    workersOf: (name: QueueName) => number;
    careHref: string;
    activityHref: string;
    onOpen: (name: QueueName, tab?: JobTab) => void;
    /** Pause or resume one task, through the Job manager's review. */
    onCommand: (command: 'pause' | 'resume', row: Row) => void;
    onPauseAll: () => void;
    onResumeAll: () => void;
    onConcurrency: () => void;
    onEnrichment: () => void;
    onCreate: () => void;
    /** After Try again or Stop trying: the queues' counts changed. */
    onChanged: () => void;
  } = $props();

  let overview = $state<QueueOverviewResponseDto>();
  let failedToLoad = $state(false);
  let generation = 0;
  const load = async () => {
    const mine = ++generation;
    try {
      const next = await getQueueOverview();
      if (mine === generation) {
        overview = next;
        failedToLoad = false;
      }
    } catch {
      if (mine === generation) {
        failedToLoad = true;
      }
    }
  };
  $effect(() => {
    void refreshToken;
    untrack(() => void load());
  });

  // ---- Needs a look --------------------------------------------------------------------------------

  type Fix = 'retry' | 'stop' | 'care' | 'jobs';
  const PROBLEMS: Record<QueueProblemCause, { icon: string; fix: Fix; key: string }> = {
    [QueueProblemCause.Drive]: { icon: mdiHarddiskRemove, fix: 'retry', key: 'drive' },
    [QueueProblemCause.Missing]: { icon: mdiImageSearchOutline, fix: 'care', key: 'missing' },
    [QueueProblemCause.Damaged]: { icon: mdiImageBrokenVariant, fix: 'care', key: 'damaged' },
    [QueueProblemCause.Unsupported]: { icon: mdiFileQuestionOutline, fix: 'stop', key: 'unsupported' },
    [QueueProblemCause.WriteDenied]: { icon: mdiFolderLockOutline, fix: 'retry', key: 'write' },
    [QueueProblemCause.MlUnavailable]: { icon: mdiServerNetworkOff, fix: 'retry', key: 'ml' },
    [QueueProblemCause.TooLong]: { icon: mdiTimerSandComplete, fix: 'retry', key: 'slow' },
    [QueueProblemCause.Other]: { icon: mdiAlertCircleOutline, fix: 'jobs', key: 'other' },
  };
  const FIX_LABELS: Record<Fix, Translations> = {
    retry: 'frameleaf_bgwork_try_again',
    stop: 'frameleaf_jobs_adv_stop_trying',
    care: 'frameleaf_jobs_open_library_care',
    jobs: 'frameleaf_jobs_adv_see_jobs',
  };
  /** How many reasons show before the fold: the biggest, so the tasks stay within reach. */
  const SHOWN = 3;

  const byName = $derived(new Map(rows.map((row) => [row.definition.name, row])));
  const titleOf = (name: QueueName) => {
    const row = byName.get(name);
    return row ? title(row.definition) : name;
  };
  /** A problem acted on here stays in its place, saying what was done, until the next read no longer has it. */
  let settled = $state(new Map<QueueProblemCause, string>());
  let acting = $state<QueueProblemCause>();
  let actionFailed = $state<QueueProblemCause>();
  let said = $state(new Set<QueueProblemCause>());
  const toggleSaid = (cause: QueueProblemCause) => {
    const next = new Set(said);
    if (!next.delete(cause)) {
      next.add(cause);
    }
    said = next;
  };
  let allProblems = $state(false);
  let allSettled = $state<QueueProblemDto[]>([]);
  // what was acted on keeps its row (the server no longer lists it) until the page is left
  const problems = $derived.by(() => {
    const listed = overview?.problems ?? [];
    const gone = allSettled.filter(
      ({ cause }) => settled.has(cause) && listed.every((problem) => problem.cause !== cause),
    );
    // a copy, sorted in place: toSorted is not in Chrome 109
    return [...listed, ...gone].sort((a, b) => b.count - a.count);
  });
  const open = $derived(problems.filter(({ cause }) => !settled.has(cause)));
  const failed = $derived(open.reduce((sum, { count }) => sum + count, 0));
  const more = $derived(problems.slice(SHOWN));

  const unit = ({ cause, unit, count }: QueueProblemDto) => {
    const kind =
      unit === QueueProblemUnit.Photos && cause === QueueProblemCause.Unsupported ? 'files' : (unit as string);
    return $t(`frameleaf_jobs_adv_unit_${kind}` as Translations, { values: { count } });
  };
  const act = async (problem: QueueProblemDto) => {
    const { fix } = PROBLEMS[problem.cause];
    if (fix === 'jobs') {
      const [first] = problem.queues;
      if (first) {
        onOpen(first, 'failed');
      }
      return;
    }
    if (fix === 'care') {
      return;
    }
    acting = problem.cause;
    actionFailed = undefined;
    try {
      await actOnQueueProblem({
        queueProblemActionDto: {
          cause: problem.cause,
          action: fix === 'retry' ? QueueProblemAction.Retry : QueueProblemAction.Stop,
        },
      });
      const paused = problem.queues.map((name) => byName.get(name)).find((row) => row?.queue.isPaused);
      allSettled = [...allSettled.filter(({ cause }) => cause !== problem.cause), problem];
      settled = new Map(settled).set(
        problem.cause,
        fix === 'stop'
          ? $t('frameleaf_jobs_adv_done_stop')
          : paused
            ? $t('frameleaf_jobs_adv_done_retry_paused', { values: { name: title(paused.definition) } })
            : $t('frameleaf_jobs_adv_done_retry'),
      );
      onChanged();
    } catch {
      actionFailed = problem.cause;
    } finally {
      acting = undefined;
    }
  };

  // ---- Tasks ---------------------------------------------------------------------------------------

  // typed over the catalogue's name, so a feature's own page opens with its tasks found
  let query = $state(untrack(() => initialQuery));
  let idleOpen = $state(false);
  const taskOf = $derived(new Map((overview?.tasks ?? []).map((task) => [task.name, task])));
  /** Why a task is not running. Until the overview answers, a pause is all the queue itself can say. */
  const whyOf = ({ definition, queue }: Row): QueueTaskDto => {
    const known = taskOf.get(definition.name);
    const name = definition.name;
    if (!known) {
      return { name, reason: queue.isPaused ? QueueIdleReason.Paused : null };
    }
    // the queue list is read more often than the overview: a pause or resume made a moment ago shows at once
    if (known.reason === QueueIdleReason.Paused && !queue.isPaused) {
      return { name, reason: null };
    }
    if (queue.isPaused && known.reason !== QueueIdleReason.Paused && known.reason !== QueueIdleReason.FeatureOff) {
      return { name, reason: QueueIdleReason.Paused };
    }
    return known;
  };
  const day = (value: string) =>
    new Date(value).toLocaleDateString($locale ?? undefined, { month: 'short', day: 'numeric' });
  const DAY = 86_400_000;
  const whyLine = (why: QueueTaskDto) => {
    switch (why.reason) {
      case QueueIdleReason.Paused: {
        return why.pausedAt
          ? $t('frameleaf_jobs_adv_why_you', { values: { date: day(why.pausedAt) } })
          : $t('frameleaf_jobs_adv_why_paused');
      }
      case QueueIdleReason.QuietHours: {
        const until = why.closedUntil ? new Date(why.closedUntil) : undefined;
        if (!until) {
          return $t('frameleaf_jobs_adv_why_night');
        }
        return until.getTime() - Date.now() < DAY
          ? $t('frameleaf_jobs_adv_why_night_at', {
              values: { time: until.toLocaleTimeString($locale ?? undefined, { hour: 'numeric', minute: '2-digit' }) },
            })
          : $t('frameleaf_jobs_adv_why_night_on', { values: { date: day(why.closedUntil!) } });
      }
      case QueueIdleReason.WaitingFor: {
        return $t('frameleaf_jobs_adv_why_after', { values: { name: why.waitingFor ? titleOf(why.waitingFor) : '' } });
      }
      case QueueIdleReason.FeatureOff: {
        return $t('frameleaf_jobs_adv_why_off');
      }
      default: {
        return '';
      }
    }
  };
  const isUnknown = (name: QueueName) => unknown === 'all' || !!unknown?.has(name);
  const anyUnknown = $derived(rows.some(({ definition }) => isUnknown(definition.name)));
  const tasks = $derived(
    rows.map((row) => {
      const counts = jobCounts(row.queue.statistics);
      const why = whyOf(row);
      const dash = isUnknown(row.definition.name);
      const state = dash
        ? 'idle'
        : counts.active
          ? 'running'
          : why.reason
            ? 'held'
            : counts.pending
              ? 'waiting'
              : counts.failed
                ? 'stopped'
                : 'idle';
      const line = dash
        ? '—'
        : counts.active
          ? $t('frameleaf_jobs_adv_running', { values: { count: counts.active } })
          : why.reason
            ? whyLine(why)
            : counts.pending
              ? $t('frameleaf_jobs_adv_next')
              : counts.failed
                ? $t('frameleaf_jobs_adv_only_failures')
                : $t('frameleaf_jobs_adv_nothing');
      // one button: undo what holds it when a person can, else pause it
      const button =
        why.reason === QueueIdleReason.FeatureOff || why.reason === QueueIdleReason.WaitingFor
          ? undefined
          : row.queue.isPaused
            ? ('resume' as const)
            : why.reason === QueueIdleReason.QuietHours
              ? ('start' as const)
              : row.definition.canPause
                ? ('pause' as const)
                : undefined;
      return {
        row,
        name: title(row.definition),
        feature: featureName(row.definition.name),
        counts,
        dash,
        state,
        line,
        button,
      };
    }),
  );
  const matches = (task: { name: string; feature: string }) =>
    `${task.name} ${task.feature}`
      .toLocaleLowerCase($locale ?? undefined)
      .includes(query.trim().toLocaleLowerCase($locale ?? undefined));
  // a task whose counts are not known is never filed under "nothing to do"
  const hasWork = ({ counts, dash }: (typeof tasks)[number]) =>
    dash || counts.active + counts.pending + counts.failed > 0;
  const busy = $derived(tasks.filter((task) => hasWork(task) && matches(task)));
  const idle = $derived(tasks.filter((task) => !hasWork(task) && matches(task)));
  const yours = $derived(rows.filter(({ queue, definition }) => queue.isPaused && definition.canPause));
  const pausable = $derived(rows.filter(({ queue, definition }) => !queue.isPaused && definition.canPause));
  const sum = (key: 'active' | 'pending') => tasks.reduce((total, { counts }) => total + counts[key], 0);
</script>

{#snippet taskRow(task: (typeof tasks)[number])}
  {@const { row, name, counts, button } = task}
  <li class="ja-task">
    <button type="button" class="ja-task-main" onclick={() => onOpen(row.definition.name)}>
      <span class="ja-task-icon"><Icon icon={row.definition.icon} size="17px" aria-hidden={true} /></span>
      <span class="ja-task-name">
        {name}
        <small>{task.feature}</small>
      </span>
      <span class="ja-state" data-state={task.state}>
        <i aria-hidden="true"></i>
        {task.line}
      </span>
      <span class="ja-num">
        {#if task.dash}
          <span class="ja-dim">—</span>
        {:else if counts.pending}
          {$t('frameleaf_jobs_adv_sum_waiting', { values: { count: counts.pending } })}
        {:else}
          <span class="ja-dim">{$t('frameleaf_jobs_adv_none_waiting')}</span>
        {/if}
      </span>
      <span class="ja-num">
        {#if task.dash}
          <span class="ja-dim">—</span>
        {:else if counts.failed}
          <span class="ja-failed">{$t('frameleaf_jobs_adv_failed', { values: { count: counts.failed } })}</span>
        {:else}
          <span class="ja-dim">{$t('frameleaf_jobs_adv_no_failures')}</span>
        {/if}
      </span>
    </button>
    <span class="ja-task-actions">
      <button
        type="button"
        class="ja-atonce"
        disabled={!canChangeWorkers}
        aria-label={$t('frameleaf_bgwork_at_once_aria', { values: { name, count: workersOf(row.definition.name) } })}
        onclick={onConcurrency}
      >
        {$t('frameleaf_jobs_adv_at_once', { values: { count: workersOf(row.definition.name) } })}
      </button>
      {#if button}
        <span class="ja-task-button">
          <Button
            label={$t(
              button === 'pause'
                ? 'frameleaf_jobs_pause_named'
                : button === 'resume'
                  ? 'frameleaf_jobs_resume_named'
                  : 'frameleaf_jobs_adv_start_named',
              { values: { name } },
            )}
            onclick={() => onCommand(button === 'pause' ? 'pause' : 'resume', row)}
          >
            <Icon icon={button === 'pause' ? mdiPause : mdiPlay} size="1rem" aria-hidden={true} />
            {$t(
              button === 'pause'
                ? 'frameleaf_jobs_pause'
                : button === 'resume'
                  ? 'frameleaf_jobs_resume'
                  : 'frameleaf_bgwork_start_now',
            )}
          </Button>
        </span>
      {:else}
        <span class="ja-task-button" aria-hidden="true"></span>
      {/if}
      <button
        type="button"
        class="ja-icon-button"
        aria-label={$t('frameleaf_jobs_open_queue', { values: { name } })}
        onclick={() => onOpen(row.definition.name)}
      >
        <Icon icon={mdiChevronRight} size="1rem" aria-hidden={true} />
      </button>
    </span>
  </li>
{/snippet}

<div class="ja">
  <header class="ja-head">
    <div>
      <p class="ja-eyebrow">{$t('frameleaf_bgwork_adv_overline')}</p>
      <h2>{$t('frameleaf_bgwork_adv_title')}</h2>
      <p class="ja-sum">
        <!-- an account's counts that are not all known are not summed: a part would read as the whole -->
        {#if !anyUnknown}
          <span>{$t('frameleaf_jobs_adv_sum_running', { values: { count: sum('active') } })}</span>
          <span aria-hidden="true">·</span>
          <span>{$t('frameleaf_jobs_adv_sum_waiting', { values: { count: sum('pending') } })}</span>
          <span aria-hidden="true">·</span>
        {/if}
        <span class:ja-bad={failed > 0}>{$t('frameleaf_jobs_adv_sum_look', { values: { count: failed } })}</span>
      </p>
    </div>
    <div class="ja-head-actions">
      {#if yours.length > 0}
        <Button onclick={onResumeAll}>
          <Icon icon={mdiPlay} size="1rem" aria-hidden={true} />
          {$t('frameleaf_jobs_adv_resume_yours', { values: { count: yours.length } })}
        </Button>
      {/if}
      {#if pausable.length > 0}
        <Button onclick={onPauseAll}>
          <Icon icon={mdiPause} size="1rem" aria-hidden={true} />
          {$t('frameleaf_bgwork_pause_all')}
        </Button>
      {/if}
    </div>
  </header>

  <section class="ja-section" aria-labelledby="ja-look">
    <div class="ja-section-head">
      <h3 id="ja-look">{$t('frameleaf_jobs_adv_look')}</h3>
      {#if overview}
        <p>{failed > 0 ? $t('frameleaf_jobs_adv_look_help') : $t('frameleaf_jobs_adv_look_none')}</p>
      {/if}
    </div>
    {#if failedToLoad && !overview}
      <InlineError message={$t('frameleaf_jobs_queues_load_failed')} onRetry={() => void load()} />
    {/if}
    {#if problems.length > 0}
      <ul class="ja-problems">
        {#each allProblems ? problems : problems.slice(0, SHOWN) as problem (problem.cause)}
          {@const { icon, fix, key } = PROBLEMS[problem.cause]}
          {@const heading = $t(`frameleaf_jobs_adv_cause_${key}` as Translations)}
          {#if settled.has(problem.cause)}
            <li class="ja-problem ja-settled" role="status">
              <span class="ja-problem-icon"><Icon icon={mdiCheckCircleOutline} size="19px" aria-hidden={true} /></span>
              <div class="ja-problem-text">
                <h4>{heading}</h4>
                <p>{settled.get(problem.cause)}</p>
              </div>
            </li>
          {:else}
            <!-- an unrecognised problem has only the server's words to go on: they show at once -->
            {@const always = problem.cause === QueueProblemCause.Other}
            <li class="ja-problem">
              <span class="ja-problem-icon"><Icon {icon} size="19px" aria-hidden={true} /></span>
              <div class="ja-problem-text">
                <h4>
                  {heading}
                  <span class="ja-count">{unit(problem)}</span>
                </h4>
                <p>{$t(`frameleaf_jobs_adv_cause_${key}_body` as Translations)}</p>
                {#if problem.message && (always || said.has(problem.cause))}
                  <code class="ja-said">{problem.message}</code>
                {/if}
                <p class="ja-where">
                  {$t('frameleaf_jobs_adv_in', {
                    values: { tasks: problem.queues.map((name) => titleOf(name)).join(', ') },
                  })}
                  {#if problem.message && !always}
                    <button
                      type="button"
                      class="ja-link"
                      aria-expanded={said.has(problem.cause)}
                      onclick={() => toggleSaid(problem.cause)}
                    >
                      {said.has(problem.cause) ? $t('frameleaf_jobs_adv_said_hide') : $t('frameleaf_jobs_adv_said')}
                    </button>
                  {/if}
                </p>
                {#if actionFailed === problem.cause}
                  <p class="ja-action-failed" role="alert">{$t('frameleaf_jobs_adv_action_failed')}</p>
                {/if}
              </div>
              <span class="ja-problem-action">
                {#if fix === 'care'}
                  <a class="fl-control {problem === open[0] ? 'primary' : 'default'}" href={careHref}>
                    {$t(FIX_LABELS[fix])}
                  </a>
                {:else}
                  <Button
                    variant={problem === open[0] ? 'primary' : 'default'}
                    disabled={acting !== undefined}
                    onclick={() => void act(problem)}
                  >
                    {$t(FIX_LABELS[fix])}
                  </Button>
                {/if}
              </span>
            </li>
          {/if}
        {/each}
      </ul>
      {#if more.length > 0}
        <button type="button" class="ja-fold" aria-expanded={allProblems} onclick={() => (allProblems = !allProblems)}>
          <Icon icon={allProblems ? mdiChevronDown : mdiChevronRight} size="18px" aria-hidden={true} />
          {allProblems
            ? $t('frameleaf_jobs_adv_fewer_reasons')
            : $t('frameleaf_jobs_adv_more_reasons', {
                values: { count: more.length, items: more.reduce((total, { count }) => total + count, 0) },
              })}
        </button>
      {/if}
    {/if}
  </section>

  <section class="ja-section" aria-labelledby="ja-tasks">
    <div class="ja-section-head ja-with-search">
      <div>
        <h3 id="ja-tasks">{$t('frameleaf_jobs_adv_tasks')}</h3>
        <p>{$t('frameleaf_jobs_adv_tasks_help')}</p>
      </div>
      <label class="ja-search">
        <Icon icon={mdiMagnify} size="16px" aria-hidden={true} />
        <span class="ja-sr">{$t('frameleaf_jobs_search_queues')}</span>
        <input type="search" maxlength="200" placeholder={$t('frameleaf_bgwork_find_task')} bind:value={query} />
      </label>
    </div>
    <ul class="ja-tasks">
      {#each busy as task (task.row.definition.name)}
        {@render taskRow(task)}
      {/each}
      {#if busy.length === 0}
        <li class="ja-none">
          {query.trim()
            ? $t('frameleaf_jobs_adv_no_match', { values: { query: query.trim() } })
            : $t('frameleaf_jobs_adv_no_work')}
        </li>
      {/if}
    </ul>
    {#if idle.length > 0}
      <button type="button" class="ja-fold" aria-expanded={idleOpen} onclick={() => (idleOpen = !idleOpen)}>
        <Icon icon={idleOpen ? mdiChevronDown : mdiChevronRight} size="18px" aria-hidden={true} />
        {$t('frameleaf_jobs_adv_idle', { values: { count: idle.length } })}
      </button>
      {#if idleOpen}
        <ul class="ja-tasks ja-quiet">
          {#each idle as task (task.row.definition.name)}
            {@render taskRow(task)}
          {/each}
        </ul>
      {/if}
    {/if}
  </section>

  <section class="ja-section ja-tools" aria-label={$t('frameleaf_jobs_adv_tools')}>
    <Button disabled={!canChangeWorkers} onclick={onConcurrency}>
      <Icon icon={mdiTuneVariant} size="1rem" aria-hidden={true} />
      {pendingConcurrency > 0
        ? $t('frameleaf_jobs_adv_at_once_pending', { values: { count: pendingConcurrency } })
        : $t('frameleaf_jobs_adv_at_once_tool')}
    </Button>
    <Button onclick={onEnrichment}>
      <Icon icon={mdiImageSearchOutline} size="1rem" aria-hidden={true} />
      {$t('frameleaf_jobs_enrichment_tasks')}
    </Button>
    <Button onclick={onCreate}>
      <Icon icon={mdiPlus} size="1rem" aria-hidden={true} />
      {$t('frameleaf_jobs_adv_create')}
    </Button>
    <a class="ja-link ja-recent" href={activityHref}>
      {$t('frameleaf_jobs_adv_recent')}
      <Icon icon={mdiArrowRight} size="15px" aria-hidden={true} />
    </a>
  </section>
</div>

<style>
  /* The page sits beside the settings sidebar: the rows fold by the list's own width, not the window's. */
  .ja {
    container-type: inline-size;
    display: grid;
    gap: var(--fl-space-10);
    min-width: 0;
    color: var(--fl-text);
    font-size: var(--fl-font-size);
    line-height: 1.5;
  }
  .ja button,
  .ja input {
    font: inherit;
  }
  .ja-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .ja-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: var(--fl-space-6);
    flex-wrap: wrap;
  }
  .ja-head h2 {
    font-size: var(--fl-font-title);
    font-weight: 600;
    letter-spacing: -0.6px;
    margin: 2px 0 10px;
  }
  .ja-eyebrow {
    font-size: var(--fl-font-micro);
    letter-spacing: 1.3px;
    text-transform: uppercase;
    color: var(--fl-muted);
    margin: 0;
  }
  .ja-sum {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    margin: 0;
    color: var(--fl-muted);
    font-variant-numeric: tabular-nums;
  }
  .ja-sum .ja-bad,
  .ja-failed {
    color: var(--fl-danger);
  }
  .ja-head-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .ja-section {
    min-width: 0;
  }
  .ja-section-head {
    margin-bottom: var(--fl-space-4);
  }
  .ja-section-head h3 {
    margin: 0 0 4px;
    font-size: var(--fl-font-headline);
    font-weight: 600;
  }
  .ja-section-head p {
    margin: 0;
    color: var(--fl-muted);
  }
  .ja-with-search {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: var(--fl-space-6);
    flex-wrap: wrap;
  }
  .ja-search {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 1 280px;
    min-width: 0;
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    color: var(--fl-muted);
  }
  .ja-search input {
    border: 0;
    background: transparent;
    min-width: 0;
    width: 100%;
    color: var(--fl-text);
  }
  .ja-search:focus-within {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .ja-search input:focus-visible {
    outline: 0;
  }
  .ja-problems,
  .ja-tasks {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    overflow: hidden;
  }
  .ja-problem {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr) auto;
    gap: var(--fl-space-4);
    align-items: start;
    padding: var(--fl-space-5) var(--fl-space-6);
  }
  .ja-problem + .ja-problem,
  .ja-task + .ja-task {
    border-top: 1px solid var(--fl-border);
  }
  .ja-problem-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--fl-danger) 14%, transparent);
    color: var(--fl-danger);
  }
  .ja-settled .ja-problem-icon {
    background: color-mix(in srgb, var(--fl-accent) 14%, transparent);
    color: var(--fl-accent);
  }
  .ja-problem-text {
    min-width: 0;
  }
  .ja-problem-text h4 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 12px;
    margin: 0 0 4px;
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  .ja-count {
    color: var(--fl-danger);
    font-weight: 500;
    font-size: var(--fl-font-callout);
    font-variant-numeric: tabular-nums;
  }
  .ja-problem-text p {
    margin: 0;
    color: var(--fl-muted);
    max-width: 640px;
  }
  .ja-problem-text .ja-where {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 16px;
    margin-top: 10px;
    font-size: var(--fl-font-small);
  }
  .ja-problem-text .ja-action-failed {
    margin-top: 10px;
    color: var(--fl-danger);
  }
  .ja-said {
    display: block;
    margin-top: 10px;
    padding: 10px 12px;
    border-radius: var(--fl-radius-sm);
    background: var(--fl-bg);
    border: 1px solid var(--fl-border);
    color: var(--fl-text);
    font-size: var(--fl-font-small);
    overflow-wrap: anywhere;
    max-width: 640px;
  }
  .ja-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--fl-accent);
    cursor: pointer;
    font-size: inherit;
    line-height: inherit;
    min-height: 0;
    text-decoration: none;
  }
  .ja-link:hover {
    text-decoration: underline;
  }
  .ja-task {
    display: flex;
    align-items: center;
    gap: var(--fl-space-4);
    padding: 0 var(--fl-space-5) 0 0;
  }
  .ja-task-main {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-columns: 33px minmax(150px, 1.1fr) minmax(170px, 1.5fr) minmax(96px, 0.7fr) minmax(88px, 0.6fr);
    gap: var(--fl-space-4);
    align-items: center;
    padding: var(--fl-space-4) 0 var(--fl-space-4) var(--fl-space-6);
    border: 0;
    background: none;
    color: inherit;
    text-align: start;
    cursor: pointer;
  }
  .ja-task-main:hover {
    background: color-mix(in srgb, var(--fl-text) 4%, transparent);
  }
  .ja-task-icon {
    flex: none;
    height: 33px;
    width: 33px;
    display: grid;
    place-items: center;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    color: var(--fl-muted);
  }
  .ja-task-name {
    font-weight: 500;
    min-width: 0;
  }
  .ja-task-name small {
    display: block;
    color: var(--fl-muted);
    font-weight: 400;
    font-size: var(--fl-font-small);
  }
  .ja-state {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .ja-state i {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    transform: translateY(-1px);
  }
  .ja-state[data-state='running'] {
    color: var(--fl-accent);
  }
  .ja-state[data-state='held'] {
    color: var(--fl-warning);
  }
  .ja-state[data-state='stopped'] {
    color: var(--fl-danger);
  }
  .ja-num {
    font-size: var(--fl-font-callout);
    color: var(--fl-text);
    font-variant-numeric: tabular-nums;
  }
  .ja-dim {
    color: var(--fl-muted);
    opacity: 0.8;
  }
  .ja-task-actions {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
  }
  .ja-task-button {
    display: flex;
    min-width: 112px;
  }
  .ja-task-button :global(.fl-control) {
    flex: 1;
    justify-content: center;
  }
  .ja-atonce {
    padding: 4px 0;
    border: 0;
    background: none;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    white-space: nowrap;
    cursor: pointer;
    min-width: 72px;
    text-align: end;
  }
  .ja-atonce:hover:not(:disabled) {
    color: var(--fl-text);
    text-decoration: underline;
  }
  .ja-atonce:disabled {
    cursor: default;
  }
  .ja-icon-button {
    appearance: none;
    display: inline-grid;
    place-items: center;
    min-width: var(--fl-control-height);
    min-height: var(--fl-control-height);
    padding: 0;
    border: 0;
    border-radius: var(--fl-radius-control);
    background: none;
    color: inherit;
    cursor: pointer;
  }
  .ja-icon-button:hover {
    background: color-mix(in srgb, var(--fl-text) 6%, transparent);
  }
  .ja-fold {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: var(--fl-space-4);
    padding: 8px 0;
    border: 0;
    background: none;
    color: var(--fl-muted);
    cursor: pointer;
    text-align: start;
  }
  .ja-fold:hover {
    color: var(--fl-text);
  }
  .ja-quiet {
    margin-top: 8px;
  }
  .ja-none {
    padding: var(--fl-space-6);
    color: var(--fl-muted);
  }
  .ja-tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding-top: var(--fl-space-6);
    border-top: 1px solid var(--fl-border);
  }
  .ja-recent {
    margin-inline-start: auto;
  }
  /* 900px: one line still fits beside the settings sidebar on a 1280px window */
  @container (max-width: 900px) {
    .ja-task {
      flex-wrap: wrap;
      padding: 0 var(--fl-space-5) var(--fl-space-4) 0;
    }
    .ja-task-main {
      flex-basis: 100%;
      grid-template-columns: 33px minmax(0, 1fr) minmax(0, 1fr);
      padding-bottom: var(--fl-space-3);
    }
    .ja-task-main .ja-task-name,
    .ja-task-main .ja-state {
      grid-column: 2 / -1;
    }
    .ja-state + .ja-num {
      grid-column: 2;
    }
    .ja-task-actions {
      margin-inline-start: 73px;
    }
  }
  @container (max-width: 640px) {
    .ja-problem {
      grid-template-columns: 36px minmax(0, 1fr);
      padding: var(--fl-space-5) var(--fl-space-4);
    }
    .ja-problem-action {
      grid-column: 2;
      justify-self: start;
    }
    .ja-task-main {
      padding-inline-start: var(--fl-space-4);
    }
    .ja-task-actions {
      margin-inline-start: 65px;
      flex-wrap: wrap;
    }
    .ja-atonce {
      min-width: 0;
    }
    .ja-search {
      flex: 1 1 100%;
    }
    .ja-recent {
      margin-inline-start: 0;
    }
  }
</style>
