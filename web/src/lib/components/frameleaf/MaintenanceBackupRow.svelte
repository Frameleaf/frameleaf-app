<script lang="ts">
  /**
   * One database backup (FL-81 CC-18): the prototype's backup row (`design/frameleaf/template/src/
   * Maintenance.jsx:355-418`) — when it was made, its version, a status pill, its size and visible
   * Download / Restore / Delete buttons — in place of the legacy `MaintenanceBackupEntry` card with
   * its hidden context menu. Restore opens the typed RESTORE dialog; Delete asks "Delete this backup?"
   * in the Frameleaf confirmation (`handleDeleteDatabaseBackup`).
   */
  import MaintenanceRestoreConfirmDialog from '$lib/components/frameleaf/MaintenanceRestoreConfirmDialog.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { BackupFileStatus } from '$lib/constants';
  import { backupFileVersion } from '$lib/frameleaf/maintenance-page';
  import { handleDeleteDatabaseBackup, handleDownloadDatabaseBackup } from '$lib/services/database-backups.service';
  import { locale } from '$lib/stores/preferences.store';
  import { getBytesWithUnit } from '$lib/utils/byte-units';
  import { Icon } from '@immich/ui';
  import { mdiBackupRestore, mdiDatabaseOutline, mdiDeleteOutline, mdiDownload } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  type Props = {
    filename: string;
    filesize: number;
    expectedVersion: string;
    timezone?: string;
  };

  const { filename, filesize, expectedVersion, timezone }: Props = $props();

  const filesizeText = $derived(getBytesWithUnit(filesize, 1));
  const size = $derived(`${filesizeText[0]} ${filesizeText[1]}`);

  const backupDateTime = $derived.by(() => {
    const dateMatch = filename.match(/\d+T\d+/);
    if (dateMatch) {
      return DateTime.fromFormat(dateMatch[0], "yyyyMMdd'T'HHmmss", { zone: timezone }).toLocal();
    }
    return null;
  });

  const when = $derived(backupDateTime?.toLocaleString(DateTime.DATETIME_MED) ?? $t('unknown_date'));
  const relativeTime = $derived(backupDateTime?.toRelative({ locale: $locale }));

  const version = $derived(backupFileVersion(filename));

  const status = $derived.by(() => {
    if (!version) {
      return BackupFileStatus.UnknownVersion;
    }
    if (version !== expectedVersion) {
      return BackupFileStatus.DifferentVersion;
    }
    return BackupFileStatus.OK;
  });

  let isDeleting = $state(false);
  let restoreConfirmOpen = $state(false);

  function onBackupDeleteStatus(event: { filename: string; isDeleting: boolean }) {
    if (event.filename === filename) {
      isDeleting = event.isDeleting;
    }
  }
</script>

<OnEvents {onBackupDeleteStatus} />

<div class="mt-row" role="listitem">
  <Icon icon={mdiDatabaseOutline} size="20" aria-hidden={true} />
  <div class="mt-row-main">
    <strong>{when}</strong>
    <small class="filename">{filename}</small>
    <small>
      {#if relativeTime}{relativeTime} ·
      {/if}{$t('version')}
      {version ? `v${version}` : $t('unknown')}
    </small>
  </div>
  <div class="mt-row-meta">
    {#if status === BackupFileStatus.OK}
      <span class="mt-status is-ok">{$t('admin.frameleaf_maintenance_backup_complete')}</span>
    {:else if status === BackupFileStatus.DifferentVersion}
      <span class="mt-status is-issue">{$t('admin.maintenance_restore_backup_different_version')}</span>
    {:else}
      <span class="mt-status is-error">{$t('admin.maintenance_restore_backup_unknown_version')}</span>
    {/if}
    <small>{size}</small>
  </div>
  <div class="mt-actions">
    <button
      type="button"
      class="button"
      disabled={isDeleting}
      aria-label={$t('admin.frameleaf_maintenance_backup_download_label', { values: { date: when } })}
      onclick={() => handleDownloadDatabaseBackup(filename)}
    >
      <Icon icon={mdiDownload} size="16" aria-hidden={true} />
      {$t('download')}
    </button>
    <button type="button" class="button" disabled={isDeleting} onclick={() => (restoreConfirmOpen = true)}>
      <Icon icon={mdiBackupRestore} size="16" aria-hidden={true} />
      {$t('restore')}
    </button>
    <button
      type="button"
      class="button danger"
      disabled={isDeleting}
      aria-label={$t('admin.frameleaf_maintenance_backup_delete_label', { values: { date: when } })}
      onclick={() => void handleDeleteDatabaseBackup({ date: when }, filename)}
    >
      <Icon icon={mdiDeleteOutline} size="16" aria-hidden={true} />
      {$t('delete')}
    </button>
  </div>
</div>

<MaintenanceRestoreConfirmDialog
  {filename}
  date={backupDateTime?.toLocaleString(DateTime.DATETIME_MED)}
  {size}
  {version}
  {expectedVersion}
  bind:open={restoreConfirmOpen}
  onClose={() => (restoreConfirmOpen = false)}
/>

<style>
  /* design/frameleaf/template/src/maintenance.css `.mt-row`. */
  .mt-row {
    display: grid;
    grid-template-columns: 22px minmax(0, 1.6fr) minmax(0, 1fr) auto;
    align-items: center;
    gap: 14px;
    padding: 12px 0;
    border-top: 1px solid var(--fl-border);
    font-size: var(--fl-font-small);
    color: var(--fl-text);
    text-align: left;
  }
  .mt-row:first-child {
    border-top: 0;
  }
  .mt-row > :global(svg) {
    color: var(--fl-muted);
  }
  .mt-row-main,
  .mt-row-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .mt-row-main strong {
    font-weight: 500;
    font-size: var(--fl-font-size);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mt-row small {
    color: var(--fl-muted);
  }
  .filename {
    font-family: var(--fl-font-mono, monospace);
    word-break: break-all;
  }
  .mt-status {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: 8px;
    padding: 4px 10px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    white-space: normal;
  }
  .mt-status::before {
    content: '';
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--fl-muted);
  }
  .mt-status.is-ok::before {
    background: var(--fl-teal);
  }
  .mt-status.is-issue::before {
    background: var(--fl-warning);
  }
  .mt-status.is-error::before {
    background: var(--fl-danger);
  }
  .mt-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  }
  .mt-actions .button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 9px;
    font-size: var(--fl-font-small);
  }
  .mt-actions .button.danger {
    color: var(--fl-danger);
  }
  @media (max-width: 700px) {
    .mt-row {
      grid-template-columns: 22px minmax(0, 1fr);
    }
    .mt-row-meta,
    .mt-actions {
      grid-column: 2;
      justify-content: flex-start;
    }
  }
</style>
