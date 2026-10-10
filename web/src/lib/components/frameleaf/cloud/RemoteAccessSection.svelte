<script lang="ts">
  /**
   * Settings → Frameleaf Cloud → Remote access (FL-161, FL-165): the prototype's Remote access section
   * (design/frameleaf/template/src/FrameleafCloud.jsx `RemoteAccess`, with `validateCustomHostname`,
   * `customHostnameRecords` and `checkCustomHostname` in frameleaf-cloud-data.mjs) on real state from
   * `admin/cloud/remote` and `admin/cloud/status`:
   *
   * - the switch and connection mode, turned on only for a linked server with a remote access plan;
   * - the relay and direct connection as the edge worker reports them, and port forwarding;
   * - the public address with its certificate and QR code;
   * - the custom hostname: the two DNS records to add, "Check DNS" (adds the hostname, then asks
   *   Frameleaf Cloud whether the records are in place) and "Remove domain";
   * - the Public server URL (FL-168: moved here from Server identity), which "Use the Frameleaf
   *   address" or "Use my domain" fill, publishing the same address to the apps;
   * - who can connect (a Frameleaf sign-in for remote visitors is a fixed policy; originals and
   *   passwords over the relay ask before turning on); and the connection test.
   *
   * The prototype's "Preview other network conditions" panel only simulates states and is not ported.
   */
  import './cloud-account.css';
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import QrCode from '$lib/components/frameleaf/QrCode.svelte';
  import CloudBanner from '$lib/components/frameleaf/cloud/CloudBanner.svelte';
  import CloudCard from '$lib/components/frameleaf/cloud/CloudCard.svelte';
  import CloudToggleRow from '$lib/components/frameleaf/cloud/CloudToggleRow.svelte';
  import { formatDateTime } from '$lib/frameleaf/cloud-ml';
  import { checkCustomHostname, hostnameMessageKey } from '$lib/frameleaf/remote-access';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { copyToClipboard } from '$lib/utils';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    RemoteAccessMode,
    RemoteAccessPublicUrl,
    RemoteAccessState,
    RemoteDirectGuidance,
    RemoteHostnameStatus,
    RemoteMappingMethod,
    checkRemoteHostname,
    getRemoteAccess,
    getRemoteAccessUsage,
    removeRemoteHostname,
    setRemoteHostname,
    testRemoteAccess,
    updateRemoteAccess,
    type RemoteAccessStatusResponseDto,
    type RemoteAccessUpdateDto,
    type RemoteAccessUsageResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCheckCircleOutline,
    mdiCloudOutline,
    mdiContentCopy,
    mdiDeleteOutline,
    mdiDnsOutline,
    mdiEarth,
    mdiLinkVariant,
    mdiProgressClock,
    mdiWeb,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  type Setting = 'allowOriginalsOverRelay' | 'allowPasswordOverRelay';

  /** While remote access is starting, the page asks again this often. */
  const REFRESH_MS = 5000;

  const status = $derived(cloudManager.status);
  const linked = $derived(status?.state === 'linked');
  let remote = $state<RemoteAccessStatusResponseDto | null>(null);
  let usage = $state<RemoteAccessUsageResponseDto | null>(null);
  let busy = $state(false);
  let testing = $state(false);
  let failure = $state('');
  let notice = $state('');
  let confirming = $state<Setting | null>(null);
  let confirmOpen = $state(false);
  let hostInput = $state('');
  let hostTouched = $state(false);
  let portInput = $state('');

  const blocked = $derived(remote?.unavailableReason ?? null);
  const direct = $derived(remote?.mode === RemoteAccessMode.RelayAndDirect);
  const hostCheck = $derived(hostInput ? checkCustomHostname(hostInput) : null);
  const hostVerified = $derived(remote?.customHostnameStatus === RemoteHostnameStatus.Verified);
  const hostPending = $derived(remote?.customHostnameStatus === RemoteHostnameStatus.Pending);
  const customUrl = $derived(remote?.customHostname ? `https://${remote.customHostname}` : '');
  const serving = $derived(remote?.status === RemoteAccessState.Ready);

  // FL-168: the Public server URL (`server.externalDomain`) lives here rather than in Server
  // identity, as in the prototype's Remote access (FrameleafCloud.jsx "Public server URL"). It is part
  // of the settings draft ("Saved with your other settings changes"); the two buttons fill it with the
  // Frameleaf address or the verified domain and publish the same address to the apps.
  const settingsDraft = getSystemConfigDraft();
  // a configuration file manages the settings: the field is read-only, as on every settings page
  const configFile = $derived(settingsDraft ? featureFlagsManager.value.configFile : false);
  const serverUrl = $derived(settingsDraft?.draft.server.externalDomain ?? remote?.publicUrl ?? '');
  const frameleafUrl = $derived(remote?.frameleafAddress ?? '');
  const choseCustom = $derived(remote?.publicUrlChoice === RemoteAccessPublicUrl.Custom);

  const records = $derived(
    hostCheck?.valid && remote?.frameleafAddress
      ? [
          {
            type: 'CNAME',
            name: hostCheck.host,
            value: new URL(remote.frameleafAddress).host,
            purpose: $t('frameleaf_remote_record_relay_purpose'),
          },
          {
            type: 'CNAME',
            name: `_acme-challenge.${hostCheck.host}`,
            value: `_acme-challenge.${new URL(remote.frameleafAddress).host.replace(/^r\./, '')}`,
            purpose: $t('frameleaf_remote_record_challenge_purpose'),
          },
        ]
      : (remote?.customHostnameRecords ?? []).map((record, index) => ({
          ...record,
          purpose:
            index === 0 ? $t('frameleaf_remote_record_relay_purpose') : $t('frameleaf_remote_record_challenge_purpose'),
        })),
  );

  const statusLabel = $derived.by(() => {
    if (!remote?.enabled || blocked) {
      return $t('frameleaf_remote_status_off');
    }
    if (remote.status === RemoteAccessState.Error) {
      return $t('frameleaf_remote_status_error');
    }
    if (remote.status === RemoteAccessState.Starting || remote.status === RemoteAccessState.Unknown) {
      return $t('frameleaf_remote_status_starting');
    }
    return remote.relayConnected ? $t('frameleaf_remote_status_on_connected') : $t('frameleaf_remote_status_on');
  });
  const statusTone = $derived.by(() => {
    if (!remote?.enabled || blocked) {
      return 'muted' as const;
    }
    if (remote.status === RemoteAccessState.Error) {
      return 'warning' as const;
    }
    return serving ? ('ok' as const) : ('running' as const);
  });

  const directStatus = $derived.by(() => {
    if (!direct) {
      return { label: $t('frameleaf_remote_status_off'), tone: 'muted' as const };
    }
    if (remote?.cgnatSuspected && remote.portMapping) {
      return { label: $t('frameleaf_remote_direct_unavailable'), tone: 'warning' as const };
    }
    // FL-167: Frameleaf Cloud reached this server directly
    if (remote?.wanVerified) {
      return { label: $t('frameleaf_remote_direct_listening'), tone: 'ok' as const };
    }
    const tested = remote?.lastTestChecks.find((check) => check.id === 'direct');
    return tested?.ok
      ? { label: $t('frameleaf_remote_direct_listening'), tone: 'ok' as const }
      : { label: $t('frameleaf_remote_direct_not_tested'), tone: 'muted' as const };
  });

  // FL-167: how the router opens the port, and what Frameleaf Cloud's probe found
  const mappingLabel = $derived.by(() => {
    switch (remote?.mappingMethod) {
      case RemoteMappingMethod.Upnp: {
        return $t('frameleaf_remote_mapping_upnp');
      }
      case RemoteMappingMethod.NatPmp: {
        return $t('frameleaf_remote_mapping_nat_pmp');
      }
      case RemoteMappingMethod.Manual: {
        return $t('frameleaf_remote_mapping_manual');
      }
      default: {
        return remote?.portMapping ? $t('frameleaf_remote_mapping_auto') : $t('frameleaf_remote_mapping_manual');
      }
    }
  });
  const directResult = $derived.by(() => {
    if (remote?.wanVerified && remote.wanAddress) {
      return $t('frameleaf_remote_wan_verified', { values: { address: new URL(remote.wanAddress).host } });
    }
    if (remote?.wanProblem) {
      return $t('frameleaf_remote_wan_unreachable');
    }
    return remote?.lastTestChecks.find((check) => check.id === 'direct')?.detail ?? $t('frameleaf_remote_run_test');
  });

  const domainStatus = $derived(
    hostVerified
      ? { label: $t('frameleaf_remote_domain_verified'), tone: 'ok' as const }
      : hostPending
        ? { label: $t('frameleaf_remote_domain_waiting'), tone: 'running' as const }
        : { label: $t('frameleaf_remote_domain_not_set'), tone: 'muted' as const },
  );

  const checkLabels: Record<string, string> = $derived({
    certificate: $t('frameleaf_remote_check_certificate'),
    listener: $t('frameleaf_remote_check_listener'),
    api: $t('frameleaf_remote_check_api'),
    relay: $t('frameleaf_remote_check_relay'),
    direct: $t('frameleaf_remote_check_direct'),
  });

  const apply = (next: RemoteAccessStatusResponseDto | undefined | null) => {
    if (!next) {
      return;
    }
    remote = next;
    portInput = String(next.directPort);
    if (!hostTouched) {
      hostInput = next.customHostname ?? '';
    }
  };

  const load = async () => {
    try {
      apply(await getRemoteAccess());
    } catch (error) {
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
    }
  };

  // FL-166: "Relay use this month" as Frameleaf Cloud meters it, asked for only once remote access is
  // available (a linked server with the plan); the meter stays hidden when it cannot be read
  const usageAvailable = $derived(!!remote && !remote.unavailableReason);
  $effect(() => {
    if (!usageAvailable) {
      usage = null;
      return;
    }
    void (async () => {
      try {
        usage = await getRemoteAccessUsage();
      } catch {
        usage = null;
      }
    })();
  });
  const usageRatio = $derived(usage && usage.limitBytes > 0 ? Math.min(1, usage.bytes / usage.limitBytes) : 0);
  const throttleSpeed = (bps: number) =>
    `${Number((bps / 1_000_000).toFixed(1)).toLocaleString($locale ?? undefined)} Mbit/s`;

  onMount(() => {
    const stop = cloudManager.listen();
    void load();
    const timer = setInterval(() => {
      const waiting =
        remote?.enabled &&
        (remote.status === RemoteAccessState.Starting || remote.status === RemoteAccessState.Unknown);
      if (waiting && !busy && !testing) {
        void load();
      }
    }, REFRESH_MS);
    return () => {
      clearInterval(timer);
      stop();
    };
  });

  const run = async (call: () => Promise<RemoteAccessStatusResponseDto>, message?: string) => {
    busy = true;
    failure = '';
    notice = '';
    try {
      apply(await call());
      if (message) {
        notice = message;
      }
      return true;
    } catch (error) {
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
      return false;
    } finally {
      busy = false;
    }
  };

  const update = (dto: RemoteAccessUpdateDto, message?: string) =>
    run(() => updateRemoteAccess({ remoteAccessUpdateDto: dto }), message);

  const savePort = () => {
    const value = Number(portInput);
    if (Number.isSafeInteger(value) && value >= 1024 && value <= 65_535 && value !== remote?.directPort) {
      void update({ directPort: value }, $t('frameleaf_remote_saved'));
    }
  };

  /** "Check DNS": a new hostname is added first; the one already added is checked. */
  const checkDns = async () => {
    if (!hostCheck?.valid) {
      return;
    }
    const host = hostCheck.host;
    const added = remote?.customHostname === host;
    const ok = await run(() =>
      added ? checkRemoteHostname() : setRemoteHostname({ remoteHostnameUpdateDto: { hostname: host } }),
    );
    if (ok) {
      hostTouched = false;
      notice =
        remote?.customHostnameStatus === RemoteHostnameStatus.Verified
          ? $t('frameleaf_remote_domain_verified_notice', { values: { host } })
          : (remote?.customHostnameProblem ?? $t('frameleaf_remote_domain_checking'));
    }
  };

  const removeDomain = async () => {
    hostInput = '';
    hostTouched = false;
    await run(() => removeRemoteHostname(), $t('frameleaf_remote_domain_removed'));
  };

  const setServerUrl = (value: string) => {
    if (settingsDraft) {
      settingsDraft.draft.server.externalDomain = value.trim();
    }
  };

  /** "Use the Frameleaf address" / "Use my domain": fill the Public server URL and publish that address. */
  const usePublicUrl = async (choice: RemoteAccessPublicUrl) => {
    const url = choice === RemoteAccessPublicUrl.Custom ? customUrl : frameleafUrl;
    if (!configFile) {
      setServerUrl(url);
    }
    if (remote?.publicUrlChoice !== choice) {
      await update({ publicUrl: choice }, $t('frameleaf_remote_saved'));
    }
  };

  const runTest = async () => {
    testing = true;
    try {
      await run(() => testRemoteAccess(), $t('frameleaf_remote_test_done'));
    } finally {
      testing = false;
    }
  };

  const copy = (value: string) => void copyToClipboard(value);

  // ------------------------------------------------------------------ who can connect (FL-161)

  const confirmTitle = $derived(
    confirming === 'allowOriginalsOverRelay'
      ? $t('frameleaf_remote_originals_confirm_title')
      : $t('frameleaf_remote_password_confirm_title'),
  );
  const confirmBody = $derived(
    confirming === 'allowOriginalsOverRelay'
      ? $t('frameleaf_remote_originals_confirm_body')
      : $t('frameleaf_remote_password_confirm_body'),
  );

  const save = async (setting: Setting, value: boolean) => {
    busy = true;
    failure = '';
    notice = '';
    try {
      await cloudManager.setRemoteAccess({ [setting]: value });
      if (setting === 'allowOriginalsOverRelay') {
        notice = value ? $t('frameleaf_remote_originals_on_notice') : $t('frameleaf_remote_originals_off_notice');
      } else {
        notice = value ? $t('frameleaf_remote_password_on_notice') : $t('frameleaf_remote_password_off_notice');
      }
      return true;
    } catch (error) {
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
      return false;
    } finally {
      busy = false;
    }
  };

  /** Turning a setting on asks first, as in the prototype; turning it off is immediate. */
  const change = (setting: Setting, value: boolean) => {
    if (!value) {
      void save(setting, false);
      return;
    }
    confirming = setting;
    confirmOpen = true;
  };

  const confirm = async () => {
    if (!confirming || !(await save(confirming, true))) {
      return;
    }
    confirmOpen = false;
    confirming = null;
  };

  const keepOff = () => {
    confirmOpen = false;
    confirming = null;
  };
</script>

{#snippet copyValue(value: string, what: string)}
  <span class="fc-copy">
    <code>{value}</code>
    <Button variant="quiet" label={$t('frameleaf_remote_copy', { values: { what } })} onclick={() => copy(value)}>
      <Icon icon={mdiContentCopy} size="16" />
    </Button>
  </span>
{/snippet}

<div class="frameleaf-cloud" data-section="cloud-remote">
  {#if blocked}
    <CloudBanner tone="warning" title={$t('frameleaf_remote_gate_title')}>
      {blocked}
      {#snippet action()}
        {#if !linked}
          <Button variant="primary" onclick={() => goto(commandCenterUrl('cloud', 'cloud-account'))}
            >{$t('frameleaf_cloud_link_action')}</Button
          >
        {:else}
          <Button variant="primary" onclick={() => goto(commandCenterUrl('cloud', 'cloud-plan'))}
            >{$t('frameleaf_remote_gate_plan')}</Button
          >
        {/if}
      {/snippet}
    </CloudBanner>
  {/if}

  <CloudCard
    icon={mdiEarth}
    title={$t('frameleaf_remote_title')}
    description={$t('frameleaf_remote_description')}
    status={statusLabel}
    tone={statusTone}
  >
    <CloudToggleRow
      label={$t('frameleaf_remote_allow')}
      help={$t('frameleaf_remote_allow_help')}
      checked={!!remote?.enabled && !blocked}
      disabled={!!blocked || !remote || busy}
      reason={blocked ?? undefined}
      onChange={(value) =>
        void update({ enabled: value }, value ? $t('frameleaf_remote_on_notice') : $t('frameleaf_remote_off_notice'))}
    />
    <label class="fc-stack">
      {$t('frameleaf_remote_connection')}
      <select
        value={remote?.mode ?? RemoteAccessMode.Relay}
        disabled={!!blocked || !remote || busy}
        onchange={(event) => void update({ mode: event.currentTarget.value as RemoteAccessMode })}
      >
        <option value={RemoteAccessMode.Relay}>{$t('frameleaf_remote_mode_relay')}</option>
        <option value={RemoteAccessMode.RelayAndDirect}>{$t('frameleaf_remote_mode_direct')}</option>
      </select>
      <small class="fc-muted">{$t('frameleaf_remote_connection_help')}</small>
    </label>
    {#if remote?.enabled && remote.reason && !blocked}
      <p class="fc-muted" role="status">{remote.reason}</p>
    {/if}
  </CloudCard>

  <div class="fc-grid">
    <CloudCard
      title={$t('frameleaf_remote_relay_title')}
      status={remote?.enabled && remote.relayConnected
        ? $t('frameleaf_remote_connected')
        : $t('frameleaf_remote_not_connected')}
      tone={remote?.enabled && remote.relayConnected ? 'ok' : 'muted'}
    >
      <dl class="fc-facts">
        <dt>{$t('frameleaf_remote_region')}</dt>
        <dd>{remote?.relayRegion ?? '—'}</dd>
        <dt>{$t('frameleaf_remote_latency')}</dt>
        <dd>
          {remote?.enabled && remote.relayConnected && remote.relayLatencyMs !== null
            ? $t('frameleaf_remote_latency_value', { values: { ms: remote.relayLatencyMs } })
            : '—'}
        </dd>
        <dt>{$t('frameleaf_remote_speed')}</dt>
        <dd>{$t('frameleaf_remote_speed_value')}</dd>
        {#if remote?.enabled && remote.relayConnected && remote.relayConnectedAt}
          <dt>{$t('frameleaf_remote_relay_connected_since')}</dt>
          <dd>{formatDateTime(remote.relayConnectedAt, $locale)}</dd>
        {/if}
        {#if remote?.enabled && remote.relayBytesIn + remote.relayBytesOut > 0}
          <dt>{$t('frameleaf_remote_relay_traffic')}</dt>
          <dd>
            {$t('frameleaf_remote_relay_traffic_value', {
              values: {
                received: getByteUnitString(remote.relayBytesIn, $locale ?? undefined),
                sent: getByteUnitString(remote.relayBytesOut, $locale ?? undefined),
              },
            })}
          </dd>
        {/if}
      </dl>
      {#if usage}
        <div class="fc-meter">
          <div class="fc-meter-label">
            <span>{$t('frameleaf_remote_relay_usage_label')}</span>
            <strong>
              {$t('frameleaf_remote_relay_usage_of', {
                values: {
                  used: getByteUnitString(usage.bytes, $locale ?? undefined),
                  allowance: getByteUnitString(usage.limitBytes, $locale ?? undefined),
                },
              })}
            </strong>
          </div>
          <div
            class="fc-meter-track"
            class:is-high={usageRatio >= 0.8}
            role="meter"
            aria-label={$t('frameleaf_remote_relay_usage_label')}
            aria-valuemin={0}
            aria-valuemax={usage.limitBytes}
            aria-valuenow={usage.bytes}
          >
            <span style:width="{(usageRatio * 100).toFixed(1)}%"></span>
          </div>
        </div>
        {#if usage.throttled && usage.throttleBps !== null && usage.throttleUntil}
          <p class="fc-muted" role="status">
            {$t('frameleaf_remote_relay_throttled', {
              values: {
                speed: throttleSpeed(usage.throttleBps),
                when: formatDateTime(usage.throttleUntil, $locale),
              },
            })}
          </p>
        {/if}
      {/if}
      {#if remote?.enabled && remote.relayRevoked}
        <CloudBanner tone="warning" title={$t('frameleaf_remote_relay_revoked_title')}>
          {$t('frameleaf_remote_relay_revoked_body')}
        </CloudBanner>
      {:else if remote?.enabled && !remote.relayConnected && remote.relayLastError}
        <p class="fc-muted" role="status">
          {$t('frameleaf_remote_relay_last_problem', { values: { problem: remote.relayLastError } })}
        </p>
      {/if}
    </CloudCard>
    <CloudCard title={$t('frameleaf_remote_direct_title')} status={directStatus.label} tone={directStatus.tone}>
      {#if direct && remote}
        <dl class="fc-facts">
          <dt>{$t('frameleaf_remote_port')}</dt>
          <dd>{remote.directPort}</dd>
          <dt>{$t('frameleaf_remote_router_mapping')}</dt>
          <dd>{mappingLabel}</dd>
          {#if remote.directExternalIp}
            <dt>{$t('frameleaf_remote_public_address')}</dt>
            <dd>{remote.directExternalIp}</dd>
          {/if}
          <dt>{$t('frameleaf_remote_last_result')}</dt>
          <dd>{directResult}</dd>
        </dl>
        {#if remote.directGuidance === RemoteDirectGuidance.Bridge}
          <CloudBanner tone="warning" title={$t('frameleaf_remote_bridge_title')}>
            {$t('frameleaf_remote_bridge_body')}
          </CloudBanner>
        {:else if remote.portMapping && remote.mappingError && !remote.cgnatSuspected}
          <p class="fc-muted" role="status">
            {$t('frameleaf_remote_mapping_failed', { values: { problem: remote.mappingError } })}
          </p>
        {/if}
        {#if remote.cgnatSuspected}
          <CloudBanner tone="warning" title={$t('frameleaf_remote_cgnat_title')}>
            {$t('frameleaf_remote_cgnat_body')}
          </CloudBanner>
        {/if}
      {:else}
        <p class="fc-muted">{$t('frameleaf_remote_relay_only_body')}</p>
      {/if}
    </CloudCard>
  </div>

  {#if direct && remote}
    <CloudCard title={$t('frameleaf_remote_port_title')} description={$t('frameleaf_remote_port_description')}>
      <CloudToggleRow
        label={$t('frameleaf_remote_manual_port')}
        help={$t('frameleaf_remote_manual_port_help')}
        checked={!remote.portMapping}
        disabled={!!blocked || busy}
        onChange={(value) => void update({ portMapping: !value })}
      />
      <label class="fc-stack">
        {$t('frameleaf_remote_external_port')}
        <span class="fc-input-unit">
          <input
            type="number"
            min="1024"
            max="65535"
            step="1"
            bind:value={portInput}
            disabled={!!blocked || busy}
            onchange={savePort}
            aria-label={$t('frameleaf_remote_external_port')}
          />
        </span>
        <small class="fc-muted">{$t('frameleaf_remote_external_port_help')}</small>
      </label>
    </CloudCard>
  {/if}

  <CloudCard title={$t('frameleaf_remote_address_title')} description={$t('frameleaf_remote_address_description')}>
    {#if remote?.publicUrl}
      <div class="fc-address">
        <div>
          {@render copyValue(remote.publicUrl, $t('frameleaf_remote_address_title'))}
          <dl class="fc-facts">
            <dt>{$t('frameleaf_remote_certificate')}</dt>
            <dd>{remote.certificateName ?? '—'}</dd>
            <dt>{$t('frameleaf_remote_renews')}</dt>
            <dd>
              {remote.certificateExpiresAt
                ? $t('frameleaf_remote_renews_value', {
                    values: { date: formatDateTime(remote.certificateExpiresAt, $locale) },
                  })
                : '—'}
            </dd>
            <dt>{$t('frameleaf_remote_issued_to')}</dt>
            <dd>{$t('frameleaf_remote_issued_to_value')}</dd>
          </dl>
          {#if remote.certificateError}
            <p class="fc-notice is-error" role="alert">{remote.certificateError}</p>
          {/if}
        </div>
        <QrCode
          value={remote.publicUrl}
          size={148}
          label={$t('frameleaf_remote_qr_label')}
          copyLabel={$t('frameleaf_remote_copy', { values: { what: $t('frameleaf_remote_address_title') } })}
          downloadLabel={$t('frameleaf_remote_qr_download')}
          errorLabel={$t('frameleaf_remote_qr_error')}
          fileName="frameleaf-remote-address"
        />
      </div>
    {:else}
      <p class="fc-muted">{$t('frameleaf_remote_address_pending')}</p>
    {/if}
  </CloudCard>

  <CloudCard
    icon={mdiWeb}
    title={$t('frameleaf_remote_domain_title')}
    description={$t('frameleaf_remote_domain_description')}
    status={domainStatus.label}
    tone={domainStatus.tone}
  >
    <label class="fc-stack">
      {$t('frameleaf_remote_hostname')}
      <input
        value={hostInput}
        placeholder="photos.example.com"
        autocomplete="off"
        spellcheck={false}
        disabled={!!blocked}
        aria-invalid={hostCheck ? !hostCheck.valid : undefined}
        oninput={(event) => {
          hostInput = event.currentTarget.value;
          hostTouched = true;
        }}
      />
      <small class="fc-muted">{$t('frameleaf_remote_hostname_help')}</small>
      {#if hostCheck && !hostCheck.valid && hostInput.length > 3}
        <small class="fc-notice is-error">{$t(hostnameMessageKey(hostCheck.reason))}</small>
      {/if}
    </label>
    {#if (hostCheck?.valid || remote?.customHostname) && records.length > 0}
      <div class="fc-table-wrap">
        <table class="fc-table">
          <thead>
            <tr>
              <th scope="col">{$t('frameleaf_remote_record_type')}</th>
              <th scope="col">{$t('frameleaf_remote_record_name')}</th>
              <th scope="col">{$t('frameleaf_remote_record_value')}</th>
            </tr>
          </thead>
          <tbody>
            {#each records as record (record.name)}
              <tr>
                <td>{record.type}</td>
                <td>
                  {@render copyValue(record.name, `${record.type} ${$t('frameleaf_remote_record_name')}`)}
                  <small class="fc-muted">{record.purpose}</small>
                </td>
                <td>{@render copyValue(record.value, `${record.type} ${$t('frameleaf_remote_record_value')}`)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
    {#if hostPending}
      <p class="fc-muted" role="status">
        <Icon icon={mdiProgressClock} size="16" />
        {remote?.customHostnameProblem ?? $t('frameleaf_remote_domain_pending_note')}
      </p>
    {/if}
    {#if hostVerified && remote?.customHostname}
      <p class="fc-ok" role="status">
        <Icon icon={mdiCheckCircleOutline} size="16" />
        {$t('frameleaf_remote_domain_verified_note', { values: { host: remote.customHostname } })}
      </p>
    {/if}
    <div class="fc-actions">
      <Button
        variant={remote?.customHostname ? 'default' : 'primary'}
        disabled={!!blocked || busy || !hostCheck?.valid}
        onclick={() => void checkDns()}
      >
        <Icon icon={mdiDnsOutline} size="16" />
        {$t('frameleaf_remote_check_dns')}
      </Button>
      {#if remote?.customHostname}
        <Button disabled={busy} onclick={() => void removeDomain()}>
          <Icon icon={mdiDeleteOutline} size="16" />
          {$t('frameleaf_remote_remove_domain')}
        </Button>
      {/if}
    </div>
  </CloudCard>

  <CloudCard
    icon={mdiLinkVariant}
    title={$t('frameleaf_remote_public_url_title')}
    description={$t('frameleaf_remote_public_url_description')}
  >
    {#if settingsDraft}
      <label class="fc-stack">
        {$t('frameleaf_remote_public_url_title')}
        <input
          type="url"
          value={serverUrl}
          placeholder="https://photos.example.com"
          autocomplete="off"
          spellcheck={false}
          disabled={configFile}
          data-testid="public-server-url"
          oninput={(event) => setServerUrl(event.currentTarget.value)}
        />
        <small class="fc-muted">{$t('frameleaf_remote_public_url_help')}</small>
      </label>
    {:else if remote?.publicUrl}
      {@render copyValue(remote.publicUrl, $t('frameleaf_remote_public_url_title'))}
    {/if}
    <div class="fc-actions">
      <Button
        disabled={!!blocked || busy || !frameleafUrl || (serverUrl === frameleafUrl && !choseCustom)}
        onclick={() => void usePublicUrl(RemoteAccessPublicUrl.Frameleaf)}
      >
        <Icon icon={mdiCloudOutline} size="16" />
        {$t('frameleaf_remote_use_frameleaf')}
      </Button>
      <Button
        disabled={!!blocked || busy || !hostVerified || (serverUrl === customUrl && choseCustom)}
        onclick={() => void usePublicUrl(RemoteAccessPublicUrl.Custom)}
      >
        <Icon icon={mdiWeb} size="16" />
        {$t('frameleaf_remote_use_domain')}
      </Button>
    </div>
  </CloudCard>

  <CloudCard title={$t('frameleaf_remote_who_title')} description={$t('frameleaf_remote_who_description')}>
    <CloudToggleRow
      label={$t('frameleaf_remote_require_signin')}
      help={$t('frameleaf_remote_require_signin_help')}
      checked
      policy={$t('frameleaf_signin_always_on')}
    />
    <CloudToggleRow
      label={$t('frameleaf_remote_allow_originals')}
      help={$t('frameleaf_remote_allow_originals_help')}
      checked={!!status?.allowOriginalsOverRelay}
      disabled={!linked || busy}
      reason={$t('frameleaf_signin_link_first')}
      onChange={(value) => change('allowOriginalsOverRelay', value)}
    />
    <CloudToggleRow
      label={$t('frameleaf_remote_allow_password')}
      help={$t('frameleaf_remote_allow_password_help')}
      checked={!!status?.allowPasswordOverRelay}
      disabled={!linked || busy}
      reason={$t('frameleaf_signin_link_first')}
      onChange={(value) => change('allowPasswordOverRelay', value)}
    />
    {#if !linked}
      <div class="fc-actions">
        <Button variant="primary" onclick={() => goto(commandCenterUrl('cloud', 'cloud-account'))}
          >{$t('frameleaf_cloud_link_action')}</Button
        >
      </div>
    {/if}
  </CloudCard>

  {#if failure}
    <p class="fc-notice is-error" role="alert">{failure}</p>
  {:else if notice}
    <p class="fc-notice" role="status">{notice}</p>
  {/if}

  <div class="fc-actions">
    <Button
      variant="primary"
      disabled={!!blocked || !remote?.enabled || testing || busy}
      onclick={() => void runTest()}
    >
      <Icon icon={mdiCheckCircleOutline} size="16" />
      {testing ? $t('frameleaf_remote_testing') : $t('frameleaf_remote_test')}
    </Button>
    {#if remote?.lastTestAt}
      <span class="fc-muted"
        >{$t('frameleaf_remote_last_tested', { values: { date: formatDateTime(remote.lastTestAt, $locale) } })}</span
      >
    {/if}
  </div>
  {#if remote && remote.lastTestChecks.length > 0}
    <ul class="fc-steps" data-testid="remote-test-checks">
      {#each remote.lastTestChecks as check (check.id)}
        <li class:is-ok={check.ok}>
          <strong>{checkLabels[check.id] ?? check.id}</strong>
          <span>{check.detail}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<Dialog bind:open={confirmOpen} title={confirmTitle} closeLabel={$t('close')} onRequestClose={keepOff}>
  <p>{confirmBody}</p>
  {#snippet actions()}
    <Button onclick={keepOff}>{$t('frameleaf_remote_keep_off')}</Button>
    <Button variant="primary" disabled={busy} onclick={() => void confirm()}>{$t('frameleaf_remote_turn_on')}</Button>
  {/snippet}
</Dialog>
