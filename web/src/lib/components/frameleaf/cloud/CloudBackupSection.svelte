<script lang="ts">
  import { locale } from '$lib/stores/preferences.store';
  /**
   * Settings › Frameleaf Cloud › Cloud backup (FL-160): the prototype's `Backup`
   * (design/frameleaf/template/src/FrameleafCloud.jsx) on the server's real backup agent. Not set up:
   * what it does and "Set up cloud backup". Set up: the bucket, the key mode and fingerprint (never the
   * key), storage used, the last run and the run in progress with "Back up now"; in own-memory mode a
   * banner while the key is not loaded, with Unlock; and turning it off.
   *
   * FL-164 (CLD-302): Frameleaf-managed storage with its allowance and read-only state, the escrow and
   * last check facts, Verify and Restore…, the Schedule & retention card (ordinary settings, saved with
   * the settings bar) and the Restore section.
   */
  import './frameleaf-cloud.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import CloudBackupSetupDialog from '$lib/components/frameleaf/cloud/CloudBackupSetupDialog.svelte';
  import CloudWorkControls from '$lib/components/frameleaf/cloud/CloudWorkControls.svelte';
  import CloudBanner from '$lib/components/frameleaf/cloud/CloudBanner.svelte';
  import BackupPlaceHeader from '$lib/components/frameleaf/backup/BackupPlaceHeader.svelte';
  import Toggle from '$lib/components/frameleaf/Toggle.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Amount from '$lib/components/frameleaf/settings/kit/Amount.svelte';
  import Facts, { type Fact } from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Meter from '$lib/components/frameleaf/settings/kit/Meter.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { backupWhen, cloudPlaceState } from '$lib/frameleaf/backup-overview';
  import {
    RETENTION_FIELDS,
    endpointHost,
    isEscrowPassphraseValid,
    keyFileName,
    readBackupKeyFile,
    withRecoveryHistory,
  } from '$lib/frameleaf/cloud-backup';
  import { downloadBlob } from '$lib/utils';
  import { backupPageUrl } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { getCloudManager } from '$lib/managers/get-cloud-manager.svelte';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    CloudBackupCoverageState,
    CloudBackupKeyMode,
    CloudBackupLastRunStatus,
    CloudBackupRunState,
    CloudBackupTargetSetting,
    CloudBackupTask,
    CloudBackupVerifyDepth,
    CloudBackupVerifyStatus,
    getCloudBackupRecoveryHistory,
    getCloudBackupStatus,
    startCloudBackupRun,
    storeCloudBackupEscrow,
    turnOffCloudBackup,
    unlockCloudBackupKey,
    verifyCloudBackup,
    type CloudBackupStatusResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCheckCircleOutline,
    mdiClose,
    mdiCloudOutline,
    mdiCloudUploadOutline,
    mdiContentDuplicate,
    mdiKeyOutline,
    mdiLockOutline,
    mdiPlayOutline,
    mdiRestore,
    mdiServerOutline,
    mdiUpload,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  /** How often the card reads the status again while a run is queued or running. */
  const ACTIVE_POLL_MS = 3000;

  let status = $state<CloudBackupStatusResponseDto | null>(null);
  let loadError = $state(false);
  let notice = $state('');
  let failure = $state('');
  let busy = $state(false);
  let setupOpen = $state(false);
  let unlockOpen = $state(false);
  let turnOffOpen = $state(false);
  let escrowOpen = $state(false);
  let escrowPassphrase = $state({ first: '', second: '' });
  let escrowFailure = $state('');
  let unlockValue = $state('');
  let unlockError = $state<Translations | null>(null);
  let unlockFailure = $state('');
  let fileInput = $state<HTMLInputElement>();
  let recoveryInput = $state<HTMLInputElement>();

  const load = async () => {
    try {
      status = await getCloudBackupStatus();
      loadError = false;
    } catch {
      loadError = true;
    }
  };

  onMount(() => {
    const stop = cloudManager.listen();
    void load();
    return stop;
  });

  // While a run or a restore is queued or running, read its progress again; the timer goes with it.
  $effect(() => {
    if (!status?.activeRun && !status?.activeRestore) {
      return;
    }
    const timer = setInterval(() => {
      if (!document.hidden) {
        void load();
      }
    }, ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  });

  // However the setup dialog closes (Done, Close, Escape), read the status again: a bucket claimed in it
  // and then closed without Done must not leave this page saying backup is not set up.
  let setupWasOpen = false;
  $effect(() => {
    if (setupOpen) {
      setupWasOpen = true;
    } else if (setupWasOpen) {
      setupWasOpen = false;
      void load();
    }
  });

  // What a backup includes is an ordinary setting, saved with the settings bar like the other pages.
  const settingsDraft = getSystemConfigDraft();
  const include = $derived(settingsDraft?.draft.frameleafCloud?.cloudBackup?.include);
  // FL-164: the schedule and retention are ordinary settings too
  const backupDraft = $derived(settingsDraft?.draft.frameleafCloud?.cloudBackup);
  const configDisabled = $derived(featureFlagsManager.value.configFile);

  const linked = $derived(cloudManager.status?.state === 'linked');
  const entitled = $derived(linked && !!cloudManager.license?.entitlements.cloudBackup);
  const instanceId = $derived(status?.instanceId ?? cloudManager.status?.instanceId ?? '');
  const active = $derived(status?.activeRun ?? null);
  const locked = $derived(status?.keyMode === CloudBackupKeyMode.OwnMemory && !status.keyLoaded);

  const modeTitle: Record<CloudBackupKeyMode, Translations> = {
    [CloudBackupKeyMode.Server]: 'frameleaf_cloud_backup_mode_server',
    [CloudBackupKeyMode.OwnStored]: 'frameleaf_cloud_backup_mode_own_stored',
    [CloudBackupKeyMode.OwnMemory]: 'frameleaf_cloud_backup_mode_own_memory',
  };

  const managed = $derived(status?.managed ?? null);
  const readOnly = $derived(!!managed?.readOnly);
  const task = $derived(active?.task ?? CloudBackupTask.Backup);

  /** A run in progress reads as what it does: backing up, checking the files or cleaning up. */
  const taskWords: Record<CloudBackupTask, Translations> = {
    [CloudBackupTask.Backup]: 'frameleaf_cloud_backup_run_running',
    [CloudBackupTask.Verify]: 'frameleaf_cloud_backup_run_verifying',
    [CloudBackupTask.Prune]: 'frameleaf_cloud_backup_run_pruning',
  };

  /** The operation's name, as Activity and Background work name it. */
  const workTitle: Record<CloudBackupTask, Translations> = {
    [CloudBackupTask.Backup]: 'frameleaf_cloud_work_backup',
    [CloudBackupTask.Verify]: 'frameleaf_cloud_work_verify',
    [CloudBackupTask.Prune]: 'frameleaf_cloud_work_prune',
  };

  const runWords: Record<CloudBackupRunState, Translations> = {
    [CloudBackupRunState.Queued]: 'frameleaf_cloud_backup_run_queued',
    [CloudBackupRunState.Running]: 'frameleaf_cloud_backup_run_running',
    [CloudBackupRunState.Pausing]: 'frameleaf_cloud_backup_run_pausing',
    [CloudBackupRunState.Paused]: 'frameleaf_cloud_backup_run_paused',
    [CloudBackupRunState.Cancelling]: 'frameleaf_cloud_backup_run_cancelling',
  };

  const place = $derived(cloudPlaceState(status, new Date()));
  const when = (value: string | null | undefined) => {
    if (!value) {
      return $t('frameleaf_backup_not_yet');
    }
    const { key, values } = backupWhen(new Date(value), { locale: $locale });
    return $t(key, { values });
  };

  /** The few facts the page opens on: the last backup, the last check, and where it is kept. */
  const glance = $derived.by((): Fact[] => {
    if (!status) {
      return [];
    }
    const run = status.lastRun;
    const check = status.lastVerify;
    return [
      {
        label: $t('frameleaf_backup_fact_last'),
        value: when(status.lastSuccessAt),
        detail:
          run && run.status === CloudBackupLastRunStatus.Completed
            ? $t('frameleaf_backup_fact_last_detail', {
                values: { count: run.uploaded, size: getByteUnitString(run.bytesUploaded, $locale) },
              })
            : undefined,
      },
      {
        label: $t('frameleaf_backup_fact_checked'),
        value: when(check?.at),
        detail: check
          ? check.status === CloudBackupVerifyStatus.Degraded
            ? $t('frameleaf_cloud_backup_verify_degraded', { values: { count: check.missing + check.mismatched } })
            : check.status === CloudBackupVerifyStatus.Failed
              ? $t('frameleaf_cloud_backup_verify_failed')
              : $t('frameleaf_backup_fact_checked_ok')
          : undefined,
      },
      {
        label: $t('frameleaf_backup_fact_stored'),
        value: status.managed?.location
          ? `${status.managed.location.city}, ${status.managed.location.country}`
          : status.target === CloudBackupTargetSetting.Managed
            ? $t('frameleaf_backup_place_cloud_where')
            : endpointHost(status.endpoint),
        detail:
          status.target === CloudBackupTargetSetting.Managed
            ? $t('frameleaf_backup_place_cloud_where')
            : $t('frameleaf_cloud_backup_own_bucket'),
      },
    ];
  });

  /**
   * FL-362: when the newest run's numbers have not reached Frameleaf Cloud. Publishing them never holds up
   * a backup; it is tried again on its own.
   */
  const coverageNote = $derived.by(() => {
    const coverage = status?.coverage;
    if (!coverage || status?.target !== CloudBackupTargetSetting.Managed) {
      return '';
    }
    if (coverage.state === CloudBackupCoverageState.Pending) {
      return $t('frameleaf_cloud_backup_coverage_pending');
    }
    return coverage.state === CloudBackupCoverageState.NotReported
      ? $t('frameleaf_cloud_backup_coverage_not_reported')
      : '';
  });

  /** What went wrong with the last run, when something did. */
  const lastRunNote = $derived.by(() => {
    const run = status?.lastRun;
    if (!run || active) {
      return '';
    }
    if (run.status === CloudBackupLastRunStatus.Failed && run.error) {
      return $t('frameleaf_cloud_backup_last_run_failed', { values: { error: run.error } });
    }
    if (run.status === CloudBackupLastRunStatus.Cancelled) {
      return $t('frameleaf_cloud_backup_last_run_cancelled');
    }
    if (run.status === CloudBackupLastRunStatus.WaitingForKey) {
      return $t('frameleaf_cloud_backup_last_run_waiting');
    }
    return run.missing > 0 ? $t('frameleaf_cloud_backup_last_run_missing', { values: { count: run.missing } }) : '';
  });

  const act = async (call: () => Promise<CloudBackupStatusResponseDto>, success: string) => {
    busy = true;
    failure = '';
    try {
      status = await call();
      notice = success;
      return true;
    } catch (error) {
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
      return false;
    } finally {
      busy = false;
    }
  };

  const backUpNow = () => act(() => startCloudBackupRun(), $t('frameleaf_cloud_backup_queued'));

  /** "Verify": fetch and check this week's sample of the backed-up files now. */
  const verify = () =>
    act(
      () => verifyCloudBackup({ cloudBackupVerifyDto: { depth: CloudBackupVerifyDepth.Sample } }),
      $t('frameleaf_cloud_backup_verify_queued'),
    );

  const turnOff = async () => {
    if (await act(() => turnOffCloudBackup(), $t('frameleaf_cloud_backup_turned_off'))) {
      turnOffOpen = false;
    }
  };

  // The backup key never outlives its dialog: closing it (Cancel, Close, Escape) forgets what was typed or read.
  $effect(() => {
    if (unlockOpen) {
      return;
    }
    unlockValue = '';
    unlockError = null;
    unlockFailure = '';
  });

  /** Adds the latest signed history to the recovery file the administrator picks; keys never come from the server. */
  const refreshRecoveryFile = async (file: File | undefined) => {
    if (!file || !status?.keyFingerprint) {
      return;
    }
    failure = '';
    const read = readBackupKeyFile(await file.text(), status.keyFingerprint);
    if ('error' in read) {
      failure = $t(read.error);
      return;
    }
    busy = true;
    try {
      const { history } = await getCloudBackupRecoveryHistory();
      const refreshed = history ? withRecoveryHistory(read.key, history) : read.key;
      downloadBlob(new Blob([refreshed], { type: 'application/json' }), keyFileName(status.keyFingerprint));
      notice = $t('frameleaf_cloud_backup_recovery_file_refreshed');
    } catch (error) {
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
    } finally {
      busy = false;
      if (recoveryInput) {
        recoveryInput.value = '';
      }
    }
  };

  // The passphrase never outlives its dialog, however it closes.
  $effect(() => {
    if (escrowOpen) {
      return;
    }
    escrowPassphrase = { first: '', second: '' };
    escrowFailure = '';
  });

  const readKeyFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    const read = readBackupKeyFile(await file.text(), status?.keyFingerprint);
    if ('error' in read) {
      unlockError = read.error;
      return;
    }
    unlockValue = read.key;
    unlockError = null;
  };

  const updateEscrow = async () => {
    busy = true;
    escrowFailure = '';
    try {
      status = await storeCloudBackupEscrow({ cloudBackupEscrowDto: { passphrase: escrowPassphrase.first } });
      notice = $t('frameleaf_cloud_backup_escrow_updated');
      escrowOpen = false;
    } catch (error) {
      escrowFailure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
    } finally {
      busy = false;
    }
  };

  const unlock = async () => {
    busy = true;
    unlockFailure = '';
    try {
      status = await unlockCloudBackupKey({ cloudBackupUnlockDto: { key: unlockValue } });
      notice = $t('frameleaf_cloud_backup_unlocked');
      unlockOpen = false;
      unlockValue = '';
    } catch (error) {
      unlockFailure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
    } finally {
      busy = false;
    }
  };
</script>

{#snippet gate()}
  {#if !linked || !entitled}
    <CloudBanner icon={mdiCloudOutline} title={$t('frameleaf_gate_backup')}>
      {$t('frameleaf_why_backup')}
      {#snippet action()}
        <Button variant="primary" onclick={() => getCloudManager.open('backup', { onDone: () => (setupOpen = true) })}
          >{$t('frameleaf_get_cloud')}</Button
        >
      {/snippet}
    </CloudBanner>
  {/if}
{/snippet}

{#if failure}
  <p class="fc-notice is-error" role="alert">{failure}</p>
{/if}
{#if notice}
  <div class="fc-notice" role="status">
    <span>{notice}</span>
    <button
      type="button"
      class="fc-link"
      aria-label={$t('frameleaf_cloud_dismiss_notice')}
      onclick={() => (notice = '')}
    >
      <Icon icon={mdiClose} size="16" />
    </button>
  </div>
{/if}

{#if !status}
  {#if loadError}
    <InlineError message={$t('frameleaf_cloud_backup_load_failed')} onRetry={load} />
  {:else}
    <div class="fc-loading" role="status" aria-label={$t('frameleaf_cloud_loading')}>
      <Skeleton variant="block" height="168px" />
    </div>
  {/if}
{:else if !status.configured}
  <BackupPlaceHeader
    icon={mdiCloudOutline}
    name={$t('frameleaf_buddy_cloud_backup')}
    where={$t('frameleaf_backup_place_holds')}
    status={$t('frameleaf_cloud_backup_status_off')}
  />
  {@render gate()}
  <Section title={$t('frameleaf_cloud_backup_off_title')} description={$t('frameleaf_cloud_backup_off_description')}>
    {#snippet action()}
      <Button variant="primary" disabled={!entitled} onclick={() => (setupOpen = true)}>
        <Icon icon={mdiCloudUploadOutline} size="18" />
        {$t('frameleaf_cloud_backup_set_up')}
      </Button>
    {/snippet}
    <ul class="fc-benefits benefits">
      <li>
        <Icon icon={mdiContentDuplicate} size="18" />
        <span>
          <strong>{$t('frameleaf_cloud_backup_benefit_dedup_title')}</strong>
          {$t('frameleaf_cloud_backup_benefit_dedup_body')}
        </span>
      </li>
      <li>
        <Icon icon={mdiLockOutline} size="18" />
        <span>
          <strong>{$t('frameleaf_cloud_backup_benefit_key_title')}</strong>
          {$t('frameleaf_cloud_backup_benefit_key_body')}
        </span>
      </li>
      <li>
        <Icon icon={mdiServerOutline} size="18" />
        <span>
          <strong>{$t('frameleaf_cloud_backup_benefit_bucket_title')}</strong>
          {$t('frameleaf_cloud_backup_benefit_bucket_body')}
        </span>
      </li>
    </ul>
  </Section>
{:else}
  <BackupPlaceHeader
    icon={mdiCloudOutline}
    name={$t('frameleaf_buddy_cloud_backup')}
    where={status.target === CloudBackupTargetSetting.Managed
      ? $t('frameleaf_cloud_backup_managed')
      : $t('frameleaf_cloud_backup_own_bucket')}
    tone={place.tone}
    status={active && active.task !== CloudBackupTask.Backup
      ? $t(taskWords[active.task])
      : $t(place.status.key, { values: place.status.values })}
  >
    <Button
      variant="primary"
      disabled={busy || locked || readOnly || !!active || !!status.activeRestore || !entitled}
      onclick={() => void backUpNow()}
    >
      <Icon icon={mdiPlayOutline} size="18" />
      {active ? $t(runWords[active.state]) : $t('frameleaf_cloud_backup_back_up_now')}
    </Button>
  </BackupPlaceHeader>

  {#if readOnly && managed?.readOnlyReason === 'plan_full'}
    <CloudBanner tone="warning" icon={mdiLockOutline} title={$t('frameleaf_cloud_backup_plan_full_title')}>
      {$t('frameleaf_cloud_backup_plan_full_body')}
    </CloudBanner>
  {:else if readOnly}
    <CloudBanner tone="warning" icon={mdiLockOutline} title={$t('frameleaf_cloud_backup_read_only_title')}>
      {$t('frameleaf_cloud_backup_read_only_body')}
    </CloudBanner>
  {:else if managed?.refusal}
    <CloudBanner tone="warning" title={$t('frameleaf_cloud_backup_refused_title')}>
      {managed.refusal}
    </CloudBanner>
  {/if}
  {#if locked}
    <CloudBanner tone="danger" icon={mdiLockOutline} title={$t('frameleaf_cloud_backup_locked_title')}>
      {$t('frameleaf_cloud_backup_locked_body')}
      {#snippet action()}
        <Button variant="primary" onclick={() => (unlockOpen = true)}>
          <Icon icon={mdiKeyOutline} size="18" />
          {$t('frameleaf_cloud_backup_unlock')}
        </Button>
      {/snippet}
    </CloudBanner>
  {/if}
  {@render gate()}

  <Section
    title={$t('frameleaf_backup_glance')}
    description={status.target === CloudBackupTargetSetting.Managed
      ? $t('frameleaf_cloud_backup_managed_description')
      : $t('frameleaf_cloud_backup_own_bucket_description', { values: { host: endpointHost(status.endpoint) } })}
  >
    <Facts rows={glance} />
    {#if managed}
      {@const used = managed.usedBytes ?? status.usage?.bytes ?? 0}
      {@const allowance = managed.allowanceBytes ?? managed.quotaBytes}
      <div class="under">
        <Meter
          label={$t('frameleaf_cloud_backup_storage_used_label')}
          value={getByteUnitString(used, $locale)}
          max={$t('frameleaf_backup_storage_of', { values: { limit: getByteUnitString(allowance, $locale) } })}
          fraction={allowance > 0 ? used / allowance : undefined}
        />
        {#if managed.extraBlocks}
          <p class="fc-muted">
            {$t('frameleaf_cloud_backup_extra_blocks', { values: { count: managed.extraBlocks } })}
          </p>
        {/if}
      </div>
    {:else if status.usage}
      <p class="fc-muted under">
        {$t('frameleaf_cloud_backup_storage_used', {
          values: { size: getByteUnitString(status.usage.bytes, $locale), files: status.usage.objects },
        })}
      </p>
    {/if}
    {#if lastRunNote}
      <p
        class={status.lastRun?.status === CloudBackupLastRunStatus.Failed ? 'fc-refusal under' : 'fc-muted under'}
        role="status"
      >
        {lastRunNote}
      </p>
    {/if}
    {#if coverageNote}
      <p class="fc-muted under">{coverageNote}</p>
    {/if}
    {#if active}
      <div class="under">
        <p class="fc-muted" role="status">
          {#if active.state === CloudBackupRunState.Queued}
            {$t('frameleaf_cloud_backup_progress_queued')}
          {:else if task === CloudBackupTask.Verify}
            {$t('frameleaf_cloud_backup_progress_verifying', {
              values: { progress: Math.round(active.progress), checked: active.checked },
            })}
          {:else if task === CloudBackupTask.Prune}
            {$t('frameleaf_cloud_backup_progress_pruning')}
          {:else if active.progress === 0}
            {$t('frameleaf_cloud_backup_progress_starting')}
          {:else}
            {$t('frameleaf_cloud_backup_progress_running', {
              values: { progress: Math.round(active.progress), uploaded: active.uploaded },
            })}
          {/if}
        </p>
        {#if active.state === CloudBackupRunState.Running}
          <progress
            max={100}
            value={Math.round(active.progress)}
            aria-label={$t('frameleaf_cloud_backup_progress_label')}
          >
            {Math.round(active.progress)}%
          </progress>
        {/if}
        <CloudWorkControls
          operationId={active.operationId}
          runState={active.state}
          title={$t(workTitle[active.task])}
          onStatus={(next) => (status = next)}
        />
      </div>
    {/if}
  </Section>

  {#if include}
    <Section title={$t('frameleaf_backup_also_title')} description={$t('frameleaf_backup_also_description')}>
      <Row label={$t('frameleaf_backup_also_data')} help={$t('frameleaf_backup_also_data_help')}>
        <span class="always">{$t('frameleaf_backup_always')}</span>
      </Row>
      <Row
        label={$t('frameleaf_cloud_backup_include_thumbs')}
        help={$t('frameleaf_cloud_backup_include_thumbs_description')}
      >
        <Toggle
          label={$t('frameleaf_cloud_backup_include_thumbs')}
          checked={include.thumbs}
          disabled={configDisabled}
          onLabel={$t('frameleaf_kit_on')}
          offLabel={$t('frameleaf_kit_off')}
          onChange={(value) => (include.thumbs = value)}
        />
      </Row>
      <Row
        label={$t('frameleaf_cloud_backup_include_encoded_video')}
        help={$t('frameleaf_cloud_backup_include_encoded_video_description')}
      >
        <Toggle
          label={$t('frameleaf_cloud_backup_include_encoded_video')}
          checked={include.encodedVideo}
          disabled={configDisabled}
          onLabel={$t('frameleaf_kit_on')}
          offLabel={$t('frameleaf_kit_off')}
          onChange={(value) => (include.encodedVideo = value)}
        />
      </Row>
    </Section>
  {/if}

  {#if backupDraft}
    <Section title={$t('frameleaf_backup_versions_title')} description={$t('frameleaf_backup_versions_description')}>
      {#each RETENTION_FIELDS as { field, labelKey, unitKey, min, max } (field)}
        <Row label={$t(labelKey)}>
          <Amount
            label={$t(labelKey)}
            unit={$t(unitKey)}
            {min}
            {max}
            value={backupDraft.retention[field]}
            disabled={configDisabled}
            onChange={(value) => (backupDraft.retention[field] = value)}
          />
        </Row>
      {/each}
    </Section>
  {/if}

  <Section title={$t('frameleaf_backup_safety_title')}>
    {#if backupDraft}
      <Row
        label={$t('frameleaf_cloud_backup_verify_weekly')}
        help={$t('frameleaf_cloud_backup_verify_weekly_description')}
      >
        <Toggle
          label={$t('frameleaf_cloud_backup_verify_weekly')}
          checked={backupDraft.verifyWeekly}
          disabled={configDisabled}
          onLabel={$t('frameleaf_kit_on')}
          offLabel={$t('frameleaf_kit_off')}
          onChange={(value) => (backupDraft.verifyWeekly = value)}
        />
      </Row>
    {/if}
    <Row label={$t('frameleaf_backup_check_now')} help={$t('frameleaf_backup_check_now_help')}>
      <Button disabled={busy || locked || !!active || !!status.activeRestore} onclick={() => void verify()}>
        <Icon icon={mdiCheckCircleOutline} size="18" />
        {active?.task === CloudBackupTask.Verify
          ? $t('frameleaf_cloud_backup_verifying')
          : $t('frameleaf_cloud_backup_verify')}
      </Button>
    </Row>
    <Row label={$t('frameleaf_cloud_backup_recovery_file')} help={$t('frameleaf_cloud_backup_recovery_file_help')}>
      <input
        bind:this={recoveryInput}
        type="file"
        accept=".json,application/json"
        hidden
        onchange={(event) => void refreshRecoveryFile(event.currentTarget.files?.[0])}
      />
      <Button disabled={busy} onclick={() => recoveryInput?.click()}>
        <Icon icon={mdiKeyOutline} size="18" />
        {$t('frameleaf_cloud_backup_recovery_file_refresh')}
      </Button>
    </Row>
    {#if status.escrow.outdated}
      <Row
        label={$t('frameleaf_cloud_backup_escrow_outdated')}
        help={$t('frameleaf_cloud_backup_escrow_outdated_help')}
      >
        <Button disabled={busy} onclick={() => (escrowOpen = true)}>
          <Icon icon={mdiKeyOutline} size="18" />
          {$t('frameleaf_cloud_backup_escrow_update')}
        </Button>
      </Row>
    {/if}
    <Row label={$t('frameleaf_backup_restore_row')} help={$t('frameleaf_backup_restore_row_help')}>
      <a class="button" href={backupPageUrl('restore') + '#restore-cloud'}>
        <Icon icon={mdiRestore} size="18" />
        {$t('frameleaf_cloud_backup_restore_button')}
      </a>
    </Row>
    <Advanced summary={$t('frameleaf_backup_technical')}>
      <dl class="fc-facts">
        <dt>{$t('frameleaf_cloud_backup_bucket')}</dt>
        <dd><code>{status.bucket}</code></dd>
        {#if status.target !== CloudBackupTargetSetting.Managed}
          <dt>{$t('frameleaf_cloud_backup_region')}</dt>
          <dd>{status.region ?? '—'}</dd>
        {/if}
        <dt>{$t('frameleaf_cloud_backup_key')}</dt>
        <dd>{status.keyMode ? $t(modeTitle[status.keyMode]) : '—'}</dd>
        <dt>{$t('frameleaf_cloud_backup_key_fingerprint')}</dt>
        <dd><code>{status.keyFingerprint ?? '—'}</code></dd>
        {#if status.keyMode === CloudBackupKeyMode.Server}
          <dt>{$t('frameleaf_cloud_backup_escrow')}</dt>
          <dd>
            {status.escrow.stored ? $t('frameleaf_cloud_backup_escrow_on') : $t('frameleaf_cloud_backup_escrow_off')}
          </dd>
        {/if}
      </dl>
    </Advanced>
  </Section>

  <Section
    title={$t('frameleaf_cloud_backup_turn_off_title')}
    description={status?.target === CloudBackupTargetSetting.Managed
      ? $t('frameleaf_cloud_backup_turn_off_description_managed')
      : $t('frameleaf_cloud_backup_turn_off_description')}
  >
    {#snippet action()}
      <Button variant="danger" disabled={!!active} onclick={() => (turnOffOpen = true)}>
        {$t('frameleaf_cloud_backup_turn_off')}
      </Button>
    {/snippet}
  </Section>
{/if}

{#if setupOpen && status}
  <CloudBackupSetupDialog
    bind:open={setupOpen}
    {instanceId}
    dataRegion={cloudManager.status?.dataRegion ?? null}
    managedAvailable={status.managedAvailable}
    onDone={(next) => {
      status = next;
      notice = $t('frameleaf_cloud_backup_set_up_done');
    }}
  />
{/if}

<Dialog bind:open={unlockOpen} title={$t('frameleaf_cloud_backup_unlock_title')} closeLabel={$t('close')}>
  <p>{$t('frameleaf_cloud_backup_unlock_body')}</p>
  <input
    bind:this={fileInput}
    type="file"
    accept=".json,application/json"
    hidden
    onchange={(event) => {
      void readKeyFile(event.currentTarget.files?.[0]);
      event.currentTarget.value = '';
    }}
  />
  <div class="fc-actions">
    <Button onclick={() => fileInput?.click()}>
      <Icon icon={mdiUpload} size="18" />
      {$t('frameleaf_cloud_backup_choose_key_file')}
    </Button>
  </div>
  <label class="fc-stack">
    {$t('frameleaf_cloud_backup_paste_key')}
    <input
      type="password"
      autocomplete="off"
      value={unlockValue}
      oninput={(event) => (unlockValue = event.currentTarget.value)}
    />
  </label>
  {#if status?.keyFingerprint}
    <p class="fc-muted">
      {$t('frameleaf_cloud_backup_expected_fingerprint')} <code>{status.keyFingerprint}</code>
    </p>
  {/if}
  {#if unlockError}
    <p class="cc-error" role="alert">{$t(unlockError)}</p>
  {/if}
  {#if unlockFailure}
    <p class="cc-error" role="alert">{unlockFailure}</p>
  {/if}
  {#snippet actions()}
    <Button onclick={() => (unlockOpen = false)}>{$t('frameleaf_cloud_cancel')}</Button>
    <Button variant="primary" disabled={!unlockValue.trim() || busy} onclick={() => void unlock()}>
      {$t('frameleaf_cloud_backup_unlock')}
    </Button>
  {/snippet}
</Dialog>

<Dialog
  bind:open={escrowOpen}
  title={$t('frameleaf_cloud_backup_escrow_update')}
  closeLabel={$t('close')}
  onRequestClose={() => {
    // The request can't be cancelled once sent, so the dialog stays until it answers.
    if (!busy) {
      escrowOpen = false;
    }
  }}
>
  <p>{$t('frameleaf_cloud_backup_escrow_outdated_help')}</p>
  <div class="fc-form">
    <label class="fc-stack">
      {$t('frameleaf_cloud_backup_escrow_passphrase')}
      <input
        type="password"
        autocomplete="new-password"
        value={escrowPassphrase.first}
        oninput={(event) => (escrowPassphrase = { ...escrowPassphrase, first: event.currentTarget.value })}
      />
    </label>
    <label class="fc-stack">
      {$t('frameleaf_cloud_backup_escrow_passphrase_repeat')}
      <input
        type="password"
        autocomplete="new-password"
        value={escrowPassphrase.second}
        oninput={(event) => (escrowPassphrase = { ...escrowPassphrase, second: event.currentTarget.value })}
      />
    </label>
    {#if escrowPassphrase.second && !isEscrowPassphraseValid(escrowPassphrase.first, escrowPassphrase.second)}
      <small class="cc-error">{$t('frameleaf_cloud_backup_escrow_passphrase_invalid')}</small>
    {/if}
  </div>
  {#if escrowFailure}
    <p class="cc-error" role="alert">{escrowFailure}</p>
  {/if}
  {#snippet actions()}
    <Button disabled={busy} onclick={() => (escrowOpen = false)}>{$t('frameleaf_cloud_cancel')}</Button>
    <Button
      variant="primary"
      disabled={busy || !isEscrowPassphraseValid(escrowPassphrase.first, escrowPassphrase.second)}
      onclick={() => void updateEscrow()}
    >
      {$t('frameleaf_cloud_backup_escrow_update')}
    </Button>
  {/snippet}
</Dialog>

<Dialog bind:open={turnOffOpen} title={$t('frameleaf_cloud_backup_turn_off_confirm_title')} closeLabel={$t('close')}>
  <p>
    {status?.keyMode === CloudBackupKeyMode.Server
      ? $t('frameleaf_cloud_backup_turn_off_body_kit')
      : $t('frameleaf_cloud_backup_turn_off_body_key_file')}
    {status?.target === CloudBackupTargetSetting.Managed
      ? $t('frameleaf_cloud_backup_turn_off_delete_managed')
      : $t('frameleaf_cloud_backup_turn_off_delete_own')}
  </p>
  {#snippet actions()}
    <Button onclick={() => (turnOffOpen = false)}>{$t('frameleaf_cloud_backup_keep_backing_up')}</Button>
    <Button variant="primary" disabled={busy} onclick={() => void turnOff()}
      >{$t('frameleaf_cloud_backup_turn_off_confirm')}</Button
    >
  {/snippet}
</Dialog>

<style>
  .benefits,
  .under {
    margin: 0;
    padding: 0 0 var(--fl-space-5);
  }
  .always {
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  a.button {
    text-decoration: none;
  }
  progress {
    width: 100%;
    height: 6px;
    accent-color: var(--fl-accent);
  }
</style>
