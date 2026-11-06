<script lang="ts">
  /**
   * Recent work (FL-1265): one plain row per run of server work. What it was, how far it has got in photos (or
   * tasks, for work that is not about photos), what is holding it up in words, a link to anything that failed, and
   * Release when the server is holding it back for setup.
   */
  import { isHttpError, listDurableJobRuns, releaseJobRun, type DurableJobRun } from '@frameleaf/sdk';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Pill, { type KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import type { ActivityFilter } from '$lib/frameleaf/activity';
  import {
    failedItems,
    isRunSettled,
    matchesRunFilter,
    runBlockers,
    runFailedQueues,
    runStateKey,
    runTitleKey,
    settledItems,
  } from '$lib/frameleaf/durable-runs';
  import { jobQueue } from '$lib/frameleaf/job-queues';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { untrack } from 'svelte';
  import { locale, t, type Translations } from 'svelte-i18n';

  let {
    filter = 'all',
    refreshToken = 0,
    focusRunId = null,
  }: { filter?: ActivityFilter; refreshToken?: number; focusRunId?: string | null } = $props();
  const PAGE_SIZE = 25;
  const headingId = $props.id();
  let runs = $state<DurableJobRun[]>([]);
  let offset = $state(0);
  let hasNext = $state(false);
  let loading = $state(false);
  let unavailable = $state(false);
  let releasing = $state<string | null>(null);
  let notice = $state('');
  const visible = $derived(runs.filter((run) => matchesRunFilter(run, filter)));
  const number = (value: number) => value.toLocaleString($locale ?? undefined);
  const when = (iso: string) =>
    new Intl.DateTimeFormat($locale ?? undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  const ownQueue = (run: DurableJobRun) => jobQueue(run.kind as Parameters<typeof jobQueue>[0]);
  const title = (run: DurableJobRun) => $t(runTitleKey(run.kind, ownQueue(run)?.key, 'frameleaf_job_runs_server_work'));
  const queueTitle = (name: Parameters<typeof jobQueue>[0]) => {
    const key = jobQueue(name)?.key;
    return key ? $t(`frameleaf_jobs_queue_${key}` as Translations) : name;
  };
  /** Photos when the work is one per photo, tasks otherwise. */
  const photos = (run: DurableJobRun) => run.countsPhotos !== false;
  const howFar = (run: DurableJobRun) => {
    const done = settledItems(run);
    if (!run.enumerationDone) {
      return $t(photos(run) ? 'frameleaf_job_runs_photos_so_far' : 'frameleaf_job_runs_tasks_so_far', {
        values: { count: done },
      });
    }
    return $t(photos(run) ? 'frameleaf_job_runs_photos' : 'frameleaf_job_runs_tasks', {
      values: { count: run.total, done: number(done) },
    });
  };
  const tone = (run: DurableJobRun): KitTone =>
    ['completed', 'running', 'retrying'].includes(run.state)
      ? 'good'
      : ['completed_with_errors', 'needs_attention', 'paused', 'blocked', 'unavailable'].includes(run.state)
        ? 'warn'
        : 'off';
  const percent = (run: DurableJobRun) =>
    run.total > 0 ? Math.min(100, Math.floor((settledItems(run) / run.total) * 100)) : 0;

  /** A read asked for while another is on its way (a refresh, a poll): it runs once that read ends. */
  let queuedSkip: number | null = null;
  const load = async (skip = offset): Promise<void> => {
    if (loading) {
      queuedSkip = skip;
      return;
    }
    loading = true;
    try {
      const page = await listDurableJobRuns({ take: PAGE_SIZE, skip });
      runs = page.items;
      hasNext = page.hasNextPage;
      offset = skip;
      unavailable = false;
    } catch {
      unavailable = true;
    } finally {
      loading = false;
    }
    if (queuedSkip !== null) {
      const next = queuedSkip;
      queuedSkip = null;
      await load(next);
    }
  };
  const release = async (run: DurableJobRun) => {
    releasing = run.id;
    notice = '';
    try {
      await releaseJobRun({ id: run.id });
      notice = $t('frameleaf_job_runs_released', { values: { name: title(run) } });
    } catch (error) {
      if (isHttpError(error) && error.status === 400) {
        notice = $t('frameleaf_job_runs_release_import_not_ready');
      } else {
        handleError(error, $t('frameleaf_job_runs_release_failed'));
      }
    } finally {
      releasing = null;
    }
    await load();
  };
  $effect(() => {
    void refreshToken;
    untrack(() => void load(0));
  });
  $effect(() => {
    // A hidden tab is not polled; the next tick after it shows again catches up.
    const timer = setInterval(
      () => {
        if (!document.hidden) {
          void load();
        }
      },
      runs.some((run) => !isRunSettled(run)) ? 5000 : 30_000,
    );
    return () => clearInterval(timer);
  });
</script>

<section class="runs" aria-labelledby={headingId}>
  <header>
    <h3 id={headingId}>{$t('frameleaf_job_runs_title')}</h3>
    <p>{$t('frameleaf_job_runs_help')}</p>
  </header>
  {#if unavailable}<p class="note" role="status">{$t('frameleaf_job_runs_unavailable')}</p>{/if}
  {#if notice}<p class="note" role="status">{notice}</p>{/if}
  {#if !loading && runs.length === 0 && !unavailable}<p class="note">{$t('frameleaf_job_runs_empty')}</p>{/if}
  <ul>
    {#each visible as run (run.id)}
      {@const failed = failedItems(run)}
      {@const blockers = runBlockers(run)}
      <li class:is-focused={focusRunId === run.id}>
        <div class="head">
          <strong>{title(run)}</strong>
          <Pill tone={tone(run)}>{$t(runStateKey(run.state))}</Pill>
        </div>
        <p class="far">{howFar(run)}</p>
        {#if run.enumerationDone && run.total > 0 && !isRunSettled(run)}
          <span class="bar" aria-hidden="true"><span style:width="{percent(run)}%"></span></span>
        {/if}
        {#each blockers as key (key)}
          <p class="why">
            {key === 'frameleaf_job_runs_why_setup' && (run.held ?? 0) > 0
              ? $t(photos(run) ? 'frameleaf_job_runs_why_setup_photos' : 'frameleaf_job_runs_why_setup_tasks', {
                  values: { count: run.held },
                })
              : $t(key)}
          </p>
        {/each}
        {#if failed > 0}
          <p class="why is-failed">
            {$t(photos(run) ? 'frameleaf_job_runs_failed_photos' : 'frameleaf_job_runs_failed_tasks', {
              values: { count: failed },
            })}
            {#each runFailedQueues(run, ownQueue(run)?.name) as queue (queue)}
              <a href={Route.viewQueue({ name: queue, tab: 'failed' })}
                >{$t('frameleaf_job_runs_see_failed', { values: { name: queueTitle(queue) } })}</a
              >
            {:else}
              <a href={commandCenterUrl('processing', 'queues')}>{$t('frameleaf_job_runs_see_failed_all')}</a>
            {/each}
          </p>
        {/if}
        <div class="foot">
          <time datetime={run.finishedAt ?? run.createdAt}>
            {run.finishedAt
              ? $t('frameleaf_job_runs_finished_at', { values: { time: when(run.finishedAt) } })
              : $t('frameleaf_job_runs_started_at', { values: { time: when(run.createdAt) } })}
          </time>
          {#if run.canRelease}
            <Button disabled={releasing !== null} onclick={() => void release(run)}>
              {$t('frameleaf_job_runs_release')}
            </Button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
  {#if offset > 0 || hasNext}
    <div class="pager">
      <Button disabled={loading || offset === 0} onclick={() => void load(Math.max(0, offset - PAGE_SIZE))}
        >{$t('frameleaf_job_runs_previous')}</Button
      >
      <Button disabled={loading || !hasNext} onclick={() => void load(offset + PAGE_SIZE)}
        >{$t('frameleaf_job_runs_next')}</Button
      >
    </div>
  {/if}
</section>

<style>
  .runs {
    margin-top: var(--fl-space-6);
    padding-top: var(--fl-space-5);
    border-top: 1px solid var(--fl-border);
  }
  header {
    display: grid;
    gap: var(--fl-space-1);
    margin-bottom: var(--fl-space-3);
  }
  h3 {
    margin: 0;
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  header p,
  .note {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .note {
    margin-block: var(--fl-space-3);
  }
  ul {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: grid;
    gap: var(--fl-space-2);
    padding: var(--fl-space-4) 0;
    border-bottom: 1px solid var(--fl-border);
  }
  li.is-focused {
    padding-inline: var(--fl-space-3);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .head,
  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-2) var(--fl-space-4);
  }
  .head strong {
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  p {
    margin: 0;
  }
  .far {
    font-size: var(--fl-font-callout);
    font-variant-numeric: tabular-nums;
  }
  .why {
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .why.is-failed {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-1) var(--fl-space-3);
    color: var(--fl-text);
  }
  .why a {
    color: var(--fl-accent);
    font-weight: 500;
  }
  .bar {
    display: block;
    height: 4px;
    overflow: hidden;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-border);
  }
  .bar > span {
    display: block;
    height: 100%;
    background: var(--fl-accent);
  }
  time {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .pager {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    margin-top: var(--fl-space-4);
  }
</style>
