<script lang="ts">
  /**
   * Frameleaf redesign of the "Database backups" section of the design template's
   * `Maintenance.jsx`. The list itself, upload card and per-backup row stay the existing
   * `MaintenanceBackupsList`/`MaintenanceBackupEntry` components (they already call the real
   * backup endpoints and, per FL-81, `MaintenanceBackupEntry` now opens the Frameleaf typed
   * "RESTORE" confirmation dialog instead of the legacy one-click confirm when this shell is
   * active) — only the surrounding chrome changes here.
   */
  import Pane from '$lib/components/frameleaf/Pane.svelte';
  import MaintenanceBackupsList from '$lib/components/maintenance/MaintenanceBackupsList.svelte';
  import type { DatabaseBackupDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  type Props = {
    backups?: DatabaseBackupDto[];
    expectedVersion: string;
  };

  const { backups, expectedVersion }: Props = $props();
</script>

<Pane label={$t('admin.maintenance_backup_management')}>
  <div class="head">
    <h2>{$t('admin.maintenance_restore_database_backup')}</h2>
    <p>{$t('admin.maintenance_restore_database_backup_description')}</p>
  </div>
  <MaintenanceBackupsList {backups} {expectedVersion} />
</Pane>

<style>
  .head h2 {
    font-size: var(--fl-font-body);
    margin: 0 0 0.25rem;
  }
  .head p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
</style>
