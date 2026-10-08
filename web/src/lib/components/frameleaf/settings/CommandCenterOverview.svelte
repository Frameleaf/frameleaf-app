<script lang="ts">
  /**
   * The Command Center's Overview (FL-71), the template's `Overview` in CommandCenter.jsx: the
   * library's scoped inventory, filesystem, latest database backup, version, growth, what needs
   * attention and a processing snapshot. Every value comes from an existing endpoint; what the
   * server does not measure is shown as not measured rather than invented.
   */
  import { page } from '$app/state';
  import BackupSummary from '$lib/components/frameleaf/cloud/BackupSummary.svelte';
  import AnalyticsChart from '$lib/components/frameleaf/analytics/AnalyticsChart.svelte';
  import CountUp from '$lib/components/frameleaf/CountUp.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { commandCenterUrl, type SettingsAreaId } from '$lib/frameleaf/settings-areas';
  import { formatBytes } from '$lib/frameleaf/physical-dedup';
  import { Route } from '$lib/route';
  import { jobQueue } from '$lib/frameleaf/job-queues';
  import { cloudGlance, gpuStudioState, mlEndpointState } from '$lib/frameleaf/overview-readiness';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import {
    AnalyticsRange,
    AnalyticsScopeKind,
    getAboutInfo,
    getAnalyticsReport,
    getBackupRestoreVerification,
    getMlWorkloadRoutes,
    getQueues,
    getRenderWorkerCompatibility,
    getStorage,
    listDatabaseBackups,
    listMlDestinations,
    type AnalyticsReportResponseDto,
    type BackupRestoreVerificationResponseDto,
    type MlDestinationResponseDto,
    type MlWorkloadRouteDto,
    type RenderWorkerCompatibilityResponseDto,
    type DatabaseBackupDto,
    type QueueName,
    type QueueResponseDto,
    type ServerAboutResponseDto,
    type ServerStorageResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiBackupRestore,
    mdiChevronRight,
    mdiCloudOutline,
    mdiDesktopTowerMonitor,
    mdiImageSearchOutline,
    mdiRefresh,
    mdiServerOutline,
  } from '@mdi/js';
  import { backupMoment } from '$lib/components/frameleaf/settings/backup-time';
  import { locale } from '$lib/stores/preferences.store';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';
  let report = $state<AnalyticsReportResponseDto>();
  let about = $state<ServerAboutResponseDto>();
  let storage = $state<ServerStorageResponseDto>();
  let queues = $state<QueueResponseDto[]>();
  let backups = $state<DatabaseBackupDto[]>();
  // CC-9: the readiness rows (CommandCenter.jsx:1790-1812, 1905-1935); each stays "Not measured" when unread.
  let restore = $state<BackupRestoreVerificationResponseDto>();
  let compatibility = $state<RenderWorkerCompatibilityResponseDto>();
  let ml = $state<{ destinations: MlDestinationResponseDto[]; routes: MlWorkloadRouteDto[] }>();
  let failed = $state(false);
  /** True while a snapshot is being read; the last one stays on screen until the next arrives. */
  let loading = $state(true);
  let retry = $state(0);
  const scope = $derived(page.url.searchParams.get('scope') ?? 'all');
  const failures = $derived(queues?.reduce((sum, queue) => sum + queue.statistics.failed, 0));
  const restoreDue = $derived(restore?.overdue === true);
  const workersDue = $derived(!!compatibility && compatibility.unavailable.length > 0);
  /** The "Needs your attention" items, counted for the health line (the template's "n things need attention"). */
  const attentionCount = $derived(
    failures === undefined && !restore && !compatibility
      ? undefined
      : (failures ? 1 : 0) + (restoreDue ? 1 : 0) + (workersDue ? 1 : 0),
  );
  const when = (value: string) => new Intl.DateTimeFormat($locale, { dateStyle: 'medium' }).format(new Date(value));
  const restoreDetail = $derived.by(() => {
    if (!restore) {
      return '';
    }
    if (!restore.metadataVerifiedAt && !restore.originalsVerifiedAt) {
      return $t('frameleaf_cc_attention_restore_never');
    }
    if (!restore.originalsVerifiedAt) {
      return $t('frameleaf_cc_attention_restore_originals');
    }
    if (!restore.metadataVerifiedAt) {
      return $t('frameleaf_cc_attention_restore_metadata');
    }
    const oldest = [restore.metadataVerifiedAt, restore.originalsVerifiedAt].sort()[0];
    return $t('frameleaf_cc_attention_restore_overdue', { values: { date: when(oldest), days: restore.intervalDays } });
  });
  const kindLabel = (kind: string) => $t(`frameleaf_render_workers_kind_${kind}` as Translations);
  const snapshotQueues = $derived(
    queues
      ?.filter((queue) => queue.statistics.active + queue.statistics.waiting + queue.statistics.failed > 0)
      .slice(0, 4) ?? [],
  );
  /** The newest backup by the moment it was made, whatever its file name starts with. */
  const latestBackup = $derived(
    backups
      ?.map((backup) => ({ filename: backup.filename, at: backupMoment(backup.filename, backup.timezone) }))
      .filter((backup) => backup.at)
      .sort((a, b) => a.at!.toMillis() - b.at!.toMillis())
      .at(-1),
  );
  /**
   * When the latest backup was made, in this device's time zone like Backups & restore shows it,
   * as a time and a date ("8:00 PM · Oct 6"). The file name stays in the tooltip.
   */
  const latestBackupTime = $derived.by(() => {
    const at = latestBackup?.at;
    if (!at) {
      return;
    }
    const part = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat($locale, options).format(at.toJSDate());
    return {
      time: part({ hour: 'numeric', minute: '2-digit' }),
      date: part({
        day: 'numeric',
        month: 'short',
        year: at.year === DateTime.now().year ? undefined : 'numeric',
      }),
    };
  });
  /** The storage percentage with the decimals the server reported, for the counting figure. */
  const percent = (value: number) => {
    const digits = (String(storage?.diskUsagePercentage ?? '').split('.', 2)[1] ?? '').length;
    return `${value.toFixed(Math.min(digits, 2))}%`;
  };
  const href = (area: SettingsAreaId, section?: string) => commandCenterUrl(area, section);
  /**
   * The storage key (CommandCenter.jsx:1839-1867): thumbnails & proxies, and database & other, read
   * the whole-server report's measured breakdown (FL-79). Before the nightly collector has measured
   * the generated folders both read "Not yet measured"; outside the whole-server scope, and when
   * the volume could not be read, they stay "Not measured".
   */
  const breakdown = $derived(report?.host.breakdown ?? null);
  const generatedMeasured = $derived(
    breakdown !== null && breakdown.previewsBytes !== null && breakdown.encodedVideoBytes !== null,
  );
  const storageValue = (bytes: () => number) =>
    breakdown === null
      ? $t('frameleaf_cc_unmeasured')
      : generatedMeasured
        ? formatBytes(bytes())
        : $t('frameleaf_cc_not_yet_measured');
  const storageNote = $derived(
    breakdown === null
      ? $t(
          report?.scopeKind === AnalyticsScopeKind.Host
            ? 'frameleaf_cc_storage_volume_unread'
            : 'frameleaf_cc_storage_whole_server',
        )
      : generatedMeasured
        ? breakdown.exceedsUsed || breakdown.onOtherDisk.length > 0
          ? $t('frameleaf_cc_storage_elsewhere')
          : $t('frameleaf_cc_storage_note')
        : $t('frameleaf_cc_storage_pending'),
  );
  /** A queue's title as the Job manager shows it. */
  const queueTitle = (name: QueueName) => {
    const definition = jobQueue(name);
    return definition ? $t(`frameleaf_jobs_queue_${definition.key}` as Translations) : name;
  };
  // FL-168: the Frameleaf Cloud tile (the prototype's `cloudSummary`), from the cloud manager's
  // link status and licence (the same status the Frameleaf Cloud pages show).
  onMount(() => cloudManager.listen());
  const cloud = $derived(cloudManager.status ? cloudGlance(cloudManager.status, cloudManager.license) : null);
  const cloudText = $derived.by(() => {
    if (!cloud) {
      return $t('frameleaf_cc_unmeasured');
    }
    if (!cloud.configured) {
      return $t('frameleaf_cc_cloud_not_set_up');
    }
    return [
      $t(`frameleaf_cc_cloud_link_${cloud.link}` as Translations),
      $t(cloud.remote ? 'frameleaf_cc_cloud_remote_on' : 'frameleaf_cc_cloud_remote_off'),
      $t(`frameleaf_cc_cloud_plan_${cloud.plan}` as Translations),
    ].join(' · ');
  });
  const analyticsHref = $derived(
    commandCenterUrl('analytics', undefined, { scope: scope === 'all' ? undefined : scope }),
  );
  $effect(() => {
    const selected = scope;
    void retry;
    let cancelled = false;
    // The previous snapshot stays in place (dimmed) while the next one is read, so a scope change
    // or a refresh updates the figures where they are instead of blanking the page (finding 69).
    loading = true;
    failed = false;
    void (async () => {
      const [inventory, version, disk, jobs, backup, restoreTest, workers, destinations, routes] =
        await Promise.allSettled([
          getAnalyticsReport({ scope: selected, range: AnalyticsRange.Year }),
          getAboutInfo(),
          getStorage(),
          getQueues(),
          listDatabaseBackups(),
          getBackupRestoreVerification(),
          getRenderWorkerCompatibility(),
          listMlDestinations(),
          getMlWorkloadRoutes(),
        ]);
      if (cancelled) {
        return;
      }
      loading = false;
      if (inventory.status === 'fulfilled') {
        report = inventory.value;
      } else {
        // Another scope's figures must not stand in for the one that could not be read.
        report = undefined;
        failed = true;
      }
      // A reading that could not be taken shows as not measured, never as the last one.
      about = version.status === 'fulfilled' ? version.value : undefined;
      storage = disk.status === 'fulfilled' ? disk.value : undefined;
      queues = jobs.status === 'fulfilled' ? jobs.value : undefined;
      backups = backup.status === 'fulfilled' ? backup.value.backups : undefined;
      restore = restoreTest.status === 'fulfilled' ? restoreTest.value : undefined;
      compatibility = workers.status === 'fulfilled' ? workers.value : undefined;
      ml =
        destinations.status === 'fulfilled' && routes.status === 'fulfilled'
          ? { destinations: destinations.value, routes: routes.value.routes }
          : undefined;
    })();
    return () => {
      cancelled = true;
    };
  });

  /**
   * Coming back to the window takes a new snapshot (design review finding 77), at most twice a
   * minute; the figures on screen stay in place while it is read.
   */
  const RETURN_REFRESH_MS = 30_000;
  let lastReturn = Date.now();
  const refreshOnReturn = () => {
    if (document.visibilityState !== 'visible' || loading || Date.now() - lastReturn < RETURN_REFRESH_MS) {
      return;
    }
    lastReturn = Date.now();
    retry++;
  };
</script>

<svelte:window onfocus={refreshOnReturn} />
<svelte:document onvisibilitychange={refreshOnReturn} />

{#if failed}
  <InlineError message={$t('frameleaf_cc_section_load_failed')} onRetry={() => retry++} />
{:else if !report}
  <!-- The shape of what is coming: four figures, then the panels. -->
  <div class="overview-loading" role="status" aria-busy="true">
    <span class="sr-only">{$t('loading')}</span>
    <div class="metrics">
      {#each [0, 1, 2, 3] as tile (tile)}<Skeleton variant="block" height="7.25rem" />{/each}
    </div>
    <div class="overview-grid">
      {#each [0, 1, 2, 3] as panel (panel)}<Skeleton variant="block" height="13rem" />{/each}
    </div>
  </div>
{:else}
  <div class="health">
    <span class="dot" class:warn={!!attentionCount}></span><strong>{$t('frameleaf_cc_library_available')}</strong
    >{#if attentionCount !== undefined}<span
        >{$t('frameleaf_cc_attention_count', { values: { count: attentionCount } })}</span
      >{/if}<span class="time" aria-live="polite"
      >{loading
        ? $t('frameleaf_cc_refreshing')
        : `${$t('frameleaf_cc_snapshot')} · ${new Date(report.generatedAt).toLocaleString($locale)}`}</span
    >
    <IconButton label={$t('frameleaf_cc_refresh')} disabled={loading} onclick={() => retry++}>
      <Icon icon={mdiRefresh} size={ICON_SIZE.md} />
    </IconButton>
  </div>
  <div class="snapshot" class:busy={loading} aria-busy={loading}>
    <div class="metrics">
      <a href={analyticsHref} style:--i={0}
        ><span>{report.scopeLabel || $t('frameleaf_analytics_scope_all')}</span><strong
          ><CountUp value={report.summary.items} /></strong
        ><small>{$t('frameleaf_cc_items')}<Icon icon={mdiChevronRight} size="16" /></small></a
      >
      <a href={href('storage')} style:--i={1}
        ><span>{$t('frameleaf_cc_filesystem')}</span><strong
          >{storage ? storage.diskUse : $t('frameleaf_cc_unmeasured')}</strong
        ><small
          >{storage
            ? $t('frameleaf_cc_available', { values: { size: storage.diskAvailable } })
            : $t('frameleaf_cc_unmeasured')}<Icon icon={mdiChevronRight} size="16" /></small
        ></a
      >
      <!-- Both backup entry points on this page open Backup → Backups & restore (finding 66). -->
      <a href={href('maintenance', 'backups')} style:--i={2}
        ><span>{$t('frameleaf_cc_latest_backup')}</span>{#if latestBackupTime}<strong title={latestBackup?.filename}
            >{latestBackupTime.time}<span class="date">{latestBackupTime.date}</span></strong
          >{:else}<strong class="note"
            >{backups
              ? $t(backups.length > 0 ? 'frameleaf_cc_unmeasured' : 'frameleaf_cc_no_backup')
              : $t('frameleaf_cc_unmeasured')}</strong
          >{/if}<small
          >{restoreDue ? $t('frameleaf_cc_restore_drill_overdue') : $t('frameleaf_cc_section_backups')}<Icon
            icon={mdiChevronRight}
            size="16"
          /></small
        ></a
      >
      <a href={href('server', 'version-check')} style:--i={3}
        ><span>{$t('frameleaf_cc_version')}</span><strong>{about?.version ?? $t('frameleaf_cc_unmeasured')}</strong
        ><small>{$t('frameleaf_cc_updates')}<Icon icon={mdiChevronRight} size="16" /></small>{#if about?.build}<small
            >{$t('frameleaf_cc_build')} {about.build}</small
          >{/if}</a
      >
    </div>
    <div class="overview-grid">
      <section class="panel">
        <header>
          <div>
            <h2>{$t('frameleaf_cc_growth')}</h2>
            <p>{$t('frameleaf_cc_growth_period')}</p>
          </div>
          <a href={analyticsHref}>{$t('frameleaf_cc_explore')} ›</a>
        </header>
        {#if report.series.some((row) => row.items !== null)}<AnalyticsChart
            compact
            kind="line"
            title={$t('frameleaf_cc_growth')}
            labels={report.series.map((row) => row.key)}
            datasets={[{ label: $t('frameleaf_cc_items'), values: report.series.map((row) => row.items) }]}
            unit=""
          />
          <details>
            <summary>{$t('frameleaf_cc_details')}</summary>
            <table>
              <tbody
                >{#each report.series as row (row.key)}<tr
                    ><th>{row.key}</th><td>{row.items ?? $t('frameleaf_cc_unmeasured')}</td></tr
                  >{/each}</tbody
              >
            </table>
          </details>
        {:else}<p class="subtle">{$t('frameleaf_analytics_growth_unknown')}</p>{/if}
      </section>
      <section class="panel">
        <header>
          <h2>{$t('frameleaf_cc_attention')}</h2>
          {#if attentionCount !== undefined}<span>{attentionCount}</span>{/if}
        </header>
        {#if restoreDue}<a class="action" href={href('maintenance', 'backups')}
            ><Icon icon={mdiBackupRestore} size="18" /><span
              ><strong>{$t('frameleaf_cc_attention_restore')}</strong><small>{restoreDetail}</small></span
            ><Icon icon={mdiChevronRight} size="18" /></a
          >{/if}
        {#if workersDue && compatibility}<a class="action" href={Route.systemWorkers()}
            ><Icon icon={mdiDesktopTowerMonitor} size="18" /><span
              ><strong>{$t('frameleaf_cc_attention_workers')}</strong><small
                >{$t('frameleaf_cc_attention_workers_detail', {
                  values: { kinds: compatibility.unavailable.map((kind) => kindLabel(kind)).join(', ') },
                })}</small
              ></span
            ><Icon icon={mdiChevronRight} size="18" /></a
          >{/if}
        {#if failures}<a class="action" href={Route.queues()}
            ><Icon icon={mdiAlertCircleOutline} size="18" /><span
              ><strong>{$t('frameleaf_cc_failed_jobs')}</strong><small>{failures} · {$t('frameleaf_cc_server')}</small
              ></span
            ><Icon icon={mdiChevronRight} size="18" /></a
          >{/if}
        {#if !restoreDue && !workersDue && !failures}<p class="subtle">
            {$t(queues ? 'frameleaf_cc_no_attention' : 'frameleaf_cc_unmeasured')}
          </p>{/if}
        <!-- CommandCenter.jsx:1807 -->
        <p class="subtle">{$t('frameleaf_cc_attention_footer')}</p>
      </section>
      <section class="panel">
        <header>
          <div>
            <h2>{$t('storage')}</h2>
            <p>{$t('frameleaf_cc_storage_subtitle')}</p>
          </div>
          <a href={href('storage')}>{$t('frameleaf_cc_manage')} ›</a>
        </header>
        {#if storage}<div class="storage-value">
            <strong><CountUp value={storage.diskUsagePercentage} format={percent} /></strong><span
              >{$t('frameleaf_cc_storage_of_used', { values: { size: storage.diskSize } })}</span
            >
          </div>
          <meter
            min="0"
            max={storage.diskSizeRaw}
            value={storage.diskUseRaw}
            aria-label={$t('frameleaf_cc_storage_meter', { values: { used: storage.diskUse, size: storage.diskSize } })}
          ></meter>{/if}
        <dl>
          <div>
            <dt>{$t('frameleaf_cc_originals')} · {report.scopeLabel || $t('frameleaf_analytics_scope_all')}</dt>
            <dd>{formatBytes(report.summary.physicalBytes)}</dd>
          </div>
          <div>
            <dt>{$t('frameleaf_cc_derivatives')}</dt>
            <dd>{storageValue(() => breakdown!.previewsBytes! + breakdown!.encodedVideoBytes!)}</dd>
          </div>
          <div>
            <dt>{$t('frameleaf_cc_other')}</dt>
            <dd>{storageValue(() => breakdown!.databaseBytes + breakdown!.otherBytes)}</dd>
          </div>
        </dl>
        <p class="subtle">{storageNote}</p>
      </section>
      <section class="panel">
        <header>
          <div>
            <h2>{$t('frameleaf_cc_processing')}</h2>
            <p>{$t('frameleaf_cc_processing_subtitle')}</p>
          </div>
          <a href={Route.queues()}>{$t('frameleaf_cc_queues')} ›</a>
        </header>
        {#if queues}{#each snapshotQueues as queue (queue.name)}<a class="service" href={Route.viewQueue(queue)}
              ><span>{queueTitle(queue.name)}</span><small class:failed={queue.statistics.failed > 0}
                >{queue.statistics.failed > 0 && queue.statistics.active + queue.statistics.waiting === 0
                  ? $t('frameleaf_cc_queue_failed', { values: { failed: queue.statistics.failed } })
                  : $t('frameleaf_cc_queue_counts', {
                      values: { active: queue.statistics.active, waiting: queue.statistics.waiting },
                    })}</small
              ></a
            >{:else}<p class="subtle">{$t('frameleaf_cc_processing_idle')}</p>{/each}{:else}<p class="subtle">
            {$t('frameleaf_cc_unmeasured')}
          </p>{/if}
        <a class="activity" href={Route.activity()}>{$t('frameleaf_cc_activity')} ›</a>
      </section>
    </div>
    <BackupSummary />
    <section class="glance">
      <h2>{$t('frameleaf_cc_glance')}</h2>
      <div>
        <a href={href('server')}
          ><Icon icon={mdiServerOutline} size="18" /><span
            ><strong>{$t('frameleaf_cc_api')}</strong><small>{$t('frameleaf_cc_responding')}</small></span
          ><Icon icon={mdiChevronRight} size="18" /></a
        >
        <a href={href('processing')}
          ><Icon icon={mdiImageSearchOutline} size="18" /><span
            ><strong>{$t('frameleaf_cc_ml')}</strong><small
              >{ml
                ? $t(`frameleaf_cc_ml_${mlEndpointState(ml.destinations, ml.routes)}` as Translations)
                : $t('frameleaf_cc_unmeasured')}</small
            ></span
          ><Icon icon={mdiChevronRight} size="18" /></a
        >
        <a href={href('processing')}
          ><Icon icon={mdiDesktopTowerMonitor} size="18" /><span
            ><strong>{$t('frameleaf_cc_gpu_studio')}</strong><small
              >{compatibility
                ? $t(`frameleaf_cc_gpu_${gpuStudioState(compatibility)}` as Translations)
                : $t('frameleaf_cc_unmeasured')}</small
            ></span
          ><Icon icon={mdiChevronRight} size="18" /></a
        >
        <a href={href('cloud')} class:attention={cloud?.attention} data-testid="overview-cloud-tile"
          ><Icon icon={mdiCloudOutline} size="18" /><span
            ><strong>{$t('frameleaf_settings_area_cloud')}</strong><small>{cloudText}</small></span
          ><Icon icon={mdiChevronRight} size="18" /></a
        >
      </div>
    </section>
  </div>
{/if}

<style>
  /* A refresh or a scope change dims the last snapshot until the next one lands. */
  .snapshot {
    transition: opacity var(--fl-motion) var(--fl-ease);
  }
  .snapshot.busy {
    opacity: 0.6;
  }
  .glance {
    margin-top: 22px;
  }
  .glance h2 {
    font-size: 14px;
    font-weight: 550;
  }
  .glance > div {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }
  .glance a {
    display: flex;
    gap: 12px;
    justify-content: space-between;
    align-items: center;
    padding: 16px;
    border: 1px solid var(--fl-border);
    background: var(--fl-panel);
    border-radius: var(--fl-radius-card);
    font-size: 12px;
    color: var(--fl-text);
    text-decoration: none;
  }
  .glance a > span {
    flex: 1;
  }
  .glance small {
    display: block;
    color: var(--fl-muted);
    margin-top: 6px;
  }
  /* The prototype's `cc-glance-attention`: a plan in its grace period or expired. */
  .glance a.attention > :global(svg:first-child),
  .glance a.attention small {
    color: var(--fl-warning);
  }
  @media (max-width: 1000px) {
    .glance > div {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 700px) {
    .glance > div {
      grid-template-columns: 1fr;
    }
  }

  .subtle {
    color: var(--fl-muted);
    font-size: 12px;
    line-height: 1.5;
  }
  .health {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 18px;
    font-size: 12px;
    color: var(--fl-muted);
  }
  .health strong {
    color: var(--fl-text);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--fl-accent);
  }
  /* The dot agrees with the sentence beside it. */
  .dot.warn {
    background: var(--fl-warning);
  }
  .time {
    margin-inline-start: auto;
  }
  .metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 22px;
  }
  .metrics > a {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 18px;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    color: var(--fl-text);
    text-decoration: none;
  }
  .metrics span,
  .metrics small {
    font-size: 11px;
    color: var(--fl-muted);
  }
  .metrics strong {
    font-size: 26px;
    font-weight: 550;
  }
  .metrics small {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .metrics strong .date {
    margin-inline-start: var(--fl-space-2);
    font-size: var(--fl-font-size);
    font-weight: 500;
  }
  .metrics .note {
    font-size: var(--fl-font-headline);
  }
  /* The four figures arrive one after another on first load; the stagger is `--i`. */
  .metrics > a {
    animation: fl-fade-in var(--fl-duration-fade) var(--fl-ease) both;
    animation-delay: calc(var(--i, 0) * var(--fl-stagger));
  }
  .overview-grid {
    display: grid;
    grid-template-columns: 1.2fr 1fr;
    gap: 16px;
  }
  .panel {
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    padding: 20px;
    min-width: 0;
  }
  .panel header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 20px;
  }
  .panel h2 {
    font-size: 14px;
    font-weight: 550;
    margin: 0;
  }
  .panel header p {
    font-size: 11px;
    color: var(--fl-muted);
    margin: 6px 0 0;
  }
  .panel a {
    color: var(--fl-accent);
    font-size: 11px;
    text-decoration: none;
  }
  .action,
  .service {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 0;
    border-bottom: 1px solid var(--fl-border);
  }
  /* A row is read, not skimmed: the link colour and micro size above are for the header links only. */
  .panel a.action,
  .panel a.service {
    font-size: var(--fl-font-callout);
  }
  .action small,
  .service small {
    font-size: var(--fl-font-small);
  }
  .action > :global(svg:first-child) {
    color: var(--fl-warning);
  }
  .action > :global(svg:last-child) {
    color: var(--fl-muted);
  }
  .service small {
    color: var(--fl-muted);
    margin-inline-start: auto;
    font-variant-numeric: var(--fl-numeric);
  }
  .service small.failed {
    color: var(--fl-danger);
  }
  /* command-center.css `.cc-action-row`: icon, title over its detail, chevron. */
  .action > span {
    display: grid;
    gap: 3px;
    flex: 1;
    min-width: 0;
    color: var(--fl-text);
  }
  .action small {
    color: var(--fl-muted);
    line-height: 1.5;
  }
  .service span {
    color: var(--fl-text);
  }
  .storage-value {
    display: flex;
    gap: 16px;
    align-items: baseline;
  }
  .storage-value strong {
    font-size: 28px;
    font-weight: 550;
  }
  .storage-value span {
    color: var(--fl-muted);
    font-size: 11px;
  }
  meter {
    width: 100%;
    height: 8px;
    margin: 16px 0;
    appearance: none;
    border: 0;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    overflow: hidden;
  }
  meter::-webkit-meter-bar {
    height: 8px;
    border: 0;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
  }
  meter::-webkit-meter-optimum-value,
  meter::-webkit-meter-suboptimum-value,
  meter::-webkit-meter-even-less-good-value {
    border-radius: var(--fl-radius-pill);
    background: var(--fl-accent);
  }
  meter::-moz-meter-bar {
    border-radius: var(--fl-radius-pill);
    background: var(--fl-accent);
  }
  dl > div {
    display: flex;
    justify-content: space-between;
    gap: 14px;
    font-size: 11px;
    margin: 10px 0;
  }
  dt {
    color: var(--fl-muted);
  }
  dd {
    margin: 0;
  }
  .activity {
    display: block;
    margin-top: 18px;
  }
  details {
    font-size: 11px;
    color: var(--fl-muted);
  }
  table {
    width: 100%;
    text-align: start;
  }
  @media (max-width: 1100px) {
    .metrics {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 700px) {
    .overview-grid {
      grid-template-columns: 1fr;
    }
    .health {
      flex-wrap: wrap;
    }
    .time {
      margin-inline-start: 0;
    }
    .metrics > a {
      padding: 14px;
    }
    .metrics strong {
      font-size: 22px;
    }
  }
</style>
