<script lang="ts">
  /**
   * The database backups list (FL-81 CC-18/19), shared by Maintenance → Database backups and the
   * maintenance page's restore flow: the prototype's `.mt-list` of backup rows, newest first, with
   * "No backups yet." when empty (`design/frameleaf/template/src/Maintenance.jsx:354-420`), and the
   * existing upload of a backup file above it. Replaces the legacy `MaintenanceBackupsList`.
   */
  import MaintenanceBackupRow from '$lib/components/frameleaf/MaintenanceBackupRow.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { handleUploadDatabaseBackup } from '$lib/services/database-backups.service';
  import { listDatabaseBackups, type DatabaseBackupDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiTrayArrowUp } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    backups?: DatabaseBackupDto[];
    expectedVersion: string;
  };

  const { backups, expectedVersion }: Props = $props();

  // A caller that polls for a new backup passes the fresh list; otherwise the list loads its own.
  let loaded = $state<DatabaseBackupDto[]>([]);
  $effect.pre(() => {
    if (backups) {
      loaded = backups;
    }
  });

  const reload = async () => {
    const result = await listDatabaseBackups();
    loaded = result.backups;
  };

  onMount(() => {
    if (!backups) {
      void reload();
    }
  });

  let uploadProgress = $state(-1);

  function onBackupDeleted(event: { filename: string }) {
    loaded = loaded.filter((backup) => backup.filename !== event.filename);
  }

  function onBackupUpload(event: { progress: number; isComplete: boolean }) {
    uploadProgress = event.progress;
    if (event.isComplete) {
      void reload();
    }
  }

  // Backup filenames carry their UTC-free timestamp (yyyyMMddTHHmmss), so they sort by date.
  const stamp = (filename: string) => filename.match(/\d{8}T\d{6}/)?.[0] ?? '';
  const sorted = $derived([...loaded].sort((a, b) => stamp(b.filename).localeCompare(stamp(a.filename))));
</script>

<OnEvents {onBackupDeleted} {onBackupUpload} />

<div class="mt-upload">
  <Icon icon={mdiTrayArrowUp} size="20" aria-hidden={true} />
  {#if uploadProgress === -1}
    <span>{$t('admin.maintenance_upload_backup')}</span>
    <button type="button" class="button" onclick={handleUploadDatabaseBackup}>{$t('select_from_computer')}</button>
  {:else}
    <span>{$t('asset_uploading')}</span>
    <progress value={Math.round(uploadProgress * 100)} max="100" aria-label={$t('asset_uploading')}></progress>
  {/if}
</div>

<div class="mt-list" role="list" aria-label={$t('admin.frameleaf_maintenance_backups_list_label')}>
  {#each sorted as backup (backup.filename)}
    <MaintenanceBackupRow
      filename={backup.filename}
      filesize={backup.filesize}
      {expectedVersion}
      timezone={backup.timezone}
    />
  {/each}
  {#if sorted.length === 0}
    <p class="mt-empty">{$t('admin.frameleaf_maintenance_backups_empty')}</p>
  {/if}
</div>

<style>
  .mt-upload {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    margin-bottom: 8px;
    border: 1px dashed var(--fl-border);
    border-radius: var(--fl-radius-control);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    text-align: left;
  }
  .mt-upload span {
    flex: 1;
  }
  .mt-upload progress {
    flex: 1;
    height: 6px;
    accent-color: var(--fl-blue);
  }
  .mt-list {
    display: flex;
    flex-direction: column;
  }
  .mt-empty {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    padding: 8px 0;
    margin: 0;
  }
</style>
