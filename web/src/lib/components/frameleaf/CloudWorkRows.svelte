<script lang="ts">
  /**
   * Activity's background work (FL-164): the prototype's `BackgroundRow` rows (Activity.jsx and
   * activity-feed.mjs `summariseCloudWork`) for this server's cloud backup operation and restore in
   * progress. Read-only: each row opens Cloud backup, and pause, retry and limits live in Settings ›
   * Background work. Shown to administrators, who own the server's backups; the stage follows the
   * prototype's Queued → Starting → Running → Paused, with files and bytes as the server counts them.
   */
  import { cloudWorkRows, type CloudWorkRow } from '$lib/frameleaf/cloud-backup';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { CloudBackupTargetSetting, getCloudBackupStatus, type CloudBackupStatusResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiBackupRestore, mdiChevronRight, mdiCloudUploadOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  /** How often the rows are read again while something runs, and while nothing does. */
  const ACTIVE_POLL_MS = 5000;
  const IDLE_POLL_MS = 30_000;

  const STAGE_WORDS: Record<CloudWorkRow['stage'], Translations> = {
    queued: 'frameleaf_activity_stage_queued',
    starting: 'frameleaf_activity_stage_starting',
    running: 'frameleaf_activity_stage_running',
    paused: 'frameleaf_activity_stage_paused',
  };

  let status = $state<CloudBackupStatusResponseDto | null>(null);
  const rows = $derived(cloudWorkRows(status));
  const where = $derived(
    status?.target === CloudBackupTargetSetting.Managed
      ? $t('frameleaf_cloud_work_where_managed')
      : $t('frameleaf_cloud_work_where_own'),
  );
  const headingId = $props.id();

  const load = async () => {
    try {
      status = await getCloudBackupStatus();
    } catch {
      // not set up, or unreachable: nothing to show
      status = null;
    }
  };

  onMount(() => {
    void load();
  });

  $effect(() => {
    const timer = setInterval(() => void load(), rows.length > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  });

  const filesOf = ({ files }: CloudWorkRow) => {
    if (!files) {
      return null;
    }
    return files.total === null
      ? $t('frameleaf_cloud_work_files', { values: { count: files.done } })
      : $t('frameleaf_cloud_work_files_of', { values: { done: files.done, total: files.total } });
  };

  const detailOf = (row: CloudWorkRow) =>
    [
      $t(STAGE_WORDS[row.stage]),
      row.progress !== null && row.stage !== 'queued' ? `${row.progress}%` : null,
      filesOf(row),
      row.bytes ? getByteUnitString(row.bytes) : null,
      where,
    ]
      .filter(Boolean)
      .join(' · ');
</script>

{#if rows.length > 0}
  <section class="fla-bg-group" aria-labelledby={headingId}>
    <h2 id={headingId} class="fla-bg-heading">
      {$t('frameleaf_activity_background_work')} <span class="fla-bg-count">{rows.length}</span>
    </h2>
    <p class="fla-bg-hint">
      {$t('frameleaf_activity_background_hint')}
      <a href={commandCenterUrl('processing', 'queues')}>{$t('frameleaf_activity_background_link')}</a>
    </p>
    <ul class="fla-bg-list">
      {#each rows as row (row.id)}
        {@const title = $t(row.titleKey)}
        {@const detail = detailOf(row)}
        <li>
          <a
            class="fla-bg"
            class:is-paused={row.stage === 'paused'}
            href={commandCenterUrl('cloud', 'cloud-backup')}
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
  </section>
{/if}

<style>
  .fla-bg-group {
    margin: 0 0 1.25rem;
  }
  .fla-bg-heading {
    margin: 0;
    font-size: var(--fl-font-body, 0.875rem);
    font-weight: 600;
  }
  .fla-bg-count {
    color: var(--fl-muted);
    font-weight: 500;
  }
  .fla-bg-hint {
    margin: 0.25rem 0 0.75rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 0.75rem);
  }
  .fla-bg-list {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .fla-bg {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 0.75rem;
    align-items: center;
    padding: 0.75rem 0.875rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control, 10px);
    color: inherit;
    text-decoration: none;
  }
  .fla-bg:hover,
  .fla-bg:focus-visible {
    background: var(--fl-raised);
  }
  .fla-bg.is-paused {
    border-color: var(--fl-warning);
  }
  .fla-bg-icon {
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    border-radius: 999px;
    background: var(--fl-raised);
  }
  .fla-bg-body {
    display: grid;
    gap: 0.25rem;
    min-width: 0;
  }
  .fla-bg-title {
    font-weight: 500;
  }
  .fla-bg-detail {
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 0.75rem);
  }
  .fla-bg-bar {
    height: 4px;
    border-radius: 999px;
    background: var(--fl-raised);
    overflow: hidden;
  }
  .fla-bg-bar > span {
    display: block;
    height: 100%;
    background: var(--fl-accent);
  }
  .fla-bg-link {
    display: inline-flex;
    gap: 0.25rem;
    align-items: center;
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 0.75rem);
    white-space: nowrap;
  }
</style>
