<script lang="ts">
  import { goto } from '$app/navigation';
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import {
    ACTIVITY_FILTERS,
    activityCounts,
    buildActivityList,
    matchesActivityFilter,
    type ActivityFilter,
    type ActivityItem,
  } from '$lib/frameleaf/activity';
  import { activitySession } from '$lib/frameleaf/activity-session.svelte';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import '$lib/frameleaf/tokens.css';
  import { downloadManager } from '$lib/managers/download-manager.svelte';
  import { Route } from '$lib/route';
  import { uploadAssetsStore } from '$lib/stores/upload';
  import { handleError } from '$lib/utils/handle-error';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The Activity page (FL-104), ported from the prototype's `Processing` screen.
   *
   * Everything the prototype simulated with a timer is real here. A render's progress, its
   * destination, its failure and its cancellation all come from the durable job row; Cancel and
   * Retry are requests to the server, and the row only changes when the server says it has.
   *
   * Four kinds of work share the list. Renders and bulk operations belong to the account and keep
   * going when this page is closed; a bulk job can be cancelled and retried here like a render. Uploads and downloads belong to this browser tab, and the page
   * says so on the row rather than letting somebody assume otherwise.
   */

  let { filter: initialFilter = 'all' }: { filter?: ActivityFilter } = $props();

  let filter = $state<ActivityFilter>(initialFilter);
  let busyId = $state<string | null>(null);
  let announcement = $state('');

  const items = $derived(
    buildActivityList({
      operations: activitySession.operations,
      uploads: $uploadAssetsStore,
      downloads: [...downloadManager.assets.entries()],
      bulk: librarySession.session.operations,
    }),
  );
  const counts = $derived(activityCounts(items));
  const visible = $derived(items.filter((item) => matchesActivityFilter(item, filter)));
  const hasFinished = $derived(items.some((item) => item.source === 'job' && item.finished));

  onMount(() => activitySession.watch());

  const setFilter = (next: ActivityFilter) => {
    filter = next;
    // Keep the URL honest so the view can be linked to and reloaded onto the same filter.
    void goto(Route.activity(next === 'all' ? undefined : { filter: next }), {
      replaceState: true,
      keepFocus: true,
      noScroll: true,
    });
  };

  const run = async (item: ActivityItem, action: () => Promise<unknown>, announceKey: string) => {
    busyId = item.id;
    try {
      await action();
      announcement = $t(announceKey, { values: { name: item.title } });
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      busyId = null;
    }
  };

  /**
   * Cancel is only offered for durable server jobs.
   *
   * A running bulk operation is aborted by the library page's own controller, which holds the
   * request. Rewriting the session record from here would say "cancelled" while the work carried
   * on, so this page shows those read-only and sends the person back to the library instead.
   */
  const cancel = (item: ActivityItem) => {
    if (item.operationId) {
      void run(item, () => activitySession.cancel(item.operationId as string), 'frameleaf_activity_cancel_requested');
    }
  };

  const retry = (item: ActivityItem) => {
    if (item.operationId) {
      void run(item, () => activitySession.retry(item.operationId as string), 'frameleaf_activity_retry_queued');
    }
  };

  const dismiss = (item: ActivityItem) => {
    if (item.source === 'bulk') {
      librarySession.dispatch({ type: 'operation-dismiss', requestId: item.id.slice('bulk:'.length) });
      return;
    }
    if (item.operationId) {
      void run(item, () => activitySession.dismiss(item.operationId as string), 'frameleaf_activity_cleared');
    }
  };

  const openResult = (item: ActivityItem) => {
    if (item.assetId) {
      void goto(Route.viewAsset({ id: item.assetId }));
    }
  };

  const clearFinished = async () => {
    try {
      await activitySession.dismissFinished();
      announcement = $t('frameleaf_activity_cleared_all');
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    }
  };
</script>

<main class="frameleaf fl-activity-page" aria-labelledby="fl-activity-title">
  <p class="sr-only" role="status" aria-live="polite">{announcement}</p>

  <header class="head">
    <div>
      <p class="eyebrow">{$t('frameleaf_activity_eyebrow')}</p>
      <h1 id="fl-activity-title">{$t('frameleaf_activity_title')}</h1>
      <p class="summary">
        {#if counts.all === 0}
          {$t('frameleaf_activity_summary_idle')}
        {:else}
          {$t('frameleaf_activity_summary', {
            values: { running: counts.running, done: counts.done, failed: counts.failed },
          })}
        {/if}
      </p>
    </div>

    <div class="head-actions">
      <div class="filters" role="group" aria-label={$t('frameleaf_activity_filter_group')}>
        {#each ACTIVITY_FILTERS as name (name)}
          <Button variant="quiet" pressed={filter === name} onclick={() => setFilter(name)}>
            {$t(`frameleaf_activity_filter_${name}`)}
            {#if counts[name] > 0}
              <Badge
                value={counts[name]}
                tone={name === 'failed' ? 'danger' : 'neutral'}
                label={$t('frameleaf_activity_filter_count', { values: { count: counts[name] } })}
              />
            {/if}
          </Button>
        {/each}
      </div>

      {#if hasFinished}
        <Button onclick={() => void clearFinished()}>{$t('frameleaf_activity_clear_finished')}</Button>
      {/if}
    </div>
  </header>

  {#if activitySession.unreachable}
    <p class="offline" role="status">{$t('frameleaf_activity_offline')}</p>
  {/if}

  {#if activitySession.loading && items.length === 0}
    <p class="empty-note" role="status" aria-busy="true">{$t('loading')}</p>
  {:else if visible.length === 0}
    <div class="empty">
      <h2>{$t(`frameleaf_activity_empty_${filter}`)}</h2>
      <p>{$t('frameleaf_activity_empty_help')}</p>
    </div>
  {/if}

  <ul class="list">
    {#each visible as item (item.id)}
      <li class="job">
        <div class="body">
          <div class="row">
            <h3>{item.titleKey ? $t(item.titleKey) : item.title}</h3>
            <span class="chip chip-{item.tone}">{$t(item.statusKey)}</span>
          </div>

          <p class="meta">
            {[
              $t(item.kindKey),
              item.destinationKey ? $t(item.destinationKey) : null,
              ...item.details,
              item.browserLocal ? $t('frameleaf_activity_this_tab_only') : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>

          {#if item.bulk}
            <!-- Counts only: a refused item is never named or shown here, Locked or not. -->
            <p class="meta">{$t('frameleaf_activity_bulk_counts', { values: item.bulk })}</p>
          {/if}

          {#if item.running || item.progress !== null}
            <progress
              class="progress"
              max="100"
              value={item.progress ?? undefined}
              aria-label={$t('frameleaf_activity_progress_for', { values: { name: item.title } })}
            ></progress>
          {/if}

          {#if item.failed && item.error}
            <p class="error">{item.error}</p>
          {/if}
        </div>

        <div class="actions">
          {#if item.canCancel && item.source === 'job'}
            <Button disabled={busyId === item.id} onclick={() => cancel(item)}>{$t('cancel')}</Button>
          {/if}
          {#if item.canRetry}
            <Button disabled={busyId === item.id} onclick={() => retry(item)}>{$t('retry')}</Button>
          {/if}
          {#if item.finished && !item.failed && item.assetId}
            <Button variant="primary" onclick={() => openResult(item)}>
              {$t('frameleaf_activity_open_result')}
            </Button>
          {/if}
          {#if item.canDismiss}
            <Button
              variant="quiet"
              disabled={busyId === item.id}
              label={$t('frameleaf_activity_clear_one', { values: { name: item.title } })}
              onclick={() => dismiss(item)}
            >
              {$t('dismiss')}
            </Button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>

  <footer class="foot">{$t('frameleaf_activity_footnote')}</footer>
</main>

<style>
  .fl-activity-page {
    display: grid;
    gap: 1rem;
    padding: 1.5rem 1rem;
    max-width: 60rem;
    margin-inline: auto;
    color: var(--fl-text);
    font-size: var(--fl-font-size);
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 1rem;
  }
  .eyebrow {
    margin: 0;
    font-size: var(--fl-font-small);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fl-muted);
  }
  h1 {
    margin: 0.125rem 0 0;
    font-size: 1.375rem;
    font-weight: 600;
  }
  .summary,
  .meta,
  .foot,
  .empty-note {
    margin: 0.25rem 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .head-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .filters {
    display: flex;
    gap: 0.25rem;
  }
  .offline {
    margin: 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-panel-radius);
    background: var(--fl-raised);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .list {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .job {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.75rem;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-panel-radius);
  }
  .body {
    flex: 1 1 18rem;
    min-width: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  h3 {
    margin: 0;
    font-size: var(--fl-font-size);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip {
    flex-shrink: 0;
    padding: 0.0625rem 0.5rem;
    border-radius: var(--fl-radius-pill);
    font-size: var(--fl-font-micro);
    font-weight: 600;
    color: var(--fl-text);
    background: var(--fl-raised);
    box-shadow: inset 0 0 0 1px var(--fl-border);
  }
  .chip-info {
    color: var(--fl-blue-text);
    background: var(--fl-blue);
    box-shadow: none;
  }
  .chip-success {
    color: var(--fl-teal-text);
    background: var(--fl-teal);
    box-shadow: none;
  }
  .chip-warning {
    color: var(--fl-warning-text);
    background: var(--fl-warning);
    box-shadow: none;
  }
  .chip-danger {
    color: var(--fl-danger-text);
    background: var(--fl-danger);
    box-shadow: none;
  }
  .progress {
    inline-size: 100%;
    block-size: 0.25rem;
    margin-top: 0.375rem;
  }
  .error {
    margin: 0.25rem 0 0;
    font-size: var(--fl-font-small);
    color: var(--fl-danger);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .empty {
    padding: 2.5rem 1rem;
    text-align: center;
    border: 1px dashed var(--fl-border);
    border-radius: var(--fl-panel-radius);
  }
  .empty h2 {
    margin: 0;
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  .empty p {
    margin: 0.25rem 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .sr-only {
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
