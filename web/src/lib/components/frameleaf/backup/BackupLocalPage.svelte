<script lang="ts">
  /**
   * Backup › On this server (FL-362): the copy of the library data (albums, people, edits and
   * settings) this server keeps of itself. It replaces the "Database backups" form and the
   * Maintenance backups manager: whether a snapshot is taken, how many are kept, taking one now, and
   * the saved snapshots with their download, restore and delete.
   *
   * "Take a snapshot now" queues the server's own `backup-database` job, then re-reads the list
   * until the new snapshot appears; it stops and offers to try again when the job fails, when the
   * queue goes idle without a new file, or after `timeoutMs`. A snapshot that failed for good since
   * the newest one finished is shown with a retry, also after a reload (FL-657).
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import MaintenanceBackupList from '$lib/components/frameleaf/MaintenanceBackupList.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import Toggle from '$lib/components/frameleaf/Toggle.svelte';
  import BackupPlaceHeader from '$lib/components/frameleaf/backup/BackupPlaceHeader.svelte';
  import { BACKUP_PLACE_COPY } from '$lib/components/frameleaf/backup/backup-places';
  import Amount from '$lib/components/frameleaf/settings/kit/Amount.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { lastSnapshotFailure, localPlaceState, snapshotFailureKey } from '$lib/frameleaf/backup-overview';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { handleCreateJob } from '$lib/services/job.service';
  import {
    getQueue,
    getQueueJobs,
    getServerVersion,
    listDatabaseBackups,
    ManualJobName,
    QueueJobStatus,
    QueueName,
    type DatabaseBackupDto,
    type QueueJobResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiPlayOutline } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    /** How often the list is re-read while a new snapshot is being written. */
    pollMs?: number;
    /** Stop waiting for the new snapshot after this long; the list is still re-read on the next visit. */
    timeoutMs?: number;
  };
  const { pollMs = 3000, timeoutMs = 120_000 }: Props = $props();

  let backups = $state<DatabaseBackupDto[]>();
  let expectedVersion = $state('');
  let loadFailed = $state(false);
  let creating = $state(false);
  let failed = $state(false);
  /** The queue's failed snapshot jobs; null when they cannot be read, which then shows no failure. */
  let failedJobs = $state<QueueJobResponseDto[] | null>(null);
  let alive = true;
  onDestroy(() => (alive = false));

  const load = () => {
    loadFailed = false;
    void Promise.all([getServerVersion(), listDatabaseBackups()])
      .then(([{ major, minor, patch }, result]) => {
        expectedVersion = `${major}.${minor}.${patch}`;
        backups = result.backups;
      })
      .catch(() => (loadFailed = true));
    void loadFailures();
  };
  const loadFailures = async () => {
    try {
      failedJobs = await getQueueJobs({ name: QueueName.BackupDatabase, status: [QueueJobStatus.Failed] });
    } catch {
      failedJobs = null;
    }
  };
  onMount(load);

  // Whether a snapshot is taken and how many are kept are ordinary settings, saved with the settings bar.
  const settingsDraft = getSystemConfigDraft();
  const database = $derived(settingsDraft?.draft.backup.database);
  const configDisabled = $derived(featureFlagsManager.value.configFile);
  const lastFailure = $derived(lastSnapshotFailure(failedJobs));
  const placeState = $derived(
    localPlaceState(
      backups ?? null,
      settingsDraft?.baseline.backup.database.enabled ?? true,
      new Date(),
      undefined,
      lastFailure?.at ?? null,
    ),
  );
  /** The last snapshot failed: just now while this page waited, or earlier and not made good since. */
  const showFailure = $derived(failed || placeState.status.key === 'frameleaf_backup_state_failed');
  /** A recorded reason explains only a failure newer than the newest snapshot; otherwise say it plainly. */
  const failureMessage = $derived(
    placeState.status.key === 'frameleaf_backup_state_failed' && lastFailure
      ? snapshotFailureKey(lastFailure.reason)
      : 'frameleaf_backup_local_failed',
  );

  /** The backup queue, or undefined when it cannot be read. */
  /** The database backup queue alone; reading every queue's counts on each poll is far more work. */
  const readQueue = async () => {
    try {
      return await getQueue({ name: QueueName.BackupDatabase });
    } catch {
      return undefined;
    }
  };

  const takeSnapshot = async () => {
    failed = false;
    const before = new Set((backups ?? []).map(({ filename }) => filename));
    // Unknown when the queue cannot be read, so older failed jobs are never taken for this one.
    const failedBefore = (await readQueue())?.statistics.failed;
    if (!(await handleCreateJob({ name: ManualJobName.BackupDatabase }))) {
      return;
    }
    creating = true;
    const startedAt = Date.now();
    let polls = 0;
    const stop = (didFail: boolean) => {
      creating = false;
      failed = didFail;
      void loadFailures();
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
        const { failed: failedNow, active, waiting, delayed } = queue.statistics;
        const idle = active + waiting + delayed === 0;
        // The first poll may run before the queue picks the job up, so idle only counts after it.
        if ((failedBefore !== undefined && failedNow > failedBefore) || (idle && polls > 1)) {
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

<BackupPlaceHeader
  icon={BACKUP_PLACE_COPY.local.icon}
  name={$t('frameleaf_backup_place_local')}
  where={$t('frameleaf_backup_place_local_where')}
  tone={creating ? 'good' : placeState.tone}
  status={creating
    ? $t('frameleaf_backup_local_running')
    : backups
      ? $t(placeState.status.key, { values: placeState.status.values })
      : undefined}
>
  <Button variant="primary" disabled={creating} onclick={() => void takeSnapshot()}>
    <Icon icon={mdiPlayOutline} size="18" aria-hidden />
    {$t('frameleaf_backup_local_take')}
  </Button>
</BackupPlaceHeader>

{#if creating}
  <p class="running" role="status">
    <progress aria-label={$t('frameleaf_backup_local_running')}></progress>
  </p>
{:else if showFailure}
  <InlineError compact message={$t(failureMessage)} onRetry={takeSnapshot} />
{/if}

<Notice title={$t('frameleaf_backup_local_not_photos')}>{$t('frameleaf_backup_local_not_photos_body')}</Notice>

{#if database}
  <Section title={$t('frameleaf_backup_local_settings')}>
    <Row label={$t('frameleaf_backup_local_enabled')} help={$t('frameleaf_backup_local_enabled_help')}>
      <Toggle
        label={$t('frameleaf_backup_local_enabled')}
        checked={database.enabled}
        disabled={configDisabled}
        onLabel={$t('frameleaf_kit_on')}
        offLabel={$t('frameleaf_kit_off')}
        onChange={(value) => (database.enabled = value)}
      />
    </Row>
    <Row label={$t('frameleaf_backup_local_keep')} help={$t('frameleaf_backup_local_keep_help')}>
      <Amount
        label={$t('frameleaf_backup_local_keep_label')}
        unit={$t('frameleaf_backup_local_keep_unit', { values: { count: database.keepLastAmount } })}
        min={1}
        max={365}
        value={database.keepLastAmount}
        disabled={configDisabled || !database.enabled}
        onChange={(value) => (database.keepLastAmount = value)}
      />
    </Row>
  </Section>
{/if}

<Section
  id="snapshots"
  title={$t('frameleaf_backup_local_saved')}
  description={$t('frameleaf_backup_local_saved_description')}
>
  {#if loadFailed}
    <InlineError message={$t('frameleaf_cc_section_load_failed')} onRetry={load} />
  {:else if backups}
    <div class="saved">
      <MaintenanceBackupList {backups} {expectedVersion} />
    </div>
  {:else}
    <div class="saved" role="status" aria-busy="true">
      <span class="sr-only">{$t('loading')}</span>
      <Skeleton variant="block" height="5rem" />
    </div>
  {/if}
</Section>

<style>
  .running {
    margin: 0;
  }
  progress {
    width: 100%;
    height: 6px;
    accent-color: var(--fl-accent);
  }
  .saved {
    padding: var(--fl-space-4) 0 var(--fl-space-5);
    border-top: 1px solid var(--fl-border);
  }
</style>
