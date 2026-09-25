<script lang="ts">
  /**
   * Settings → Frameleaf Cloud → Account & link (FL-154, FL-155): the prototype's `AccountLink`
   * (design/frameleaf/template/src/FrameleafCloud.jsx:438-782, effd05ffb7) on real server state.
   * States: not configured (no FRAMELEAF_CLOUD_URL), not linked, waiting for approval of a device
   * code (code, QR, countdown, key fingerprint), linked (account, dates, instance ID, apps card,
   * permission toggles, "What this server sends", unlink) and revoked (the cloud's reason).
   * Nothing is simulated: every change goes through `admin/cloud/*`.
   */
  import './cloud-account.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import QrCode from '$lib/components/frameleaf/QrCode.svelte';
  import CloudBanner from '$lib/components/frameleaf/cloud/CloudBanner.svelte';
  import CloudCard from '$lib/components/frameleaf/cloud/CloudCard.svelte';
  import CloudToggleRow from '$lib/components/frameleaf/cloud/CloudToggleRow.svelte';
  import { displayHost, formatCountdown, secondsUntil, shortFingerprint } from '$lib/frameleaf/cloud';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import type { CloudHeartbeatField, CloudPermissionsDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiCellphone,
    mdiCheck,
    mdiClose,
    mdiCloudCheckOutline,
    mdiCloudOffOutline,
    mdiCloudOutline,
    mdiCloudSyncOutline,
    mdiCloudUploadOutline,
    mdiEarth,
    mdiInformationOutline,
    mdiLinkOff,
    mdiLinkVariant,
    mdiProgressClock,
    mdiQrcode,
    mdiRefresh,
    mdiServerOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  onMount(() => cloudManager.listen());

  const status = $derived(cloudManager.status);
  let notice = $state('');
  let failure = $state('');
  let busy = $state(false);
  let unlinking = $state(false);
  let understood = $state(false);
  let now = $state(Date.now());

  $effect(() => {
    if (status?.state !== 'pending') {
      return;
    }
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  const left = $derived(secondsUntil(status?.pending?.expiresAt, now));
  const expired = $derived(status?.state === 'pending' && left === 0);

  const formatWhen = (value: string | null | undefined) =>
    value
      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
      : '—';

  const act = async (call: () => Promise<unknown>, success = '') => {
    busy = true;
    failure = '';
    try {
      await call();
      notice = success;
      return true;
    } catch (error) {
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
      return false;
    } finally {
      busy = false;
    }
  };

  const permission = (key: keyof CloudPermissionsDto, value: boolean) =>
    act(() => cloudManager.setPermissions({ [key]: value }));

  const heartbeatLabel = (field: CloudHeartbeatField) => $t(`frameleaf_cloud_sends_${field}` as Translations);
  const heartbeatHelp = (field: CloudHeartbeatField) => $t(`frameleaf_cloud_sends_${field}_help` as Translations);

  const unlinkConsequences = $derived([
    $t('frameleaf_cloud_unlink_consequence_remote'),
    $t('frameleaf_cloud_unlink_consequence_processing'),
    $t('frameleaf_cloud_unlink_consequence_backup'),
    $t('frameleaf_cloud_unlink_consequence_accounts'),
    $t('frameleaf_cloud_unlink_consequence_local'),
  ]);
</script>

{#snippet headless()}
  <details class="fc-disclosure fl-continuous-corners">
    <summary><Icon icon={mdiServerOutline} size="18" /> {$t('frameleaf_cloud_headless_title')}</summary>
    <p class="fc-muted">
      {$t('frameleaf_cloud_headless_body')}
      <code>FRAMELEAF_LINK_TOKEN=fll_…</code>
    </p>
    {#if status?.linkTokenConfigured}
      <p class="fc-muted">{$t('frameleaf_cloud_headless_configured')}</p>
    {/if}
  </details>
{/snippet}

<div class="frameleaf-cloud" data-section="cloud-account">
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
    {#if cloudManager.error}
      <p class="fc-notice is-error" role="alert">{$t('frameleaf_cloud_status_unavailable')}</p>
    {:else}
      <p class="fc-muted" role="status">{$t('frameleaf_cloud_loading')}</p>
    {/if}
  {:else if status.state === 'not-configured'}
    <CloudCard
      icon={mdiCloudOffOutline}
      title={$t('frameleaf_cloud_not_configured_title')}
      description={$t('frameleaf_cloud_not_configured_description')}
      status={$t('frameleaf_cloud_status_not_configured')}
    >
      <p class="fc-muted">{$t('frameleaf_cloud_not_configured_help')}</p>
    </CloudCard>
  {:else if status.state === 'unlinked' || status.state === 'revoked'}
    {#if status.state === 'revoked'}
      <CloudBanner tone="danger" title={$t('frameleaf_cloud_revoked_title')}>
        {status.revoked?.reason || $t('frameleaf_cloud_revoked_no_reason')}
        {$t('frameleaf_cloud_revoked_help')}
      </CloudBanner>
    {:else if status.linkResult === 'denied'}
      <CloudBanner tone="warning" title={$t('frameleaf_cloud_link_denied_title')}>
        {$t('frameleaf_cloud_link_denied_body')}
      </CloudBanner>
    {:else if status.linkResult === 'expired'}
      <CloudBanner tone="warning" title={$t('frameleaf_cloud_link_expired_title')}>
        {$t('frameleaf_cloud_link_expired_body')}
      </CloudBanner>
    {/if}
    {#if status.lastError && status.state === 'unlinked'}
      <CloudBanner tone="warning" title={$t('frameleaf_cloud_last_problem')}>{status.lastError}</CloudBanner>
    {/if}
    <CloudCard
      icon={mdiCloudOutline}
      title={$t('frameleaf_cloud_unlinked_title')}
      description={$t('frameleaf_cloud_unlinked_description')}
      status={status.state === 'revoked'
        ? $t('frameleaf_cloud_status_revoked')
        : $t('frameleaf_cloud_status_not_linked')}
      tone={status.state === 'revoked' ? 'danger' : 'muted'}
    >
      <ul class="fc-benefits">
        <li>
          <Icon icon={mdiCellphone} size="18" />
          <span>
            <strong>{$t('frameleaf_cloud_benefit_apps_title')}</strong>
            {$t('frameleaf_cloud_benefit_apps_body')}
          </span>
        </li>
        <li>
          <Icon icon={mdiEarth} size="18" />
          <span
            ><strong>{$t('frameleaf_cloud_benefit_remote_title')}</strong>
            {$t('frameleaf_cloud_benefit_remote_body')}</span
          >
        </li>
        <li>
          <Icon icon={mdiCloudSyncOutline} size="18" />
          <span>
            <strong>{$t('frameleaf_cloud_benefit_processing_title')}</strong>
            {$t('frameleaf_cloud_benefit_processing_body')}
          </span>
        </li>
        <li>
          <Icon icon={mdiCloudUploadOutline} size="18" />
          <span
            ><strong>{$t('frameleaf_cloud_benefit_backup_title')}</strong>
            {$t('frameleaf_cloud_benefit_backup_body')}</span
          >
        </li>
      </ul>
      <p class="fc-muted">{$t('frameleaf_cloud_unlinked_how', { values: { host: status.cloudHost } })}</p>
      <div class="fc-actions">
        <Button
          variant="primary"
          disabled={busy}
          onclick={() => void act(() => cloudManager.startLink(), $t('frameleaf_cloud_link_started'))}
        >
          <Icon icon={mdiLinkVariant} size="18" />
          {$t('frameleaf_cloud_link_action')}
        </Button>
        {#if status.state === 'revoked'}
          <Button
            disabled={busy}
            onclick={() => void act(() => cloudManager.unlink(), $t('frameleaf_cloud_forgotten'))}
          >
            {$t('frameleaf_cloud_forget_link')}
          </Button>
        {/if}
      </div>
    </CloudCard>
    {@render headless()}
  {:else if status.state === 'pending' && status.pending}
    {@const pending = status.pending}
    <CloudCard
      icon={mdiQrcode}
      title={$t('frameleaf_cloud_pending_title', { values: { host: displayHost(pending.verificationUri) } })}
      description={$t('frameleaf_cloud_pending_description')}
      status={expired ? $t('frameleaf_cloud_code_expired') : $t('frameleaf_cloud_waiting')}
      tone={expired ? 'danger' : 'running'}
    >
      <div class="fc-device-code">
        <div>
          <p class="fc-overline">{$t('frameleaf_cloud_your_code')}</p>
          <p class="fc-code" class:is-expired={expired} aria-live="polite">{pending.userCode}</p>
          <p>
            {$t('frameleaf_cloud_go_to')}
            <a href={pending.verificationUriComplete} target="_blank" rel="noopener noreferrer">
              {displayHost(pending.verificationUri)}
            </a>
            {$t('frameleaf_cloud_enter_code')}
          </p>
          <dl class="fc-facts">
            <dt>{$t('frameleaf_cloud_expires_in')}</dt>
            <dd>{expired ? $t('frameleaf_cloud_expired') : formatCountdown(left)}</dd>
            <dt>{$t('frameleaf_cloud_server_key')}</dt>
            <dd><code title={status.keyFingerprint ?? ''}>{shortFingerprint(status.keyFingerprint)}</code></dd>
          </dl>
          <p class="fc-muted">{$t('frameleaf_cloud_pending_check')}</p>
          {#if !expired}
            <p class="fc-waiting"><Icon icon={mdiProgressClock} size="18" /> {$t('frameleaf_cloud_waiting')}</p>
          {/if}
          {#if status.lastError}
            <p class="fc-muted" role="status">{status.lastError}</p>
          {/if}
        </div>
        <QrCode
          value={pending.verificationUriComplete}
          size={168}
          label={$t('frameleaf_cloud_qr_label')}
          copyLabel={$t('frameleaf_cloud_qr_copy')}
          downloadLabel={$t('frameleaf_cloud_qr_download')}
          errorLabel={$t('frameleaf_cloud_qr_error')}
          showActions={false}
        />
      </div>
      <div class="fc-actions">
        <Button
          variant={expired ? 'primary' : 'default'}
          disabled={busy}
          onclick={() => void act(() => cloudManager.startLink(), $t('frameleaf_cloud_new_code_ready'))}
        >
          <Icon icon={mdiRefresh} size="18" />
          {$t('frameleaf_cloud_new_code')}
        </Button>
        <Button
          disabled={busy}
          onclick={() => void act(() => cloudManager.cancelLink(), $t('frameleaf_cloud_link_cancelled'))}
        >
          {$t('frameleaf_cloud_cancel')}
        </Button>
      </div>
    </CloudCard>
  {:else if status.state === 'linked'}
    {#if status.relinkRequested}
      <CloudBanner tone="warning" title={$t('frameleaf_cloud_relink_title')}
        >{$t('frameleaf_cloud_relink_body')}</CloudBanner
      >
    {/if}
    {#if status.cloneSuspected}
      <CloudBanner tone="warning" title={$t('frameleaf_cloud_clone_title')}
        >{$t('frameleaf_cloud_clone_body')}</CloudBanner
      >
    {/if}
    {#if status.heartbeatFailures > 0 && status.lastError}
      <CloudBanner
        tone="warning"
        title={$t('frameleaf_cloud_checkin_failing', { values: { count: status.heartbeatFailures } })}
      >
        {status.lastError}
      </CloudBanner>
    {/if}
    <CloudCard
      icon={mdiCloudCheckOutline}
      title={$t('frameleaf_cloud_linked_title')}
      description={$t('frameleaf_cloud_linked_description')}
      status={$t('frameleaf_cloud_status_linked')}
      tone="ok"
    >
      <dl class="fc-facts">
        <dt>{$t('frameleaf_cloud_account')}</dt>
        <dd>{status.account?.label ?? '—'}</dd>
        <dt>{$t('frameleaf_cloud_linked_at')}</dt>
        <dd>{formatWhen(status.linkedAt)}</dd>
        <dt>{$t('frameleaf_cloud_last_contact')}</dt>
        <dd>{formatWhen(status.lastContactAt)}</dd>
        <dt>{$t('frameleaf_cloud_instance_id')}</dt>
        <dd><code>{status.instanceId}</code></dd>
        <dt>{$t('frameleaf_cloud_key_fingerprint')}</dt>
        <dd><code title={status.keyFingerprint ?? ''}>{shortFingerprint(status.keyFingerprint)}</code></dd>
        {#if status.dataRegion}
          <dt>{$t('frameleaf_cloud_data_region')}</dt>
          <dd>{status.dataRegion.toUpperCase()}</dd>
        {/if}
      </dl>
      <div class="fc-actions">
        <Button
          disabled={busy}
          onclick={() => void act(() => cloudManager.checkIn(), $t('frameleaf_cloud_checked_in'))}
        >
          <Icon icon={mdiRefresh} size="18" />
          {$t('frameleaf_cloud_check_in')}
        </Button>
      </div>
    </CloudCard>
    <CloudCard
      icon={mdiCellphone}
      title={$t('frameleaf_cloud_benefit_apps_title')}
      description={$t('frameleaf_cloud_apps_description')}
      status={status.remoteAccessEnabled ? $t('frameleaf_cloud_apps_anywhere') : $t('frameleaf_cloud_apps_at_home')}
      tone={status.remoteAccessEnabled ? 'ok' : 'muted'}
    >
      <p class="fc-muted">
        {status.remoteAccessEnabled
          ? $t('frameleaf_cloud_apps_anywhere_help')
          : $t('frameleaf_cloud_apps_at_home_help')}
      </p>
    </CloudCard>
    <CloudCard
      title={$t('frameleaf_cloud_permissions_title')}
      description={$t('frameleaf_cloud_permissions_description')}
    >
      <CloudToggleRow
        label={$t('frameleaf_cloud_permission_remote')}
        help={$t('frameleaf_cloud_permission_remote_help')}
        checked={status.permissions.allowRemoteEnable}
        disabled={busy}
        onChange={(value) => void permission('allowRemoteEnable', value)}
      />
      <CloudToggleRow
        label={$t('frameleaf_cloud_permission_backup')}
        help={$t('frameleaf_cloud_permission_backup_help')}
        checked={status.permissions.allowBackupTrigger}
        disabled={busy}
        onChange={(value) => void permission('allowBackupTrigger', value)}
      />
      <CloudToggleRow
        label={$t('frameleaf_cloud_permission_refresh')}
        help={$t('frameleaf_cloud_permission_refresh_help')}
        checked={status.permissions.allowEntitlementRefresh}
        disabled={busy}
        onChange={(value) => void permission('allowEntitlementRefresh', value)}
      />
    </CloudCard>
    <details class="fc-disclosure fl-continuous-corners">
      <summary><Icon icon={mdiInformationOutline} size="18" /> {$t('frameleaf_cloud_sends_title')}</summary>
      <dl class="fc-facts" data-testid="cloud-heartbeat-fields">
        {#each status.heartbeatFields as field (field)}
          <dt>{heartbeatLabel(field)}</dt>
          <dd>{heartbeatHelp(field)}</dd>
        {/each}
        <dt>{$t('frameleaf_cloud_sends_never')}</dt>
        <dd>{$t('frameleaf_cloud_sends_never_help')}</dd>
      </dl>
      <p class="fc-muted">{$t('frameleaf_cloud_sends_footer')}</p>
    </details>
    {@render headless()}
    <CloudCard title={$t('frameleaf_cloud_unlink_title')} description={$t('frameleaf_cloud_unlink_description')}>
      <div class="fc-actions">
        <Button
          onclick={() => {
            understood = false;
            unlinking = true;
          }}
        >
          <Icon icon={mdiLinkOff} size="18" />
          {$t('frameleaf_cloud_unlink_action')}
        </Button>
      </div>
    </CloudCard>
    <p class="fc-muted">
      {$t('frameleaf_cloud_next')}
      <a class="fc-link" href={commandCenterUrl('cloud', 'cloud-plan')}>{$t('frameleaf_cloud_next_plan')}</a>
      ·
      <a class="fc-link" href={commandCenterUrl('cloud', 'cloud-license')}>{$t('frameleaf_cloud_next_license')}</a>
    </p>
  {/if}
</div>

<Dialog bind:open={unlinking} title={$t('frameleaf_cloud_unlink_dialog_title')} closeLabel={$t('close')}>
  <ul class="fc-consequences">
    {#each unlinkConsequences as item (item)}
      <li>{item}</li>
    {/each}
  </ul>
  <label class="fc-confirm">
    <input type="checkbox" bind:checked={understood} />
    {$t('frameleaf_cloud_unlink_confirm')}
  </label>
  {#snippet actions()}
    <Button onclick={() => (unlinking = false)}>{$t('frameleaf_cloud_keep_linked')}</Button>
    <Button
      variant="danger"
      disabled={!understood || busy}
      onclick={async () => {
        if (await act(() => cloudManager.unlink(), $t('frameleaf_cloud_unlinked_notice'))) {
          unlinking = false;
        }
      }}
    >
      <Icon icon={mdiCheck} size="18" />
      {$t('frameleaf_cloud_unlink_confirm_action')}
    </Button>
  {/snippet}
</Dialog>
