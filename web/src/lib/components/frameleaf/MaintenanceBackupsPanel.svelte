<script lang="ts">
  /**
   * Maintenance → Database backups (FL-81 CC-17/18/19): the prototype's backups card
   * (`design/frameleaf/template/src/Maintenance.jsx:325-422`) — its copy, "Schedule" (the backup
   * settings) and "Create backup now", which queues the real `backup-database` job — over the
   * Frameleaf backup list. While the job runs, the card shows a running row and re-reads the list
   * until the new backup appears.
   */
  import MaintenanceBackupList from '$lib/components/frameleaf/MaintenanceBackupList.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { handleCreateJob } from '$lib/services/job.service';
  import { getQueuesLegacy, listDatabaseBackups, ManualJobName, type DatabaseBackupDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiDatabaseOutline } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    backups?: DatabaseBackupDto[];
    expectedVersion: string;
    /** How often the list is re-read while a new backup is being written. */
    pollMs?: number;
    /** Stop waiting for the new backup after this long; the list is still re-read on the next visit. */
    timeoutMs?: number;
  };

  const { backups: initial, expectedVersion, pollMs = 3000, timeoutMs = 120_000 }: Props = $props();

  // The caller's list until "Create backup now" re-reads it.
  let backups = $derived<DatabaseBackupDto[] | undefined>(initial);

  let creating = $state(false);
  let failed = $state(false);
  let alive = true;
  onDestroy(() => (alive = false));

  /** The backup queue, or undefined when it cannot be read. */
  const readQueue = async () => {
    try {
      return (await getQueuesLegacy()).backupDatabase;
    } catch {
      return undefined;
    }
  };

  /**
   * Queues the backup job, then re-reads the list until the new backup appears. It stops and offers
   * Retry when the job fails (the queue's failed count rises), when the queue goes idle without a new
   * file, or after `timeoutMs`.
   */
  const createBackup = async () => {
    failed = false;
    const before = new Set((backups ?? []).map(({ filename }) => filename));
    const failedBefore = (await readQueue())?.jobCounts.failed ?? 0;
    if (!(await handleCreateJob({ name: ManualJobName.BackupDatabase }))) {
      return;
    }
    creating = true;
    const startedAt = Date.now();
    let polls = 0;
    const stop = (didFail: boolean) => {
      creating = false;
      failed = didFail;
    };
    const poll = async () => {
      if (!alive) {
        return;
      }
      polls++;
      try {
        const result = await listDatabaseBackups();
        backups = result.backups;
        if (result.backups.some(({ filename }) => !before.has(filename))) {
          stop(false);
          return;
        }
      } catch {
        // Keep waiting; a transient failure must not end the running row early.
      }
      const queue = await readQueue();
      if (queue) {
        const { failed: failedNow, active, waiting, delayed } = queue.jobCounts;
        const idle = !queue.queueStatus.isActive && active + waiting + delayed === 0;
        // The first poll may run before the queue picks the job up, so idle only counts after it.
        if (failedNow > failedBefore || (idle && polls > 1)) {
          stop(true);
          return;
        }
      }
      if (Date.now() - startedAt >= timeoutMs) {
        stop(true);
        return;
      }
      setTimeout(() => void poll(), pollMs);
    };
    setTimeout(() => void poll(), pollMs);
  };
</script>

<section class="mt-card" aria-labelledby="fl-maintenance-backups-title">
  <div class="mt-card-title">
    <div>
      <!-- The page heading already names this section (a section named like its area does not repeat the name). -->
      <h2 class="sr-only" id="fl-maintenance-backups-title">{$t('admin.frameleaf_maintenance_backups_title')}</h2>
      <p>{$t('admin.frameleaf_maintenance_backups_description')}</p>
    </div>
    <div class="mt-actions">
      <a class="button" href={commandCenterUrl('backup', 'backup')}
        >{$t('admin.frameleaf_maintenance_backups_schedule')}</a
      >
      <button type="button" class="button primary" disabled={creating} onclick={createBackup}>
        <Icon icon={mdiDatabaseOutline} size="16" aria-hidden={true} />
        {$t('admin.frameleaf_maintenance_backups_create')}
      </button>
    </div>
  </div>
  {#if creating}
    <p class="mt-running" role="status">
      <span class="mt-status is-running">{$t('admin.frameleaf_maintenance_backups_running')}</span>
      <progress aria-label={$t('admin.frameleaf_maintenance_backups_running')}></progress>
    </p>
  {:else if failed}
    <p class="mt-running mt-failed" role="alert">
      <span>{$t('admin.frameleaf_maintenance_backups_failed')}</span>
      <button type="button" class="button" onclick={createBackup}>{$t('retry')}</button>
    </p>
  {/if}
  <MaintenanceBackupList {backups} {expectedVersion} />
</section>

<style>
  .mt-card {
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    padding: 20px;
    min-width: 0;
  }
  .mt-card-title {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .mt-card-title h2 {
    margin: 0 0 4px;
    font-size: 16px;
    font-weight: 600;
  }
  .mt-card-title p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.6;
    max-width: 40rem;
  }
  .mt-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .mt-actions a.button {
    text-decoration: none;
  }
  .mt-actions .button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .mt-running {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 0 12px;
    font-size: var(--fl-font-small);
  }
  .mt-failed {
    color: var(--fl-danger);
  }
  .mt-running progress {
    flex: 1;
    height: 6px;
    accent-color: var(--fl-blue);
  }
  .mt-status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    white-space: nowrap;
  }
  .mt-status::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--fl-blue);
  }
</style>
