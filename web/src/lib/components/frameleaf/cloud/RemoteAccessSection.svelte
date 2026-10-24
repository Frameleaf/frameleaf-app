<script lang="ts">
  /**
   * Settings → Frameleaf Cloud → Remote access (FL-161, FL-165; FL-541 after the prototype's
   * `settings-v2/cloud/Remote.jsx`): is it working and at what address (Copy, QR code, "Check it
   * now", the details of the check opening on a failure), then plain choices: how devices connect,
   * the monthly allowance beside it, the address in links you share (your Frameleaf address or your
   * own domain), and one control for signing in away from home. Router, port, region and
   * certificate detail sit in a closed "Connection details". "Relay" is said "Through Frameleaf".
   *
   * State comes from `admin/cloud/remote` and `admin/cloud/status`. A server without the plan keeps
   * only its direct address (FL-437). The Public server URL (FL-168) is set by the links choice, or
   * typed under "Another address" as part of the settings draft.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import QrCode from '$lib/components/frameleaf/QrCode.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Choice from '$lib/components/frameleaf/settings/kit/Choice.svelte';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Meter from '$lib/components/frameleaf/settings/kit/Meter.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
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
  import { mdiContentCopy, mdiSpeedometerSlow, mdiWebCheck, mdiWebClock, mdiWebOff } from '@mdi/js';
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
  // FL-437: a Server licence without a plan has its direct address but no relay; direct is the only way in
  const relayNeedsPlan = $derived(!blocked && !!remote?.relayNeedsPlan);
  const direct = $derived(remote?.mode === RemoteAccessMode.RelayAndDirect || relayNeedsPlan);
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
    hostCheck?.valid && remote?.frameleafAddress && !relayNeedsPlan
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

  const checkLabels: Record<string, string> = $derived({
    certificate: $t('frameleaf_remote_check_certificate'),
    listener: $t('frameleaf_remote_check_listener'),
    api: $t('frameleaf_remote_check_api'),
    relay: $t('frameleaf_remote_check_relay'),
    direct: $t('frameleaf_remote_check_direct'),
  });

  let showQr = $state(false);
  const testFailed = $derived(remote?.lastTestOk === false);
  const allowance = $derived(usage ? getByteUnitString(usage.limitBytes, $locale ?? undefined) : '');

  /** What the hero says: off, starting, working, slowed, or not reachable. */
  const hero = $derived.by(() => {
    if (blocked) {
      return { tone: 'quiet' as const, icon: mdiWebOff, title: $t('frameleaf_remote_gate_title'), body: blocked };
    }
    if (!remote?.enabled) {
      return {
        tone: 'quiet' as const,
        icon: mdiWebOff,
        title: $t('frameleaf_ra_off'),
        body: $t('frameleaf_ra_off_body'),
      };
    }
    if (remote.status === RemoteAccessState.Error || testFailed) {
      return {
        tone: 'bad' as const,
        icon: mdiWebOff,
        title: $t('frameleaf_ra_unreachable'),
        body: remote.reason ?? $t('frameleaf_ra_unreachable_body'),
      };
    }
    if (!serving) {
      return {
        tone: 'warn' as const,
        icon: mdiWebClock,
        title: $t('frameleaf_ra_starting'),
        body: $t('frameleaf_ra_starting_body'),
      };
    }
    if (usage?.throttled && usage.throttleUntil) {
      return {
        tone: 'warn' as const,
        icon: mdiSpeedometerSlow,
        title: $t('frameleaf_ra_slow', { values: { when: formatDateTime(usage.throttleUntil, $locale) } }),
        body: $t('frameleaf_ra_slow_body', { values: { allowance } }),
      };
    }
    return {
      tone: 'good' as const,
      icon: mdiWebCheck,
      title: $t('frameleaf_ra_working'),
      body: remote.lastTestAt
        ? $t('frameleaf_ra_working_checked', { values: { date: formatDateTime(remote.lastTestAt, $locale) } })
        : $t('frameleaf_ra_working_body'),
    };
  });

  /** "Right now": how devices actually connect, whatever was chosen. */
  const rightNow = $derived(
    !direct
      ? $t('frameleaf_ra_now_frameleaf')
      : remote?.cgnatSuspected
        ? $t('frameleaf_ra_now_blocked')
        : remote?.wanVerified || remote?.lastTestChecks.find((check) => check.id === 'direct')?.ok
          ? $t('frameleaf_ra_now_direct')
          : $t('frameleaf_ra_now_checking'),
  );

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
  const usageAvailable = $derived(!!remote && !remote.unavailableReason && !relayNeedsPlan);
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
  <span class="copy">
    <code>{value}</code>
    <Button variant="quiet" label={$t('frameleaf_remote_copy', { values: { what } })} onclick={() => copy(value)}>
      <Icon icon={mdiContentCopy} size="16" />
    </Button>
  </span>
{/snippet}

<div data-section="cloud-remote">
  <KitPage>
    <Said message={notice} onDismiss={() => (notice = '')} />
    {#if failure}
      <Notice tone="warn" title={failure} />
    {/if}

    <Hero label={$t('frameleaf_ra_status')} tone={hero.tone} icon={hero.icon} title={hero.title} body={hero.body}>
      {#snippet actions()}
        {#if blocked}
          {#if !linked}
            <Button variant="primary" onclick={() => goto(commandCenterUrl('cloud', 'cloud-account'))}
              >{$t('frameleaf_cloud_link_action')}</Button
            >
          {:else}
            <Button variant="primary" onclick={() => goto(commandCenterUrl('cloud', 'cloud-plan'))}
              >{$t('frameleaf_remote_gate_plan')}</Button
            >
          {/if}
        {:else if remote && !remote.enabled}
          <Button
            variant="primary"
            disabled={busy}
            onclick={() => void update({ enabled: true }, $t('frameleaf_remote_on_notice'))}
            >{$t('frameleaf_remote_turn_on')}</Button
          >
        {:else if remote?.enabled}
          <Button variant={testFailed ? 'primary' : 'default'} disabled={testing || busy} onclick={() => void runTest()}
            >{testing
              ? $t('frameleaf_remote_testing')
              : testFailed
                ? $t('frameleaf_ra_check_again')
                : $t('frameleaf_ra_check_now')}</Button
          >
        {/if}
      {/snippet}
      {#if remote?.enabled && !blocked}
        <div class="hero-extra">
          {#if remote.publicUrl}
            <div class="address">
              {@render copyValue(remote.publicUrl, $t('frameleaf_remote_address_title'))}
              <Button onclick={() => (showQr = !showQr)}
                >{showQr ? $t('frameleaf_ra_hide_qr') : $t('frameleaf_ra_show_qr')}</Button
              >
            </div>
            {#if showQr}
              <QrCode
                value={remote.publicUrl}
                size={148}
                label={$t('frameleaf_remote_qr_label')}
                copyLabel={$t('frameleaf_remote_copy', { values: { what: $t('frameleaf_remote_address_title') } })}
                downloadLabel={$t('frameleaf_remote_qr_download')}
                errorLabel={$t('frameleaf_remote_qr_error')}
                fileName="frameleaf-remote-address"
              />
            {/if}
          {:else}
            <p class="hint">{$t('frameleaf_remote_address_pending')}</p>
          {/if}
          {#if remote.lastTestChecks.length > 0}
            <Advanced summary={$t('frameleaf_ra_check_details')} open={testFailed}>
              <ItemList>
                {#each remote.lastTestChecks as check, index (check.id)}
                  <Item
                    name={checkLabels[check.id] ?? check.id}
                    detail={check.detail}
                    tone={check.ok ? 'good' : 'bad'}
                    status={check.ok ? $t('frameleaf_ra_passed') : $t('frameleaf_ra_failed')}
                    note={$t('frameleaf_ra_check_n', { values: { n: index + 1 } })}
                  />
                {/each}
              </ItemList>
            </Advanced>
          {/if}
        </div>
      {/if}
    </Hero>

    {#if !blocked}
      <Section title={$t('frameleaf_remote_title')}>
        <Row label={$t('frameleaf_ra_allow')} help={$t('frameleaf_ra_allow_help')}>
          <Switch
            label={$t('frameleaf_ra_allow')}
            checked={!!remote?.enabled}
            held={!remote || busy}
            onChange={(value) =>
              void update(
                { enabled: value },
                value ? $t('frameleaf_remote_on_notice') : $t('frameleaf_remote_off_notice'),
              )}
          />
        </Row>
      </Section>
    {/if}

    {#if remote?.enabled && !blocked}
      <Section title={$t('frameleaf_ra_how')} description={$t('frameleaf_ra_how_description')}>
        <Choice
          label={$t('frameleaf_ra_how')}
          value={direct ? RemoteAccessMode.RelayAndDirect : RemoteAccessMode.Relay}
          disabled={busy}
          options={[
            {
              value: RemoteAccessMode.RelayAndDirect,
              label: $t('frameleaf_ra_how_direct'),
              detail: $t('frameleaf_ra_how_direct_detail'),
            },
            {
              value: RemoteAccessMode.Relay,
              label: $t('frameleaf_ra_how_frameleaf'),
              detail: relayNeedsPlan
                ? $t('frameleaf_remote_connection_needs_plan')
                : $t('frameleaf_ra_how_frameleaf_detail'),
              disabled: relayNeedsPlan,
            },
          ]}
          onChange={(value) => void update({ mode: value as RemoteAccessMode })}
        />
        <p class="said-back"><strong>{$t('frameleaf_ra_right_now')}</strong> {rightNow}</p>
        {#if remote.reason}
          <p class="hint" role="status">{remote.reason}</p>
        {/if}
        {#if relayNeedsPlan}
          <Notice title={$t('frameleaf_remote_relay_needs_plan_status')}>
            {$t('frameleaf_remote_relay_needs_plan_body')}
            {#snippet action()}
              <Button onclick={() => goto(commandCenterUrl('cloud', 'cloud-plan'))}
                >{$t('frameleaf_remote_gate_plan')}</Button
              >
            {/snippet}
          </Notice>
        {:else if remote.relayRevoked}
          <Notice tone="warn" title={$t('frameleaf_remote_relay_revoked_title')}
            >{$t('frameleaf_remote_relay_revoked_body')}</Notice
          >
        {/if}
        {#if usage}
          <Row
            label={$t('frameleaf_ra_this_month')}
            help={$t('frameleaf_ra_this_month_help', { values: { allowance } })}
          >
            <div class="meter">
              <Meter
                label={$t('frameleaf_remote_relay_usage_label')}
                value={getByteUnitString(usage.bytes, $locale ?? undefined)}
                max={$t('frameleaf_ra_of', { values: { allowance } })}
                fraction={usageRatio}
              />
            </div>
          </Row>
          {#if usage.throttled && usage.throttleBps !== null && usage.throttleUntil}
            <p class="hint" role="status">
              {$t('frameleaf_remote_relay_throttled', {
                values: { speed: throttleSpeed(usage.throttleBps), when: formatDateTime(usage.throttleUntil, $locale) },
              })}
            </p>
          {/if}
        {/if}
        <Row label={$t('frameleaf_remote_allow_originals')} help={$t('frameleaf_remote_allow_originals_help')}>
          <Switch
            label={$t('frameleaf_remote_allow_originals')}
            checked={!!status?.allowOriginalsOverRelay}
            held={!linked || busy}
            onChange={(value) => change('allowOriginalsOverRelay', value)}
          />
        </Row>
        <Advanced summary={$t('frameleaf_ra_details')}>
          <Facts
            rows={[
              {
                label: $t('frameleaf_ra_region'),
                value: remote.relayRegion ?? '—',
                detail:
                  remote.relayConnected && remote.relayLatencyMs !== null
                    ? $t('frameleaf_ra_response_time', { values: { ms: remote.relayLatencyMs } })
                    : remote.relayConnected
                      ? undefined
                      : $t('frameleaf_remote_not_connected'),
              },
              {
                label: $t('frameleaf_ra_through_frameleaf'),
                value:
                  remote.relayBytesIn + remote.relayBytesOut > 0
                    ? $t('frameleaf_remote_relay_traffic_value', {
                        values: {
                          received: getByteUnitString(remote.relayBytesIn, $locale ?? undefined),
                          sent: getByteUnitString(remote.relayBytesOut, $locale ?? undefined),
                        },
                      })
                    : remote.relayConnected
                      ? $t('frameleaf_remote_connected')
                      : $t('frameleaf_remote_not_connected'),
                detail:
                  remote.relayConnected && remote.relayConnectedAt
                    ? $t('frameleaf_ra_connected_since', {
                        values: { date: formatDateTime(remote.relayConnectedAt, $locale) },
                      })
                    : undefined,
              },
              {
                label: $t('frameleaf_remote_check_direct'),
                value: directStatus.label,
                detail: direct ? directResult : undefined,
              },
              ...(direct
                ? [
                    {
                      label: $t('frameleaf_ra_door'),
                      value: $t('frameleaf_ra_port', { values: { port: remote.directPort } }),
                      detail: remote.directExternalIp ? `${mappingLabel} · ${remote.directExternalIp}` : mappingLabel,
                    },
                  ]
                : []),
            ]}
          />
          {#if !remote.relayConnected && remote.relayLastError}
            <p class="hint" role="status">
              {$t('frameleaf_remote_relay_last_problem', { values: { problem: remote.relayLastError } })}
            </p>
          {/if}
          {#if direct}
            <p class="hint">{$t('frameleaf_ra_door_hint')}</p>
            {#if remote.directGuidance === RemoteDirectGuidance.Bridge}
              <Notice tone="warn" title={$t('frameleaf_remote_bridge_title')}
                >{$t('frameleaf_remote_bridge_body')}</Notice
              >
            {:else if remote.portMapping && remote.mappingError && !remote.cgnatSuspected}
              <p class="hint" role="status">
                {$t('frameleaf_remote_mapping_failed', { values: { problem: remote.mappingError } })}
              </p>
            {/if}
            {#if remote.cgnatSuspected}
              <Notice tone="warn" title={$t('frameleaf_remote_cgnat_title')}>{$t('frameleaf_remote_cgnat_body')}</Notice
              >
            {/if}
            <Row label={$t('frameleaf_remote_manual_port')} help={$t('frameleaf_remote_manual_port_help')}>
              <Switch
                label={$t('frameleaf_remote_manual_port')}
                checked={!remote.portMapping}
                held={busy}
                onChange={(value) => void update({ portMapping: !value })}
              />
            </Row>
            {#if !remote.portMapping}
              <Row label={$t('frameleaf_remote_external_port')} help={$t('frameleaf_remote_external_port_help')}>
                <input
                  class="port"
                  type="number"
                  min="1024"
                  max="65535"
                  step="1"
                  bind:value={portInput}
                  disabled={busy}
                  onchange={savePort}
                  aria-label={$t('frameleaf_remote_external_port')}
                />
              </Row>
            {/if}
          {/if}
          {#if remote.publicUrl}
            <Facts
              rows={[
                {
                  label: $t('frameleaf_remote_certificate'),
                  value: remote.certificateName ?? '—',
                  detail: $t('frameleaf_remote_issued_to_value'),
                },
                {
                  label: $t('frameleaf_remote_renews'),
                  value: remote.certificateExpiresAt
                    ? $t('frameleaf_remote_renews_value', {
                        values: { date: formatDateTime(remote.certificateExpiresAt, $locale) },
                      })
                    : '—',
                },
              ]}
            />
            {#if remote.certificateError}
              <Notice tone="warn" title={remote.certificateError} />
            {/if}
          {/if}
        </Advanced>
      </Section>

      <Section title={$t('frameleaf_ra_links')} description={$t('frameleaf_ra_links_description')}>
        <Choice
          label={$t('frameleaf_ra_links')}
          value={choseCustom ? RemoteAccessPublicUrl.Custom : RemoteAccessPublicUrl.Frameleaf}
          disabled={busy || configFile}
          options={[
            {
              value: RemoteAccessPublicUrl.Frameleaf,
              label: $t('frameleaf_ra_links_frameleaf'),
              detail: frameleafUrl || undefined,
            },
            {
              value: RemoteAccessPublicUrl.Custom,
              label: $t('frameleaf_ra_links_own'),
              detail: hostVerified ? customUrl : $t('frameleaf_ra_links_own_not_ready'),
              disabled: !hostVerified,
            },
          ]}
          onChange={(value) => void usePublicUrl(value as RemoteAccessPublicUrl)}
        />
        {#if serverUrl}
          <p class="said-back">{$t('frameleaf_ra_links_start')} <strong>{serverUrl}</strong></p>
        {/if}
        <Advanced summary={$t('frameleaf_remote_domain_title')}>
          <p class="hint">
            {relayNeedsPlan ? $t('frameleaf_remote_domain_needs_plan') : $t('frameleaf_remote_domain_description')}
          </p>
          <label class="stack">
            {$t('frameleaf_remote_hostname')}
            <input
              value={hostInput}
              placeholder="photos.example.com"
              autocomplete="off"
              spellcheck={false}
              disabled={relayNeedsPlan}
              aria-invalid={hostCheck ? !hostCheck.valid : undefined}
              oninput={(event) => {
                hostInput = event.currentTarget.value;
                hostTouched = true;
              }}
            />
            <small>{$t('frameleaf_remote_hostname_help')}</small>
            {#if hostCheck && !hostCheck.valid && hostInput.length > 3}
              <small class="error">{$t(hostnameMessageKey(hostCheck.reason))}</small>
            {/if}
          </label>
          {#if (hostCheck?.valid || remote.customHostname) && records.length > 0}
            <div class="table-wrap">
              <table>
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
                        <small>{record.purpose}</small>
                      </td>
                      <td>{@render copyValue(record.value, `${record.type} ${$t('frameleaf_remote_record_value')}`)}</td
                      >
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
          <p class="hint" role="status">
            {hostVerified && remote.customHostname
              ? $t('frameleaf_remote_domain_verified_note', { values: { host: remote.customHostname } })
              : hostPending
                ? (remote.customHostnameProblem ?? $t('frameleaf_remote_domain_pending_note'))
                : $t('frameleaf_ra_domain_nothing_changes')}
          </p>
          <div class="actions">
            <Button
              variant={remote.customHostname ? 'default' : 'primary'}
              disabled={relayNeedsPlan || busy || !hostCheck?.valid}
              onclick={() => void checkDns()}>{$t('frameleaf_ra_check_domain')}</Button
            >
            {#if remote.customHostname}
              <Button disabled={busy} onclick={() => void removeDomain()}>{$t('frameleaf_remote_remove_domain')}</Button
              >
            {/if}
          </div>
          {#if settingsDraft}
            <Row label={$t('frameleaf_ra_other_address')} help={$t('frameleaf_ra_other_address_help')}>
              <input
                class="wide"
                type="url"
                value={serverUrl}
                placeholder="https://"
                autocomplete="off"
                spellcheck={false}
                disabled={configFile}
                data-testid="public-server-url"
                aria-label={$t('frameleaf_ra_other_address')}
                oninput={(event) => setServerUrl(event.currentTarget.value)}
              />
            </Row>
          {/if}
        </Advanced>
      </Section>
    {/if}

    {#if !blocked || linked}
      <Section title={$t('frameleaf_ra_signin')} description={$t('frameleaf_ra_signin_description')}>
        <Choice
          label={$t('frameleaf_ra_signin')}
          value={status?.allowPasswordOverRelay ? 'password' : 'frameleaf'}
          disabled={!linked || busy}
          options={[
            {
              value: 'frameleaf',
              label: $t('frameleaf_ra_signin_frameleaf'),
              detail: $t('frameleaf_ra_signin_frameleaf_detail'),
            },
            {
              value: 'password',
              label: $t('frameleaf_ra_signin_password'),
              detail: $t('frameleaf_ra_signin_password_detail'),
            },
          ]}
          onChange={(value) => change('allowPasswordOverRelay', value === 'password')}
        />
        {#if status?.allowPasswordOverRelay}
          <Notice tone="warn" title={$t('frameleaf_ra_signin_password_on')}
            >{$t('frameleaf_ra_signin_password_on_body')}</Notice
          >
        {/if}
        <p class="hint">{$t('frameleaf_ra_signin_hint')}</p>
      </Section>
    {/if}
  </KitPage>
</div>

<Dialog bind:open={confirmOpen} title={confirmTitle} closeLabel={$t('close')} onRequestClose={keepOff}>
  <p>{confirmBody}</p>
  {#snippet actions()}
    <Button onclick={keepOff}>{$t('frameleaf_remote_keep_off')}</Button>
    <Button variant="primary" disabled={busy} onclick={() => void confirm()}>{$t('frameleaf_remote_turn_on')}</Button>
  {/snippet}
</Dialog>

<style>
  .hero-extra {
    display: grid;
    gap: var(--fl-space-3);
    padding: var(--fl-space-4) var(--fl-space-6);
    border-top: 1px solid var(--fl-border);
  }
  @media (max-width: 640px) {
    .hero-extra {
      padding: var(--fl-space-4);
    }
  }
  .address {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    align-items: center;
  }
  .address code {
    font-size: 1.05rem;
    font-weight: 600;
  }
  .copy {
    display: inline-flex;
    gap: var(--fl-space-1);
    align-items: center;
    max-width: 100%;
  }
  code {
    overflow-wrap: anywhere;
  }
  .said-back {
    margin: 0 0 var(--fl-space-3);
    color: var(--fl-text);
  }
  .hint {
    margin: var(--fl-space-2) 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .meter {
    min-width: 14rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    margin: var(--fl-space-2) 0 var(--fl-space-3);
  }
  .stack {
    display: grid;
    gap: var(--fl-space-1);
    margin: var(--fl-space-3) 0;
    color: var(--fl-text);
    font-weight: 500;
  }
  .stack small,
  td small {
    display: block;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 400;
  }
  .stack small.error {
    color: var(--fl-danger, #c0392b);
  }
  input:not([type='radio']) {
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control, 8px);
    background: var(--fl-raised);
    color: var(--fl-text);
    font: inherit;
  }
  input.port {
    width: 7rem;
  }
  input.wide {
    width: min(100%, 22rem);
  }
  .table-wrap {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fl-font-small);
  }
  th,
  td {
    padding: var(--fl-space-2);
    border-bottom: 1px solid var(--fl-border);
    text-align: start;
    vertical-align: top;
  }
</style>
