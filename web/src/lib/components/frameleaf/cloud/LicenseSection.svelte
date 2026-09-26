<script lang="ts">
  /**
   * Settings → Frameleaf Cloud → Licence (FL-156): the prototype's `License`
   * (design/frameleaf/template/src/FrameleafCloud.jsx:1041-1222, effd05ffb7) on the server's real
   * licence certificates. Licence is its own page, separate from Plan (owner decision 2026-09-25).
   * States: none, active, grace, expired and invalid, with the key hint, expiry, grace deadline and
   * entitlement chips; actions: activate a key, install an offline file, refresh and remove.
   */
  import './cloud-account.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import CloudBanner from '$lib/components/frameleaf/cloud/CloudBanner.svelte';
  import CloudCard from '$lib/components/frameleaf/cloud/CloudCard.svelte';
  import LicenseKeyField from '$lib/components/frameleaf/cloud/LicenseKeyField.svelte';
  import { discountPercent, type ProductKeyCheck } from '$lib/frameleaf/cloud';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { Route } from '$lib/route';
  import { copyToClipboard } from '$lib/utils';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { deleteUserLicense, getMyUser, setUserLicense } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiCartOutline,
    mdiCertificateOutline,
    mdiCheckCircleOutline,
    mdiClose,
    mdiContentCopy,
    mdiCreditCardOutline,
    mdiDeleteOutline,
    mdiFileDocumentOutline,
    mdiHeartOutline,
    mdiInfinity,
    mdiKeyOutline,
    mdiMinus,
    mdiRefresh,
    mdiTagOutline,
    mdiUpload,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  onMount(() => cloudManager.listen());

  const license = $derived(cloudManager.license);
  const key = $derived(license?.key ?? null);
  const serverLicensed = $derived(!!key && (key.state === 'active' || key.state === 'grace'));
  // FL-156: a key for one person (the administrator's own) is an individual licence, shown as
  // Licensed as in the prototype (frameleaf-cloud-data.mjs:579-592)
  const personal = $derived(authManager.user.license ?? null);
  const licensed = $derived(serverLicensed || !!personal);
  // the plan discount Frameleaf Cloud published (license/products); none shown until it is known
  const offered = $derived(cloudManager.products?.licensedDiscount ?? 0);
  const pct = $derived(discountPercent(offered));

  let keyValue = $state('');
  let keyCheck = $state<ProductKeyCheck | null>(null);
  /** Which key the Remove dialog is about: this server's key or the administrator's own. */
  let removingKey = $state<'server' | 'personal' | null>(null);
  const removing = $derived(removingKey !== null);
  let busy = $state(false);
  let notice = $state('');
  let failure = $state('');
  let fileInput = $state<HTMLInputElement>();

  const formatDate = (value: string | null | undefined) =>
    value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(value)) : '—';
  const formatWhen = (value: string | null | undefined) =>
    value
      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
      : '—';

  const act = async (call: () => Promise<unknown>, success: string) => {
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

  const installFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      failure = $t('frameleaf_license_file_unreadable');
      return;
    }
    await act(() => cloudManager.installLicenseFile(text), $t('frameleaf_license_file_installed'));
  };

  const stateLabel = (state: string | undefined) => {
    switch (state) {
      case 'active': {
        return $t('frameleaf_license_state_active');
      }
      case 'grace': {
        return $t('frameleaf_license_state_grace');
      }
      case 'expired': {
        return $t('frameleaf_license_state_expired');
      }
      case 'invalid': {
        return $t('frameleaf_license_state_invalid');
      }
      default: {
        return $t('frameleaf_license_state_none');
      }
    }
  };
  const tone = (state: string | undefined) =>
    state === 'active'
      ? 'ok'
      : state === 'grace'
        ? 'warning'
        : state === 'expired' || state === 'invalid'
          ? 'danger'
          : 'muted';

  const chips = $derived(
    license
      ? ([
          ['remoteAccess', $t('frameleaf_license_entitlement_remote'), license.entitlements.remoteAccess],
          ['cloudBackup', $t('frameleaf_license_entitlement_backup'), license.entitlements.cloudBackup],
          ['cloudMl', $t('frameleaf_license_entitlement_processing'), license.entitlements.cloudMl],
          // an active key for one person makes its holder a supporter too
          ['supporter', $t('frameleaf_license_entitlement_supporter'), license.entitlements.supporter || !!personal],
        ] as const)
      : [],
  );
</script>

<div class="frameleaf-cloud" data-section="cloud-license">
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

  {#if !license}
    <p class="fc-muted" role="status">{$t('frameleaf_cloud_loading')}</p>
  {:else}
    {#if license.state === 'grace'}
      <CloudBanner tone="warning" title={$t('frameleaf_license_grace_title')}>
        {$t('frameleaf_license_grace_body', { values: { date: formatDate(license.graceUntil) } })}
      </CloudBanner>
    {:else if license.state === 'expired'}
      <CloudBanner tone="danger" title={$t('frameleaf_license_expired_title')}
        >{$t('frameleaf_license_expired_body')}</CloudBanner
      >
    {:else if license.state === 'invalid'}
      <CloudBanner tone="danger" title={$t('frameleaf_license_invalid_title')}
        >{$t('frameleaf_license_invalid_body')}</CloudBanner
      >
    {/if}

    <CloudCard
      icon={mdiCertificateOutline}
      title={serverLicensed
        ? key?.kind === 'individual'
          ? $t('frameleaf_license_individual')
          : $t('frameleaf_license_server')
        : personal
          ? $t('frameleaf_license_individual')
          : $t('frameleaf_license_not_licensed_title')}
      description={licensed
        ? $t('frameleaf_license_licensed_description')
        : $t('frameleaf_license_not_licensed_description')}
      status={licensed ? $t('frameleaf_license_status_licensed') : $t('frameleaf_license_status_not_licensed')}
      tone={licensed ? 'ok' : 'muted'}
    >
      <ul class="fc-benefits">
        {#if offered > 0}
          <li>
            <Icon icon={mdiTagOutline} size="18" />
            <span>
              <strong>{$t('frameleaf_license_benefit_discount_title', { values: { pct } })}</strong>
              {$t('frameleaf_license_benefit_discount_body')}
            </span>
          </li>
        {/if}
        <li>
          <Icon icon={mdiHeartOutline} size="18" />
          <span>
            <strong>{$t('frameleaf_license_benefit_badge_title')}</strong>
            {$t('frameleaf_license_benefit_badge_body')}
          </span>
        </li>
        <li>
          <Icon icon={mdiInfinity} size="18" />
          <span>
            <strong>{$t('frameleaf_license_benefit_once_title')}</strong>
            {$t('frameleaf_license_benefit_once_body')}
          </span>
        </li>
      </ul>
      {#if key}
        <dl class="fc-facts">
          <dt>{$t('frameleaf_license_key')}</dt>
          <dd>•••• {key.keyHint ?? '—'}</dd>
          <dt>{$t('frameleaf_license_type')}</dt>
          <dd>{key.kind === 'individual' ? $t('frameleaf_license_individual') : $t('frameleaf_license_server')}</dd>
          <dt>{$t('frameleaf_license_state')}</dt>
          <dd>
            <span
              class="fc-status"
              class:is-ok={tone(key.state) === 'ok'}
              class:is-warning={tone(key.state) === 'warning'}
              class:is-danger={tone(key.state) === 'danger'}>{stateLabel(key.state)}</span
            >
          </dd>
          <dt>{$t('frameleaf_license_activated')}</dt>
          <dd>{formatWhen(key.activatedAt)}</dd>
          {#if key.graceUntil}
            <dt>{$t('frameleaf_license_grace_until')}</dt>
            <dd>{formatDate(key.graceUntil)}</dd>
          {/if}
          <dt>{$t('frameleaf_license_last_checked')}</dt>
          <dd>{formatWhen(key.refreshedAt ?? key.activatedAt)}</dd>
        </dl>
      {/if}
      {#if personal}
        <dl class="fc-facts" aria-label={$t('frameleaf_license_personal_facts')}>
          <dt>{$t('frameleaf_license_key')}</dt>
          <dd>•••• {personal.keyHint}</dd>
          <dt>{$t('frameleaf_license_type')}</dt>
          <dd>{$t('frameleaf_license_individual')}</dd>
          <dt>{$t('frameleaf_license_activated')}</dt>
          <dd>{formatWhen(personal.activatedAt)}</dd>
        </dl>
      {/if}
      <ul class="fc-chips" aria-label={$t('frameleaf_license_included')}>
        {#each chips as [id, label, on] (id)}
          <li class:is-on={on}>
            <Icon icon={on ? mdiCheckCircleOutline : mdiMinus} size="16" />
            {label}
            <span class="fc-visually-hidden">
              {on ? $t('frameleaf_license_chip_included') : $t('frameleaf_license_chip_not_included')}
            </span>
          </li>
        {/each}
      </ul>
      {#if license.refresh.lastError}
        <p class="fc-muted" role="status">
          {$t('frameleaf_license_refresh_failed', { values: { error: license.refresh.lastError } })}
        </p>
      {/if}
      <div class="fc-actions">
        {#if !licensed}
          <a class="fc-button is-primary" href={Route.buy()}>
            <Icon icon={mdiCartOutline} size="18" />
            {$t('frameleaf_license_buy')}
          </a>
        {/if}
        {#if license.linked && (license.key || license.plan)}
          <Button
            disabled={busy}
            onclick={() => void act(() => cloudManager.refreshLicense(), $t('frameleaf_license_refreshed'))}
          >
            <Icon icon={mdiRefresh} size="18" />
            {$t('frameleaf_license_refresh')}
          </Button>
        {/if}
        {#if key}
          <Button onclick={() => (removingKey = 'server')}>
            <Icon icon={mdiDeleteOutline} size="18" />
            {$t('frameleaf_license_remove_action')}
          </Button>
        {/if}
        {#if personal}
          <Button onclick={() => (removingKey = 'personal')}>
            <Icon icon={mdiDeleteOutline} size="18" />
            {$t('frameleaf_license_remove_personal_action')}
          </Button>
        {/if}
        <a class="fc-button" href={commandCenterUrl('cloud', 'cloud-plan')}>
          <Icon icon={mdiCreditCardOutline} size="18" />
          {$t('frameleaf_license_see_plans')}
        </a>
      </div>
    </CloudCard>

    <!-- as in the prototype, a key can be entered whenever the server is not licensed, also to
         replace an expired or refused one without removing it first -->
    {#if !licensed}
      <CloudCard
        icon={mdiKeyOutline}
        title={$t('frameleaf_license_enter_key_title')}
        description={$t('frameleaf_license_enter_key_description')}
      >
        <LicenseKeyField
          bind:value={keyValue}
          accept="any"
          label={$t('frameleaf_license_key')}
          help={$t('frameleaf_license_key_help')}
          onCheck={(check) => (keyCheck = check)}
        />
        {#if !license.configured}
          <p class="fc-muted">{$t('frameleaf_license_key_needs_cloud')}</p>
        {/if}
        <div class="fc-actions">
          <Button
            variant="primary"
            disabled={busy || !keyCheck?.valid || !license.configured}
            onclick={async () => {
              // a key for one person is that administrator's own supporter key (personal endpoint)
              const done =
                keyCheck?.valid && keyCheck.kind === 'individual'
                  ? await act(async () => {
                      await setUserLicense({ licenseActivateDto: { key: keyValue } });
                      authManager.setUser(await getMyUser());
                    }, $t('frameleaf_license_personal_activated_notice'))
                  : await act(() => cloudManager.activateLicense(keyValue), $t('frameleaf_license_activated_notice'));
              if (done) {
                keyValue = '';
              }
            }}
          >
            {$t('frameleaf_license_activate')}
          </Button>
        </div>
      </CloudCard>
    {/if}

    <CloudCard
      icon={mdiFileDocumentOutline}
      title={$t('frameleaf_license_file_title')}
      description={$t('frameleaf_license_file_description')}
    >
      <dl class="fc-facts">
        <dt>{$t('frameleaf_license_instance_id')}</dt>
        <dd>
          <span class="fc-copy">
            <code>{license.fingerprint.instanceId ?? '—'}</code>
            {#if license.fingerprint.instanceId}
              <Button
                label={$t('frameleaf_license_copy_instance_id')}
                onclick={() => copyToClipboard(license.fingerprint.instanceId ?? '')}
              >
                <Icon icon={mdiContentCopy} size="16" />
              </Button>
            {/if}
          </span>
        </dd>
      </dl>
      <input
        bind:this={fileInput}
        type="file"
        accept=".json,.lic,application/json"
        hidden
        onchange={(event) => {
          void installFile(event.currentTarget.files?.[0]);
          event.currentTarget.value = '';
        }}
      />
      <div class="fc-actions">
        <Button disabled={busy} onclick={() => fileInput?.click()}>
          <Icon icon={mdiUpload} size="18" />
          {$t('frameleaf_license_choose_file')}
        </Button>
      </div>
    </CloudCard>
  {/if}
</div>

<Dialog
  bind:open={() => removing, (open) => (removingKey = open ? removingKey : null)}
  title={removingKey === 'personal'
    ? $t('frameleaf_license_remove_personal_title')
    : $t('frameleaf_license_remove_title')}
  closeLabel={$t('close')}
>
  <p>
    {removingKey === 'personal' ? $t('frameleaf_license_remove_personal_body') : $t('frameleaf_license_remove_body')}
  </p>
  {#snippet actions()}
    <Button onclick={() => (removingKey = null)}>{$t('frameleaf_cloud_cancel')}</Button>
    <Button
      variant="danger"
      disabled={busy}
      onclick={async () => {
        // a server key is removed from the server; a key for one person through the personal endpoint
        const removed =
          removingKey === 'personal'
            ? await act(async () => {
                await deleteUserLicense();
                authManager.setUser(await getMyUser());
              }, $t('frameleaf_license_personal_removed_notice'))
            : await act(() => cloudManager.removeLicenseKey(), $t('frameleaf_license_removed_notice'));
        if (removed) {
          removingKey = null;
        }
      }}
    >
      {$t('frameleaf_license_remove_confirm')}
    </Button>
  {/snippet}
</Dialog>
