<script lang="ts">
  import type { Translations } from 'svelte-i18n';
  import { goto } from '$app/navigation';
  import CloudGpuUpgrade from '$lib/components/frameleaf/cloud/CloudGpuUpgrade.svelte';
  import StudioRenderProgress from '$lib/components/frameleaf/StudioRenderProgress.svelte';
  import SpokenWordsActivity from '$lib/components/frameleaf/SpokenWordsActivity.svelte';
  import ActivityLeftOver from '$lib/components/frameleaf/ActivityLeftOver.svelte';
  import ActivityScanStopped from '$lib/components/frameleaf/ActivityScanStopped.svelte';
  import ActivityWorkArrivals from '$lib/components/frameleaf/ActivityWorkArrivals.svelte';
  import ActivityWorkFeatures from '$lib/components/frameleaf/ActivityWorkFeatures.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import EmptyState from '$lib/components/frameleaf/EmptyState.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import {
    ACTIVITY_FILTERS,
    ACTIVITY_PROGRESS_STAGES,
    ACTIVITY_STAGE_HINT_KEYS,
    ACTIVITY_STAGE_KEYS,
    activityCompletion,
    activityCounts,
    activityStatusText,
    buildActivityList,
    buildFinishedRows,
    formatActivityDuration,
    formatFinishedTime,
    isProgressStage,
    isShownAsCloudWork,
    isUnfinishedCloudWork,
    matchesActivityFilter,
    type ActivityFilter,
    type ActivityFinishedRow,
    type ActivityItem,
  } from '$lib/frameleaf/activity';
  import { activitySession } from '$lib/frameleaf/activity-session.svelte';
  import { buildArrivals } from '$lib/frameleaf/arrivals';
  import {
    activityWorkStatus,
    buildBackgroundWorkCards,
    buildWorkFeatureRows,
    leftOverRuns,
    otherWorkCards,
    tonightLabel,
    workEtaSeconds,
  } from '$lib/frameleaf/background-work';
  import { cloudWorkSession } from '$lib/frameleaf/cloud-work-session.svelte';
  import { cloudCostFacts } from '$lib/frameleaf/cloud-jobs';
  import { JOB_QUEUES, jobQueue } from '$lib/frameleaf/job-queues';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { runningJobsSession } from '$lib/frameleaf/running-jobs-session.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import '$lib/frameleaf/tokens.css';
  import type { WorkFeature } from '$lib/frameleaf/work-features';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { downloadManager } from '$lib/managers/download-manager.svelte';
  import { studioBundleDownloadPath } from '$lib/frameleaf/studio/bundles';
  import { Route } from '$lib/route';
  import { uploadAssetsStore } from '$lib/stores/upload';
  import { downloadUrl, getAssetMediaUrl } from '$lib/utils';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    getBaseUrl,
    getStudioBundleOperation,
    scanLibrary,
    updateQueue,
    type QueueName,
  } from '@frameleaf/sdk';
  import { Icon, Theme, themeManager } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiAutoFix,
    mdiCancel,
    mdiCheckAll,
    mdiCheckCircle,
    mdiCheckCircleOutline,
    mdiClose,
    mdiCogOutline,
    mdiDownloadOutline,
    mdiExportVariant,
    mdiImageMultipleOutline,
    mdiLockAlertOutline,
    mdiMovieEditOutline,
    mdiPause,
    mdiPauseCircleOutline,
    mdiPlay,
    mdiProgressClock,
    mdiRefresh,
    mdiUploadOutline,
    mdiWeatherNight,
    mdiWifi,
    mdiWifiOff,
  } from '@mdi/js';
  import { onMount, untrack } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  /**
   * The Activity page (FL-104), ported from the prototype's `Processing` screen
   * (template/src/Activity.jsx and activity.css, FL-43).
   *
   * UI review 2026-11-10, A1 (FL-1388; prototype `ActivityWorkV3.jsx`): the page opens on one sentence
   * about how the work is going, with Pause all; then what needs a look (failures, as cards with their
   * reason and Retry), what is in progress (the server's work by feature, then the viewer's own jobs),
   * and what finished, one line each, with runs of the same job on one line.
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

  // FL-164: an administrator sees the server's cloud backup operations and restores in progress as
  // read-only background work, not among their own jobs; finished, they list here. FL-162: that work is
  // the last group of the In progress section (prototype Activity.jsx), so the section counts it too.
  const isAdmin = $derived(authManager.authenticated && authManager.user.isAdmin);
  /** The top-bar indicator reads the same cloud status, so both count the same runs. */
  const cloudWork = $derived(isAdmin ? cloudWorkSession.rows : []);
  $effect(() => {
    if (isAdmin) {
      return untrack(() => cloudWorkSession.watch());
    }
  });
  const allItems = $derived(
    buildActivityList({
      operations: activitySession.operations,
      uploads: $uploadAssetsStore,
      downloads: [...downloadManager.assets.entries()],
      bulk: librarySession.session.operations,
    }),
  );
  const cloudWorkIds = $derived(new Set(cloudWork.map((row) => row.operationId)));
  const items = $derived(allItems.filter((item) => !isShownAsCloudWork(item, cloudWorkIds)));
  /** A cloud operation the status has not caught up with yet: ask now rather than at the next slow poll. */
  const cloudWorkBehind = $derived(
    isAdmin && allItems.some((item) => isUnfinishedCloudWork(item) && !isShownAsCloudWork(item, cloudWorkIds)),
  );
  $effect(() => {
    if (cloudWorkBehind) {
      void cloudWorkSession.refresh();
    }
  });
  const counts = $derived(activityCounts(items));
  const visible = $derived(items.filter((item) => matchesActivityFilter(item, filter)));
  /* FL-162, prototype Activity.jsx: In progress, the viewer's own jobs grouped by stage in the order they run. */
  const inProgress = $derived(visible.filter((item) => isProgressStage(item.stage)));
  /* FL-1388: what ended well is one line each; everything else that ended keeps its card, reason and Retry. */
  const ended = $derived(visible.filter((item) => !isProgressStage(item.stage)));
  const finishedRows = $derived(buildFinishedRows(ended));
  const needsLook = $derived(ended.filter((item) => !matchesActivityFilter(item, 'done')));
  /** What the Done chip counts whatever the filter: lines, not runs. */
  const finishedCount = $derived(buildFinishedRows(items.filter((item) => !isProgressStage(item.stage))).length);
  /**
   * SHARING-P1: the server's busy kinds of work, one card each (prototype `BackgroundRow`). The
   * server sends queues and runs to administrators only. The notifications panel no longer lists
   * them (SHELL-P1), so this page watches the running-jobs summary itself.
   */
  const serverWork = $derived(buildBackgroundWorkCards(runningJobsSession.summary));
  const busyServer = $derived(serverWork.length + cloudWork.length);
  /** FL-1388: the same work as people know it, one row for each feature of Settings › Background work. */
  const features = $derived(buildWorkFeatureRows(serverWork));
  /** FL-1459: the same work by what came in: an upload from a phone, a folder scan, an import. */
  const arrivals = $derived(buildArrivals(runningJobsSession.summary));
  /**
   * The prototype opens on "By what came in"; with nothing come in, on the features at work. The viewer's own choice
   * is kept for the next visit.
   */
  const WORK_VIEW_KEY = 'frameleaf.activity.workView';
  type WorkView = 'arrival' | 'feature';
  const readWorkView = (): WorkView | null => {
    try {
      const stored = localStorage.getItem(WORK_VIEW_KEY);
      return stored === 'arrival' || stored === 'feature' ? stored : null;
    } catch {
      return null;
    }
  };
  let chosenView = $state<WorkView | null>(readWorkView());
  const workView = $derived<WorkView>(chosenView ?? (arrivals.length > 0 ? 'arrival' : 'feature'));
  const chooseWorkView = (value: string) => {
    const view: WorkView = value === 'feature' ? 'feature' : 'arrival';
    chosenView = view;
    try {
      localStorage.setItem(WORK_VIEW_KEY, view);
    } catch {
      // The choice lasts for this visit only.
    }
  };

  /**
   * FL-1409: finished work that left photos over. Recent work says "312 photos need a look" for it, so this page
   * counts it too and never says "Everything is up to date" beside that card. Shown under All and Needs a look.
   */
  const allLeftOver = $derived(leftOverRuns(runningJobsSession.summary));
  const leftOver = $derived(filter === 'all' || filter === 'failed' ? allLeftOver : []);
  const leftOverCount = $derived(allLeftOver.length);
  /** Pausing the server's work is an administrator's: the server says who may, and sends its work to nobody else. */
  const canManage = $derived(runningJobsSession.summary.canManageQueues);
  /** In progress shows under All and In progress (the `running` filter). */
  const showProgress = $derived(filter === 'all' || filter === 'running');
  const backgroundCount = $derived(showProgress ? busyServer : 0);
  /** The server's work shows, by what came in or by feature, whenever there is any. */
  const showServerWork = $derived(backgroundCount > 0 || (showProgress && arrivals.length > 0));
  /** A chip counts what its filter shows: background work under All and In progress, and finished lines, not runs. */
  const chipCount = (name: ActivityFilter) =>
    name === 'done'
      ? finishedCount
      : name === 'failed'
        ? counts.failed + leftOverCount
        : (name === 'all' ? counts.all - counts.done + finishedCount + leftOverCount : counts.running) + busyServer;
  const hasFinished = $derived(items.some((item) => item.canDismiss));

  /** The one sentence the page opens on (prototype `summaryFor`): how the work is going, most urgent first. */
  /** A run that is no feature's task (FL-1177: a held import): it has a row of its own, and counts as work. */
  const otherWork = $derived(otherWorkCards(serverWork));
  /** Work in progress that is not a feature's: the viewer's own jobs, cloud backups or restores, and those runs. */
  const otherMoving = $derived(counts.running + cloudWork.length + otherWork.length);
  /** The first answers are not in yet: the page does not know how the work is going, so it does not say. */
  const settling = $derived(activitySession.loading || runningJobsSession.loading);
  /** A read failed, so "up to date" would be a guess about numbers that may be old. */
  const stale = $derived(
    activitySession.unreachable || runningJobsSession.unreachable || (isAdmin && cloudWorkSession.unreachable),
  );
  const status = $derived.by(() => {
    const known = activityWorkStatus({
      rows: features,
      needsLook: counts.failed + leftOverCount,
      jobs: otherMoving,
    });
    return known === 'idle' && stale ? 'unread' : known;
  });
  /**
   * FL-1412 (M13): nothing is running, nothing finished and nothing needs a look, so the page is its
   * empty state: no filters, no status line, no empty section. `status` is idle only under the run rules
   * Recent work uses (FL-1409), so a run that left photos over, is paused or waits for a drive never
   * reads as "Everything is up to date"; nor does a page whose numbers may be old.
   */
  const allQuiet = $derived(
    filter === 'all' &&
      !settling &&
      status === 'idle' &&
      items.length === 0 &&
      busyServer === 0 &&
      leftOverCount === 0 &&
      arrivals.length === 0,
  );
  const banner = $derived.by(() => {
    const left = features.reduce((sum, row) => sum + row.left, 0);
    switch (status) {
      case 'paused': {
        return {
          warn: true,
          icon: mdiPauseCircleOutline,
          title: $t('frameleaf_bgwork_all_paused'),
          body: $t('frameleaf_bgwork_all_paused_body'),
        };
      }
      case 'attention': {
        return {
          warn: true,
          icon: mdiAlertCircleOutline,
          title: $t('frameleaf_activity_work_attention', { values: { count: counts.failed + leftOverCount } }),
          body: $t('frameleaf_activity_work_attention_body'),
        };
      }
      case 'working': {
        const eta = workEtaSeconds(runningJobsSession.summary);
        return {
          warn: false,
          icon: mdiProgressClock,
          title: $t('frameleaf_bgwork_working', { values: { count: left } }),
          body:
            eta === null
              ? $t('frameleaf_activity_work_working_body')
              : $t('frameleaf_activity_work_working_eta', {
                  values: { time: formatActivityDuration(eta, $locale ?? undefined) },
                }),
        };
      }
      case 'unread': {
        return {
          warn: true,
          icon: mdiAlertCircleOutline,
          title: $t('frameleaf_computers_cover_unknown'),
          body: $t('frameleaf_computers_unread'),
        };
      }
      case 'tonight': {
        const saved = features.filter((row) => row.state === 'tonight');
        const starts = saved.flatMap((row) => (row.tonight?.startsAt ? [row.tonight.startsAt] : [])).sort();
        return {
          warn: false,
          icon: mdiWeatherNight,
          title: tonightLabel(starts[0] ?? null, $t, $locale ?? undefined),
          body: $t('frameleaf_activity_work_tonight_body', {
            values: {
              count: saved.reduce((sum, row) => sum + row.left, 0),
              features: new Intl.ListFormat($locale ?? undefined, { type: 'conjunction' }).format(
                saved.map((row) => $t(`frameleaf_work_feature_${row.feature.id}` as Translations)),
              ),
            },
          }),
        };
      }
      case 'jobs': {
        return {
          warn: false,
          icon: mdiProgressClock,
          title: $t('frameleaf_activity_work_jobs', { values: { count: otherMoving } }),
          body: $t('frameleaf_activity_work_jobs_body'),
        };
      }
      default: {
        return {
          warn: false,
          icon: mdiCheckCircleOutline,
          title: $t('frameleaf_activity_work_idle'),
          body: $t('frameleaf_activity_work_idle_body'),
        };
      }
    }
  });

  /**
   * Pause all, and a feature's own pause (prototype `ActivityWorkV3.jsx`). Each is the same request Settings ›
   * Background work sends, for every task that can pause: nothing new starts, and what is running finishes.
   * The rows change when the server's next answer says so, never before.
   */
  let pausing = $state(false);
  const setPaused = async (names: readonly QueueName[], isPaused: boolean, said: string) => {
    pausing = true;
    try {
      for (const name of names) {
        await updateQueue({ name, queueUpdateDto: { isPaused } });
      }
      announcement = said;
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      pausing = false;
      await runningJobsSession.refresh();
    }
  };
  const pauseAll = (isPaused: boolean) =>
    void setPaused(
      JOB_QUEUES.filter((queue) => queue.canPause).map((queue) => queue.name),
      isPaused,
      $t(isPaused ? 'frameleaf_activity_work_paused_all' : 'frameleaf_activity_work_resumed_all'),
    );
  const pauseFeature = (feature: WorkFeature, isPaused: boolean) =>
    void setPaused(
      feature.queues.filter((name) => jobQueue(name)?.canPause),
      isPaused,
      $t(isPaused ? 'frameleaf_activity_pause_requested' : 'frameleaf_activity_resumed', {
        values: { name: $t(`frameleaf_work_feature_${feature.id}` as Translations) },
      }),
    );

  onMount(() => activitySession.watch());
  onMount(() => runningJobsSession.watch());

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

  /**
   * A Finished line's short result: the kind of work, how many times it ran, and how it ended where that says
   * more than the tick does ("Done in 3 minutes · 12 MB", "Cancelled at 40%"). Work that left this server
   * says where it ran, so cloud work is never implicit.
   */
  const finishedDetail = ({ item, count }: ActivityFinishedRow) => {
    const kind = $t(item.kindKey);
    const result = item.bulk ? $t('frameleaf_activity_bulk_counts', { values: item.bulk }) : statusLine(item);
    return [
      kind === nameOf(item) ? null : kind,
      item.destinationKey && item.destinationKey !== 'frameleaf_activity_destination_local'
        ? $t(item.destinationKey)
        : null,
      ...item.details,
      count > 1 ? $t('frameleaf_activity_finished_times', { values: { count } }) : null,
      item.stage === 'done' && result === $t(item.statusKey) ? null : result,
      item.browserLocal ? $t('frameleaf_activity_this_tab_only') : null,
    ]
      .filter(Boolean)
      .join(' · ');
  };

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
      replace: true,
      reset: false,
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

  /**
   * FL-1409: start an interrupted scan again. The scan checks its folders and the library's owner first, as from
   * Libraries; the stopped one is then cleared, and the new one shows under In progress. If only the clearing
   * fails, the scan has still started: that is said by itself, and Not now can clear the card.
   */
  const scanAgain = (item: ActivityItem, libraryId: string) =>
    void run(
      item,
      async () => {
        await scanLibrary({ id: libraryId });
        try {
          await activitySession.dismiss(item.operationId as string);
        } catch (error) {
          handleError(error, $t('frameleaf_activity_scan_again_not_cleared'));
        }
        await activitySession.refresh();
      },
      'frameleaf_activity_scan_again_started',
    );

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
      // A bulk change this tab started is a record of the library session, not a server job.
      for (const item of items) {
        if (item.source === 'bulk' && item.canDismiss) {
          dismiss(item);
        }
      }
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
    <div class="fla-head-text">
      <p class="eyebrow">{$t('frameleaf_activity_eyebrow')}</p>
      <h1 id="fl-activity-title">{$t('frameleaf_activity_title')}</h1>
      <p class="fla-intro">{$t('frameleaf_activity_intro')}</p>
    </div>

    {#if !allQuiet}
      <div class="fla-head-actions">
        <div class="fla-filters" role="group" aria-label={$t('frameleaf_activity_filter_group')}>
          {#each ACTIVITY_FILTERS as name (name)}
            <button
              type="button"
              class="fl-control"
              class:is-on={filter === name}
              aria-pressed={filter === name}
              onclick={() => setFilter(name)}
            >
              {$t(`frameleaf_activity_filter_${name}`)}
              {#if chipCount(name) > 0}
                <b aria-hidden="true">{chipCount(name)}</b>
                <span class="sr-only"
                  >{$t('frameleaf_activity_filter_count', { values: { count: chipCount(name) } })}</span
                >
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
    {/if}
  </header>

  <SpokenWordsActivity />

  {#if activitySession.unreachable}
    <div class="fla-offline" role="status">
      <Icon icon={mdiWifiOff} size="1.125rem" aria-hidden={true} />
      <span>{$t('frameleaf_activity_offline')}</span>
      <span class="grow"></span>
      <Button disabled={retrying} onclick={() => void tryAgain()}>
        <Icon icon={mdiWifi} size="1.125rem" aria-hidden={true} />{$t('frameleaf_activity_reconnect')}
      </Button>
    </div>
  {:else if isAdmin && (runningJobsSession.unreachable || cloudWorkSession.unreachable)}
    <!-- Background work keeps its last numbers when a read fails; say they may be out of date. -->
    <div class="fla-offline" role="status">
      <Icon icon={mdiWifiOff} size="1.125rem" aria-hidden={true} />
      <span>{$t('frameleaf_activity_background_stale')}</span>
    </div>
  {/if}

  <!-- The page's answer (prototype `.fw3-status`): how the work is going, Pause all, and its settings. -->
  {#if allQuiet}
    <EmptyState
      icon={mdiCheckCircleOutline}
      title={$t('frameleaf_activity_work_idle')}
      message={$t(isAdmin ? 'frameleaf_activity_work_quiet' : 'frameleaf_activity_empty_help_own')}
    />
  {:else if !(settling && status === 'idle')}
    <section class="fw3-status" class:is-warn={banner.warn} aria-label={$t('frameleaf_activity_work_status')}>
      <Icon icon={banner.icon} size="28" aria-hidden={true} />
      <div class="fw3-status-text">
        <h2>{banner.title}</h2>
        <p>{banner.body}</p>
      </div>
      {#if canManage}
        <div class="fw3-status-actions">
          {#if status === 'paused'}
            <Button variant="primary" disabled={pausing} onclick={() => pauseAll(false)}>
              <Icon icon={mdiPlay} size="1.125rem" aria-hidden={true} />{$t('resume')}
            </Button>
          {:else if serverWork.length > 0}
            <Button disabled={pausing} onclick={() => pauseAll(true)}>
              <Icon icon={mdiPause} size="1.125rem" aria-hidden={true} />{$t('frameleaf_activity_work_pause_all')}
            </Button>
          {/if}
          <IconButton
            variant="default"
            href={commandCenterUrl('processing', 'queues')}
            label={$t('frameleaf_activity_work_settings')}
          >
            <Icon icon={mdiCogOutline} size="1.125rem" />
          </IconButton>
        </div>
      {/if}
    </section>
  {/if}

  {#if activitySession.loading && items.length === 0}
    <p class="fla-empty" role="status" aria-busy="true">{$t('loading')}</p>
  {:else if !showProgress && visible.length + leftOver.length === 0}
    <EmptyState
      icon={filter === 'failed' ? mdiCheckCircleOutline : mdiProgressClock}
      title={filter === 'done' ? $t('frameleaf_activity_empty_done') : undefined}
      message={$t(filter === 'done' ? 'frameleaf_activity_empty_help_finished' : 'frameleaf_activity_empty_failed')}
    />
  {/if}

  <!-- A job in progress, or one that failed. Its title is one level below the heading it sits under. -->
  {#snippet card(item: ActivityItem, index: number, level: 'h3' | 'h4')}
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
          <svelte:element this={level} class="fla-name" id="{rowIdPrefix}-job-{index}">{nameOf(item)}</svelte:element>
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

        {#if item.cloud}
          <!-- FL-162: a Frameleaf Cloud job's model and cost (prototype CloudCost). -->
          <dl class="fla-cost" aria-label={$t('frameleaf_activity_cloud_cost')}>
            {#each cloudCostFacts(item.cloud, item.stage) as fact (fact.labelKey)}
              <div>
                <dt>{$t(fact.labelKey)}</dt>
                <dd>{fact.valueKey ? $t(fact.valueKey) : fact.value}</dd>
              </div>
            {/each}
          </dl>
        {/if}

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
          {#if item.scan === 'resuming'}
            <!-- FL-1409: a restart is said in plain words; the server's own message is not shown for it. -->
            · {$t('frameleaf_activity_scan_resuming')}
          {:else if (item.failed || item.statusKey === 'frameleaf_activity_status_retrying') && item.error}
            · <span class="fla-error">{item.error}</span>
          {/if}
        </p>
        <!-- Only while it works: a queued, done or failed export shows its outcome in the status line (FL-1120). -->
        {#if item.renderProgress && item.running && (item.stage === 'starting' || item.stage === 'running')}
          <StudioRenderProgress
            progress={item.renderProgress}
            startedAt={item.renderStartedAt}
            online={!activitySession.unreachable}
          />
        {/if}
        {#if item.cloud && item.stage === 'starting'}
          <p class="fla-status">
            {$t('frameleaf_activity_cloud_start_note', { values: { workers: item.cloud.plannedWorkers } })}
          </p>
        {/if}
        {#if item.bulk && item.bulk.retried > 0}
          <p class="fla-status">{$t('frameleaf_activity_bulk_retried', { values: { count: item.bulk.retried } })}</p>
        {/if}
        {#if item.encryptedWithOlderKey}
          <!-- some restored items can't be opened here: a warning, not a status -->
          <p class="fla-warn" role="note">
            <Icon icon={mdiLockAlertOutline} size="16" aria-hidden={true} />
            <span>{$t('frameleaf_le_activity_older_key', { values: { count: item.encryptedWithOlderKey } })}</span>
          </p>
        {/if}
      </div>

      <div class="fla-actions">
        {#if item.cloud?.routing?.upgradeAvailable && !item.finished && item.operationId}
          <CloudGpuUpgrade operationId={item.operationId} />
        {/if}
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
          <!-- Shown disabled with its reason rather than hidden; focusable so the reason can be
               read aloud. -->
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
        {#if item.projectId}
          <Button onclick={() => openInStudio(item)}>
            <Icon icon={mdiMovieEditOutline} size="1.125rem" aria-hidden={true} />{$t(
              'frameleaf_activity_open_in_studio',
            )}
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
  {/snippet}

  {#if needsLook.length + leftOver.length > 0}
    <section class="fla-section" aria-labelledby="{rowIdPrefix}-needs-look">
      <h2 id="{rowIdPrefix}-needs-look" class="fla-section-title">
        {$t('frameleaf_activity_section_needs_look')}
        <span class="fla-count">{needsLook.length + leftOver.length}</span>
      </h2>
      <div class="fla-list">
        {#each needsLook as item (item.id)}
          {#if item.scan === 'interrupted' || item.scan === 'drive'}
            <ActivityScanStopped
              {item}
              busy={busyId === item.id}
              onScanAgain={(libraryId) => scanAgain(item, libraryId)}
              onDismiss={() => dismiss(item)}
            />
          {:else}
            {@render card(item, visible.indexOf(item), 'h3')}
          {/if}
        {/each}
        <ActivityLeftOver runs={leftOver} onChanged={() => void runningJobsSession.refresh()} />
      </div>
    </section>
  {/if}

  {#if showProgress && !allQuiet && !(activitySession.loading && items.length === 0)}
    <section class="fla-section" aria-labelledby="{rowIdPrefix}-in-progress">
      <div class="fla-heading-row">
        <h2 id="{rowIdPrefix}-in-progress" class="fla-section-title">
          {$t('frameleaf_activity_section_in_progress')}
        </h2>
        {#if showServerWork}
          <SegmentedControl
            label={$t('frameleaf_activity_view')}
            options={[
              { value: 'arrival', label: $t('frameleaf_activity_view_arrival') },
              { value: 'feature', label: $t('frameleaf_activity_view_feature') },
            ]}
            value={workView}
            onChange={chooseWorkView}
          />
        {/if}
      </div>
      {#if showServerWork && workView === 'arrival'}
        <ActivityWorkArrivals {arrivals} viewerId={authManager.authenticated ? authManager.user.id : null} />
      {:else if showServerWork}
        <!-- Every feature while any of them is busy, so what is up to date shows beside what is not. -->
        <ActivityWorkFeatures
          rows={serverWork.length > 0 ? features : []}
          others={otherWork}
          cloudStatus={isAdmin ? cloudWorkSession.status : null}
          canPause={canManage}
          busy={pausing}
          onPause={pauseFeature}
        />
      {/if}
      {#each ACTIVITY_PROGRESS_STAGES as stage (stage)}
        {@const group = inProgress.filter((item) => item.stage === stage)}
        {#if group.length > 0}
          <div class="fla-group" role="group" aria-labelledby="{rowIdPrefix}-stage-{stage}">
            <h3 id="{rowIdPrefix}-stage-{stage}" class="fla-group-title">
              {$t(ACTIVITY_STAGE_KEYS[stage])}
              <span class="fla-count">{group.length}</span>
              <span class="fla-group-hint">{$t(ACTIVITY_STAGE_HINT_KEYS[stage])}</span>
            </h3>
            <div class="fla-list">
              {#each group as item (item.id)}
                {@render card(item, visible.indexOf(item), 'h4')}
              {/each}
            </div>
          </div>
        {/if}
      {/each}
      {#if inProgress.length === 0 && !showServerWork}
        <!-- Only administrators see the server's background work here. -->
        <p class="fw3-quiet">
          {$t(isAdmin ? 'frameleaf_activity_work_quiet' : 'frameleaf_activity_empty_help_own')}
        </p>
      {/if}
    </section>
  {/if}

  {#if finishedRows.length > 0}
    <section class="fla-section" aria-labelledby="{rowIdPrefix}-finished">
      <h2 id="{rowIdPrefix}-finished" class="fla-section-title">{$t('frameleaf_activity_section_finished')}</h2>
      <ul class="fw3-finished">
        {#each finishedRows as row (row.id)}
          {@const item = row.item}
          {@const name = nameOf(item)}
          <li>
            <span class="fw3-finished-icon" class:is-cancelled={item.stage === 'cancelled'} aria-hidden="true">
              <Icon icon={item.stage === 'cancelled' ? mdiCancel : mdiCheckCircle} size="16" />
            </span>
            <strong>{name}</strong>
            <span class="fw3-finished-detail">{finishedDetail(row)}</span>
            <span class="fw3-finished-end">
              {#if item.studioBundle === 'export'}
                <button type="button" class="fw3-link" onclick={() => void downloadBundle(item)}
                  >{$t('frameleaf_studio_bundle_download')}</button
                >
              {:else if item.studioBundle === 'import'}
                <button type="button" class="fw3-link" onclick={() => void openImportedProject(item)}
                  >{$t('frameleaf_studio_library_open')}</button
                >
              {/if}
              {#if item.projectId}
                <button type="button" class="fw3-link" onclick={() => openInStudio(item)}
                  >{$t('frameleaf_activity_open_in_studio')}</button
                >
              {/if}
              {#if item.assetId && item.stage === 'done'}
                <button
                  type="button"
                  class="fw3-link"
                  aria-label={$t('frameleaf_activity_open_result_of', { values: { name } })}
                  onclick={() => openResult(item)}>{$t('frameleaf_activity_open_result')}</button
                >
              {/if}
              {#if item.canRetry}
                <button
                  type="button"
                  class="fw3-link"
                  disabled={busyId === item.id}
                  aria-label={$t('frameleaf_activity_retry_of', { values: { name } })}
                  onclick={() => retry(item)}>{$t('retry')}</button
                >
              {/if}
              {#if row.at}
                <time datetime={new Date(row.at).toISOString()}>{formatFinishedTime(row.at, $locale ?? undefined)}</time
                >
              {/if}
            </span>
            {#if item.cloud}
              <!-- FL-162: what a Frameleaf Cloud job cost, settled. -->
              <dl class="fla-cost" aria-label={$t('frameleaf_activity_cloud_cost')}>
                {#each cloudCostFacts(item.cloud, item.stage) as fact (fact.labelKey)}
                  <div>
                    <dt>{$t(fact.labelKey)}</dt>
                    <dd>{fact.valueKey ? $t(fact.valueKey) : fact.value}</dd>
                  </div>
                {/each}
              </dl>
            {/if}
            {#if item.bulk && item.bulk.retried > 0}
              <p class="fla-status">
                {$t('frameleaf_activity_bulk_retried', { values: { count: item.bulk.retried } })}
              </p>
            {/if}
            {#if item.encryptedWithOlderKey}
              <!-- some restored items can't be opened here: a warning, not a status -->
              <p class="fla-warn" role="note">
                <Icon icon={mdiLockAlertOutline} size="16" aria-hidden={true} />
                <span>{$t('frameleaf_le_activity_older_key', { values: { count: item.encryptedWithOlderKey } })}</span>
              </p>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <footer class="fla-footer">
    <span class="muted">{$t('frameleaf_activity_footnote')}</span>
  </footer>
</main>

<style>
  /* template/src/activity.css, the Activity screen's half (the topbar indicator is ActivityIndicator). */
  .fla {
    flex: 1;
    min-width: 0;
    /* With the page's own 8px, the prototype's 32px above the eyebrow. */
    padding: var(--fl-space-6) 36px 48px;
    color: var(--fl-text);
  }
  /* P4 (review-1030-shell.css): the filters sit on their own row, in line with the content. */
  .fla-head {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 16px;
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
    margin: 0 0 var(--fl-space-2);
    font-size: 28px;
    font-weight: 600;
    letter-spacing: -0.6px;
    line-height: 1.3;
  }
  .fla-head-text {
    min-width: 0;
  }
  /* activity.css `.fla-intro`: what the page is for, above the counts. */
  .fla-intro {
    margin: 0 0 6px;
    max-width: 560px;
    font-size: var(--fl-font-callout);
    line-height: 1.5;
    color: var(--fl-text);
  }
  .fla-head-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .fla-filters {
    display: inline-flex;
    /* At 44px segments the prototype's 2px and 12px read cramped (spacing review). */
    gap: var(--fl-space-1);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    padding: var(--fl-space-1);
  }
  /*
   * The segments keep the height floor from tokens.css (44px, 48px on touch); with a mouse they are
   * the prototype's 30px (activity.css `.fla-filters button`), FL-1390.
   */
  @media (pointer: fine) {
    .fla-filters button {
      min-height: calc(var(--fl-control-height) - 6px);
    }
  }
  .fla-filters button {
    padding: 0 var(--fl-space-4);
    border-radius: var(--fl-radius-control);
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
    border-inline-start: 3px solid var(--fl-warning);
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
  /* activity.css `.fw3-status`: the page's answer, with what to do about it. */
  .fw3-status {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-4);
    margin: 0 0 28px;
    padding: 18px 20px;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .fw3-status > :global(svg) {
    color: var(--fl-accent);
  }
  .fw3-status.is-warn {
    background:
      linear-gradient(
        color-mix(in srgb, var(--fl-warning) 14%, transparent),
        color-mix(in srgb, var(--fl-warning) 14%, transparent)
      ),
      var(--fl-panel);
    border-color: color-mix(in srgb, var(--fl-warning) 45%, var(--fl-border));
  }
  .fw3-status.is-warn > :global(svg) {
    color: var(--fl-warning);
  }
  .fw3-status h2 {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
  }
  .fw3-status p {
    margin: 2px 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .fw3-status-actions {
    display: flex;
    gap: var(--fl-space-2);
  }
  /* activity.css `.fw3-quiet`: nothing is in progress. */
  .fw3-quiet {
    margin: 0;
    padding: var(--fl-space-4);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    border: 1px dashed var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  /* activity.css `.fw3-finished`: one line per thing that finished, a rule between them. */
  .fw3-finished {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .fw3-finished li {
    display: grid;
    grid-template-columns: auto minmax(0, max-content) minmax(0, 1fr) auto;
    align-items: baseline;
    gap: 2px 10px;
    padding: 9px 2px;
    font-size: var(--fl-font-callout);
  }
  .fw3-finished li + li {
    border-top: 1px solid var(--fl-border);
  }
  .fw3-finished-icon {
    display: inline-flex;
    align-self: center;
    color: var(--fl-accent);
  }
  .fw3-finished-icon.is-cancelled {
    color: var(--fl-muted);
  }
  .fw3-finished strong {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fw3-finished-detail {
    color: var(--fl-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fw3-finished-end {
    display: inline-flex;
    align-items: baseline;
    gap: var(--fl-space-3);
    color: var(--fl-muted);
  }
  .fw3-finished time {
    font-size: var(--fl-font-small);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  /* What a line can't hold sits under it, in line with its name. */
  .fw3-finished li > :is(dl, p) {
    grid-column: 2 / -1;
  }
  .fw3-link {
    min-height: 0;
    padding: 0;
    color: var(--fl-accent);
    font: inherit;
    background: none;
    border: 0;
    cursor: pointer;
    white-space: nowrap;
  }
  .fw3-link:hover:not(:disabled) {
    text-decoration: underline;
  }
  .fw3-link:disabled {
    color: var(--fl-muted);
    cursor: default;
  }
  /* activity.css `.fw3`: the sections run the page's width; job cards keep their 900px measure (`.fla-list`). */
  .fla-section {
    margin-bottom: 28px;
  }
  /* The feature list, then the viewer's own jobs by stage. */
  .fla-section > :global(.fw3-features) {
    margin-bottom: var(--fl-space-4);
  }
  /* activity.css `.fw3-heading-row`: In progress and its view switch. */
  .fla-heading-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3);
    margin: 0 0 var(--fl-space-3);
  }
  .fla-heading-row .fla-section-title {
    margin: 0;
  }
  .fla-section-title {
    font-size: 15px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 var(--fl-space-3);
  }
  .fla-count {
    font-size: 11px;
    font-weight: 500;
    color: var(--fl-muted);
    background: var(--fl-raised);
    padding: 0 7px;
    border-radius: var(--fl-radius-pill);
    line-height: 1.7;
    font-variant-numeric: tabular-nums;
  }
  .fla-group {
    margin: 0 0 16px;
  }
  .fla-group-title {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 8px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--fl-muted);
    margin: 0 0 8px;
  }
  .fla-group-hint {
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
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
    border-radius: var(--fl-radius-sm);
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
  .fla-name {
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
  /* A disabled control that still explains itself. */
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
  .fla-warn {
    display: flex;
    align-items: flex-start;
    gap: var(--fl-space-2);
    margin: var(--fl-space-2) 0 0;
    padding: var(--fl-space-2) var(--fl-space-3);
    color: var(--fl-text);
    font-size: var(--fl-font-small);
    background: color-mix(in srgb, var(--fl-warning), transparent 88%);
    border-radius: var(--fl-radius-control);
  }
  .fla-warn :global(svg) {
    flex-shrink: 0;
    margin-top: 1px;
    color: var(--fl-warning);
  }
  /* Frameleaf Cloud cost facts on a job (activity.css) */
  .fla-cost {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    margin: 2px 0 6px;
    font-size: var(--fl-font-small);
    font-variant-numeric: tabular-nums;
  }
  .fla-cost div {
    display: flex;
    gap: 6px;
    min-width: 0;
  }
  .fla-cost dt {
    color: var(--fl-muted);
    white-space: nowrap;
  }
  .fla-cost dd {
    margin: 0;
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
    /* With the page's own 8px, the 16px phone gutter. */
    .fla {
      padding: var(--fl-space-2) var(--fl-space-2) 40px;
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
    .fw3-status {
      grid-template-columns: auto minmax(0, 1fr);
      padding: var(--fl-space-4);
    }
    .fw3-status-actions {
      grid-column: 1 / -1;
    }
    /* A finished line stacks: its name, then its result, then what to do with it and when. */
    .fw3-finished li {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .fw3-finished-detail,
    .fw3-finished-end {
      grid-column: 2;
      white-space: normal;
    }
    .fw3-finished-end {
      flex-wrap: wrap;
      align-items: center;
    }
    .fw3-link {
      min-height: var(--fl-control-height);
    }
    .fla-head-actions {
      width: 100%;
    }
    .fla-filters {
      flex: 1;
    }
    /* Each segment takes what its label and count need, then shares the rest, so "In progress 5" isn't squeezed. */
    .fla-filters button {
      flex: 1 1 auto;
      justify-content: center;
      padding: 0 8px;
    }
  }
</style>
