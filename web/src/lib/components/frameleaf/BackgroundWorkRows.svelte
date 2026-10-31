<script lang="ts">
  /**
   * Activity's "Background work" group (SHARING-P1; prototype Activity.jsx `BackgroundRow`,
   * activity.css `.fla-bg`): the last group of the In progress section.
   *
   * One simple card per kind of work the server is busy with (Thumbnails, Metadata, Face detection…)
   * and, for Frameleaf Cloud backups, the backup or restore in progress (FL-164). Read-only: a card
   * opens its page in Settings › Background work (or Cloud backup), where pause, retry and limits live.
   * The notifications panel no longer lists running work (SHELL-P1); this page and the top bar's
   * Activity indicator do.
   */
  import { ACTIVITY_STAGE_KEYS } from '$lib/frameleaf/activity';
  import { tonightStart, type BackgroundWorkCard } from '$lib/frameleaf/background-work';
  import { cloudWorkRows, type CloudWorkRow } from '$lib/frameleaf/cloud-backup';
  import { jobQueue } from '$lib/frameleaf/job-queues';
  import { backupPageUrl, commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { Route } from '$lib/route';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { CloudBackupTargetSetting, type CloudBackupStatusResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiBackupRestore, mdiChevronRight, mdiCloudUploadOutline, mdiCogOutline } from '@mdi/js';
  import { locale, t, type Translations } from 'svelte-i18n';

  let {
    cards = [],
    cloudStatus = null,
  }: { cards?: BackgroundWorkCard[]; cloudStatus?: CloudBackupStatusResponseDto | null } = $props();

  const cloudRows = $derived(cloudWorkRows(cloudStatus));
  const count = $derived(cards.length + cloudRows.length);
  const headingId = $props.id();
  const number = (value: number) => value.toLocaleString($locale ?? undefined);

  const titleOf = (card: BackgroundWorkCard) => {
    const queue = jobQueue(card.queueName);
    return queue ? $t(`frameleaf_jobs_queue_${queue.key}` as Translations) : $t('frameleaf_activity_background_work');
  };

  /**
   * FL-711: work quiet hours saved for the overnight window starts again by itself, so it says when,
   * never "Paused". Tonight's start reads as a time; a start further off names its day as well.
   */
  const tonightOf = ({ startsAt }: NonNullable<BackgroundWorkCard['tonight']>) => {
    const when = tonightStart(startsAt);
    if (when === 'unscheduled' || !startsAt) {
      return $t('frameleaf_activity_bg_tonight_unscheduled');
    }
    const at = new Date(startsAt);
    const time = new Intl.DateTimeFormat($locale ?? undefined, { hour: 'numeric', minute: '2-digit' }).format(at);
    if (when === 'tonight') {
      return $t('frameleaf_activity_bg_tonight', { values: { time } });
    }
    const day = new Intl.DateTimeFormat($locale ?? undefined, { weekday: 'long' }).format(at);
    return $t('frameleaf_activity_bg_tonight_day', { values: { day, time } });
  };

  /** The prototype's line: the state, what is waiting and running, how far, and where. */
  const detailOf = (card: BackgroundWorkCard) =>
    [
      card.tonight ? tonightOf(card.tonight) : $t(ACTIVITY_STAGE_KEYS[card.stage]),
      card.waiting > 0 ? $t('frameleaf_activity_bg_waiting', { values: { count: number(card.waiting) } }) : null,
      card.running > 0 ? $t('frameleaf_activity_bg_running', { values: { count: number(card.running) } }) : null,
      card.progress === null ? null : `${card.progress}%`,
      $t('frameleaf_activity_bg_where_server'),
    ]
      .filter(Boolean)
      .join(' · ');

  const cloudWhere = $derived(
    cloudStatus?.target === CloudBackupTargetSetting.Managed
      ? $t('frameleaf_cloud_work_where_managed')
      : $t('frameleaf_cloud_work_where_own'),
  );

  const cloudFiles = ({ files }: CloudWorkRow) => {
    if (!files) {
      return null;
    }
    return files.total === null
      ? $t('frameleaf_cloud_work_files', { values: { count: files.done } })
      : $t('frameleaf_cloud_work_files_of', { values: { done: files.done, total: files.total } });
  };

  const cloudDetail = (row: CloudWorkRow) =>
    [
      $t(ACTIVITY_STAGE_KEYS[row.stage]),
      row.progress !== null && row.stage !== 'queued' ? `${row.progress}%` : null,
      cloudFiles(row),
      row.bytes ? getByteUnitString(row.bytes) : null,
      cloudWhere,
    ]
      .filter(Boolean)
      .join(' · ');
</script>

{#if count > 0}
  <div class="fla-bg-group" role="group" aria-labelledby={headingId}>
    <h3 id={headingId} class="fla-bg-heading">
      {$t('frameleaf_activity_background_work')} <span class="fla-bg-count">{count}</span>
      <span class="fla-bg-hint">
        {$t('frameleaf_activity_background_hint')}
        <a href={commandCenterUrl('processing', 'queues')}>{$t('frameleaf_activity_background_link')}</a>
      </span>
    </h3>
    <ul class="fla-bg-list">
      {#each cards as card (card.id)}
        {@const title = titleOf(card)}
        {@const detail = detailOf(card)}
        <li>
          <a
            class="fla-bg"
            class:is-info={card.stage === 'running'}
            class:is-warning={card.stage === 'paused'}
            href={Route.viewQueue({ name: card.queueName })}
            aria-label={$t('frameleaf_activity_bg_row_label', { values: { title, detail } })}
          >
            <span class="fla-bg-icon" aria-hidden="true">
              <Icon icon={jobQueue(card.queueName)?.icon ?? mdiCogOutline} size="18" />
            </span>
            <span class="fla-bg-body">
              <span class="fla-bg-title">{title}</span>
              <span class="fla-bg-detail">{detail}</span>
              {#if card.progress !== null}
                <span class="fla-bg-bar" aria-hidden="true"><span style:width="{card.progress}%"></span></span>
              {/if}
            </span>
            <span class="fla-bg-link" aria-hidden="true">
              {$t('frameleaf_activity_background_work')}
              <Icon icon={mdiChevronRight} size="16" />
            </span>
          </a>
        </li>
      {/each}
      {#each cloudRows as row (row.id)}
        {@const title = $t(row.titleKey)}
        {@const detail = cloudDetail(row)}
        <li>
          <a
            class="fla-bg"
            class:is-info={row.stage === 'running' || row.stage === 'starting'}
            class:is-warning={row.stage === 'paused'}
            href={backupPageUrl('cloud')}
            aria-label={$t('frameleaf_cloud_work_row_label', { values: { title, detail } })}
          >
            <span class="fla-bg-icon" aria-hidden="true">
              <Icon icon={row.id === 'cloud-restore-run' ? mdiBackupRestore : mdiCloudUploadOutline} size="18" />
            </span>
            <span class="fla-bg-body">
              <span class="fla-bg-title">{title}</span>
              <span class="fla-bg-detail">{detail}</span>
              {#if row.progress !== null}
                <span class="fla-bg-bar" aria-hidden="true"><span style:width="{row.progress}%"></span></span>
              {/if}
            </span>
            <span class="fla-bg-link" aria-hidden="true">
              {$t('frameleaf_cc_section_cloud_backup')}
              <Icon icon={mdiChevronRight} size="16" />
            </span>
          </a>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  /* activity.css: a group inside In progress, titled like the stage groups above it. */
  .fla-bg-group {
    margin: 0 0 var(--fl-space-4);
  }
  .fla-bg-heading {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--fl-space-1) var(--fl-space-2);
    margin: 0 0 var(--fl-space-2);
    font-size: var(--fl-font-small);
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--fl-muted);
  }
  .fla-bg-count {
    font-size: var(--fl-font-micro);
    font-weight: 500;
    color: var(--fl-muted);
    background: var(--fl-raised);
    padding: 0 7px;
    border-radius: var(--fl-radius-pill);
    line-height: 1.7;
    font-variant-numeric: tabular-nums;
    text-transform: none;
  }
  .fla-bg-hint {
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }
  .fla-bg-hint a {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .fla-bg-hint a:hover {
    color: var(--fl-text);
  }
  .fla-bg-list {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .fla-bg {
    width: 100%;
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr) auto;
    gap: var(--fl-space-3);
    align-items: center;
    min-height: 44px;
    padding: 10px 14px;
    background: var(--fl-panel);
    border: 1px solid transparent;
    border-radius: var(--fl-radius-card);
    color: var(--fl-text);
    text-decoration: none;
  }
  :global([data-theme='light']) .fla-bg {
    border-color: var(--fl-border);
  }
  .fla-bg:hover {
    background: color-mix(in srgb, var(--fl-panel), var(--fl-text) 5%);
  }
  .fla-bg:focus-visible {
    outline: 2px solid var(--fl-teal);
    outline-offset: 2px;
  }
  .fla-bg-icon {
    width: 32px;
    height: 32px;
    border-radius: var(--fl-radius-control-compact);
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .fla-bg.is-info .fla-bg-icon {
    color: var(--fl-teal);
  }
  .fla-bg.is-warning .fla-bg-icon {
    color: var(--fl-warning);
  }
  .fla-bg-body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .fla-bg-title {
    font-size: var(--fl-font-callout);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fla-bg-detail {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
    font-variant-numeric: tabular-nums;
  }
  .fla-bg-bar {
    display: block;
    height: 4px;
    border-radius: 2px;
    background: var(--fl-raised);
    overflow: hidden;
    max-width: 320px;
  }
  .fla-bg-bar > span {
    display: block;
    height: 100%;
    background: var(--fl-teal);
  }
  .fla-bg-link {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
    white-space: nowrap;
  }
  .fla-bg:hover .fla-bg-link {
    color: var(--fl-text);
  }
  @media (max-width: 700px) {
    .fla-bg {
      padding: 10px var(--fl-space-3);
    }
    .fla-bg-title {
      white-space: normal;
    }
  }
</style>
