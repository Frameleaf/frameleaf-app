<script lang="ts">
  /**
   * "Set up cloud backup" (FL-160): the prototype's `BackupSetup`
   * (design/frameleaf/template/src/FrameleafCloud.jsx). Steps: Destination (your own bucket, checked for
   * SSE-C), Encryption key ("Generate a key for me" or "I'll maintain my own key"), the Recovery kit for
   * a generated key, and Claim bucket, which claims it on the server and turns backup on.
   *
   * An own key is made in this browser and must be downloaded, and saved somewhere other than this
   * server, before Continue is enabled; without a copy on this server (own-memory) the administrator
   * also types "I understand". A generated key is made by the server and shown once, in the kit. The
   * key goes to this server only to claim the bucket (and, in the stored modes, to keep); it is never
   * sent to Frameleaf Cloud, and it is forgotten here when the dialog closes.
   */
  import './frameleaf-cloud.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import CloudToggleRow from '$lib/components/frameleaf/cloud/CloudToggleRow.svelte';
  import RecoveryKitPanel from '$lib/components/frameleaf/cloud/RecoveryKitPanel.svelte';
  import {
    BUCKET_MARKER,
    backupKeyFile,
    bucketSettingsErrors,
    createBackupKey,
    isOwnMemoryAcknowledged,
    keyFileName,
    recoveryKitText,
    type BackupKey,
  } from '$lib/frameleaf/cloud-backup';
  import { downloadBlob } from '$lib/utils';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    checkCloudBackupBucket,
    CloudBackupKeyMode,
    CloudBackupTarget,
    generateCloudBackupKey,
    setupCloudBackup,
    type CloudBackupGeneratedKeyDto,
    type CloudBackupStatusResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiAlertCircleOutline,
    mdiAlertOutline,
    mdiCheck,
    mdiCheckCircleOutline,
    mdiDownloadOutline,
    mdiLockOutline,
    mdiServerOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    open: boolean;
    instanceId: string;
    managedAvailable: boolean;
    onDone: (status: CloudBackupStatusResponseDto) => void;
  };

  let { open = $bindable(), instanceId, managedAvailable, onDone }: Props = $props();

  type Step = 'destination' | 'key' | 'kit' | 'claim';

  let step = $state(0);
  let target = $state<'managed' | 'byo'>('byo');
  let settings = $state({ endpoint: 'https://', bucket: '', accessKeyId: '', secretAccessKey: '' });
  let probe = $state<{ ok: boolean; message: string } | null>(null);
  let checking = $state(false);
  let keyChoice = $state<'generated' | 'own'>('generated');
  let storeOwnKey = $state(true);
  let ownKey = $state<BackupKey | null>(null);
  let generated = $state<CloudBackupGeneratedKeyDto | null>(null);
  let downloaded = $state(false);
  let savedKey = $state(false);
  let typed = $state('');
  let kitSaved = $state(false);
  let busy = $state(false);
  let failure = $state('');
  let claim = $state<{ ok: boolean; message: string; status?: CloudBackupStatusResponseDto } | null>(null);

  const keyMode = $derived(
    keyChoice === 'generated'
      ? CloudBackupKeyMode.Server
      : storeOwnKey
        ? CloudBackupKeyMode.OwnStored
        : CloudBackupKeyMode.OwnMemory,
  );
  const serverKey = $derived(keyMode === CloudBackupKeyMode.Server);
  const steps = $derived<Step[]>(['destination', 'key', ...(serverKey ? (['kit'] as const) : []), 'claim']);
  const current = $derived(steps[step]);
  // Your own bucket is the only destination that can be chosen until Frameleaf-managed storage is offered.
  const errors = $derived(bucketSettingsErrors(settings));
  const bucketName = $derived(settings.bucket.trim());
  const stepLabels: Record<Step, string> = $derived({
    destination: $t('frameleaf_cloud_backup_step_destination'),
    key: $t('frameleaf_cloud_backup_step_key'),
    kit: $t('frameleaf_cloud_backup_step_kit'),
    claim: $t('frameleaf_cloud_backup_step_claim'),
  });

  const canContinue = $derived.by(() => {
    switch (current) {
      case 'destination': {
        return target === 'byo' && Object.keys(errors).length === 0 && !!probe?.ok;
      }
      case 'key': {
        return (
          serverKey ||
          (downloaded && savedKey && (keyMode !== CloudBackupKeyMode.OwnMemory || isOwnMemoryAcknowledged(typed)))
        );
      }
      case 'kit': {
        return kitSaved;
      }
      case 'claim': {
        return !!claim?.ok;
      }
    }
  });

  const kit = $derived(
    generated
      ? recoveryKitText({
          heading: $t('frameleaf_cloud_backup_kit_heading'),
          instance: $t('frameleaf_cloud_backup_kit_instance', { values: { instanceId } }),
          bucket: $t('frameleaf_cloud_backup_kit_bucket', { values: { bucket: bucketName } }),
          fingerprint: $t('frameleaf_cloud_backup_kit_fingerprint', { values: { fingerprint: generated.fingerprint } }),
          keep: $t('frameleaf_cloud_backup_kit_keep'),
          code: $t('frameleaf_cloud_backup_kit_code', { values: { code: generated.recoveryCode } }),
        })
      : '',
  );

  const fields = [
    { field: 'endpoint', labelKey: 'frameleaf_cloud_backup_endpoint', type: 'url' },
    { field: 'bucket', labelKey: 'frameleaf_cloud_backup_bucket', type: 'text' },
    { field: 'accessKeyId', labelKey: 'frameleaf_cloud_backup_access_key', type: 'text' },
    { field: 'secretAccessKey', labelKey: 'frameleaf_cloud_backup_secret', type: 'password' },
  ] as const;

  /** A field shows its problem once something was typed into it. */
  const problemOf = (field: keyof typeof settings) =>
    settings[field] !== '' && settings[field] !== 'https://' ? errors[field] : undefined;

  const back = () => {
    if (step > 0 && !claim?.ok) {
      step -= 1;
      return;
    }
    open = false;
  };

  const s3 = () => ({
    endpoint: settings.endpoint.trim(),
    bucket: bucketName,
    accessKeyId: settings.accessKeyId.trim(),
    secretAccessKey: settings.secretAccessKey,
  });

  const edit = (field: keyof typeof settings, value: string) => {
    settings = { ...settings, [field]: value };
    probe = null;
  };

  const check = async () => {
    checking = true;
    try {
      probe = await checkCloudBackupBucket({ cloudBackupCheckDto: { s3: s3() } });
    } catch (error) {
      probe = { ok: false, message: getServerErrorMessage(error) ?? $t('frameleaf_cloud_backup_check_failed') };
    } finally {
      checking = false;
    }
  };

  const chooseKey = (choice: 'generated' | 'own') => {
    keyChoice = choice;
    downloaded = false;
    savedKey = false;
    typed = '';
  };

  const downloadKey = () => {
    if (!ownKey) {
      return;
    }
    const file = backupKeyFile({ ...ownKey, instanceId, bucket: bucketName, mode: keyMode });
    downloadBlob(new Blob([file], { type: 'application/json' }), keyFileName(ownKey.fingerprint));
    downloaded = true;
  };

  const next = async () => {
    failure = '';
    if (current === 'destination') {
      ownKey ??= createBackupKey();
    }
    if (current === 'key' && serverKey && !generated) {
      busy = true;
      try {
        generated = await generateCloudBackupKey();
      } catch (error) {
        failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
        return;
      } finally {
        busy = false;
      }
    }
    step += 1;
  };

  const claimBucket = async () => {
    const key = serverKey ? generated?.key : ownKey?.key;
    if (!key) {
      return;
    }
    busy = true;
    try {
      const status = await setupCloudBackup({
        cloudBackupSetupDto: {
          target: CloudBackupTarget.ByoS3,
          s3: s3(),
          keyMode,
          key,
          ...(keyMode === CloudBackupKeyMode.OwnMemory && { acknowledgement: typed }),
        },
      });
      claim = { ok: true, message: $t('frameleaf_cloud_backup_claimed'), status };
    } catch (error) {
      claim = { ok: false, message: getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed') };
    } finally {
      busy = false;
    }
  };

  const finish = () => {
    if (claim?.status) {
      onDone(claim.status);
    }
    open = false;
  };
</script>

<Dialog bind:open title={$t('frameleaf_cloud_backup_setup_title')} closeLabel={$t('close')} wide>
  <ol class="fc-steps" aria-label={$t('frameleaf_cloud_backup_steps')}>
    {#each steps as name, index (name)}
      <li aria-current={index === step ? 'step' : undefined} class:is-done={index < step}>
        <span>
          {#if index < step}
            <Icon icon={mdiCheck} size="14" />
          {:else}
            {index + 1}
          {/if}
        </span>
        {stepLabels[name]}
      </li>
    {/each}
  </ol>

  {#if current === 'destination'}
    <fieldset class="fc-choices">
      <legend>{$t('frameleaf_cloud_backup_where')}</legend>
      <label class:is-selected={target === 'managed'}>
        <input
          type="radio"
          name="fc-target"
          checked={target === 'managed'}
          disabled={!managedAvailable}
          onchange={() => (target = 'managed')}
        />
        <strong>{$t('frameleaf_cloud_backup_managed')}</strong>
        <span>
          {managedAvailable
            ? $t('frameleaf_cloud_backup_managed_body')
            : $t('frameleaf_cloud_backup_managed_unavailable')}
        </span>
      </label>
      <label class:is-selected={target === 'byo'}>
        <input type="radio" name="fc-target" checked={target === 'byo'} onchange={() => (target = 'byo')} />
        <strong>{$t('frameleaf_cloud_backup_byo')}</strong>
        <span>{$t('frameleaf_cloud_backup_byo_body')}</span>
      </label>
    </fieldset>
    {#if target === 'byo'}
      <div class="fc-form">
        {#each fields as { field, labelKey, type } (field)}
          {@const problem = problemOf(field)}
          <label class="fc-stack">
            {$t(labelKey)}
            <input
              {type}
              value={settings[field]}
              autocomplete="off"
              spellcheck={false}
              aria-invalid={!!problem}
              oninput={(event) => edit(field, event.currentTarget.value)}
            />
            {#if field === 'secretAccessKey'}
              <small class="fc-muted">{$t('frameleaf_cloud_backup_secret_help')}</small>
            {/if}
            {#if problem}
              <small class="cc-error">{$t(problem)}</small>
            {/if}
          </label>
        {/each}
        <div class="fc-actions">
          <Button disabled={Object.keys(errors).length > 0 || checking} onclick={() => void check()}>
            {checking ? $t('frameleaf_cloud_backup_checking') : $t('frameleaf_cloud_backup_check')}
          </Button>
        </div>
        {#if probe}
          <p class={probe.ok ? 'fc-ok' : 'fc-refusal'} role="status">
            <Icon icon={probe.ok ? mdiCheckCircleOutline : mdiAlertCircleOutline} size="18" />
            {probe.message}
          </p>
        {/if}
      </div>
    {/if}
  {:else if current === 'key'}
    <p class="fc-muted">{$t('frameleaf_cloud_backup_key_intro')}</p>
    <fieldset class="fc-choices">
      <legend>{$t('frameleaf_cloud_backup_key_legend')}</legend>
      <label class:is-selected={keyChoice === 'generated'}>
        <input
          type="radio"
          name="fc-key-choice"
          checked={keyChoice === 'generated'}
          onchange={() => chooseKey('generated')}
        />
        <strong>{$t('frameleaf_cloud_backup_key_generated')}</strong>
        <span>{$t('frameleaf_cloud_backup_key_generated_body')}</span>
        <em><Icon icon={mdiAlertOutline} size="14" /> {$t('frameleaf_cloud_backup_key_generated_warning')}</em>
      </label>
      <label class:is-selected={keyChoice === 'own'}>
        <input type="radio" name="fc-key-choice" checked={keyChoice === 'own'} onchange={() => chooseKey('own')} />
        <strong>{$t('frameleaf_cloud_backup_key_own')}</strong>
        <span>{$t('frameleaf_cloud_backup_key_own_body')}</span>
        <em><Icon icon={mdiAlertOutline} size="14" /> {$t('frameleaf_cloud_backup_key_own_warning')}</em>
      </label>
    </fieldset>
    {#if !serverKey && ownKey}
      <div class="fc-key-card">
        <dl class="fc-facts">
          <dt>{$t('frameleaf_cloud_backup_key_fingerprint')}</dt>
          <dd><code>{ownKey.fingerprint}</code></dd>
          <dt>{$t('frameleaf_cloud_backup_key_created')}</dt>
          <dd>{$t('frameleaf_cloud_backup_key_created_here')}</dd>
        </dl>
        <div class="fc-actions">
          <Button variant={downloaded ? 'default' : 'primary'} onclick={downloadKey}>
            <Icon icon={downloaded ? mdiCheck : mdiDownloadOutline} size="18" />
            {downloaded ? $t('frameleaf_cloud_backup_key_downloaded') : $t('frameleaf_cloud_backup_key_download')}
          </Button>
        </div>
        {#if !downloaded}
          <p class="fc-muted" role="status">
            <Icon icon={mdiLockOutline} size="14" />
            {$t('frameleaf_cloud_backup_key_download_first')}
          </p>
        {/if}
        <label class="fc-confirm">
          <input
            type="checkbox"
            checked={savedKey}
            disabled={!downloaded}
            onchange={(event) => (savedKey = event.currentTarget.checked)}
          />
          {$t('frameleaf_cloud_backup_key_saved_elsewhere')}
        </label>
        <CloudToggleRow
          label={$t('frameleaf_cloud_backup_keep_copy')}
          help={storeOwnKey ? $t('frameleaf_cloud_backup_keep_copy_on') : $t('frameleaf_cloud_backup_keep_copy_off')}
          checked={storeOwnKey}
          onChange={(value) => {
            storeOwnKey = value;
            typed = '';
          }}
        />
        {#if keyMode === CloudBackupKeyMode.OwnMemory}
          <label class="fc-stack">
            {$t('frameleaf_cloud_backup_acknowledge')}
            <input value={typed} autocomplete="off" oninput={(event) => (typed = event.currentTarget.value)} />
          </label>
        {/if}
      </div>
    {/if}
  {:else if current === 'kit'}
    <RecoveryKitPanel {kit} saved={kitSaved} onSavedChange={(saved) => (kitSaved = saved)} />
  {:else}
    <p>{$t('frameleaf_cloud_backup_claim_body', { values: { marker: BUCKET_MARKER } })}</p>
    <dl class="fc-facts">
      <dt>{$t('frameleaf_cloud_backup_bucket')}</dt>
      <dd><code>{bucketName}</code></dd>
      <dt>{$t('frameleaf_cloud_backup_instance')}</dt>
      <dd><code>{instanceId}</code></dd>
    </dl>
    <div class="fc-actions">
      <Button variant={claim ? 'default' : 'primary'} disabled={busy || !!claim?.ok} onclick={() => void claimBucket()}>
        <Icon icon={mdiServerOutline} size="18" />
        {busy ? $t('frameleaf_cloud_backup_claiming') : $t('frameleaf_cloud_backup_claim')}
      </Button>
    </div>
    {#if claim}
      <p class={claim.ok ? 'fc-ok' : 'fc-refusal'} role="status">
        <Icon icon={claim.ok ? mdiCheckCircleOutline : mdiAlertCircleOutline} size="18" />
        {claim.message}
      </p>
    {/if}
  {/if}

  {#if failure}
    <p class="fc-notice is-error" role="alert">{failure}</p>
  {/if}

  {#snippet actions()}
    <Button onclick={back}>
      {step > 0 && !claim?.ok ? $t('frameleaf_cloud_backup_back') : $t('frameleaf_cloud_cancel')}
    </Button>
    {#if current === 'claim' && claim?.ok}
      <Button variant="primary" onclick={finish}>{$t('frameleaf_cloud_backup_finish')}</Button>
    {:else if current !== 'claim'}
      <Button variant="primary" disabled={!canContinue || busy} onclick={() => void next()}>
        {$t('frameleaf_cloud_backup_continue')}
      </Button>
    {/if}
  {/snippet}
</Dialog>
