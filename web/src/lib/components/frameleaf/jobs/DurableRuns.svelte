<script lang="ts">
  import {
    listDurableJobRuns,
    listDurableJobRunItems,
    type DurableJobRun,
    type DurableJobItem,
    type QueueName,
  } from '@frameleaf/sdk';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { untrack } from 'svelte';
  import { locale, t, type Translations } from 'svelte-i18n';
  import type { ActivityFilter } from '$lib/frameleaf/activity';
  import {
    DURABLE_OUTCOMES,
    isRunSettled,
    matchesRunFilter,
    runOutcomeKey,
    runReasonKey,
    runStateKey,
    settledItems,
  } from '$lib/frameleaf/durable-runs';
  import { jobQueue } from '$lib/frameleaf/job-queues';

  let {
    filter = 'all',
    refreshToken = 0,
    focusRunId = null,
  }: { filter?: ActivityFilter; refreshToken?: number; focusRunId?: string | null } = $props();
  const PAGE_SIZE = 25;
  let runs = $state<DurableJobRun[]>([]);
  let offset = $state(0);
  let hasNext = $state(false);
  let loading = $state(false);
  let unavailable = $state(false);
  let selectedId = $state<string | null>(null);
  let items = $state<DurableJobItem[]>([]);
  let itemOffset = $state(0);
  let itemsHaveNext = $state(false);
  let itemsLoading = $state(false);
  let itemsUnavailable = $state(false);
  let itemRequest = 0;
  let pendingItemsId: string | null = null;
  const visible = $derived(runs.filter((run) => matchesRunFilter(run, filter)));
  const number = (value: number) => value.toLocaleString($locale ?? undefined);
  const title = (run: DurableJobRun) => {
    const queue = jobQueue(run.kind as QueueName);
    return queue ? $t(`frameleaf_jobs_queue_${queue.key}` as Translations) : $t('frameleaf_job_runs_server_work');
  };
  const loadItems = async (id: string, skip = 0) => {
    if (itemsLoading && pendingItemsId === id) {
      return;
    }
    const request = ++itemRequest;
    pendingItemsId = id;
    itemsLoading = true;
    try {
      const page = await listDurableJobRunItems({ id, take: PAGE_SIZE, skip });
      if (selectedId !== id || request !== itemRequest) {
        return;
      }
      items = page.items;
      itemsHaveNext = page.hasNextPage;
      itemOffset = skip;
      itemsUnavailable = false;
    } catch {
      if (request === itemRequest && selectedId === id) {
        itemsUnavailable = true;
      }
    } finally {
      if (request === itemRequest) {
        itemsLoading = false;
        pendingItemsId = null;
      }
    }
  };
  const inspect = (id: string) => {
    selectedId = id;
    items = [];
    itemOffset = 0;
    itemsHaveNext = false;
    itemsUnavailable = false;
    void loadItems(id);
  };
  const load = async (skip = offset) => {
    if (loading) {
      return;
    }
    loading = true;
    try {
      const page = await listDurableJobRuns({ take: PAGE_SIZE, skip });
      runs = page.items;
      hasNext = page.hasNextPage;
      offset = skip;
      unavailable = false;
      if (selectedId) {
        void loadItems(selectedId, itemOffset);
      }
    } catch {
      unavailable = true;
    } finally {
      loading = false;
    }
  };
  $effect(() => {
    void refreshToken;
    untrack(() => void load(0));
  });
  $effect(() => {
    const id = focusRunId;
    if (id) {
      untrack(() => inspect(id));
    }
  });
  $effect(() => {
    const timer = setInterval(() => void load(), runs.some((run) => !isRunSettled(run)) ? 5000 : 30_000);
    return () => clearInterval(timer);
  });
</script>

<section class="jm-history" aria-label={$t('frameleaf_job_runs_title')}>
  <h3>{$t('frameleaf_job_runs_title')}</h3>
  <p>{$t('frameleaf_job_runs_help')}</p>
  {#if unavailable}<p role="status">{$t('frameleaf_job_runs_unavailable')}</p>{/if}
  {#if !loading && runs.length === 0 && !unavailable}<p>{$t('frameleaf_job_runs_empty')}</p>{/if}
  <ol>
    {#each visible as run (run.id)}
      <li>
        <strong>{title(run)}</strong>
        <span>{$t(runStateKey(run.state))}</span>
        <p>
          {$t('frameleaf_job_runs_progress', { values: { done: number(settledItems(run)), total: number(run.total) } })}
        </p>
        {#if run.enumerationDone && run.total > 0}
          <progress max={run.total} value={settledItems(run)} aria-label={$t('frameleaf_job_runs_selected_items')}
          ></progress>
        {/if}
        {#if !run.enumerationDone}<p>{$t('frameleaf_job_runs_enumerating')}</p>{/if}
        <dl>
          {#each DURABLE_OUTCOMES as outcome (outcome)}
            {#if run[outcome] > 0}<dt>{$t(runOutcomeKey(outcome))}</dt>
              <dd>{number(run[outcome])}</dd>{/if}
          {/each}
        </dl>
        <p>{$t('frameleaf_job_runs_stages', { values: { count: number(run.stageTotals.total) } })}</p>
        {#if run.lastStage}<p>{$t('frameleaf_job_runs_last_stage', { values: { stage: run.lastStage } })}</p>{/if}
        {#if run.lastProgressAt}<time datetime={run.lastProgressAt}
            >{$t('frameleaf_job_runs_last_progress', {
              values: { time: new Date(run.lastProgressAt).toLocaleString($locale ?? undefined) },
            })}</time
          >{/if}
        {#each run.reasons as reason (reason)}<p>{$t(runReasonKey(reason))}</p>{/each}
        <Button onclick={() => inspect(run.id)}>{$t('frameleaf_job_runs_inspect')}</Button>
        {#if selectedId === run.id}
          <section aria-label={$t('frameleaf_job_runs_items')}>
            {#if itemsUnavailable}<p role="status">{$t('frameleaf_job_runs_items_unavailable')}</p>{/if}
            <ol start={itemOffset + 1}>
              {#each items as item (item.id)}
                <li>
                  <strong>{$t(runOutcomeKey(item.outcome))}</strong>
                  <span>{$t('frameleaf_job_runs_stages', { values: { count: number(item.stageTotals.total) } })}</span>
                  <dl>
                    {#each DURABLE_OUTCOMES as outcome (outcome)}{#if item.stageTotals[outcome] > 0}<dt>
                          {$t(runOutcomeKey(outcome))}
                        </dt>
                        <dd>{number(item.stageTotals[outcome])}</dd>{/if}{/each}
                  </dl>
                  {#if item.lastStage}<p>
                      {$t('frameleaf_job_runs_last_stage', { values: { stage: item.lastStage } })}
                    </p>{/if}
                  {#if item.lastProgressAt}<time datetime={item.lastProgressAt}
                      >{$t('frameleaf_job_runs_last_progress', {
                        values: { time: new Date(item.lastProgressAt).toLocaleString($locale ?? undefined) },
                      })}</time
                    >{/if}
                  {#each item.reasons as reason (reason)}<p>{$t(runReasonKey(reason))}</p>{/each}
                </li>
              {/each}
            </ol>
            <div class="pager">
              <Button
                disabled={itemsLoading || itemOffset === 0}
                onclick={() => void loadItems(run.id, Math.max(0, itemOffset - PAGE_SIZE))}
                >{$t('frameleaf_job_runs_previous')}</Button
              >
              <Button disabled={itemsLoading} onclick={() => void loadItems(run.id, itemOffset)}
                >{$t('frameleaf_job_runs_refresh')}</Button
              >
              <Button
                disabled={itemsLoading || !itemsHaveNext}
                onclick={() => void loadItems(run.id, itemOffset + PAGE_SIZE)}>{$t('frameleaf_job_runs_next')}</Button
              >
            </div>
          </section>
        {/if}
      </li>
    {/each}
  </ol>
  <div class="pager">
    <Button disabled={loading || offset === 0} onclick={() => void load(Math.max(0, offset - PAGE_SIZE))}
      >{$t('frameleaf_job_runs_previous')}</Button
    >
    <Button disabled={loading} onclick={() => void load()}>{$t('frameleaf_job_runs_refresh')}</Button>
    <Button disabled={loading || !hasNext} onclick={() => void load(offset + PAGE_SIZE)}
      >{$t('frameleaf_job_runs_next')}</Button
    >
  </div>
</section>

<style>
  section {
    margin-block: 1rem;
  }
  h3 {
    font-weight: 600;
  }
  li {
    padding-block: 0.75rem;
    border-block-end: 1px solid var(--fl-border);
  }
  li > span {
    margin-inline-start: 0.75rem;
  }
  dl {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  dd {
    margin-inline-end: 0.75rem;
  }
  p,
  time {
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .pager {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    margin-top: var(--fl-space-3);
  }
</style>
