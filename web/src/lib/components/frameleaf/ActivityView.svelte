<script lang="ts">
  import type { Translations } from 'svelte-i18n';
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import {
    ACTIVITY_FILTERS,
    activityCompletion,
    activityCounts,
    activityStatusText,
    buildActivityList,
    formatActivityDuration,
    matchesActivityFilter,
    type ActivityFilter,
    type ActivityItem,
  } from '$lib/frameleaf/activity';
  import { activitySession } from '$lib/frameleaf/activity-session.svelte';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import '$lib/frameleaf/tokens.css';
  import { downloadManager } from '$lib/managers/download-manager.svelte';
  import { studioBundleDownloadPath } from '$lib/frameleaf/studio/bundles';
  import { Route } from '$lib/route';
  import { uploadAssetsStore } from '$lib/stores/upload';
  import { downloadUrl, getAssetMediaUrl } from '$lib/utils';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { handleError } from '$lib/utils/handle-error';
  import { AssetMediaSize, getBaseUrl, getStudioBundleOperation } from '@immich/sdk';
  import { Icon, Theme, themeManager } from '@immich/ui';
  import {
    mdiAutoFix,
    mdiCancel,
    mdiCheckAll,
    mdiCheckCircleOutline,
    mdiClose,
    mdiDownloadOutline,
    mdiExportVariant,
    mdiImageMultipleOutline,
    mdiMovieEditOutline,
    mdiOpenInApp,
    mdiPause,
    mdiPlay,
    mdiProgressClock,
    mdiRefresh,
    mdiUploadOutline,
    mdiWifi,
    mdiWifiOff,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  /**
   * The Activity page (FL-104), ported from the prototype's `Processing` screen
   * (template/src/Activity.jsx and activity.css, FL-43).
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
  /** Row heading ids come from the list position: an item id can hold spaces (a download key). */
  const rowIdPrefix = $props.id();
  /** No ancestor sets the token scope for this page, so it declares its own, as AuthShell does. */
  const theme = $derived(themeManager.value === Theme.Dark ? 'dark' : 'light');
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
  /** The prototype's summary: only the counts that are not zero, or "nothing" when idle. */
  const summary = $derived(
    [
      counts.running ? $t('frameleaf_activity_summary_running', { values: { count: counts.running } }) : null,
      counts.done ? $t('frameleaf_activity_summary_done', { values: { count: counts.done } }) : null,
      counts.failed ? $t('frameleaf_activity_summary_failed', { values: { count: counts.failed } }) : null,
    ]
      .filter(Boolean)
      .join(' · ') || $t('frameleaf_activity_summary_idle'),
  );

  onMount(() => activitySession.watch());

  /**
   * Announce a job that finishes by itself while the page is open (`Activity.jsx`: "Export of
   * Lake trip finished."). The first sight of the list only records where everything stands.
   */
  let seenStatuses: Map<string, Translations> | null = null;
  $effect(() => {
    const current = items;
    const completed = seenStatuses ? activityCompletion(seenStatuses, current) : null;
    seenStatuses = new Map(current.map((item) => [item.id, item.statusKey]));
    const item = completed && current.find((entry) => entry.id === completed.id);
    if (item) {
      announcement = $t(
        completed.outcome === 'finished'
          ? 'frameleaf_activity_announce_finished'
          : 'frameleaf_activity_announce_failed',
        { values: { kind: $t(item.kindKey), name: nameOf(item) } },
      );
    }
  });

  /** The row's name: a translated one where the server withheld or never had the words (FL-43). */
  const nameOf = (item: ActivityItem) => (item.titleKey ? $t(item.titleKey) : item.title);

  /**
   * The row's picture. A server job about a photo shows it; a withheld Locked item, a bulk job,
   * an upload and a download never do, so nothing private is drawn here (FL-43). An upload row
   * carries no withheld flag, so a Locked upload would otherwise show its picture. Everything
   * else gets the prototype's kind icon.
   */
  const thumbnailOf = (item: ActivityItem) =>
    item.source === 'job' && item.assetId && !item.withheld && !item.bulk
      ? getAssetMediaUrl({ id: item.assetId, size: AssetMediaSize.Thumbnail })
      : null;

  const kindIcon = (item: ActivityItem) => {
    if (item.bulk) {
      return mdiImageMultipleOutline;
    }
    if (item.source === 'upload') {
      return mdiUploadOutline;
    }
    if (item.source === 'download') {
      return mdiDownloadOutline;
    }
    return item.kindKey.includes('export') ? mdiExportVariant : mdiAutoFix;
  };

  /**
   * The prototype's status line (`Activity.jsx` `statusText`): the state, how far along it is and
   * about how long is left; "Paused at N%"; "Waiting for connection" while the server is unreachable.
   */
  const statusLine = (item: ActivityItem) =>
    activityStatusText(item, {
      translate: $t,
      online: !activitySession.unreachable,
      formatDuration: (seconds) => formatActivityDuration(seconds, $locale ?? undefined),
      formatSize: (bytes) => getByteUnitString(bytes, $locale ?? undefined),
    });

  let retrying = $state(false);
  /** Ask the server again now, rather than waiting for the next poll (FL-43). */
  const tryAgain = async () => {
    retrying = true;
    try {
      await activitySession.refresh();
      if (!activitySession.unreachable) {
        announcement = $t('frameleaf_activity_reconnected');
      }
    } finally {
      retrying = false;
    }
  };

  const setFilter = (next: ActivityFilter) => {
    filter = next;
    // Keep the URL honest so the view can be linked to and reloaded onto the same filter.
    void goto(Route.activity(next === 'all' ? undefined : { filter: next }), {
      replaceState: true,
      keepFocus: true,
      noScroll: true,
    });
  };

  const run = async (item: ActivityItem, action: () => Promise<unknown>, announceKey: Translations) => {
    busyId = item.id;
    try {
      await action();
      announcement = $t(announceKey, { values: { name: nameOf(item) } });
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

  /**
   * Pause and resume (FL-104). A running job answers "Pausing" until its worker reaches a
   * checkpoint; the row changes when the server says so, never before.
   */
  const pause = (item: ActivityItem) => {
    if (item.operationId) {
      void run(item, () => activitySession.pause(item.operationId as string), 'frameleaf_activity_pause_requested');
    }
  };

  const resume = (item: ActivityItem) => {
    if (item.operationId) {
      void run(item, () => activitySession.resume(item.operationId as string), 'frameleaf_activity_resumed');
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

  /** A Studio render's project (FL-104): open it in Studio. */
  const openInStudio = (item: ActivityItem) => {
    if (item.projectId) {
      void goto(Route.studio({ projectId: item.projectId }));
    }
  };

  /** A finished bundle export (FL-91): the file comes from the owner-scoped download route. */
  const downloadBundle = async (item: ActivityItem) => {
    if (!item.operationId) {
      return;
    }
    try {
      const bundle = await getStudioBundleOperation({ id: item.operationId });
      if (!bundle.export?.downloadable) {
        announcement = $t('frameleaf_studio_bundle_expired');
        return;
      }
      downloadUrl(getBaseUrl() + studioBundleDownloadPath(item.operationId), bundle.export.fileName);
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    }
  };

  /** A finished bundle import (FL-91) opens the project it created. */
  const openImportedProject = async (item: ActivityItem) => {
    if (!item.operationId) {
      return;
    }
    try {
      const bundle = await getStudioBundleOperation({ id: item.operationId });
      if (bundle.import?.projectId) {
        void goto(Route.studio({ projectId: bundle.import.projectId }));
      }
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
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

<main class="frameleaf fla" data-theme={theme} aria-labelledby="fl-activity-title">
  <p class="sr-only" role="status" aria-live="polite">{announcement}</p>

  <header class="fla-head">
    <div>
      <p class="eyebrow">{$t('frameleaf_activity_eyebrow')}</p>
      <h1 id="fl-activity-title">{$t('frameleaf_activity_title')}</h1>
      <p class="fla-summary">{summary}</p>
    </div>

    <div class="fla-head-actions">
      <div class="fla-filters" role="group" aria-label={$t('frameleaf_activity_filter_group')}>
        {#each ACTIVITY_FILTERS as name (name)}
          <button
            type="button"
            class:is-on={filter === name}
            aria-pressed={filter === name}
            onclick={() => setFilter(name)}
          >
            {$t(`frameleaf_activity_filter_${name}`)}
            {#if counts[name] > 0}
              <b aria-hidden="true">{counts[name]}</b>
              <span class="sr-only">{$t('frameleaf_activity_filter_count', { values: { count: counts[name] } })}</span>
            {/if}
          </button>
        {/each}
      </div>

      {#if hasFinished}
        <Button onclick={() => void clearFinished()}>
          <Icon icon={mdiCheckAll} size="1.125rem" aria-hidden={true} />{$t('frameleaf_activity_clear_finished')}
        </Button>
      {/if}
    </div>
  </header>

  {#if activitySession.unreachable}
    <div class="fla-offline" role="status">
      <Icon icon={mdiWifiOff} size="1.125rem" aria-hidden={true} />
      <span>{$t('frameleaf_activity_offline')}</span>
      <span class="grow"></span>
      <Button disabled={retrying} onclick={() => void tryAgain()}>
        <Icon icon={mdiWifi} size="1.125rem" aria-hidden={true} />{$t('frameleaf_activity_reconnect')}
      </Button>
    </div>
  {/if}

  {#if activitySession.loading && items.length === 0}
    <p class="fla-empty" role="status" aria-busy="true">{$t('loading')}</p>
  {:else if visible.length === 0}
    <div class="fla-empty">
      <Icon icon={filter === 'failed' ? mdiCheckCircleOutline : mdiProgressClock} size="2.25rem" aria-hidden={true} />
      <h2>{$t(`frameleaf_activity_empty_${filter}`)}</h2>
      {#if filter === 'all' || filter === 'running'}
        <p>{$t('frameleaf_activity_empty_help')}</p>
        <Button onclick={() => void goto(Route.studioProjects())}>
          <Icon icon={mdiMovieEditOutline} size="1.125rem" aria-hidden={true} />{$t('frameleaf_activity_open_studio')}
        </Button>
      {:else}
        <p>{$t('frameleaf_activity_empty_help_finished')}</p>
      {/if}
    </div>
  {/if}

  <div class="fla-list">
    {#each visible as item, index (item.id)}
      {@const thumbnail = thumbnailOf(item)}
      <article
        class="fla-job"
        class:is-info={item.tone === 'info'}
        class:is-success={item.tone === 'success'}
        class:is-warning={item.tone === 'warning'}
        class:is-danger={item.tone === 'danger'}
        class:is-neutral={item.tone === 'neutral'}
        aria-labelledby="{rowIdPrefix}-job-{index}"
      >
        <div class="fla-thumb">
          {#if thumbnail}
            <img src={thumbnail} alt="" />
          {:else}
            <Icon icon={kindIcon(item)} size="1.375rem" aria-hidden={true} />
          {/if}
        </div>

        <div class="fla-body">
          <div class="fla-row">
            <h3 id="{rowIdPrefix}-job-{index}">{nameOf(item)}</h3>
            <span
              class="fla-chip"
              class:fla-chip--info={item.tone === 'info'}
              class:fla-chip--success={item.tone === 'success'}
              class:fla-chip--warning={item.tone === 'warning'}
              class:fla-chip--danger={item.tone === 'danger'}
            >
              {#if item.running && !activitySession.unreachable}<i class="fla-dot" aria-hidden="true"></i>{/if}
              {$t(item.statusKey)}
            </span>
          </div>

          <p class="fla-meta">
            {[
              $t(item.kindKey),
              item.destinationKey ? $t(item.destinationKey) : null,
              ...item.details,
              item.browserLocal ? $t('frameleaf_activity_this_tab_only') : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>

          {#if item.running || item.paused || item.progress !== null}
            <div
              class="fla-progress"
              class:is-indeterminate={item.progress === null}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={item.progress === null ? undefined : Math.round(item.progress)}
              aria-label={$t('frameleaf_activity_progress_for', { values: { name: nameOf(item) } })}
            >
              <span style:width={item.progress === null ? undefined : `${item.progress}%`}></span>
            </div>
          {/if}

          <p class="fla-status">
            {#if item.bulk}
              <!-- Counts only: a refused item is never named or shown here, Locked or not. -->
              {$t('frameleaf_activity_bulk_counts', { values: item.bulk })}
            {:else}
              {statusLine(item)}
            {/if}
            {#if (item.failed || item.statusKey === 'frameleaf_activity_status_retrying') && item.error}
              · <span class="fla-error">{item.error}</span>
            {/if}
          </p>
          {#if item.bulk && item.bulk.retried > 0}
            <p class="fla-status">{$t('frameleaf_activity_bulk_retried', { values: { count: item.bulk.retried } })}</p>
          {/if}
        </div>

        <div class="fla-actions">
          {#if item.canPause && item.source === 'job'}
            <Button
              disabled={busyId === item.id}
              label={$t('frameleaf_running_pause', { values: { name: nameOf(item) } })}
              onclick={() => pause(item)}
            >
              <Icon icon={mdiPause} size="1.125rem" aria-hidden={true} />{$t('pause')}
            </Button>
          {:else if item.canResume && item.source === 'job'}
            <Button
              disabled={busyId === item.id}
              label={$t('frameleaf_running_resume', { values: { name: nameOf(item) } })}
              onclick={() => resume(item)}
            >
              <Icon icon={mdiPlay} size="1.125rem" aria-hidden={true} />{$t('resume')}
            </Button>
          {:else if item.pauseBlockedKey && item.source === 'job'}
            <!-- Shown disabled with its reason rather than hidden, like the notifications panel's
                 Running now rows (RunningJobsSection); focusable so the reason can be read aloud. -->
            <button
              type="button"
              class="fla-disabled"
              aria-disabled="true"
              aria-label={$t('frameleaf_running_pause', { values: { name: nameOf(item) } })}
              aria-describedby="{rowIdPrefix}-pause-{index}"
              title={$t(item.pauseBlockedKey)}
            >
              <Icon icon={mdiPause} size="1.125rem" aria-hidden={true} />{$t('pause')}
            </button>
            <span id="{rowIdPrefix}-pause-{index}" class="sr-only">{$t(item.pauseBlockedKey)}</span>
          {/if}
          {#if item.canCancel && item.source === 'job'}
            <Button disabled={busyId === item.id} onclick={() => cancel(item)}>
              <Icon icon={mdiCancel} size="1.125rem" aria-hidden={true} />{$t('cancel')}
            </Button>
          {/if}
          {#if item.canRetry}
            <Button disabled={busyId === item.id} onclick={() => retry(item)}>
              <Icon icon={mdiRefresh} size="1.125rem" aria-hidden={true} />{$t('retry')}
            </Button>
          {/if}
          {#if item.finished && !item.failed && item.studioBundle === 'export'}
            <Button variant="primary" onclick={() => void downloadBundle(item)}>
              <Icon icon={mdiDownloadOutline} size="1.125rem" aria-hidden={true} />{$t(
                'frameleaf_studio_bundle_download',
              )}
            </Button>
          {:else if item.finished && !item.failed && item.studioBundle === 'import'}
            <Button variant="primary" onclick={() => void openImportedProject(item)}>
              <Icon icon={mdiOpenInApp} size="1.125rem" aria-hidden={true} />{$t('frameleaf_studio_library_open')}
            </Button>
          {/if}
          {#if item.projectId}
            <Button onclick={() => openInStudio(item)}>
              <Icon icon={mdiMovieEditOutline} size="1.125rem" aria-hidden={true} />{$t(
                'frameleaf_activity_open_in_studio',
              )}
            </Button>
          {/if}
          {#if item.finished && !item.failed && item.assetId}
            <Button variant="primary" onclick={() => openResult(item)}>
              <Icon icon={mdiOpenInApp} size="1.125rem" aria-hidden={true} />{$t('frameleaf_activity_open_result')}
            </Button>
          {/if}
          {#if item.canDismiss}
            <IconButton
              variant="default"
              disabled={busyId === item.id}
              label={$t('frameleaf_activity_clear_one', { values: { name: nameOf(item) } })}
              onclick={() => dismiss(item)}
            >
              <Icon icon={mdiClose} size="1.125rem" />
            </IconButton>
          {/if}
        </div>
      </article>
    {/each}
  </div>

  <footer class="fla-footer">
    <span class="muted">{$t('frameleaf_activity_footnote')}</span>
  </footer>
</main>

<style>
  /* template/src/activity.css, the Activity screen's half (the topbar indicator is ActivityIndicator). */
  .fla {
    flex: 1;
    min-width: 0;
    padding: 32px 36px 48px;
    color: var(--fl-text);
  }
  .fla-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 20px;
    max-width: 900px;
  }
  /* styles.css `.eyebrow`. */
  .eyebrow {
    margin: 0 0 8px;
    font-size: var(--fl-font-micro);
    letter-spacing: 1.2px;
    text-transform: uppercase;
    color: var(--fl-muted);
  }
  h1 {
    margin: 0 0 4px;
    font-size: 28px;
    font-weight: 600;
    letter-spacing: -0.6px;
    line-height: 1.3;
  }
  .fla-summary {
    color: var(--fl-muted);
    font-size: 13px;
    margin: 0;
  }
  .fla-head-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding-top: 6px;
  }
  .fla-filters {
    display: inline-flex;
    gap: 2px;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    padding: 2px;
  }
  /* The prototype's 30px segments keep the 44px/48px floor from tokens.css. */
  .fla-filters button {
    padding: 0 12px;
    border-radius: var(--fl-radius);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    display: inline-flex;
    gap: 6px;
    align-items: center;
    white-space: nowrap;
  }
  .fla-filters button:hover {
    color: var(--fl-text);
  }
  .fla-filters button.is-on {
    background: var(--fl-panel);
    color: var(--fl-text);
    box-shadow: var(--fl-shadow-1);
  }
  .fla-filters b {
    font-weight: 500;
    /* 10px in the prototype; the type scale stops at 11px. */
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
    background: var(--fl-canvas);
    padding: 0 6px;
    border-radius: var(--fl-radius-pill);
    line-height: 1.6;
  }
  .fla-offline {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: var(--fl-raised);
    border-left: 3px solid var(--fl-warning);
    border-radius: 0 6px 6px 0;
    font-size: var(--fl-font-small);
    margin-bottom: 16px;
    max-width: 900px;
    flex-wrap: wrap;
  }
  .fla-offline > :global(svg) {
    color: var(--fl-warning);
  }
  .grow {
    flex: 1;
  }
  .fla-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: 900px;
  }
  .fla-job {
    display: grid;
    grid-template-columns: 112px minmax(0, 1fr) auto;
    gap: 16px;
    align-items: center;
    padding: 14px 16px;
    background: var(--fl-panel);
    border-radius: var(--fl-radius-card);
    border: 1px solid transparent;
  }
  :global([data-theme='light']) .fla-job {
    border-color: var(--fl-border);
  }
  .fla-thumb {
    width: 112px;
    aspect-ratio: 16 / 10;
    border-radius: 6px;
    overflow: hidden;
    background: var(--fl-raised);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fl-muted);
    position: relative;
  }
  .fla-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .fla-body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .fla-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .fla-chip {
    font-size: var(--fl-font-micro);
    padding: 2px 8px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    color: var(--fl-muted);
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .fla-chip--info {
    color: var(--fl-teal);
  }
  .fla-chip--success {
    color: var(--fl-accent);
  }
  .fla-chip--warning {
    color: var(--fl-warning);
  }
  .fla-chip--danger {
    color: var(--fl-danger);
  }
  .fla-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    animation: fla-pulse 1.2s ease-in-out infinite;
  }
  @keyframes fla-pulse {
    50% {
      opacity: 0.3;
    }
  }
  /* A disabled control that still explains itself (RunningJobsSection's pattern). */
  .fla-disabled {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: transparent;
    color: var(--fl-muted);
    font: inherit;
    font-size: var(--fl-font-small);
    opacity: 0.55;
    cursor: not-allowed;
  }
  /* Reduce Motion: the pulsing dot, the moving bar and the width glide stop (tokens.json motion). */
  @media (prefers-reduced-motion: reduce) {
    .fla-dot,
    .fla-progress.is-indeterminate > span {
      animation: none;
    }
    .fla-progress > span {
      transition: none;
    }
  }
  .fla-meta,
  .fla-status {
    margin: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .fla-meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fla-status {
    font-variant-numeric: tabular-nums;
  }
  .fla-error {
    color: var(--fl-danger);
  }
  .fla-progress {
    height: 6px;
    border-radius: 3px;
    background: var(--fl-raised);
    overflow: hidden;
  }
  .fla-progress > span {
    display: block;
    height: 100%;
    background: var(--fl-teal);
    border-radius: 3px;
    transition: width 700ms linear;
  }
  /* The server does not always know a total; a bar that moves says "working" without guessing. */
  .fla-progress.is-indeterminate > span {
    width: 30%;
    animation: fla-indeterminate 1.4s ease-in-out infinite;
  }
  @keyframes fla-indeterminate {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(340%);
    }
  }
  .fla-job.is-success .fla-progress > span {
    background: var(--fl-accent);
  }
  .fla-job.is-warning .fla-progress > span {
    background: var(--fl-warning);
  }
  .fla-job.is-danger .fla-progress > span {
    background: var(--fl-danger);
  }
  .fla-job.is-neutral .fla-progress > span {
    background: var(--fl-muted);
  }
  .fla-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .fla-empty {
    text-align: center;
    padding: 48px 20px 40px;
    color: var(--fl-muted);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    max-width: 900px;
    margin: 0;
  }
  .fla-empty h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--fl-text);
  }
  .fla-empty p {
    margin: 0;
    max-width: 420px;
  }
  .fla-footer {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 28px;
    max-width: 900px;
    flex-wrap: wrap;
    font-size: var(--fl-font-small);
  }
  .muted {
    color: var(--fl-muted);
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
  @media (max-width: 700px) {
    .fla {
      padding: 20px 16px 40px;
    }
    .fla-job {
      grid-template-columns: 84px minmax(0, 1fr);
      padding: 12px;
    }
    .fla-thumb {
      width: 84px;
    }
    .fla-actions {
      grid-column: 1 / -1;
      justify-content: flex-start;
    }
    .fla-head-actions {
      width: 100%;
    }
    .fla-filters {
      flex: 1;
    }
    .fla-filters button {
      flex: 1;
      justify-content: center;
      padding: 0 8px;
    }
  }
</style>
