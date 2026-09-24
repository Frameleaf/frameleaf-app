<script lang="ts">
  import { activitySession } from '$lib/frameleaf/activity-session.svelte';
  import { jobQueue } from '$lib/frameleaf/job-queues';
  import type { RunningJobRow } from '$lib/frameleaf/running-jobs';
  import { runningJobsSession } from '$lib/frameleaf/running-jobs-session.svelte';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { MediaOperationStatus } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiFolderZipOutline, mdiPause, mdiPlay, mdiProgressClock, mdiTrayFull } from '@mdi/js';
  import { locale, t, type Translations } from 'svelte-i18n';

  /**
   * The running-jobs section of the notifications panel (FL-104, owner request September 23, 2026;
   * FL-72 for the server queues).
   *
   * Every background job the viewer may see, each with a progress bar and a pause/play control:
   * their own bulk changes, restorations, renders and exports, and — for administrators only — the
   * server's queues such as thumbnail generation. The rows come from one summary the session polls;
   * nothing here counts or advances anything itself.
   *
   * A row is a link to where the job is managed (Activity for the viewer's jobs, the Jobs page for a
   * queue); the control beside it is a separate button, so neither swallows the other. A job that
   * cannot pause shows the control disabled with the reason as its description, rather than hiding
   * it and leaving the person to wonder.
   */

  let { onNavigate }: { onNavigate?: () => void } = $props();

  let busyId = $state<string | null>(null);
  let announcement = $state('');

  const rows = $derived(runningJobsSession.rows);

  const format = (value: number) => value.toLocaleString($locale ?? undefined);

  const titleOf = (row: RunningJobRow): string => {
    if (row.queueName) {
      // The Job manager's queue titles (FL-71), so a queue reads the same in both places.
      const definition = jobQueue(row.queueName);
      return definition ? $t(`frameleaf_jobs_queue_${definition.key}` as Translations) : row.queueName;
    }
    return row.titleKey ? $t(row.titleKey) : (row.title ?? '');
  };

  const iconOf = (row: RunningJobRow) => {
    if (row.queueName) {
      return jobQueue(row.queueName)?.icon ?? mdiTrayFull;
    }
    return row.source === 'memoryExport' ? mdiFolderZipOutline : mdiProgressClock;
  };

  const domId = (row: RunningJobRow) => `fl-running-${row.id.replaceAll(/[^a-zA-Z0-9-]/g, '-')}`;

  /** The kind of work, and for a queue what is in hand now; the state itself is the chip. */
  const metaOf = (row: RunningJobRow) => {
    const parts = [$t(row.kindKey)];
    if (row.source === 'queue') {
      parts.push(
        $t('frameleaf_running_queue_counts', {
          values: { active: format(row.active ?? 0), waiting: format(row.waiting ?? 0) },
        }),
      );
    }
    return parts.join(' · ');
  };

  const progressText = (row: RunningJobRow) =>
    row.done === null || row.total === null || row.percent === null
      ? $t('frameleaf_running_progress_unknown')
      : $t('frameleaf_running_progress', {
          values: { done: format(row.done), total: format(row.total), percent: row.percent },
        });

  const progressValueText = (row: RunningJobRow) =>
    row.done === null || row.total === null || row.percent === null
      ? $t('frameleaf_running_progress_unknown')
      : $t('frameleaf_running_progress_value', {
          values: { done: format(row.done), total: format(row.total), percent: row.percent },
        });

  const controlLabel = (row: RunningJobRow) =>
    $t(row.control.kind === 'resume' ? 'frameleaf_running_resume' : 'frameleaf_running_pause', {
      values: { name: titleOf(row) },
    });

  const toggle = async (row: RunningJobRow) => {
    if (row.control.kind === 'unavailable' || busyId) {
      return;
    }

    const name = titleOf(row);
    const pausing = row.control.kind === 'pause';
    busyId = row.id;
    try {
      if (row.source === 'queue' && row.queueName) {
        await runningJobsSession.setQueuePaused(row.queueName, pausing);
        announcement = $t(pausing ? 'frameleaf_running_paused_announce' : 'frameleaf_running_resumed_announce', {
          values: { name },
        });
      } else if (row.operationId) {
        if (pausing) {
          const updated = await runningJobsSession.pauseOperation(row.operationId);
          announcement = $t(
            updated.status === MediaOperationStatus.Paused
              ? 'frameleaf_running_paused_announce'
              : 'frameleaf_running_pausing_announce',
            { values: { name } },
          );
        } else {
          await runningJobsSession.resumeOperation(row.operationId);
          announcement = $t('frameleaf_running_resumed_announce', { values: { name } });
        }
        // Activity reads the same jobs from its own feed; let it catch up now rather than later.
        void activitySession.refresh();
      }
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      busyId = null;
    }
  };
</script>

<p class="fl-sr-only" role="status" aria-live="polite">{announcement}</p>

{#if rows.length > 0}
  <section class="fl-running" aria-labelledby="fl-running-title">
    <header class="fl-running-head">
      <h3 id="fl-running-title">{$t('frameleaf_running_title')}</h3>
      <span class="fl-running-count">{$t('frameleaf_running_count', { values: { count: rows.length } })}</span>
      <a class="fl-running-link" href={Route.activity({ filter: 'running' })} onclick={() => onNavigate?.()}>
        {$t('frameleaf_running_open_activity')}
      </a>
    </header>

    {#if runningJobsSession.unreachable}
      <p class="fl-running-stale" role="status">{$t('frameleaf_running_unreachable')}</p>
    {/if}

    <ul class="fl-running-list">
      {#each rows as row (row.id)}
        {@const name = titleOf(row)}
        {@const id = domId(row)}
        <li
          class="fl-job"
          class:is-warning={row.tone === 'warning'}
          class:is-neutral={row.tone === 'neutral'}
          class:paused={row.paused}
          class:pausing={row.pausing}
        >
          <a class="fl-job-main" href={row.href} onclick={() => onNavigate?.()}>
            <span class="fl-job-icon" aria-hidden="true"><Icon icon={iconOf(row)} size="18" /></span>
            <span class="fl-job-text">
              <span class="fl-job-row">
                <strong>{name}</strong>
                <!-- The prototype's Activity chip: the state in words, with a pulsing dot while work moves. -->
                <span
                  class="fl-chip"
                  class:fl-chip--info={row.tone === 'info'}
                  class:fl-chip--success={row.tone === 'success'}
                  class:fl-chip--warning={row.tone === 'warning'}
                  class:fl-chip--danger={row.tone === 'danger'}
                >
                  {#if row.live}<i class="fl-dot" aria-hidden="true"></i>{/if}
                  {$t(row.statusKey)}
                </span>
              </span>
              <span class="fl-job-meta">{metaOf(row)}</span>
            </span>
          </a>

          {#if row.control.kind === 'unavailable'}
            <!-- Focusable on purpose, so the reason can be reached from the keyboard and read aloud. -->
            <button
              type="button"
              class="fl-job-control"
              aria-disabled="true"
              aria-label={controlLabel(row)}
              aria-describedby={`${id}-reason`}
              title={$t(row.control.reasonKey)}
            >
              <Icon icon={mdiPause} size="18" aria-hidden="true" />
            </button>
            <span id={`${id}-reason`} class="fl-sr-only">{$t(row.control.reasonKey)}</span>
          {:else}
            <button
              type="button"
              class="fl-job-control"
              class:resume={row.control.kind === 'resume'}
              aria-label={controlLabel(row)}
              title={controlLabel(row)}
              disabled={busyId === row.id}
              onclick={() => void toggle(row)}
            >
              <Icon icon={row.control.kind === 'resume' ? mdiPlay : mdiPause} size="18" aria-hidden="true" />
            </button>
          {/if}

          <div class="fl-job-progress">
            <div
              class="fl-job-bar"
              class:indeterminate={row.percent === null && !row.paused}
              role="progressbar"
              aria-label={$t('frameleaf_running_progress_for', { values: { name } })}
              aria-valuemin={0}
              aria-valuemax={row.total ?? 100}
              aria-valuenow={row.percent === null ? undefined : (row.done ?? undefined)}
              aria-valuetext={progressValueText(row)}
            >
              <span style={row.percent === null ? undefined : `width: ${row.percent}%`}></span>
            </div>
            <span class="fl-job-count" aria-hidden="true">{progressText(row)}</span>
          </div>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .fl-running {
    display: grid;
    gap: 0.25rem;
    padding: 0.375rem 0.375rem 0.5rem;
    border-bottom: 1px solid var(--fl-border);
  }
  .fl-running-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.375rem 0.625rem 0.125rem;
  }
  .fl-running-head h3 {
    margin: 0;
    font-size: var(--fl-font-small);
    font-weight: 600;
    color: var(--fl-text);
  }
  .fl-running-count {
    flex: 1;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .fl-running-link {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    padding: 0.125rem 0.375rem;
    border-radius: var(--fl-radius-control);
    text-decoration: none;
  }
  .fl-running-link:hover,
  .fl-running-link:focus-visible {
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  .fl-running-stale {
    margin: 0 0.625rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .fl-running-list {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .fl-job {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 0.25rem;
    padding: 0.25rem 0.25rem 0.5rem;
    border-radius: var(--fl-radius-control);
  }
  .fl-job:hover {
    background: var(--fl-raised);
  }
  .fl-job-main {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
    padding: 0.375rem;
    border-radius: var(--fl-radius-control);
    color: inherit;
    text-decoration: none;
  }
  .fl-job-icon {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 10px;
    background: var(--fl-raised);
    color: var(--fl-blue);
  }
  .fl-job:hover .fl-job-icon {
    background: var(--fl-panel);
  }
  .fl-job.is-warning .fl-job-icon {
    color: var(--fl-warning);
  }
  .fl-job.is-neutral .fl-job-icon {
    color: var(--fl-muted);
  }
  .fl-job-text {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .fl-job-text strong {
    overflow: hidden;
    font-weight: 600;
    color: var(--fl-text);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fl-job-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .fl-job-row strong {
    flex: 1 1 auto;
    min-width: 0;
  }
  .fl-job-meta {
    overflow: hidden;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fl-chip {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    white-space: nowrap;
  }
  .fl-job:hover .fl-chip {
    background: var(--fl-panel);
  }
  .fl-chip--info {
    color: var(--fl-teal);
  }
  .fl-chip--success {
    color: var(--fl-accent);
  }
  .fl-chip--warning {
    color: var(--fl-warning);
  }
  .fl-chip--danger {
    color: var(--fl-danger);
  }
  .fl-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    animation: fl-dot-pulse 1.2s ease-in-out infinite;
  }
  @keyframes fl-dot-pulse {
    50% {
      opacity: 0.35;
    }
  }
  .fl-job-control {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border: 1px solid transparent;
    border-radius: var(--fl-radius-control);
    background: transparent;
    color: var(--fl-text);
    cursor: pointer;
    transition:
      background var(--fl-motion-fast) var(--fl-ease),
      color var(--fl-motion-fast) var(--fl-ease);
  }
  .fl-job-control:hover:not(:disabled, [aria-disabled='true']) {
    background: var(--fl-panel);
    border-color: var(--fl-border);
  }
  .fl-job-control.resume {
    color: var(--fl-accent);
  }
  .fl-job-control:disabled,
  .fl-job-control[aria-disabled='true'] {
    color: var(--fl-muted);
    opacity: 0.55;
    cursor: not-allowed;
  }
  .fl-job-progress {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.625rem;
    /* Under the text, not under the icon: the bar belongs to the words above it. */
    padding: 0 0.625rem 0 calc(34px + 1.125rem);
  }
  /* The prototype's Activity bar: 6px, raised track, teal fill; warning while held, muted queued. */
  .fl-job-bar {
    position: relative;
    height: 6px;
    overflow: hidden;
    border-radius: 3px;
    background: var(--fl-raised);
  }
  .fl-job:hover .fl-job-bar {
    background: var(--fl-panel);
  }
  .fl-job-bar span {
    display: block;
    height: 100%;
    width: 0;
    border-radius: 3px;
    background: var(--fl-teal);
    transition: width 700ms linear;
  }
  .fl-job.is-warning .fl-job-bar span {
    background: var(--fl-warning);
  }
  .fl-job.is-neutral .fl-job-bar span {
    background: var(--fl-muted);
  }
  .fl-job-bar.indeterminate span {
    position: absolute;
    inset-block: 0;
    width: 35%;
    animation: fl-job-indeterminate 1.4s var(--fl-ease) infinite;
  }
  .fl-job-count {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  @keyframes fl-job-indeterminate {
    from {
      left: -35%;
    }
    to {
      left: 100%;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-job-bar span,
    .fl-job-control {
      transition: none;
    }
    .fl-dot {
      animation: none;
    }
    /* A still stripe says "working, amount unknown" without moving. */
    .fl-job-bar.indeterminate span {
      left: 0;
      width: 100%;
      opacity: 0.35;
      animation: none;
    }
  }
  .fl-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
</style>
