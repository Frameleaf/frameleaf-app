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
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import type { KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import CloudPendingCode from '$lib/components/frameleaf/cloud/CloudPendingCode.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import { dataRegionKey, displayHost, linkRefusalKeys, shortFingerprint } from '$lib/frameleaf/cloud';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { getCloudManager } from '$lib/managers/get-cloud-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { CloudLinkRefusal, type CloudHeartbeatField, type CloudPermissionsDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCellphone,
    mdiCheck,
    mdiClose,
    mdiCloudAlertOutline,
    mdiCloudCheckOutline,
    mdiCloudOffOutline,
    mdiCloudOutline,
    mdiCompassOutline,
    mdiCreationOutline,
    mdiEarth,
    mdiOpenInNew,
    mdiQrcode,
    mdiShieldCheckOutline,
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

  /** What linking leads to, each with what else it needs (the prototype's Account & link, not linked). */
  const LEADS: { key: string; icon: string; tone: KitTone; status: Translations }[] = [
    { key: 'apps', icon: mdiCellphone, tone: 'good', status: 'frameleaf_cloud_leads_free' },
    { key: 'remote', icon: mdiEarth, tone: 'off', status: 'frameleaf_cloud_leads_needs_plan' },
    { key: 'backup', icon: mdiShieldCheckOutline, tone: 'off', status: 'frameleaf_cloud_leads_needs_licence' },
    { key: 'processing', icon: mdiCreationOutline, tone: 'off', status: 'frameleaf_cloud_leads_pay' },
  ];

  const unlinkConsequences = $derived([
    $t('frameleaf_cloud_unlink_consequence_remote'),
    $t('frameleaf_cloud_unlink_consequence_processing'),
    $t('frameleaf_cloud_unlink_consequence_backup'),
    $t('frameleaf_cloud_unlink_consequence_accounts'),
    $t('frameleaf_cloud_unlink_consequence_plan'),
    $t('frameleaf_cloud_unlink_consequence_local'),
  ]);
</script>

<div class="frameleaf-cloud is-kit" data-section="cloud-account">
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
    <!-- The prototype's Account & link, Frameleaf Cloud turned off (Account.jsx, state "off"). -->
    <KitPage>
      <Hero
        label={$t('frameleaf_cloud_account_status')}
        tone="quiet"
        icon={mdiCloudOffOutline}
        title={$t('frameleaf_cloud_not_configured_title')}
        body={$t('frameleaf_cloud_not_configured_description')}
      />
      <Section title={$t('frameleaf_cloud_off_how')}>
        <p class="said">{$t('frameleaf_cloud_not_configured_help')}</p>
      </Section>
    </KitPage>
  {:else if status.state === 'unlinked' || status.state === 'revoked'}
    <!-- The prototype's Account & link, not linked (settings-v2/cloud/Account.jsx, state "new"). -->
    <KitPage>
      {#if status.state === 'unlinked' && status.linkRefusal === CloudLinkRefusal.RegionMismatch}
        {@const accountRegion = regionName(status.regionMismatch?.accountRegion)}
        <!-- FC-18: Frameleaf Cloud's own message names both regions -->
        <Notice tone="warn" title={$t('frameleaf_cloud_link_refusal_region_mismatch_title')}>
          {status.lastError || $t('frameleaf_cloud_link_refusal_region_mismatch_body')}
          {#if !status.regionMismatch?.canContinue && status.linkTokenConfigured}
            {$t('frameleaf_cloud_link_region_headless')}
          {/if}
          {#snippet action()}
            {#if status.regionMismatch?.canContinue}
              <div class="notice-actions" data-testid="cloud-region-mismatch-actions">
                <Button
                  variant="primary"
                  disabled={busy}
                  onclick={() =>
                    void act(
                      () => cloudManager.continueLink(),
                      accountRegion
                        ? $t('frameleaf_cloud_link_region_linked', { values: { region: accountRegion } })
                        : '',
                    )}
                >
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
            {/if}
          {/snippet}
        </Notice>
      {:else if status.state === 'unlinked' && status.linkRefusal}
        {@const refusal = linkRefusalKeys(status.linkRefusal)}
        <Notice tone="warn" title={$t(refusal.title)}>{$t(refusal.body)}</Notice>
      {:else if status.state === 'unlinked' && status.linkResult === 'denied'}
        <Notice tone="warn" title={$t('frameleaf_cloud_link_denied_title')}
          >{$t('frameleaf_cloud_link_denied_body')}</Notice
        >
      {:else if status.state === 'unlinked' && status.linkResult === 'expired'}
        <Notice tone="warn" title={$t('frameleaf_cloud_link_expired_title')}
          >{$t('frameleaf_cloud_link_expired_body')}</Notice
        >
      {:else if status.state === 'unlinked' && status.lastError}
        <Notice tone="warn" title={$t('frameleaf_cloud_last_problem')}>{status.lastError}</Notice>
      {/if}
      <Hero
        label={$t('frameleaf_cloud_account_status')}
        tone={status.state === 'revoked' ? 'bad' : 'quiet'}
        icon={status.state === 'revoked' ? mdiCloudOffOutline : mdiCloudOutline}
        title={status.state === 'revoked'
          ? $t('frameleaf_cloud_revoked_title')
          : $t('frameleaf_cloud_unlinked_hero_title')}
        body={status.state === 'revoked'
          ? `${status.revoked?.reason || $t('frameleaf_cloud_revoked_no_reason')} ${$t('frameleaf_cloud_revoked_help')}`
          : `${$t('frameleaf_cloud_unlinked_hero_body')} ${$t('frameleaf_cloud_unlinked_how')}`}
      >
        {#snippet actions()}
          {#if status.state === 'revoked'}
            <Button
              disabled={busy}
              onclick={() => void act(() => cloudManager.unlink(), $t('frameleaf_cloud_forgotten'))}
              >{$t('frameleaf_cloud_forget_link')}</Button
            >
          {/if}
          <Button
            variant="primary"
            disabled={busy}
            onclick={() => void act(() => cloudManager.startLink(), $t('frameleaf_cloud_link_started'))}
            >{status.state === 'revoked'
              ? $t('frameleaf_cloud_link_again')
              : $t('frameleaf_cloud_landing_link_server')}</Button
          >
        {/snippet}
      </Hero>
      <Section title={$t('frameleaf_cloud_leads')} description={$t('frameleaf_cloud_leads_description')}>
        <ItemList plain>
          {#each LEADS as lead (lead.key)}
            <Item
              icon={lead.icon}
              name={$t(`frameleaf_cloud_leads_${lead.key}` as Translations)}
              detail={$t(`frameleaf_cloud_leads_${lead.key}_detail` as Translations)}
              tone={lead.tone}
              status={$t(lead.status)}
            />
          {/each}
        </ItemList>
        <Advanced summary={$t('frameleaf_cloud_headless_title')}>
          <Row
            label={$t('frameleaf_cloud_headless_title')}
            help={status.linkTokenConfigured
              ? `${$t('frameleaf_cloud_headless_body')} ${$t('frameleaf_cloud_headless_configured')}`
              : $t('frameleaf_cloud_headless_body')}
          >
            <code class="ident">FRAMELEAF_LINK_TOKEN=fll_…</code>
          </Row>
        </Advanced>
      </Section>
    </KitPage>
  {:else if status.state === 'pending' && status.pending}
    {@const pending = status.pending}
    <!-- Linking: the code to approve on the account site, in the kit's page frame. -->
    <KitPage>
      <Hero
        label={$t('frameleaf_cloud_account_status')}
        tone={expired ? 'warn' : 'good'}
        icon={mdiQrcode}
        title={expired
          ? $t('frameleaf_cloud_code_expired')
          : $t('frameleaf_cloud_pending_title', { values: { host: displayHost(pending.verificationUri) } })}
        body={$t('frameleaf_cloud_pending_description')}
      >
        {#snippet actions()}
          <Button
            disabled={busy}
            onclick={() => void act(() => cloudManager.cancelLink(), $t('frameleaf_cloud_link_cancelled'))}
          >
            {$t('frameleaf_cloud_cancel')}
          </Button>
          <Button
            variant={expired ? 'primary' : 'default'}
            disabled={busy}
            onclick={() => void act(() => cloudManager.startLink(), $t('frameleaf_cloud_new_code_ready'))}
          >
            {$t('frameleaf_cloud_new_code')}
          </Button>
        {/snippet}
      </Hero>
      <Section
        title={$t('frameleaf_cloud_pending_code_title')}
        description={$t('frameleaf_cloud_pending_code_description')}
      >
        <div class="pending">
          <CloudPendingCode
            {pending}
            keyFingerprint={status.keyFingerprint}
            lastError={status.lastError}
            pollError={!!cloudManager.pollError}
            bind:expired={codeExpired}
          />
        </div>
      </Section>
    </KitPage>
  {:else if status.state === 'linked'}
    <!-- The prototype's Account & link, linked (settings-v2/cloud/Account.jsx, state "ok"). -->
    <KitPage>
      {#if status.relinkRequested}
        <Notice tone="warn" title={$t('frameleaf_cloud_relink_title')}>{$t('frameleaf_cloud_relink_body')}</Notice>
      {/if}
      {#if status.heartbeatFailures > 0 && status.lastError}
        <Notice
          tone="warn"
          title={$t('frameleaf_cloud_checkin_failing', { values: { count: status.heartbeatFailures } })}
        >
          {status.lastError}
        </Notice>
      {/if}
      <!-- FL-541: the link said in one sentence first -->
      <Hero
        label={$t('frameleaf_cloud_account_status')}
        tone={status.cloneSuspected ? 'warn' : 'good'}
        icon={status.cloneSuspected ? mdiCloudAlertOutline : mdiCloudCheckOutline}
        title={status.cloneSuspected
          ? $t('frameleaf_cloud_clone_title')
          : $t('frameleaf_cloud_hero_linked', { values: { account: status.account?.label ?? status.cloudHost } })}
        body={status.cloneSuspected
          ? $t('frameleaf_cloud_clone_body')
          : [
              $t('frameleaf_cloud_hero_since', { values: { date: formatWhen(status.linkedAt) } }),
              status.lastContactAt
                ? $t('frameleaf_cloud_hero_heard', { values: { when: formatWhen(status.lastContactAt) } })
                : '',
              status.dataRegion
                ? $t('frameleaf_cloud_hero_region', { values: { region: regionLabel(status.dataRegion) } })
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
      >
        {#snippet actions()}
          {#if status.manageUrl}
            <a class="fl-control button" href={status.manageUrl} target="_blank" rel="noopener noreferrer">
              <Icon icon={mdiOpenInNew} size="18" aria-hidden />
              {$t('frameleaf_cloud_manage_on_site')}
            </a>
          {/if}
        {/snippet}
      </Hero>

      <!-- The Frameleaf apps find this server by themselves; away from home they need remote access. -->
      <Notice
        icon={mdiCellphone}
        title={status.remoteAccessEnabled ? $t('frameleaf_cloud_apps_anywhere') : $t('frameleaf_cloud_apps_at_home')}
      >
        {status.remoteAccessEnabled
          ? $t('frameleaf_cloud_apps_anywhere_help')
          : $t('frameleaf_cloud_apps_at_home_help')}
        {#snippet action()}
          {#if !status.remoteAccessEnabled}
            <a class="fl-control button" href={commandCenterUrl('cloud', 'cloud-remote')}
              >{$t('frameleaf_cloud_apps_set_up_remote')}</a
            >
          {/if}
        {/snippet}
      </Notice>

      <Section title={$t('frameleaf_cloud_permissions_title')} description={$t('frameleaf_cloud_permissions_short')}>
        <Row label={$t('frameleaf_cloud_permission_remote')} help={$t('frameleaf_cloud_permission_remote_help')}>
          <Switch
            label={$t('frameleaf_cloud_permission_remote')}
            checked={status.permissions.allowRemoteEnable}
            held={busy}
            onChange={(value) => void permission('allowRemoteEnable', value)}
          />
        </Row>
        <Row label={$t('frameleaf_cloud_permission_backup')} help={$t('frameleaf_cloud_permission_backup_help')}>
          <Switch
            label={$t('frameleaf_cloud_permission_backup')}
            checked={status.permissions.allowBackupTrigger}
            held={busy}
            onChange={(value) => void permission('allowBackupTrigger', value)}
          />
        </Row>
      </Section>

      <Section title={$t('frameleaf_cloud_sends_title')} description={$t('frameleaf_cloud_sends_short')}>
        <Facts
          rows={[
            {
              label: $t('frameleaf_cloud_sends_sent'),
              value: $t('frameleaf_cloud_sends_sent_value'),
              detail: $t('frameleaf_cloud_sends_sent_detail'),
            },
            {
              label: $t('frameleaf_cloud_sends_also'),
              value: $t('frameleaf_cloud_sends_also_value'),
              detail: $t('frameleaf_cloud_sends_also_detail'),
            },
            {
              label: $t('frameleaf_cloud_sends_never'),
              value: $t('frameleaf_cloud_sends_never_value'),
              detail: $t('frameleaf_cloud_sends_never_help'),
            },
          ]}
        />
        <Advanced>
          <Row label={$t('frameleaf_cloud_instance_id')} help={$t('frameleaf_cloud_instance_id_help')}>
            <code class="ident">{status.instanceId}</code>
          </Row>
          <Row label={$t('frameleaf_cloud_key_fingerprint')} help={$t('frameleaf_cloud_key_fingerprint_help')}>
            <code class="ident" title={status.keyFingerprint ?? ''}>{shortFingerprint(status.keyFingerprint)}</code>
          </Row>
          <Row label={$t('frameleaf_cloud_contact_now')} help={$t('frameleaf_cloud_contact_now_help')}>
            <Button
              disabled={busy}
              onclick={() => void act(() => cloudManager.checkIn(), $t('frameleaf_cloud_checked_in'))}
            >
              {$t('frameleaf_cloud_check_in')}
            </Button>
          </Row>
          <Row label={$t('frameleaf_cloud_permission_refresh')} help={$t('frameleaf_cloud_permission_refresh_help')}>
            <Switch
              label={$t('frameleaf_cloud_permission_refresh')}
              checked={status.permissions.allowEntitlementRefresh}
              held={busy}
              onChange={(value) => void permission('allowEntitlementRefresh', value)}
            />
          </Row>
          <Row label={$t('frameleaf_cloud_headless_title')} help={$t('frameleaf_cloud_headless_body')}>
            <code class="ident">FRAMELEAF_LINK_TOKEN=fll_…</code>
          </Row>
          <Row label={$t('frameleaf_cloud_tour_take')} help={$t('frameleaf_cloud_signin_role_notice')}>
            <!-- FL-196: reopen the linked-server tour (CloudTourHost opens it from the address). -->
            <Button onclick={() => void goto(commandCenterUrl('cloud', 'cloud-account', { tour: 'cloud' }))}>
              <Icon icon={mdiCompassOutline} size="18" aria-hidden />
              {$t('frameleaf_cloud_tour_take')}
            </Button>
          </Row>
          <dl class="sends" data-testid="cloud-heartbeat-fields" aria-label={$t('frameleaf_cloud_sends_exactly')}>
            {#each status.heartbeatFields as field (field)}
              <dt>{heartbeatLabel(field)}</dt>
              <dd>{heartbeatHelp(field)}</dd>
            {/each}
            <dt>{$t('frameleaf_cloud_sends_never')}</dt>
            <dd>{$t('frameleaf_cloud_sends_never_help')}</dd>
          </dl>
          <p class="footnote">{$t('frameleaf_cloud_sends_footer')}</p>
        </Advanced>
      </Section>

      <Section title={$t('frameleaf_cloud_unlink_title')} description={$t('frameleaf_cloud_unlink_description')}>
        {#snippet action()}
          <Button
            variant="danger"
            onclick={() => {
              understood = false;
              unlinking = true;
            }}
          >
            {$t('frameleaf_cloud_unlink_action')}
          </Button>
        {/snippet}
      </Section>
    </KitPage>
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

<style>
  a.button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-2);
    text-decoration: none;
    white-space: nowrap;
  }
  .ident {
    font-family: inherit;
    font-size: var(--fl-font-small);
    overflow-wrap: anywhere;
  }
  .sends {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--fl-space-2) var(--fl-space-5);
    margin: 0;
    padding: var(--fl-space-4) 0;
    font-size: var(--fl-font-small);
    border-top: 1px solid var(--fl-border);
  }
  .sends dt {
    font-weight: 600;
  }
  .sends dd {
    margin: 0;
    color: var(--fl-muted);
  }
  .said {
    max-width: 720px;
    margin: 0;
    padding-bottom: var(--fl-space-5);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .notice-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  .pending {
    padding-bottom: var(--fl-space-5);
  }
  .footnote {
    margin: 0;
    padding-bottom: var(--fl-space-5);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  @container kit (max-width: 620px) {
    .sends {
      grid-template-columns: 1fr;
      gap: var(--fl-space-1);
    }
    .sends dd {
      margin-bottom: var(--fl-space-2);
    }
  }
</style>
