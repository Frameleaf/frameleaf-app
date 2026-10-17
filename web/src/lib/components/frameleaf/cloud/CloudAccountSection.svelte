<script lang="ts">
  import { locale } from '$lib/stores/preferences.store';
  /**
   * Settings → Frameleaf Cloud → Account & link (FL-154, FL-155): the prototype's `AccountLink`
   * (design/frameleaf/template/src/FrameleafCloud.jsx:438-782, effd05ffb7) on real server state.
   * States: not configured (no FRAMELEAF_CLOUD_URL), not linked, waiting for approval of a device
   * code (code, QR, countdown, key fingerprint), linked (account, dates, instance ID, "Manage on
   * frameleaf.cloud", apps card with "Set up remote access",
   * permission toggles, "What this server sends", unlink, and FL-196's "Take the tour") and revoked
   * (the cloud's reason).
   * Nothing is simulated: every change goes through `admin/cloud/*`.
   */
  import './cloud-account.css';
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import CloudBanner from '$lib/components/frameleaf/cloud/CloudBanner.svelte';
  import CloudCard from '$lib/components/frameleaf/cloud/CloudCard.svelte';
  import CloudPendingCode from '$lib/components/frameleaf/cloud/CloudPendingCode.svelte';
  import CloudToggleRow from '$lib/components/frameleaf/cloud/CloudToggleRow.svelte';
  import { dataRegionKey, displayHost, linkRefusalKeys, shortFingerprint } from '$lib/frameleaf/cloud';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { CloudLinkRefusal, type CloudHeartbeatField, type CloudPermissionsDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCellphone,
    mdiCheck,
    mdiClose,
    mdiCloudCheckOutline,
    mdiCloudOffOutline,
    mdiCloudOutline,
    mdiCloudSyncOutline,
    mdiCloudUploadOutline,
    mdiCompassOutline,
    mdiEarth,
    mdiInformationOutline,
    mdiLinkOff,
    mdiLinkVariant,
    mdiOpenInNew,
    mdiQrcode,
    mdiRefresh,
    mdiServerOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  onMount(() => cloudManager.listen());

  const status = $derived(cloudManager.status);
  /** A notice belongs to the link state it was written in: "Link started" goes once the link lands. */
  let noticeText = $state('');
  let noticeState = $state<string | undefined>();
  const notice = $derived(noticeText && noticeState === status?.state ? noticeText : '');
  let failure = $state('');
  let busy = $state(false);
  let unlinking = $state(false);
  let understood = $state(false);
  /** Reported by the pending-code block when its countdown reaches zero. */
  let codeExpired = $state(false);
  const expired = $derived(status?.state === 'pending' && codeExpired);

  const formatWhen = (value: string | null | undefined) =>
    value ? new Intl.DateTimeFormat($locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';

  const act = async (call: () => Promise<unknown>, success = '') => {
    busy = true;
    failure = '';
    try {
      await call();
      noticeText = success;
      noticeState = cloudManager.status?.state;
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

  /** FC-18: the account's region in words ("the EU", "North America"), or null when it is not one we know. */
  const regionName = (region: string | null | undefined) => {
    const key = region ? dataRegionKey(region) : null;
    return key ? $t(key) : null;
  };

  /** The region as a value on its own line: "The EU", or the raw code for a region without a name. */
  const regionLabel = (region: string) => {
    const name = regionName(region);
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : region.toUpperCase();
  };

  const heartbeatLabel = (field: CloudHeartbeatField) => $t(`frameleaf_cloud_sends_${field}` as Translations);
  const heartbeatHelp = (field: CloudHeartbeatField) => $t(`frameleaf_cloud_sends_${field}_help` as Translations);

  const unlinkConsequences = $derived([
    $t('frameleaf_cloud_unlink_consequence_remote'),
    $t('frameleaf_cloud_unlink_consequence_processing'),
    $t('frameleaf_cloud_unlink_consequence_backup'),
    $t('frameleaf_cloud_unlink_consequence_accounts'),
    $t('frameleaf_cloud_unlink_consequence_plan'),
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
        onclick={() => (noticeText = '')}
      >
        <Icon icon={mdiClose} size="16" />
      </button>
    </div>
  {/if}

  {#if !status}
    {#if cloudManager.error}
      <InlineError
        message={$t('frameleaf_cloud_status_unavailable')}
        onRetry={() => void act(() => cloudManager.refresh())}
        retrying={busy}
      />
    {:else}
      <div class="fc-loading" role="status" aria-label={$t('frameleaf_cloud_loading')}>
        <Skeleton variant="block" height="168px" />
      </div>
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
    {#if status.linkRefusal === CloudLinkRefusal.RegionMismatch && status.state === 'unlinked'}
      {@const accountRegion = regionName(status.regionMismatch?.accountRegion)}
      <!-- FC-18: Frameleaf Cloud's own message names both regions -->
      <CloudBanner tone="danger" title={$t('frameleaf_cloud_link_refusal_region_mismatch_title')}>
        {status.lastError || $t('frameleaf_cloud_link_refusal_region_mismatch_body')}
      </CloudBanner>
      {#if status.regionMismatch?.canContinue}
        <div class="fc-actions" data-testid="cloud-region-mismatch-actions">
          <Button
            variant="primary"
            disabled={busy}
            onclick={() =>
              void act(
                () => cloudManager.continueLink(),
                accountRegion ? $t('frameleaf_cloud_link_region_linked', { values: { region: accountRegion } }) : '',
              )}
          >
            <Icon icon={mdiLinkVariant} size="18" />
            {accountRegion
              ? $t('frameleaf_cloud_link_continue_region', { values: { region: accountRegion } })
              : $t('frameleaf_cloud_link_continue_account_region')}
          </Button>
          <Button
            disabled={busy}
            onclick={() => void act(() => cloudManager.cancelLink(), $t('frameleaf_cloud_link_cancelled'))}
          >
            {$t('frameleaf_cloud_cancel')}
          </Button>
        </div>
      {:else if status.linkTokenConfigured}
        <p class="fc-muted">{$t('frameleaf_cloud_link_region_headless')}</p>
      {/if}
    {:else if status.linkRefusal && status.state === 'unlinked'}
      {@const refusal = linkRefusalKeys(status.linkRefusal)}
      <CloudBanner tone="danger" title={$t(refusal.title)}>{$t(refusal.body)}</CloudBanner>
    {:else if status.lastError && status.state === 'unlinked'}
      <CloudBanner tone="warning" title={$t('frameleaf_cloud_last_problem')}>{status.lastError}</CloudBanner>
    {/if}
    <CloudCard
      brand
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
      <CloudPendingCode
        {pending}
        keyFingerprint={status.keyFingerprint}
        lastError={status.lastError}
        pollError={!!cloudManager.pollError}
        bind:expired={codeExpired}
      />
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
          <dd>{regionLabel(status.dataRegion)}</dd>
        {/if}
      </dl>
      <p class="fc-muted">{$t('frameleaf_cloud_signin_role_notice')}</p>
      <div class="fc-actions">
        <Button
          disabled={busy}
          onclick={() => void act(() => cloudManager.checkIn(), $t('frameleaf_cloud_checked_in'))}
        >
          <Icon icon={mdiRefresh} size="18" />
          {$t('frameleaf_cloud_check_in')}
        </Button>
        {#if status.manageUrl}
          <a class="fc-button" href={status.manageUrl} target="_blank" rel="noopener noreferrer">
            <Icon icon={mdiOpenInNew} size="18" />
            {$t('frameleaf_cloud_manage_on_site')}
          </a>
        {/if}
        <!-- FL-196: reopen the linked-server tour (CloudTourHost opens it from the address). -->
        <Button onclick={() => void goto(commandCenterUrl('cloud', 'cloud-account', { tour: 'cloud' }))}>
          <Icon icon={mdiCompassOutline} size="18" />
          {$t('frameleaf_cloud_tour_take')}
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
      {#if !status.remoteAccessEnabled}
        <div class="fc-actions">
          <a class="fc-button" href={commandCenterUrl('cloud', 'cloud-remote')}>
            <Icon icon={mdiEarth} size="18" />
            {$t('frameleaf_cloud_apps_set_up_remote')}
          </a>
        </div>
      {/if}
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
      ·
      <a class="fc-link" href={commandCenterUrl('cloud', 'cloud-remote')}>{$t('frameleaf_cloud_next_remote')}</a>
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
