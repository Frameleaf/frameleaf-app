<script lang="ts">
  /**
   * Recent work (FL-1265, FL-1349, after the prototype `RecentWork.jsx`): one card per piece of server work. What it
   * is, its one state and the one reason for it, how far it has got in photos (or tasks, for work that is not about
   * photos), and the photos it left over, by plain cause, with Review what failed. Nightly runs come folded into one
   * card that lists the earlier nights. Resume or Release sits beside the reason when the work waits on it.
   */
  import { isHttpError, listDurableJobRuns, releaseJobRun, type DurableJobRun } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiPlay } from '@mdi/js';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import RunFailuresSheet from '$lib/components/frameleaf/jobs/RunFailuresSheet.svelte';
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import type { ActivityFilter } from '$lib/frameleaf/activity';
  import { isRunSettled, matchesRunFilter, runTitleKey, settledItems } from '$lib/frameleaf/durable-runs';
  import { jobQueue } from '$lib/frameleaf/job-queues';
  import { CAUSE_VIEW, leftOver, runCauses } from '$lib/frameleaf/run-failures';
  import { runHeadline } from '$lib/frameleaf/run-headline';
  import { handleResumeQueue } from '$lib/services/queue.service';
  import { handleError } from '$lib/utils/handle-error';
  import { untrack } from 'svelte';
  import { locale, t } from 'svelte-i18n';

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
  let acting = $state<string | null>(null);
  let notice = $state('');
  /** The nightly card whose earlier nights are open. */
  let nightsOpen = $state<string | null>(null);
  /** The run whose left-over photos are being reviewed. */
  let reviewing = $state<DurableJobRun | null>(null);
  const visible = $derived(runs.filter((run) => matchesRunFilter(run, filter)));
  const number = (value: number) => value.toLocaleString($locale ?? undefined);
  const when = (iso: string) =>
    new Intl.DateTimeFormat($locale ?? undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  const ownQueue = (run: DurableJobRun) => jobQueue(run.kind as Parameters<typeof jobQueue>[0]);
  const title = (run: DurableJobRun) =>
    run.nightly
      ? $t('frameleaf_job_runs_kind_nightly')
      : $t(runTitleKey(run.kind, ownQueue(run)?.key, 'frameleaf_job_runs_server_work'));
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
  const percent = (run: DurableJobRun) =>
    run.total > 0 ? Math.min(100, Math.max(1, (settledItems(run) / run.total) * 100)) : 0;
  const footTime = (run: DurableJobRun) => {
    if (run.nightly) {
      return run.finishedAt
        ? $t('frameleaf_job_runs_nightly_finished', { values: { time: when(run.finishedAt) } })
        : $t('frameleaf_job_runs_nightly_started', { values: { time: when(run.createdAt) } });
    }
    return run.finishedAt
      ? $t('frameleaf_job_runs_finished_at', { values: { time: when(run.finishedAt) } })
      : $t('frameleaf_job_runs_started_at', { values: { time: when(run.createdAt) } });
  };
  /** This night first, then the earlier ones the server folded into it. */
  const nights = (run: DurableJobRun) => [
    { id: run.id, at: run.finishedAt ?? run.createdAt, total: run.total, leftOver: leftOver(run) },
    ...(run.earlierRuns ?? []).map((night) => ({ ...night, at: night.finishedAt ?? night.createdAt })),
  ];

  /** A read asked for while another is on its way (a refresh, a poll): it runs once that read ends. */
  let queuedSkip: number | null = null;
  const load = async (skip = offset): Promise<void> => {
    if (loading) {
      queuedSkip = skip;
      return;
    }
    loading = true;
    try {
      const page = await listDurableJobRuns({ take: PAGE_SIZE, skip, foldNightly: true });
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
    acting = run.id;
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
      acting = null;
    }
    await load();
  };
  /** Resume: every paused step this work waits on carries on, as the Job manager's Resume does. */
  const resume = async (run: DurableJobRun) => {
    acting = run.id;
    notice = '';
    try {
      for (const name of new Set(run.pausedQueues)) {
        await handleResumeQueue({ name });
      }
    } catch (error) {
      handleError(error, $t('frameleaf_job_runs_resume_failed'));
    } finally {
      acting = null;
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
  <ol>
    {#each visible as run (run.id)}
      {@const headline = runHeadline(run)}
      {@const over = leftOver(run)}
      {@const causes = runCauses(run)}
      <li class="run" class:is-focused={focusRunId === run.id} data-tone={headline.tone}>
        <div class="head">
          <strong>{title(run)}</strong>
          <Pill tone={headline.tone}>{$t(headline.status)}</Pill>
        </div>
        <p class="far">{howFar(run)}</p>
        {#if run.enumerationDone && run.total > 0 && !isRunSettled(run)}
          <span class="bar" aria-hidden="true"><span style:width="{percent(run)}%"></span></span>
        {/if}
        {#if headline.why}
          <div class="why">
            <p>{$t(headline.why, { values: headline.values })}</p>
            {#if headline.action}
              <!-- Paused work resumes (its steps, or its held setup); setup holds are released. -->
              <Button
                disabled={acting !== null}
                onclick={() => void (headline.action === 'resume' ? resume(run) : release(run))}
              >
                {#if headline.status === 'frameleaf_job_runs_state_paused'}
                  <Icon icon={mdiPlay} size="16" aria-hidden />
                  {$t('resume')}
                {:else}
                  {$t('frameleaf_job_runs_release')}
                {/if}
              </Button>
            {/if}
          </div>
        {/if}
        {#if over > 0}
          <div class="over">
            <span class="over-icon" aria-hidden="true"><Icon icon={mdiAlertCircleOutline} size="16" /></span>
            <p>
              <span>
                {$t(photos(run) ? 'frameleaf_job_runs_need_a_look' : 'frameleaf_job_runs_need_a_look_tasks', {
                  values: { count: over },
                })}
              </span>
              {#if causes.length > 0}
                <small>
                  {#each causes as { cause, count } (cause)}
                    <span
                      >{$t('frameleaf_job_runs_cause_count_line', {
                        values: { title: $t(CAUSE_VIEW[cause].title), count: number(count) },
                      })}</span
                    >
                  {/each}
                </small>
              {/if}
            </p>
            <Button onclick={() => (reviewing = run)}>{$t('frameleaf_job_runs_review')}</Button>
          </div>
        {/if}
        <div class="foot">
          <time datetime={run.finishedAt ?? run.createdAt}>{footTime(run)}</time>
          {#if run.earlierRuns?.length}
            <button
              type="button"
              class="link"
              aria-expanded={nightsOpen === run.id}
              onclick={() => (nightsOpen = nightsOpen === run.id ? null : run.id)}
            >
              {$t(
                nightsOpen === run.id ? 'frameleaf_job_runs_hide_earlier_nights' : 'frameleaf_job_runs_earlier_nights',
              )}
            </button>
          {/if}
        </div>
        {#if run.earlierRuns?.length && nightsOpen === run.id}
          <table class="nights">
            <thead>
              <tr>
                <th scope="col">{$t('frameleaf_job_runs_nights_night')}</th>
                <th scope="col">{$t('frameleaf_job_runs_nights_photos')}</th>
                <th scope="col">{$t('frameleaf_job_runs_nights_left_over')}</th>
              </tr>
            </thead>
            <tbody>
              {#each nights(run) as night (night.id)}
                <tr>
                  <th scope="row"><time datetime={night.at}>{when(night.at)}</time></th>
                  <td>{number(night.total)}</td>
                  <td>{number(night.leftOver)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </li>
    {/each}
  </ol>
  {#if reviewing}
    {#key reviewing.id}
      <RunFailuresSheet
        run={reviewing}
        name={title(reviewing)}
        onChanged={() => void load()}
        onClose={() => (reviewing = null)}
      />
    {/key}
  {/if}
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
    margin-top: var(--fl-space-3);
  }
  p {
    margin: 0;
  }
  /* recent-work.css `.rw-runs` and `.rw-run`: a card per piece of work, 12px apart. */
  ol {
    display: grid;
    gap: var(--fl-space-3);
    margin: var(--fl-space-4) 0 0;
    padding: 0;
    list-style: none;
  }
  .run {
    display: grid;
    gap: 10px;
    padding: var(--fl-space-4) 18px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .run.is-focused {
    border-color: var(--fl-accent);
  }
  .head,
  .foot,
  .why,
  .over {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-2) var(--fl-space-3);
  }
  .head strong {
    font-weight: 600;
  }
  .far {
    font-size: var(--fl-font-callout);
    font-variant-numeric: tabular-nums;
  }
  .why p {
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
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
  .run[data-tone='warn'] .bar > span {
    background: var(--fl-warning);
  }
  /* `.rw-over`: what is left over, on a faint warning wash, with Review what failed at its end. */
  .over {
    flex-wrap: nowrap;
    padding: 10px var(--fl-space-3);
    border-radius: var(--fl-radius-control);
    background: color-mix(in srgb, var(--fl-warning) 9%, transparent);
    font-size: var(--fl-font-callout);
  }
  .over-icon {
    display: grid;
    align-self: flex-start;
    margin-top: 1px;
    color: var(--fl-warning);
  }
  .over p {
    display: grid;
    flex: 1;
    gap: var(--fl-space-half);
    min-width: 0;
  }
  .over small {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--fl-space-3);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .foot {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--fl-accent);
    font: inherit;
    font-size: var(--fl-font-callout);
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .nights {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fl-font-small);
    font-variant-numeric: tabular-nums;
  }
  .nights th,
  .nights td {
    padding: 7px 0;
    border-top: 1px solid var(--fl-border);
    font-weight: inherit;
    text-align: left;
  }
  .nights thead th {
    border-top: 0;
    color: var(--fl-muted);
  }
  .nights time {
    color: inherit;
    font-size: inherit;
  }
  .pager {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    margin-top: var(--fl-space-4);
  }
  @media (max-width: 600px) {
    .run {
      padding: 14px;
    }
    .over {
      flex-wrap: wrap;
    }
    .over :global(button) {
      width: 100%;
    }
  }
</style>
