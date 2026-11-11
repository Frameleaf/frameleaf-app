<script lang="ts">
  /**
   * Review what failed (FL-1349, after the prototype `RecentWork.jsx` review sheet): a run's left-over photos grouped
   * by plain cause, each with exactly one thing to do. A drive or something passing is tried again; missing and
   * damaged originals are Library care's, so the sheet opens it; a kind of file that can't be opened is stopped.
   * Show photos lists a few of them: another account's photo gets the lock tile and is never requested. What the
   * server reported, and the full list one row per photo, stay under Technical details.
   */
  import {
    actOnJobRunFailures,
    AssetMediaSize,
    getJobRunFailures,
    JobRunFailureAction,
    type DurableJobRun,
    type JobRunFailureCauseDto,
    type JobRunFailuresResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiCheck, mdiLockOutline } from '@mdi/js';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { jobQueue } from '$lib/frameleaf/job-queues';
  import { CAUSE_VIEW, causeBody } from '$lib/frameleaf/run-failures';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { onMount, untrack } from 'svelte';
  import { locale, t, type Translations } from 'svelte-i18n';

  let {
    run,
    name,
    onChanged,
    onClose,
  }: {
    /** The run as Recent work last read it: while it is still going, a change in what it left over reads the sheet again. */
    run: DurableJobRun;
    /** What the work is called, as its card says. */
    name: string;
    /** After Try again or Stop trying, so Recent work reads again. */
    onChanged: () => void;
    /** Once the sheet has closed. */
    onClose: () => void;
  } = $props();

  let open = $state(false);
  let failures = $state<JobRunFailuresResponseDto>();
  let failed = $state(false);
  let acting = $state<string | null>(null);
  /** What each cause's action did, said in its place, with the cause as it was when acted on. */
  let said = $state<Record<string, { words: string; group: JobRunFailureCauseDto }>>({});
  /** Pictures that wouldn't load (a damaged file often has none): their rows keep the plain tile. */
  let broken = $state<Record<string, boolean>>({});
  /** The causes whose photos are shown. */
  let shown = $state<Record<string, boolean>>({});

  const number = (value: number) => value.toLocaleString($locale ?? undefined);
  /** Only causes with photos still needing a look; stopped ones have nothing left to do. */
  const live = $derived((failures?.causes ?? []).filter((group) => group.count > 0));
  const total = $derived(live.reduce((sum, group) => sum + group.count, 0));
  /**
   * The causes listed: those still needing a look, and those just acted on (as they were, with what was done), so the
   * confirmation stays in place after the sheet reads again. In the server's order: drive, missing, damaged,
   * unsupported, other.
   */
  const causes = $derived(
    (Object.keys(CAUSE_VIEW) as JobRunFailureCauseDto['cause'][]).flatMap((cause) => {
      const group = said[cause]?.group ?? live.find((item) => item.cause === cause);
      return group ? [group] : [];
    }),
  );
  const photos = $derived(failures?.countsPhotos !== false);
  const queueTitle = (queue: JobRunFailureCauseDto['queues'][number]) => {
    const key = jobQueue(queue)?.key;
    return key ? $t(`frameleaf_jobs_queue_${key}` as Translations) : queue;
  };

  onMount(() => {
    open = true;
    void load();
  });

  /** What the card knows about the run's left-overs; when Recent work's poll changes it, the sheet reads again. */
  const leftOverSeen = $derived(JSON.stringify([run.state, run.leftOver, run.failureCauses]));
  let lastSeen: string | undefined;
  $effect(() => {
    const seen = leftOverSeen;
    untrack(() => {
      const changed = lastSeen !== undefined && seen !== lastSeen;
      lastSeen = seen;
      // Never in the middle of an action (it reads again itself once done), nor before the first read is in. What the
      // person has open (its photos, Technical details) and any confirmation are kept: they live outside the data.
      if (changed && open && !acting && failures) {
        void load();
      }
    });
  });

  /** A read asked for while another is on its way runs once that one ends, so the last read is always current. */
  let loading = false;
  let again = false;
  const load = async (): Promise<void> => {
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    try {
      // FL-1430: as Recent work's card counts them (a night's runs together, none newer work took over)
      failures = await getJobRunFailures({ id: run.id, foldNightly: true });
      failed = false;
    } catch {
      // A read again after an action that fails keeps what is shown; only a first read says it couldn't load.
      failed = !failures;
    } finally {
      loading = false;
    }
    if (again) {
      again = false;
      await load();
    }
  };

  const act = async (group: JobRunFailureCauseDto, action: JobRunFailureAction) => {
    if (acting) {
      return;
    }
    acting = group.cause;
    try {
      const { count } = await actOnJobRunFailures({
        id: run.id,
        foldNightly: true,
        jobRunFailureActionDto: { cause: group.cause, action },
      });
      const stop = action === JobRunFailureAction.Stop;
      const key = photos
        ? stop
          ? 'frameleaf_job_runs_stopped_said'
          : 'frameleaf_job_runs_retry_said'
        : stop
          ? 'frameleaf_job_runs_stopped_said_tasks'
          : 'frameleaf_job_runs_retry_said_tasks';
      said[group.cause] = { words: $t(key, { values: { count } }), group };
      onChanged();
      await load();
    } catch (error) {
      handleError(error, $t('frameleaf_job_runs_act_failed'));
    } finally {
      acting = null;
    }
  };
</script>

<Dialog
  title={$t('frameleaf_job_runs_review_title', { values: { name } })}
  closeLabel={$t('close')}
  wide
  bind:open
  onClosed={onClose}
>
  {#if failed}
    <p class="lead" role="status">{$t('frameleaf_job_runs_review_unavailable')}</p>
  {:else if !failures}
    <p class="lead" role="status">{$t('frameleaf_job_runs_review_loading')}</p>
  {:else if causes.length === 0}
    <p class="lead">
      {(failures.superseded ?? 0) > 0
        ? $t('frameleaf_job_runs_review_superseded', { values: { count: failures.superseded } })
        : $t('frameleaf_job_runs_review_empty')}
    </p>
  {:else}
    <p class="lead">
      {live.length === 0
        ? $t('frameleaf_job_runs_review_empty')
        : $t(photos ? 'frameleaf_job_runs_review_lead' : 'frameleaf_job_runs_review_lead_tasks', {
            values: { count: total, causes: live.length },
          })}
    </p>
    <ul class="causes">
      {#each causes as group (group.cause)}
        {@const view = CAUSE_VIEW[group.cause]}
        {@const body = causeBody(group)}
        {@const done = said[group.cause]?.words}
        {@const revealed = shown[group.cause] ?? false}
        <li class="cause" data-tone={view.tone}>
          <span class="cause-icon" aria-hidden="true"><Icon icon={view.icon} size="18" /></span>
          <div class="cause-main">
            <div class="cause-head">
              <strong>{$t(view.title)}</strong>
              <span class="count">
                {$t(photos ? 'frameleaf_job_runs_cause_photos' : 'frameleaf_job_runs_cause_tasks', {
                  values: { count: group.count },
                })}
              </span>
            </div>
            <p>{$t(body.key, { values: body.values })}</p>
            {#if group.stopped > 0}
              <p>{$t('frameleaf_job_runs_cause_stopped', { values: { count: group.stopped } })}</p>
            {/if}
            {#if done}
              <p class="said" role="status"><Icon icon={mdiCheck} size="16" aria-hidden />{done}</p>
            {:else}
              <div class="cause-actions">
                {#if view.action === 'care'}
                  <a
                    class="fl-control button primary"
                    href={commandCenterUrl('care', 'files')}
                    onclick={() => (open = false)}>{$t('frameleaf_job_runs_open_care')}</a
                  >
                {:else}
                  <Button
                    variant={group.cause === 'drive' ? 'primary' : 'default'}
                    disabled={acting !== null}
                    onclick={() =>
                      void act(group, view.action === 'stop' ? JobRunFailureAction.Stop : JobRunFailureAction.Retry)}
                  >
                    {$t(view.action === 'stop' ? 'frameleaf_job_runs_stop_trying' : 'frameleaf_job_runs_try_again')}
                  </Button>
                {/if}
                {#if group.samples.length > 0}
                  <button
                    type="button"
                    class="link"
                    aria-expanded={revealed}
                    onclick={() => (shown[group.cause] = !revealed)}
                  >
                    {$t(revealed ? 'frameleaf_job_runs_hide_photos' : 'frameleaf_job_runs_show_photos')}
                  </button>
                {/if}
              </div>
            {/if}
            {#if revealed && !done}
              <div class="photos">
                <ul>
                  {#each group.samples as sample (sample.assetId)}
                    <li>
                      {#if sample.pictureAllowed && broken[sample.assetId]}
                        <span class="picture"></span>
                      {:else if sample.pictureAllowed}
                        <span class="picture" class:is-missing={group.cause === 'missing'}>
                          <img
                            src={getAssetMediaUrl({ id: sample.assetId, size: AssetMediaSize.Thumbnail })}
                            alt=""
                            loading="lazy"
                            onerror={() => (broken[sample.assetId] = true)}
                          />
                        </span>
                      {:else}
                        <!-- Never another account's picture: not even a request for it. -->
                        <span class="picture is-private"><Icon icon={mdiLockOutline} size="16" aria-hidden /></span>
                      {/if}
                      <span class="file">
                        <span class="name">{sample.fileName}</span>
                        {#if !sample.pictureAllowed}
                          <small>{$t('frameleaf_files_private_note', { values: { owner: sample.ownerName } })}</small>
                        {/if}
                      </span>
                      <!-- Another account's row already names its owner in the note. -->
                      {#if sample.pictureAllowed}<small>{sample.ownerName}</small>{/if}
                    </li>
                  {/each}
                </ul>
                {#if group.count > group.samples.length}
                  <p class="more">
                    {$t('frameleaf_job_runs_more_photos', {
                      values: { count: number(group.count - group.samples.length) },
                    })}
                  </p>
                {/if}
              </div>
            {/if}
            {#if group.message || group.queues.length > 0}
              <details class="technical">
                <summary>{$t('frameleaf_job_runs_technical')}</summary>
                {#if group.message}
                  <p>{$t('frameleaf_job_runs_technical_lead')}</p>
                  <code>{group.message}</code>
                {:else}
                  <p>{$t('frameleaf_job_runs_technical_none')}</p>
                {/if}
                {#each group.queues as queue (queue)}
                  <a class="link" href={Route.viewQueue({ name: queue, tab: 'failed' })}>
                    {group.queues.length > 1
                      ? $t('frameleaf_job_runs_full_list_named', { values: { name: queueTitle(queue) } })
                      : $t('frameleaf_job_runs_full_list')}
                  </a>
                {/each}
              </details>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
  {#snippet actions()}
    <Button variant="primary" onclick={() => (open = false)}>{$t('done')}</Button>
  {/snippet}
</Dialog>

<style>
  /* recent-work.css, the review sheet: one block per cause, 12px apart. */
  .lead {
    margin: 0 0 var(--fl-space-4);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .causes {
    display: grid;
    gap: var(--fl-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .cause {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr);
    gap: 14px;
    padding: var(--fl-space-4);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .cause-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
    color: var(--fl-warning);
  }
  .cause[data-tone='quiet'] .cause-icon {
    color: var(--fl-muted);
  }
  .cause-main {
    display: grid;
    gap: var(--fl-space-2);
    min-width: 0;
  }
  .cause-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--fl-space-3);
  }
  .cause-head strong {
    font-weight: 600;
  }
  .count {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .cause-main > p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .cause-main > .said {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    color: var(--fl-accent);
  }
  .cause-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-4);
    margin-top: var(--fl-space-1);
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
  .photos {
    display: grid;
    gap: 10px;
    margin-top: 6px;
    padding-top: var(--fl-space-3);
    border-top: 1px solid var(--fl-border);
  }
  .photos ul {
    display: grid;
    gap: var(--fl-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .photos li {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-3);
    font-size: var(--fl-font-callout);
  }
  /* FileProblems.svelte `.picture`, at the sheet's 36px. */
  .picture {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    overflow: hidden;
    border-radius: var(--fl-radius-sm);
    background: var(--fl-border);
    color: var(--fl-muted);
  }
  .picture img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .picture.is-missing img {
    filter: grayscale(1);
    opacity: 0.55;
  }
  .file {
    display: grid;
    min-width: 0;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .photos small,
  .more {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .more {
    margin: 0;
  }
  /* `.rw-technical`: what the server reported and the full lists, with nothing left below the last of them. */
  .technical {
    display: grid;
    gap: 6px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .technical summary {
    cursor: pointer;
  }
  .technical p {
    margin: var(--fl-space-1) 0 0;
  }
  .technical code {
    display: block;
    padding: var(--fl-space-2) 10px;
    border-radius: var(--fl-radius-sm);
    background: var(--fl-panel);
    color: var(--fl-text);
    overflow-wrap: anywhere;
  }
  .technical .link {
    justify-self: start;
    font-size: var(--fl-font-small);
  }
  /* With a mouse, text links and the disclosure take their text's height, as in the mock; touch keeps 44px. */
  @media (pointer: fine) {
    .link,
    .technical summary {
      min-height: 0;
    }
  }
  @media (max-width: 600px) {
    .cause {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
