<script lang="ts">
  /**
   * Settings → Frameleaf Cloud → Plan (FL-157): the prototype's `Plan`
   * (design/frameleaf/template/src/FrameleafCloud.jsx:786-1039, effd05ffb7) on the server's real plan
   * certificate. Plan and Licence are separate pages (owner decision 2026-09-25).
   *
   * - Plan status (none, active, grace, expired) with banners, included features, renewal, source,
   *   the store link, refresh and "remove from this server" (the plan only).
   * - Plan cards with the licensed-server price struck through when the server is licensed. AI
   *   credit is never discounted.
   * - Owner decision (2026-09-25): every plan includes 1 TB of cloud backup, listed on the cards as in
   *   the prototype; more storage is sold in 1 TB blocks, priced from `CLOUD_BACKUP_PRICING`.
   * - Checkout happens in the store the server was deployed with; with none configured the cards
   *   say purchasing is not available yet (FL-172). The simulated "Preview other plan states" is
   *   prototype-only and left out.
   */
  import './cloud-account.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import CloudBanner from '$lib/components/frameleaf/cloud/CloudBanner.svelte';
  import CloudCard from '$lib/components/frameleaf/cloud/CloudCard.svelte';
  import {
    CLOUD_BACKUP_PRICING,
    cloudPlanPrice,
    discountPercent,
    formatUsd,
    licensedDiscount,
  } from '$lib/frameleaf/cloud';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { Route } from '$lib/route';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { Icon } from '@immich/ui';
  import {
    mdiCheckCircleOutline,
    mdiClose,
    mdiCloudUploadOutline,
    mdiCreditCardOutline,
    mdiDeleteOutline,
    mdiLinkVariant,
    mdiMinus,
    mdiOpenInNew,
    mdiRefresh,
    mdiShieldCheckOutline,
    mdiTagOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  onMount(() => cloudManager.listen());

  const license = $derived(cloudManager.license);
  const products = $derived(cloudManager.products);
  const plan = $derived(license?.plan ?? null);
  // FL-156: an activated server key or this person's own supporter key takes the published share
  // (license/products) off plans; AI credit and extra backup never change
  const discount = $derived(
    licensedDiscount({ serverLicensed: !!license?.entitlements.supporter, personalKey: !!authManager.user.license }),
  );
  const offered = $derived(products?.licensedDiscount ?? 0);
  const share = $derived(discount === null ? 0 : offered);
  const linked = $derived(!!license?.linked);
  const plans = $derived(products?.products.filter((product) => product.kind === 'plan') ?? []);
  const pct = $derived(discountPercent(offered));

  let removing = $state(false);
  let checkout = $state<(typeof plans)[number] | null>(null);
  let busy = $state(false);
  let notice = $state('');
  let failure = $state('');

  const formatDate = (value: string | null | undefined) =>
    value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(value)) : '—';
  const formatWhen = (value: string | null | undefined) =>
    value
      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
      : '—';

  const planTitle = (id: string) =>
    id === 'cloud-annual' ? $t('frameleaf_plan_annual_title') : $t('frameleaf_plan_monthly_title');
  const periodLabel = (period: string) =>
    period === 'year' ? $t('frameleaf_plan_period_year') : $t('frameleaf_plan_period_month');

  const statusLabel = $derived.by(() => {
    switch (plan?.state) {
      case 'active': {
        return $t('frameleaf_license_state_active');
      }
      case 'grace': {
        return $t('frameleaf_plan_status_grace', { values: { date: formatDate(plan.graceUntil) } });
      }
      case 'expired': {
        return $t('frameleaf_license_state_expired');
      }
      case 'invalid': {
        return $t('frameleaf_license_state_invalid');
      }
      default: {
        return $t('frameleaf_plan_status_none');
      }
    }
  });
  const statusTone = $derived(
    plan?.state === 'active' ? 'ok' : plan?.state === 'grace' ? 'warning' : plan ? 'danger' : 'muted',
  );

  const chips = $derived(
    license
      ? ([
          ['remoteAccess', $t('frameleaf_license_entitlement_remote'), license.entitlements.remoteAccess],
          ['cloudBackup', $t('frameleaf_license_entitlement_backup'), license.entitlements.cloudBackup],
          ['cloudMl', $t('frameleaf_license_entitlement_processing'), linked || license.entitlements.cloudMl],
        ] as const)
      : [],
  );

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
</script>

{#snippet price(amount: number, period: string)}
  {@const paid = cloudPlanPrice(amount, share)}
  <p class="fc-price">
    {#if paid !== amount}
      <s>{formatUsd(amount)}</s>
      <span class="fc-visually-hidden">{$t('frameleaf_plan_licensed_price')}</span>
    {/if}
    {formatUsd(paid)}
    <small>/ {periodLabel(period)}</small>
  </p>
{/snippet}

<div class="frameleaf-cloud" data-section="cloud-plan">
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

  {#if !license || !products}
    <p class="fc-muted" role="status">{$t('frameleaf_cloud_loading')}</p>
  {:else}
    <CloudCard
      icon={mdiCreditCardOutline}
      title={plan ? $t('frameleaf_plan_title') : $t('frameleaf_plan_none_title')}
      description={plan ? $t('frameleaf_plan_description') : $t('frameleaf_plan_none_description')}
      status={statusLabel}
      tone={statusTone}
    >
      {#if plan?.state === 'grace'}
        <CloudBanner tone="warning" title={$t('frameleaf_license_grace_title')}>
          {$t('frameleaf_license_grace_body', { values: { date: formatDate(plan.graceUntil) } })}
        </CloudBanner>
      {:else if plan?.state === 'expired'}
        <CloudBanner tone="danger" title={$t('frameleaf_license_expired_title')}
          >{$t('frameleaf_license_expired_body')}</CloudBanner
        >
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
      {#if plan}
        <dl class="fc-facts">
          <dt>{plan.state === 'expired' ? $t('frameleaf_plan_ended') : $t('frameleaf_plan_renews')}</dt>
          <dd>{formatDate(plan.expiresAt)}</dd>
          <dt>{$t('frameleaf_plan_source')}</dt>
          <dd>{plan.source === 'file' ? $t('frameleaf_plan_source_file') : $t('frameleaf_plan_source_account')}</dd>
          <dt>{$t('frameleaf_license_last_checked')}</dt>
          <dd>{formatWhen(plan.refreshedAt ?? plan.activatedAt)}</dd>
        </dl>
      {/if}
      <p class="fc-note"><Icon icon={mdiShieldCheckOutline} size="16" /> {$t('frameleaf_plan_never_locked')}</p>
      {#if offered > 0}
        <p class="fc-note">
          <Icon icon={mdiTagOutline} size="16" />
          {#if discount === 'server'}
            {$t('frameleaf_plan_discount_licensed', { values: { pct } })}
          {:else if discount === 'personal'}
            {$t('frameleaf_plan_discount_personal', { values: { pct } })}
          {:else}
            {$t('frameleaf_plan_discount_offer', { values: { pct } })}
            <a class="fc-link" href={commandCenterUrl('cloud', 'cloud-license')}
              >{$t('frameleaf_plan_activate_licence')}</a
            >
          {/if}
        </p>
      {/if}
      <div class="fc-actions">
        {#if plan && plan.source !== 'file' && products.storeUrl}
          <a class="fc-button" href={products.storeUrl} target="_blank" rel="noopener noreferrer">
            <Icon icon={mdiOpenInNew} size="18" />
            {$t('frameleaf_plan_manage')}
          </a>
        {/if}
        {#if plan && linked}
          <Button
            disabled={busy}
            onclick={() => void act(() => cloudManager.refreshLicense(), $t('frameleaf_plan_refreshed'))}
          >
            <Icon icon={mdiRefresh} size="18" />
            {$t('frameleaf_license_refresh')}
          </Button>
        {/if}
        {#if plan}
          <Button onclick={() => (removing = true)}>
            <Icon icon={mdiDeleteOutline} size="18" />
            {$t('frameleaf_plan_remove_action')}
          </Button>
        {/if}
      </div>
    </CloudCard>

    {#if !plan}
      <CloudCard
        title={$t('frameleaf_plan_add_title')}
        description={linked ? $t('frameleaf_plan_add_linked') : $t('frameleaf_plan_add_unlinked')}
      >
        <div class="fc-plan-grid">
          {#each plans as item (item.id)}
            {@const url = item.storeUrl}
            <article class:is-recommended={item.id === 'cloud-annual'} class="fl-continuous-corners">
              <h3>{planTitle(item.id)}</h3>
              {@render price(item.priceUsd, item.period)}
              <ul>
                <li>{$t('frameleaf_plan_feature_remote')}</li>
                <li>{$t('frameleaf_plan_feature_backup', { values: { size: CLOUD_BACKUP_PRICING.includedTb } })}</li>
                <li>{$t('frameleaf_plan_feature_servers')}</li>
                {#if item.id === 'cloud-annual'}
                  <li>{$t('frameleaf_plan_feature_two_months')}</li>
                {/if}
              </ul>
              {#if url}
                <Button
                  variant={item.id === 'cloud-annual' ? 'primary' : 'default'}
                  disabled={!linked}
                  onclick={() => (checkout = item)}
                >
                  {$t('frameleaf_plan_continue')}
                </Button>
              {:else}
                <p class="fc-muted" role="status">{$t('frameleaf_plan_store_unavailable')}</p>
              {/if}
            </article>
          {/each}
        </div>
        <p class="fc-note">
          <Icon icon={mdiCloudUploadOutline} size="16" />
          {$t('frameleaf_plan_backup_extra', {
            values: {
              included: CLOUD_BACKUP_PRICING.includedTb,
              price: formatUsd(CLOUD_BACKUP_PRICING.usdPerTbMonth * CLOUD_BACKUP_PRICING.blockTb),
              block: CLOUD_BACKUP_PRICING.blockTb,
            },
          })}
        </p>
        <div class="fc-actions">
          {#if !linked}
            <a class="fc-button" href={commandCenterUrl('cloud', 'cloud-account')}>
              <Icon icon={mdiLinkVariant} size="18" />
              {$t('frameleaf_plan_link_server')}
            </a>
          {/if}
          <a class="fc-link" href={Route.buy()}>{$t('frameleaf_plan_compare')}</a>
        </div>
      </CloudCard>
    {/if}
  {/if}
</div>

<Dialog
  open={!!checkout}
  onRequestClose={() => (checkout = null)}
  title={$t('frameleaf_plan_checkout_title')}
  closeLabel={$t('close')}
>
  {#if checkout}
    <p>
      {$t('frameleaf_plan_checkout_body', {
        values: {
          plan: planTitle(checkout.id),
          price: formatUsd(cloudPlanPrice(checkout.priceUsd, share)),
          period: periodLabel(checkout.period),
        },
      })}
      {#if share > 0}
        {$t('frameleaf_plan_checkout_licensed')}
      {/if}
    </p>
    <p class="fc-muted">{$t('frameleaf_plan_checkout_after')}</p>
  {/if}
  {#snippet actions()}
    <Button onclick={() => (checkout = null)}>{$t('frameleaf_cloud_cancel')}</Button>
    {#if checkout?.storeUrl}
      {@const url = checkout.storeUrl}
      <Button
        variant="primary"
        onclick={() => {
          window.open(url, '_blank', 'noopener,noreferrer');
          checkout = null;
        }}
      >
        <Icon icon={mdiOpenInNew} size="18" />
        {$t('frameleaf_plan_open_store')}
      </Button>
    {/if}
  {/snippet}
</Dialog>

<Dialog bind:open={removing} title={$t('frameleaf_plan_remove_title')} closeLabel={$t('close')}>
  <p>{$t('frameleaf_plan_remove_body')}</p>
  {#snippet actions()}
    <Button onclick={() => (removing = false)}>{$t('frameleaf_cloud_cancel')}</Button>
    <Button
      variant="danger"
      disabled={busy}
      onclick={async () => {
        if (await act(() => cloudManager.removePlan(), $t('frameleaf_plan_removed_notice'))) {
          removing = false;
        }
      }}
    >
      {$t('frameleaf_plan_remove_confirm')}
    </Button>
  {/snippet}
</Dialog>
