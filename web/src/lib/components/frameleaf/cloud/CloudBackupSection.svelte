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
  import CloudBackupRestoreSection from '$lib/components/frameleaf/cloud/CloudBackupRestoreSection.svelte';
  import CloudBackupSetupDialog from '$lib/components/frameleaf/cloud/CloudBackupSetupDialog.svelte';
  import CloudWorkControls from '$lib/components/frameleaf/cloud/CloudWorkControls.svelte';
  import CloudBanner from '$lib/components/frameleaf/cloud/CloudBanner.svelte';
  import CloudCard from '$lib/components/frameleaf/cloud/CloudCard.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import {
    BACKUP_SCHEDULES,
    RETENTION_FIELDS,
    endpointHost,
    readBackupKeyFile,
    retentionValue,
  } from '$lib/frameleaf/cloud-backup';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    CloudBackupKeyMode,
    CloudBackupLastRunStatus,
    CloudBackupRunState,
    CloudBackupTargetSetting,
    CloudBackupTask,
    CloudBackupVerifyDepth,
    CloudBackupVerifyStatus,
    getCloudBackupStatus,
    startCloudBackupRun,
    turnOffCloudBackup,
    unlockCloudBackupKey,
    verifyCloudBackup,
    type CloudBackupStatusResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCertificateOutline,
    mdiCheckCircleOutline,
    mdiClose,
    mdiCloudUploadOutline,
    mdiContentDuplicate,
    mdiKeyOutline,
    mdiLinkVariant,
    mdiLockOutline,
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
  let unlockValue = $state('');
  let unlockError = $state<Translations | null>(null);
  let unlockFailure = $state('');
  let fileInput = $state<HTMLInputElement>();

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
    const timer = setInterval(() => void load(), ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  });

  // What a backup includes is an ordinary setting, saved with the settings bar like the other pages.
  const settingsDraft = getSystemConfigDraft();
  const include = $derived(settingsDraft?.draft.frameleafCloud?.cloudBackup?.include);
  const includeBaseline = $derived(settingsDraft?.baseline.frameleafCloud?.cloudBackup?.include);
  // FL-164: the schedule and retention are ordinary settings too
  const backupDraft = $derived(settingsDraft?.draft.frameleafCloud?.cloudBackup);
  /** What was typed into each retention input, kept while it is not a valid number yet. */
  let retentionTyped = $state<Record<string, string>>({});
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

  const headerStatus = $derived.by((): { key: Translations; tone: 'ok' | 'warning' | 'running' } => {
    if (locked || readOnly || active?.state === CloudBackupRunState.Paused) {
      return { key: 'frameleaf_cloud_backup_status_paused', tone: 'warning' };
    }
    if (active) {
      return {
        key: active.state === CloudBackupRunState.Running ? taskWords[active.task] : runWords[active.state],
        tone: 'running',
      };
    }
    return { key: 'frameleaf_cloud_backup_status_on', tone: 'ok' };
  });

  const formatWhen = (value: string | null | undefined) =>
    value ? new Intl.DateTimeFormat($locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';

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

  const showRestore = () => document.querySelector('#fc-restore-title')?.scrollIntoView({ block: 'start' });

  const setRetention = (field: (typeof RETENTION_FIELDS)[number]['field'], typed: string) => {
    retentionTyped = { ...retentionTyped, [field]: typed };
    const value = retentionValue(field, typed);
    if (value !== null && backupDraft) {
      backupDraft.retention[field] = value;
    }
  };

  const turnOff = async () => {
    if (await act(() => turnOffCloudBackup(), $t('frameleaf_cloud_backup_turned_off'))) {
      turnOffOpen = false;
    }
  };

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
  {#if !linked}
    <CloudBanner icon={mdiLinkVariant} title={$t('frameleaf_cloud_backup_gate_link_title')}>
      {$t('frameleaf_cloud_backup_gate_link_body')}
      {#snippet action()}
        <a class="fc-button" href={commandCenterUrl('cloud', 'cloud-account')}
          >{$t('frameleaf_cloud_backup_gate_link')}</a
        >
      {/snippet}
    </CloudBanner>
  {:else if !entitled}
    <CloudBanner icon={mdiCertificateOutline} title={$t('frameleaf_cloud_backup_gate_plan_title')}>
      {$t('frameleaf_cloud_backup_gate_plan_body')}
      {#snippet action()}
        <a class="fc-button" href={commandCenterUrl('cloud', 'cloud-plan')}>{$t('frameleaf_cloud_backup_gate_plan')}</a>
      {/snippet}
    </CloudBanner>
  {/if}
{/snippet}

<div class="frameleaf-cloud" data-section="cloud-backup">
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
    {@render gate()}
    <CloudCard
      icon={mdiCloudUploadOutline}
      title={$t('frameleaf_cloud_backup_off_title')}
      description={$t('frameleaf_cloud_backup_off_description')}
      status={$t('frameleaf_cloud_backup_status_off')}
    >
      <ul class="fc-benefits">
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
      <div class="fc-actions">
        <Button variant="primary" disabled={!entitled} onclick={() => (setupOpen = true)}>
          <Icon icon={mdiCloudUploadOutline} size="18" />
          {$t('frameleaf_cloud_backup_set_up')}
        </Button>
      </div>
    </CloudCard>
  {:else}
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
    <CloudCard
      icon={mdiCloudUploadOutline}
      title={status.target === CloudBackupTargetSetting.Managed
        ? $t('frameleaf_cloud_backup_managed')
        : $t('frameleaf_cloud_backup_own_bucket')}
      description={status.target === CloudBackupTargetSetting.Managed
        ? $t('frameleaf_cloud_backup_managed_description')
        : $t('frameleaf_cloud_backup_own_bucket_description', {
            values: { host: endpointHost(status.endpoint) },
          })}
      status={$t(headerStatus.key)}
      tone={headerStatus.tone}
    >
      <dl class="fc-facts">
        <dt>{$t('frameleaf_cloud_backup_bucket')}</dt>
        <dd><code>{status.bucket}</code></dd>
        {#if status.target === CloudBackupTargetSetting.Managed}
          <dt>{$t('frameleaf_cloud_backup_location')}</dt>
          <dd>
            {status.managed?.location ? `${status.managed.location.city}, ${status.managed.location.country}` : '—'}
          </dd>
        {:else}
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
        <dt>{$t('frameleaf_cloud_backup_last_verified')}</dt>
        <dd>
          {#if status.lastVerify}
            {formatWhen(status.lastVerify.at)}
            {#if status.lastVerify.status === CloudBackupVerifyStatus.Degraded}
              · {$t('frameleaf_cloud_backup_verify_degraded', {
                values: { count: status.lastVerify.missing + status.lastVerify.mismatched },
              })}
            {:else if status.lastVerify.status === CloudBackupVerifyStatus.Failed}
              · {$t('frameleaf_cloud_backup_verify_failed')}
            {/if}
          {:else}
            —
          {/if}
        </dd>
      </dl>
      {#if managed}
        {@const used = managed.usedBytes ?? status.usage?.bytes ?? 0}
        {@const allowance = managed.allowanceBytes ?? managed.quotaBytes}
        <div class="fc-meter">
          <div class="fc-meter-label">
            <span>{$t('frameleaf_cloud_backup_storage_used_label')}</span>
            <strong>
              {$t('frameleaf_cloud_backup_storage_of', {
                values: { used: getByteUnitString(used), allowance: getByteUnitString(allowance) },
              })}
            </strong>
          </div>
          <div
            class="fc-meter-track"
            class:is-high={allowance > 0 && used / allowance >= 0.9}
            role="meter"
            aria-label={$t('frameleaf_cloud_backup_storage_used_label')}
            aria-valuemin={0}
            aria-valuemax={allowance}
            aria-valuenow={used}
          >
            <span style:width="{allowance > 0 ? Math.min(100, Math.round((used / allowance) * 100)) : 0}%"></span>
          </div>
        </div>
        {#if managed.extraBlocks}
          <p class="fc-muted">
            {$t('frameleaf_cloud_backup_extra_blocks', { values: { count: managed.extraBlocks } })}
          </p>
        {/if}
      {:else if status.usage}
        <p class="fc-muted">
          {$t('frameleaf_cloud_backup_storage_used', {
            values: { size: getByteUnitString(status.usage.bytes), files: status.usage.objects },
          })}
        </p>
      {/if}
      <div class="fc-last-run">
        <h3>{$t('frameleaf_cloud_backup_last_run')}</h3>
        {#if status.lastRun && status.lastRun.status !== CloudBackupLastRunStatus.Running}
          <p>
            {$t('frameleaf_cloud_backup_last_run_summary', {
              values: {
                when: formatWhen(status.lastRun.finishedAt ?? status.lastRun.startedAt),
                uploaded: status.lastRun.uploaded,
                skipped: status.lastRun.skipped,
              },
            })}
          </p>
          {#if status.lastRun.status === CloudBackupLastRunStatus.Failed && status.lastRun.error}
            <p class="fc-refusal" role="status">
              {$t('frameleaf_cloud_backup_last_run_failed', { values: { error: status.lastRun.error } })}
            </p>
          {:else if status.lastRun.status === CloudBackupLastRunStatus.Cancelled}
            <p class="fc-muted">{$t('frameleaf_cloud_backup_last_run_cancelled')}</p>
          {:else if status.lastRun.status === CloudBackupLastRunStatus.WaitingForKey}
            <p class="fc-muted">{$t('frameleaf_cloud_backup_last_run_waiting')}</p>
          {/if}
          {#if status.lastRun.missing > 0}
            <p class="fc-muted">
              {$t('frameleaf_cloud_backup_last_run_missing', { values: { count: status.lastRun.missing } })}
            </p>
          {/if}
        {:else if !active}
          <p class="fc-muted">{$t('frameleaf_cloud_backup_no_run')}</p>
        {/if}
        {#if status.lastSuccessAt}
          <p class="fc-muted">
            {$t('frameleaf_cloud_backup_last_success', { values: { when: formatWhen(status.lastSuccessAt) } })}
          </p>
        {/if}
        {#if active}
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
        {/if}
      </div>
      <div class="fc-actions">
        <Button
          variant="primary"
          disabled={busy || locked || readOnly || !!active || !!status.activeRestore || !entitled}
          onclick={() => void backUpNow()}
        >
          <Icon icon={mdiUpload} size="18" />
          {active ? $t(runWords[active.state]) : $t('frameleaf_cloud_backup_back_up_now')}
        </Button>
        <Button disabled={busy || locked || !!active || !!status.activeRestore} onclick={() => void verify()}>
          <Icon icon={mdiCheckCircleOutline} size="18" />
          {active?.task === CloudBackupTask.Verify
            ? $t('frameleaf_cloud_backup_verifying')
            : $t('frameleaf_cloud_backup_verify')}
        </Button>
        <Button onclick={showRestore}>
          <Icon icon={mdiRestore} size="18" />
          {$t('frameleaf_cloud_backup_restore_button')}
        </Button>
      </div>
    </CloudCard>

    <CloudBackupRestoreSection {status} {formatWhen} onStatus={(next) => (status = next)} />

    {#if backupDraft}
      <CloudCard
        title={$t('frameleaf_cloud_backup_schedule_title')}
        description={$t('frameleaf_cloud_backup_schedule_description')}
      >
        <label class="fc-stack">
          {$t('frameleaf_cloud_backup_schedule_run')}
          <select
            value={backupDraft.schedule.cronExpression}
            disabled={configDisabled}
            onchange={(event) => (backupDraft.schedule.cronExpression = event.currentTarget.value)}
          >
            {#each BACKUP_SCHEDULES as schedule (schedule.cron)}
              <option value={schedule.cron}>{$t(schedule.labelKey)}</option>
            {/each}
            {#if BACKUP_SCHEDULES.every((schedule) => schedule.cron !== backupDraft.schedule.cronExpression)}
              <option value={backupDraft.schedule.cronExpression}>{backupDraft.schedule.cronExpression}</option>
            {/if}
          </select>
          <small class="fc-muted">{$t('frameleaf_cloud_backup_schedule_help')}</small>
        </label>
        {#each RETENTION_FIELDS as { field, labelKey, unitKey, min, max } (field)}
          {@const typed = retentionTyped[field]}
          <label class="fc-stack">
            {$t(labelKey)}
            <span class="fc-input-unit">
              <input
                type="number"
                {min}
                {max}
                step="1"
                disabled={configDisabled}
                aria-invalid={typed !== undefined && retentionValue(field, typed) === null}
                value={typed ?? String(backupDraft.retention[field])}
                oninput={(event) => setRetention(field, event.currentTarget.value)}
              />
              <span>{$t(unitKey)}</span>
            </span>
          </label>
        {/each}
        <SettingToggle
          title={$t('frameleaf_cloud_backup_verify_weekly')}
          subtitle={$t('frameleaf_cloud_backup_verify_weekly_description')}
          checked={backupDraft.verifyWeekly}
          disabled={configDisabled}
          isEdited={backupDraft.verifyWeekly !== settingsDraft?.baseline.frameleafCloud?.cloudBackup?.verifyWeekly}
          onToggle={(value) => (backupDraft.verifyWeekly = value)}
        />
      </CloudCard>
    {/if}

    {#if include}
      <CloudCard
        title={$t('frameleaf_cloud_backup_include_title')}
        description={$t('frameleaf_cloud_backup_include_description')}
      >
        <SettingToggle
          title={$t('frameleaf_cloud_backup_include_thumbs')}
          subtitle={$t('frameleaf_cloud_backup_include_thumbs_description')}
          checked={include.thumbs}
          disabled={configDisabled}
          isEdited={include.thumbs !== includeBaseline?.thumbs}
          onToggle={(value) => (include.thumbs = value)}
        />
        <SettingToggle
          title={$t('frameleaf_cloud_backup_include_encoded_video')}
          subtitle={$t('frameleaf_cloud_backup_include_encoded_video_description')}
          checked={include.encodedVideo}
          disabled={configDisabled}
          isEdited={include.encodedVideo !== includeBaseline?.encodedVideo}
          onToggle={(value) => (include.encodedVideo = value)}
        />
      </CloudCard>
    {/if}

    <CloudCard
      title={$t('frameleaf_cloud_backup_turn_off_title')}
      description={status?.target === CloudBackupTargetSetting.Managed
        ? $t('frameleaf_cloud_backup_turn_off_description_managed')
        : $t('frameleaf_cloud_backup_turn_off_description')}
    >
      <div class="fc-actions">
        <Button disabled={!!active} onclick={() => (turnOffOpen = true)}>{$t('frameleaf_cloud_backup_turn_off')}</Button
        >
      </div>
    </CloudCard>
  {/if}
</div>

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
