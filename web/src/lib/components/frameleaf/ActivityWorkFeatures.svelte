<script lang="ts">
  /**
   * Activity's In progress, by feature (UI review 2026-11-10, A1; prototype `ActivityWorkV3.jsx` "By feature",
   * activity.css `.fw3-features`).
   *
   * One row per feature of Settings › Background work: what it does, where it runs, how far it has got, and
   * a pause. The server's own names for the work stay under "Technical details". A Frameleaf Cloud backup or
   * restore in progress (FL-164) is a row of the same list; it opens Cloud backup, where it is managed.
   */
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import { ACTIVITY_STAGE_KEYS } from '$lib/frameleaf/activity';
  import {
    tonightLabel,
    tonightStart,
    type BackgroundWorkCard,
    type WorkFeatureRow,
  } from '$lib/frameleaf/background-work';
  import { cloudWorkRows, type CloudWorkRow } from '$lib/frameleaf/cloud-backup';
  import { runTitleKey } from '$lib/frameleaf/durable-runs';
  import { jobQueue } from '$lib/frameleaf/job-queues';
  import { backupPageUrl, commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import type { WorkFeature, WorkFeatureId } from '$lib/frameleaf/work-features';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import {
    CloudBackupTargetSetting,
    getMlWorkloadRoutes,
    listMlDestinations,
    MlDestinationKind,
    MlWorkload,
    type CloudBackupStatusResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiBackupRestore,
    mdiChevronRight,
    mdiCloudOutline,
    mdiCloudUploadOutline,
    mdiCogOutline,
    mdiDesktopTowerMonitor,
    mdiPause,
    mdiPlay,
    mdiServerOutline,
  } from '@mdi/js';
  import { locale, t, type Translations } from 'svelte-i18n';

  let {
    rows = [],
    others = [],
    cloudStatus = null,
    canPause = false,
    busy = false,
    onPause,
  }: {
    rows?: WorkFeatureRow[];
    /** Work that is no feature's task (FL-1177: a Manager import), each on its own row. */
    others?: BackgroundWorkCard[];
    cloudStatus?: CloudBackupStatusResponseDto | null;
    /** An administrator who may pause the server's work; nobody else is sent any rows. */
    canPause?: boolean;
    /** A pause or resume is on its way to the server. */
    busy?: boolean;
    onPause?: (feature: WorkFeature, paused: boolean) => void;
  } = $props();

  const cloudRows = $derived(cloudWorkRows(cloudStatus));
  const number = (value: number) => value.toLocaleString($locale ?? undefined);
  const nameOf = (feature: WorkFeature) => $t(`frameleaf_work_feature_${feature.id}` as Translations);

  /** The server's own tasks behind a feature, by the names Settings › Background work › Advanced uses. */
  const tasksOf = (feature: WorkFeature) =>
    feature.queues.flatMap((name) => {
      const key = jobQueue(name)?.key;
      return key ? [$t(`frameleaf_jobs_queue_${key}` as Translations)] : [];
    });
  const pausable = (feature: WorkFeature) => feature.queues.some((name) => jobQueue(name)?.canPause);

  /** How far a feature has got, in the prototype's words (`stageText`). */
  const tagOf = (row: WorkFeatureRow) => {
    const left = (state: string) =>
      row.left > 0 ? $t('frameleaf_bgwork_state_left', { values: { state, count: row.left } }) : state;
    switch (row.state) {
      case 'running': {
        return row.total
          ? $t('frameleaf_activity_work_of', { values: { done: number(row.done ?? 0), total: number(row.total) } })
          : $t('frameleaf_bgwork_state_running');
      }
      case 'paused': {
        return left($t('frameleaf_bgwork_state_paused'));
      }
      case 'tonight': {
        const startsAt = row.tonight?.startsAt ?? null;
        return left(
          tonightStart(startsAt) === 'tonight'
            ? $t('frameleaf_activity_work_tonight_tag')
            : tonightLabel(startsAt, $t, $locale ?? undefined),
        );
      }
      case 'idle': {
        return $t('frameleaf_bgwork_state_up_to_date');
      }
      default: {
        return left($t(row.statusKey ?? 'frameleaf_activity_work_up_next'));
      }
    }
  };

  const otherTitle = (card: BackgroundWorkCard) =>
    $t(runTitleKey(card.queueName, undefined, 'frameleaf_job_runs_server_work'));
  const otherTag = (card: BackgroundWorkCard) => {
    const left = card.waiting + card.running;
    const state = $t(card.statusKey);
    return left > 0 ? $t('frameleaf_bgwork_state_left', { values: { state, count: left } }) : state;
  };

  /** Where each routed feature runs now, by the place's name (the who-does-what grid in Computers). */
  const WORKLOADS: Partial<Record<WorkFeatureId, MlWorkload>> = {
    faces: MlWorkload.Face,
    search: MlWorkload.Clip,
    text: MlWorkload.Ocr,
    descriptions: MlWorkload.Enrichment,
  };
  type Place = { name: string; kind: MlDestinationKind };
  let places = $state<Partial<Record<WorkFeatureId, Place>>>({});
  const loadPlaces = async () => {
    try {
      const [destinations, { routes }] = await Promise.all([listMlDestinations(), getMlWorkloadRoutes()]);
      const named: Partial<Record<WorkFeatureId, Place>> = {};
      for (const [id, workload] of Object.entries(WORKLOADS) as [WorkFeatureId, MlWorkload][]) {
        const destination = destinations.find(
          (item) => item.id === routes.find((route) => route.workload === workload)?.destinationId,
        );
        if (destination) {
          named[id] = { name: destination.name, kind: destination.kind };
        }
      }
      places = named;
    } catch {
      // Without the routes each routed feature still links to Computers.
    }
  };
  // Asked once, and only for an administrator: nobody else may read where work runs.
  let asked = false;
  $effect(() => {
    if (canPause && !asked) {
      asked = true;
      void loadPlaces();
    }
  });
  const placeName = (place: Place) =>
    place.kind === MlDestinationKind.Local
      ? $t('frameleaf_computers_this_server')
      : place.kind === MlDestinationKind.FrameleafCloud
        ? $t('frameleaf_computers_cloud')
        : place.name;
  const placeIcon = (place: Place | undefined) =>
    place?.kind === MlDestinationKind.FrameleafCloud
      ? mdiCloudOutline
      : !place || place.kind === MlDestinationKind.Local
        ? mdiServerOutline
        : mdiDesktopTowerMonitor;

  const cloudWhere = $derived(
    cloudStatus?.target === CloudBackupTargetSetting.Managed
      ? $t('frameleaf_cloud_work_where_managed')
      : $t('frameleaf_cloud_work_where_own'),
  );
  const cloudTag = (row: CloudWorkRow) =>
    [
      $t(ACTIVITY_STAGE_KEYS[row.stage]),
      row.progress !== null && row.stage !== 'queued' ? `${row.progress}%` : null,
      row.files
        ? row.files.total === null
          ? $t('frameleaf_cloud_work_files', { values: { count: row.files.done } })
          : $t('frameleaf_cloud_work_files_of', { values: { done: row.files.done, total: row.files.total } })
        : null,
      row.bytes ? getByteUnitString(row.bytes) : null,
    ]
      .filter(Boolean)
      .join(' · ');
</script>

<ul class="fw3-features">
  {#each rows as row (row.feature.id)}
    {@const name = nameOf(row.feature)}
    {@const tasks = tasksOf(row.feature)}
    {@const held = row.state === 'paused'}
    <li
      class="fw3-feature"
      class:is-running={row.state === 'running'}
      class:is-warning={row.state === 'paused' || row.state === 'stuck'}
      class:is-tonight={row.state === 'tonight'}
    >
      <span class="fw3-icon" aria-hidden="true"><Icon icon={row.feature.icon} size="20" /></span>
      <div class="fw3-name">
        <strong>{name}</strong>
        <small>{$t(`frameleaf_work_feature_${row.feature.id}_does` as Translations)}</small>
        <details>
          <summary>{$t('frameleaf_activity_work_technical')}</summary>
          {#if tasks.length > 0}
            <p>
              {$t('frameleaf_activity_work_tasks', { values: { count: tasks.length, names: tasks.join(', ') } })}
              {#if canPause}
                <a href={commandCenterUrl('processing', 'queues', { view: 'advanced', feature: row.feature.id })}
                  >{$t('frameleaf_bgwork_feature_tasks', { values: { count: tasks.length } })}</a
                >
              {/if}
            </p>
          {:else}
            <p>{$t(`frameleaf_work_feature_${row.feature.id}_started` as Translations)}</p>
          {/if}
        </details>
      </div>
      {#if row.feature.routed}
        {@const place = places[row.feature.id]}
        <a class="fw3-where" href={commandCenterUrl('processing', 'computers')}>
          <Icon icon={placeIcon(place)} size="14" aria-hidden />{place
            ? placeName(place)
            : $t('frameleaf_bgwork_where')}
        </a>
      {:else}
        <span class="fw3-where">
          <Icon icon={mdiServerOutline} size="14" aria-hidden />{$t('frameleaf_computers_this_server')}
        </span>
      {/if}
      <div class="fw3-progress">
        <span class="fw3-tag">{tagOf(row)}</span>
        {#if row.state === 'running' && row.total}
          <span
            class="fw3-meter"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={row.total}
            aria-valuenow={row.done ?? 0}
            aria-label={$t('frameleaf_activity_progress_for', { values: { name } })}
            ><span style:width="{Math.min(100, ((row.done ?? 0) / row.total) * 100)}%"></span></span
          >
        {/if}
      </div>
      {#if canPause && row.state !== 'idle' && pausable(row.feature)}
        <IconButton
          variant="default"
          disabled={busy}
          label={$t(held ? 'frameleaf_bgwork_feature_review_resume' : 'frameleaf_bgwork_feature_review_pause', {
            values: { name },
          })}
          onclick={() => onPause?.(row.feature, !held)}
        >
          <Icon icon={held ? mdiPlay : mdiPause} size="1.125rem" />
        </IconButton>
      {:else}
        <span class="fw3-end"></span>
      {/if}
    </li>
  {/each}
  {#each others as card (card.id)}
    {@const title = otherTitle(card)}
    <li
      class="fw3-feature"
      class:is-running={card.stage === 'running'}
      class:is-warning={card.stage === 'paused' || card.stuck}
    >
      <span class="fw3-icon" aria-hidden="true"><Icon icon={mdiCogOutline} size="20" /></span>
      <div class="fw3-name"><strong>{title}</strong></div>
      <span class="fw3-where">
        <Icon icon={mdiServerOutline} size="14" aria-hidden />{$t('frameleaf_computers_this_server')}
      </span>
      <div class="fw3-progress">
        <span class="fw3-tag">{otherTag(card)}</span>
        {#if card.progress !== null}
          <span
            class="fw3-meter"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={card.progress}
            aria-label={$t('frameleaf_activity_progress_for', { values: { name: title } })}
            ><span style:width="{card.progress}%"></span></span
          >
        {/if}
      </div>
      <!-- A run with no task page of its own opens Background work, where its run is listed. -->
      <IconButton
        href={commandCenterUrl('processing', 'queues')}
        label={$t('frameleaf_activity_work_open', { values: { title, detail: otherTag(card) } })}
      >
        <Icon icon={mdiChevronRight} size="1.125rem" />
      </IconButton>
    </li>
  {/each}
  {#each cloudRows as row (row.id)}
    {@const title = $t(row.titleKey)}
    <li
      class="fw3-feature"
      class:is-running={row.stage === 'running' || row.stage === 'starting'}
      class:is-warning={row.stage === 'paused'}
    >
      <span class="fw3-icon" aria-hidden="true">
        <Icon icon={row.id === 'cloud-restore-run' ? mdiBackupRestore : mdiCloudUploadOutline} size="20" />
      </span>
      <div class="fw3-name"><strong>{title}</strong></div>
      <span class="fw3-where"><Icon icon={mdiCloudOutline} size="14" aria-hidden />{cloudWhere}</span>
      <div class="fw3-progress">
        <span class="fw3-tag">{cloudTag(row)}</span>
        {#if row.progress !== null && row.stage !== 'queued'}
          <span
            class="fw3-meter"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={row.progress}
            aria-label={$t('frameleaf_activity_progress_for', { values: { name: title } })}
            ><span style:width="{row.progress}%"></span></span
          >
        {/if}
      </div>
      <IconButton
        href={backupPageUrl('cloud')}
        label={$t('frameleaf_cloud_work_row_label', { values: { title, detail: cloudTag(row) } })}
      >
        <Icon icon={mdiChevronRight} size="1.125rem" />
      </IconButton>
    </li>
  {/each}
</ul>

<style>
  /* activity.css `.fw3-features`: one bordered list, a rule between rows. */
  .fw3-features {
    margin: 0;
    padding: 0;
    list-style: none;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    overflow: hidden;
  }
  /* The prototype's 36px last column holds its 32px button; the app's control is 44px on desktop. */
  .fw3-feature {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) 140px 180px var(--fl-control-height);
    align-items: center;
    gap: 14px;
    padding: var(--fl-space-3) var(--fl-space-4);
  }
  .fw3-feature + .fw3-feature {
    border-top: 1px solid var(--fl-border);
  }
  .fw3-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-sm);
  }
  .fw3-name strong {
    display: block;
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  .fw3-name small {
    display: block;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fw3-name details {
    margin-top: var(--fl-space-1);
    font-size: var(--fl-font-small);
  }
  /* A line of text, as the prototype draws it; its click area keeps the 44px floor around it. */
  .fw3-name summary {
    position: relative;
    width: max-content;
    max-width: 100%;
    min-height: 0;
    color: var(--fl-muted);
    cursor: pointer;
  }
  .fw3-name summary::after {
    content: '';
    position: absolute;
    inset: -14px 0;
  }
  .fw3-name details p {
    margin: var(--fl-space-1) 0 0;
    color: var(--fl-muted);
  }
  .fw3-name details a {
    color: var(--fl-accent);
    text-decoration: none;
  }
  .fw3-name details a:hover {
    text-decoration: underline;
  }
  .fw3-where {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    text-decoration: none;
  }
  a.fw3-where:hover {
    color: var(--fl-text);
    text-decoration: underline;
  }
  .fw3-progress {
    display: grid;
    gap: 6px;
    min-width: 0;
  }
  .fw3-tag {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-variant-numeric: tabular-nums;
  }
  .is-running .fw3-tag {
    color: var(--fl-text);
  }
  .is-warning .fw3-tag {
    color: var(--fl-warning);
  }
  /* The ink of the AI colour: the fill itself is too dark to read on a dark panel. */
  .is-tonight .fw3-tag {
    color: var(--fl-ai-ink);
  }
  .fw3-meter {
    display: block;
    height: 4px;
    background: var(--fl-border);
    border-radius: var(--fl-radius-pill);
    overflow: hidden;
  }
  .fw3-meter > span {
    display: block;
    height: 100%;
    background: var(--fl-blue);
    border-radius: var(--fl-radius-pill);
  }
  @media (max-width: 700px) {
    .fw3-feature {
      grid-template-columns: auto minmax(0, 1fr) var(--fl-control-height);
    }
    .fw3-where,
    .fw3-progress {
      grid-column: 2;
    }
    .fw3-feature > :global(.fl-control),
    .fw3-end {
      grid-column: 3;
      grid-row: 1;
    }
  }
</style>
