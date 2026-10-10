<script lang="ts">
  /**
   * Activity's background work (FL-164): the prototype's `BackgroundRow` rows (Activity.jsx and
   * activity-feed.mjs `summariseCloudWork`) for this server's cloud backup operation and restore in
   * progress. Read-only: each row opens Cloud backup, and pause, retry and limits live in Settings ›
   * Background work. Shown to administrators, who own the server's backups; the stage follows the
   * prototype's Queued → Starting → Running → Paused, with files and bytes as the server counts them.
   *
   * FL-162: it is the last group of Activity's In progress section, after the stage groups, as in the
   * prototype; ActivityView reads the status (so the section can count these rows) and passes it here.
   */
  import { ACTIVITY_STAGE_KEYS } from '$lib/frameleaf/activity';
  import { cloudWorkRows, type CloudWorkRow } from '$lib/frameleaf/cloud-backup';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { CloudBackupTargetSetting, type CloudBackupStatusResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiBackupRestore, mdiChevronRight, mdiCloudUploadOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let { status }: { status: CloudBackupStatusResponseDto | null } = $props();

  const rows = $derived(cloudWorkRows(status));
  const where = $derived(
    status?.target === CloudBackupTargetSetting.Managed
      ? $t('frameleaf_cloud_work_where_managed')
      : $t('frameleaf_cloud_work_where_own'),
  );
  const headingId = $props.id();

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
      $t(ACTIVITY_STAGE_KEYS[row.stage]),
      row.progress !== null && row.stage !== 'queued' ? `${row.progress}%` : null,
      filesOf(row),
      row.bytes ? getByteUnitString(row.bytes) : null,
      where,
    ]
      .filter(Boolean)
      .join(' · ');
</script>

{#if rows.length > 0}
  <div class="fla-bg-group" role="group" aria-labelledby={headingId}>
    <h3 id={headingId} class="fla-bg-heading">
      {$t('frameleaf_activity_background_work')} <span class="fla-bg-count">{rows.length}</span>
    </h3>
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
            href={commandCenterUrl('backups', undefined, { backupView: 'cloud' })}
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
  /* activity.css: a group inside In progress, titled like the stage groups above it */
  .fla-bg-group {
    margin: 0 0 16px;
  }
  .fla-bg-heading {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
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
    margin: 0.25rem 0 0.75rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
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
    border-radius: var(--fl-radius-control);
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
    border-radius: var(--fl-radius-pill);
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
    font-size: var(--fl-font-small);
  }
  .fla-bg-bar {
    height: 4px;
    border-radius: var(--fl-radius-pill);
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
    font-size: var(--fl-font-small);
    white-space: nowrap;
  }
</style>
