<script lang="ts">
  /**
   * Settings › Frameleaf Cloud › Cloud backup (FL-160): the prototype's `Backup`
   * (design/frameleaf/template/src/FrameleafCloud.jsx) on the server's real backup agent. Not set up:
   * what it does and "Set up cloud backup". Set up: the bucket, the key mode and fingerprint (never the
   * key), storage used, the last run and the run in progress with "Back up now"; in own-memory mode a
   * banner while the key is not loaded, with Unlock; and turning it off. Schedule, retention,
   * verification, restore and escrow arrive with CLD-302 (FL-164).
   */
  import './frameleaf-cloud.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import CloudBackupSetupDialog from '$lib/components/frameleaf/cloud/CloudBackupSetupDialog.svelte';
  import CloudBanner from '$lib/components/frameleaf/cloud/CloudBanner.svelte';
  import CloudCard from '$lib/components/frameleaf/cloud/CloudCard.svelte';
  import { endpointHost, readBackupKeyFile } from '$lib/frameleaf/cloud-backup';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    CloudBackupKeyMode,
    CloudBackupLastRunStatus,
    CloudBackupRunState,
    CloudBackupTargetSetting,
    getCloudBackupStatus,
    startCloudBackupRun,
    turnOffCloudBackup,
    unlockCloudBackupKey,
    type CloudBackupStatusResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiCertificateOutline,
    mdiClose,
    mdiCloudUploadOutline,
    mdiContentDuplicate,
    mdiKeyOutline,
    mdiLinkVariant,
    mdiLockOutline,
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

  // While a run is queued or running, read its progress again; the timer goes with the run or the page.
  $effect(() => {
    if (!status?.activeRun) {
      return;
    }
    const timer = setInterval(() => void load(), ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  });

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

  const runWords: Record<CloudBackupRunState, Translations> = {
    [CloudBackupRunState.Queued]: 'frameleaf_cloud_backup_run_queued',
    [CloudBackupRunState.Running]: 'frameleaf_cloud_backup_run_running',
    [CloudBackupRunState.Pausing]: 'frameleaf_cloud_backup_run_pausing',
    [CloudBackupRunState.Paused]: 'frameleaf_cloud_backup_run_paused',
    [CloudBackupRunState.Cancelling]: 'frameleaf_cloud_backup_run_cancelling',
  };

  const headerStatus = $derived.by((): { key: Translations; tone: 'ok' | 'warning' | 'running' } => {
    if (locked || active?.state === CloudBackupRunState.Paused) {
      return { key: 'frameleaf_cloud_backup_status_paused', tone: 'warning' };
    }
    if (active) {
      return { key: runWords[active.state], tone: 'running' };
    }
    return { key: 'frameleaf_cloud_backup_status_on', tone: 'ok' };
  });

  const formatWhen = (value: string | null | undefined) =>
    value
      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
      : '—';

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
    <p class={loadError ? 'fc-notice is-error' : 'fc-muted'} role={loadError ? 'alert' : 'status'}>
      {loadError ? $t('frameleaf_cloud_backup_load_failed') : $t('frameleaf_cloud_loading')}
    </p>
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
      description={$t('frameleaf_cloud_backup_own_bucket_description', {
        values: { host: endpointHost(status.endpoint) },
      })}
      status={$t(headerStatus.key)}
      tone={headerStatus.tone}
    >
      <dl class="fc-facts">
        <dt>{$t('frameleaf_cloud_backup_bucket')}</dt>
        <dd><code>{status.bucket}</code></dd>
        <dt>{$t('frameleaf_cloud_backup_region')}</dt>
        <dd>{status.region ?? '—'}</dd>
        <dt>{$t('frameleaf_cloud_backup_key')}</dt>
        <dd>{status.keyMode ? $t(modeTitle[status.keyMode]) : '—'}</dd>
        <dt>{$t('frameleaf_cloud_backup_key_fingerprint')}</dt>
        <dd><code>{status.keyFingerprint ?? '—'}</code></dd>
      </dl>
      {#if status.usage}
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
            {active.state === CloudBackupRunState.Queued
              ? $t('frameleaf_cloud_backup_progress_queued')
              : $t('frameleaf_cloud_backup_progress_running', {
                  values: { progress: Math.round(active.progress), uploaded: active.uploaded },
                })}
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
        {/if}
      </div>
      <div class="fc-actions">
        <Button variant="primary" disabled={busy || locked || !!active || !entitled} onclick={() => void backUpNow()}>
          <Icon icon={mdiUpload} size="18" />
          {active ? $t(runWords[active.state]) : $t('frameleaf_cloud_backup_back_up_now')}
        </Button>
      </div>
    </CloudCard>

    <CloudCard
      title={$t('frameleaf_cloud_backup_turn_off_title')}
      description={$t('frameleaf_cloud_backup_turn_off_description')}
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
  </p>
  {#snippet actions()}
    <Button onclick={() => (turnOffOpen = false)}>{$t('frameleaf_cloud_backup_keep_backing_up')}</Button>
    <Button variant="primary" disabled={busy} onclick={() => void turnOff()}
      >{$t('frameleaf_cloud_backup_turn_off_confirm')}</Button
    >
  {/snippet}
</Dialog>
