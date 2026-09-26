<script lang="ts">
  /**
   * Support Frameleaf (FL-157, CLD-004): the prototype's `Buy` screen
   * (design/frameleaf/template/src/AuthScreens.jsx:1696-2088, effd05ffb7) on real services.
   *
   * - Frameleaf Cloud plan cards (monthly, yearly recommended, the current plan tagged), with the
   *   licensed-server price struck through on a licensed server. Owner decision on FL-146: cloud
   *   backup is usage priced and is not listed as part of a plan.
   * - AI credit presets for administrators, with the balance the server last read. Credit is never
   *   discounted.
   * - Supporter keys: cards to buy one, "Already have a key?", and the activated card with "Hide the
   *   supporter badge" and "Remove key" in place.
   * - Purchases open the store the server was deployed with in a new tab; without one each card says
   *   purchasing is not available yet (FL-172). Keys travel only in request bodies (FL-170): a server
   *   key goes to `admin/license/activate`, an individual key to `users/me/license`, and the upstream
   *   licence server is never contacted.
   */
  import './buy.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import BuyActivated from '$lib/components/frameleaf/buy/BuyActivated.svelte';
  import BuyKeyField from '$lib/components/frameleaf/buy/BuyKeyField.svelte';
  import BuyPlanCard from '$lib/components/frameleaf/buy/BuyPlanCard.svelte';
  import {
    CLOUD_BACKUP_PRICING,
    cloudPlanPrice,
    formatUsd,
    productKeyMessageKey,
    validateProductKey,
    licensedDiscount,
  } from '$lib/frameleaf/cloud';
  import { withoutLockedRuleIds } from '$lib/frameleaf/locked-rules';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    activateLicense,
    deleteUserLicense,
    getCloudMlStatus,
    getLicenseProducts,
    getLicenseStatus,
    getMyUser,
    removeLicenseKey,
    setUserLicense,
    updateMyPreferences,
    type CloudMlWalletDto,
    type LicenseProductDto,
    type LicenseProductsResponseDto,
    type LicenseStatusResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiArrowLeft, mdiCheckCircleOutline, mdiOpenInNew } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    /** A key relayed from the Frameleaf store (fragment or session storage), pre-filled once. */
    pendingKey?: string | null;
    onBack?: () => void;
  };

  let { pendingKey = null, onBack }: Props = $props();

  let products = $state<LicenseProductsResponseDto | null>(null);
  let serverLicense = $state<LicenseStatusResponseDto | null>(null);
  let wallet = $state<CloudMlWalletDto | null>(null);
  let key = $state('');
  let keyError = $state('');
  let busy = $state(false);
  let success = $state('');
  let checkout = $state<{ product: LicenseProductDto; title: string } | null>(null);

  const isAdmin = $derived(authManager.user.isAdmin);
  // FL-156: a licensed server (its supporter key, or this person's own key) pays less for plans
  const serverSupporter = $derived(featureFlagsManager.value.supporter);
  const personal = $derived(authManager.user.license ?? null);
  const badgeHidden = $derived(!authManager.preferences.purchase.showSupportBadge);
  const plans = $derived(products?.products.filter((product) => product.kind === 'plan') ?? []);
  const supporters = $derived(products?.products.filter((product) => product.kind === 'supporter') ?? []);
  const credits = $derived(products?.products.filter((product) => product.kind === 'credit') ?? []);
  const currentPlan = $derived(serverLicense?.plan?.state === 'active' ? serverLicense.plan : null);
  const serverKey = $derived(serverLicense?.key ?? null);

  onMount(() => {
    if (pendingKey) {
      key = pendingKey;
    }
    void load();
  });

  const discount = $derived(licensedDiscount({ serverLicensed: serverSupporter, personalKey: !!personal }));
  const discounted = $derived(discount !== null);

  const load = async () => {
    products = await getLicenseProducts();
    if (isAdmin) {
      serverLicense = await getLicenseStatus().catch(() => null);
      wallet = (await getCloudMlStatus().catch(() => null))?.wallet ?? null;
    }
  };

  const reloadUser = async () => {
    authManager.setUser(await getMyUser());
    await featureFlagsManager.init();
    authManager.isPurchased = !!authManager.user.license || featureFlagsManager.value.supporter;
  };

  const planTitle = (id: string) =>
    id === 'cloud-annual' ? $t('frameleaf_plan_annual_title') : $t('frameleaf_plan_monthly_title');
  const supporterTitle = (id: string) =>
    id === 'supporter-server'
      ? $t('frameleaf_buy_supporter_server_title')
      : $t('frameleaf_buy_supporter_individual_title');

  const activate = async (event?: SubmitEvent) => {
    event?.preventDefault();
    if (busy) {
      return;
    }
    const check = validateProductKey(key);
    if (!check.valid) {
      keyError = $t(productKeyMessageKey(check.reason));
      return;
    }
    if (check.kind === 'server' && !isAdmin) {
      keyError = $t('frameleaf_buy_server_key_admin_only');
      return;
    }
    busy = true;
    keyError = '';
    try {
      if (check.kind === 'server') {
        serverLicense = await activateLicense({ licenseActivateDto: { key: check.key } });
      } else {
        await setUserLicense({ licenseActivateDto: { key: check.key } });
      }
      await reloadUser();
      key = '';
      success = $t('frameleaf_buy_activated');
    } catch (error) {
      keyError = getServerErrorMessage(error) ?? $t('frameleaf_buy_activation_failed');
    } finally {
      busy = false;
    }
  };

  const remove = async (kind: 'server' | 'individual') => {
    busy = true;
    try {
      if (kind === 'server') {
        serverLicense = await removeLicenseKey();
      } else {
        await deleteUserLicense();
      }
      await reloadUser();
      success = $t('frameleaf_buy_removed');
    } catch (error) {
      keyError = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
    } finally {
      busy = false;
    }
  };

  const setBadgeHidden = async (hidden: boolean) => {
    try {
      const response = await updateMyPreferences({
        userPreferencesUpdateDto: { purchase: { showSupportBadge: !hidden } },
      });
      authManager.setPreferences(withoutLockedRuleIds(response));
    } catch (error) {
      keyError = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
    }
  };

  const openStore = (product: LicenseProductDto) => {
    if (product.storeUrl) {
      window.open(product.storeUrl, '_blank', 'noopener,noreferrer');
    }
    checkout = null;
  };

  const activeCard = $derived(
    personal
      ? { kind: 'individual' as const, keyHint: personal.keyHint, activatedAt: personal.activatedAt, remove: true }
      : isAdmin && serverKey
        ? { kind: 'server' as const, keyHint: serverKey.keyHint, activatedAt: serverKey.activatedAt, remove: true }
        : !isAdmin && serverSupporter
          ? { kind: 'server' as const, keyHint: null, activatedAt: null, remove: false }
          : null,
  );
</script>

<div class="buy-screen">
  <div class="buy-head">
    <div class="auth-heading">
      <h1>{$t('buy')}</h1>
      <p>{$t('frameleaf_buy_intro')}</p>
    </div>
    {#if onBack}
      <Button onclick={onBack}>
        <Icon icon={mdiArrowLeft} size="18" />
        {$t('back')}
      </Button>
    {/if}
  </div>

  {#if success}
    <p class="auth-success" role="status"><Icon icon={mdiCheckCircleOutline} size="16" /><span>{success}</span></p>
  {/if}

  {#if !products}
    <p class="auth-note" role="status">{$t('frameleaf_cloud_loading')}</p>
  {:else}
    <section class="buy-section" aria-labelledby="buy-cloud">
      <div class="buy-section-head">
        <h2 id="buy-cloud">{$t('frameleaf_settings_area_cloud')}</h2>
        <p>{$t('frameleaf_buy_cloud_description')}</p>
      </div>
      {#if currentPlan}
        <p class="auth-success" role="status">
          <Icon icon={mdiCheckCircleOutline} size="16" />
          <span>
            {$t('frameleaf_buy_plan_active', {
              values: { date: currentPlan.expiresAt ? new Date(currentPlan.expiresAt).toLocaleDateString() : '—' },
            })}
          </span>
        </p>
      {/if}
      <div class="buy-cards">
        {#each plans as plan (plan.id)}
          <BuyPlanCard
            title={planTitle(plan.id)}
            tag={plan.id === 'cloud-annual' ? $t('frameleaf_buy_recommended') : undefined}
            price={cloudPlanPrice(plan.priceUsd, discounted)}
            listPrice={plan.priceUsd}
            period={plan.period === 'year' ? $t('frameleaf_buy_per_year') : $t('frameleaf_buy_per_month')}
            description={plan.id === 'cloud-annual'
              ? $t('frameleaf_buy_plan_annual_description')
              : $t('frameleaf_buy_plan_monthly_description')}
            features={[
              $t('frameleaf_plan_feature_remote'),
              $t('frameleaf_plan_feature_backup', { values: { size: CLOUD_BACKUP_PRICING.includedTb } }),
              $t('frameleaf_plan_feature_servers'),
            ]}
            recommended={plan.id === 'cloud-annual'}
          >
            {#snippet action()}
              {#if plan.storeUrl}
                <Button
                  variant={plan.id === 'cloud-annual' && !currentPlan ? 'primary' : 'default'}
                  onclick={() => (checkout = { product: plan, title: planTitle(plan.id) })}
                >
                  <Icon icon={mdiOpenInNew} size="18" />
                  {currentPlan ? $t('frameleaf_buy_switch_plan') : $t('frameleaf_buy_subscribe')}
                </Button>
              {:else}
                <p class="buy-unavailable" role="status">{$t('frameleaf_plan_store_unavailable')}</p>
              {/if}
            {/snippet}
          </BuyPlanCard>
        {/each}
      </div>
      <p class="buy-note">
        {$t('frameleaf_plan_backup_extra', {
          values: {
            included: CLOUD_BACKUP_PRICING.includedTb,
            price: formatUsd(CLOUD_BACKUP_PRICING.usdPerTbMonth * CLOUD_BACKUP_PRICING.blockTb),
            block: CLOUD_BACKUP_PRICING.blockTb,
          },
        })}
        {#if discount === 'server'}
          {$t('frameleaf_buy_licensed_discount')}
        {:else if discount === 'personal'}
          {$t('frameleaf_buy_personal_discount')}
        {/if}
      </p>
    </section>

    {#if isAdmin}
      <section class="auth-card buy-credit fl-continuous-corners" aria-labelledby="buy-credit">
        <div class="buy-credit-head">
          <div>
            <h2 id="buy-credit">{$t('frameleaf_buy_credit_title')}</h2>
            <p>{$t('frameleaf_buy_credit_description')}</p>
          </div>
          {#if wallet}
            <div class="buy-balance">
              <span>{$t('frameleaf_buy_credit_available')}</span>
              <strong>{formatUsd(wallet.availableUsd, 2)}</strong>
              {#if wallet.heldUsd > 0}
                <small>{$t('frameleaf_buy_credit_held', { values: { amount: formatUsd(wallet.heldUsd, 2) } })}</small>
              {/if}
            </div>
          {/if}
        </div>
        <div class="buy-packs" role="group" aria-label={$t('frameleaf_buy_credit_add')}>
          {#each credits as pack (pack.id)}
            <button
              type="button"
              disabled={!pack.storeUrl}
              onclick={() => (checkout = { product: pack, title: $t('frameleaf_buy_credit_title') })}
            >
              <strong>{formatUsd(pack.priceUsd)}</strong>
              <small>{$t('frameleaf_buy_credit_title')}</small>
            </button>
          {/each}
        </div>
        <p class="buy-note">
          {#if products.storeUrl}
            {$t('frameleaf_buy_credit_range', {
              values: { min: formatUsd(products.credit.minimumUsd), max: formatUsd(products.credit.maximumUsd) },
            })}
            {$t('frameleaf_buy_credit_fees')}
          {:else}
            {$t('frameleaf_plan_store_unavailable')}
          {/if}
        </p>
        <a class="auth-link" href={commandCenterUrl('processing', 'cloud-ml')}>{$t('frameleaf_buy_credit_settings')}</a>
      </section>
    {/if}

    <div class="buy-section-head">
      <h2>{$t('frameleaf_buy_supporter_title')}</h2>
      <p>{$t('frameleaf_buy_supporter_description')}</p>
    </div>
    {#if activeCard}
      <BuyActivated
        name={authManager.user.name}
        kind={activeCard.kind}
        keyHint={activeCard.keyHint}
        activatedAt={activeCard.activatedAt}
        {badgeHidden}
        {busy}
        onBadgeHidden={(hidden) => void setBadgeHidden(hidden)}
        onRemove={activeCard.remove ? () => void remove(activeCard.kind) : undefined}
      />
    {:else}
      <div class="buy-cards">
        {#each supporters as supporter (supporter.id)}
          <BuyPlanCard
            title={supporterTitle(supporter.id)}
            tag={supporter.id === 'supporter-server' ? $t('frameleaf_buy_recommended') : undefined}
            price={supporter.priceUsd}
            period={$t('frameleaf_buy_one_time')}
            description={supporter.id === 'supporter-server'
              ? $t('frameleaf_buy_supporter_server_description')
              : $t('frameleaf_buy_supporter_individual_description')}
            features={supporter.id === 'supporter-server'
              ? [
                  $t('frameleaf_buy_supporter_server_feature_accounts'),
                  $t('frameleaf_buy_supporter_server_feature_badge'),
                  $t('frameleaf_buy_supporter_feature_lifetime'),
                ]
              : [
                  $t('frameleaf_buy_supporter_individual_feature_account'),
                  $t('frameleaf_buy_supporter_individual_feature_badge'),
                  $t('frameleaf_buy_supporter_feature_lifetime'),
                ]}
            recommended={supporter.id === 'supporter-server'}
          >
            {#snippet action()}
              {#if supporter.storeUrl}
                <Button
                  variant={supporter.id === 'supporter-server' ? 'primary' : 'default'}
                  onclick={() => (checkout = { product: supporter, title: supporterTitle(supporter.id) })}
                >
                  <Icon icon={mdiOpenInNew} size="18" />
                  {$t('frameleaf_buy_purchase')}
                </Button>
              {:else}
                <p class="buy-unavailable" role="status">{$t('frameleaf_plan_store_unavailable')}</p>
              {/if}
            {/snippet}
          </BuyPlanCard>
        {/each}
      </div>
    {/if}

    {#if !personal}
      <section class="auth-card buy-key fl-continuous-corners" aria-labelledby="buy-have-key">
        <h2 id="buy-have-key">{$t('frameleaf_buy_have_key')}</h2>
        <form class="buy-key-row" onsubmit={(event) => void activate(event)} novalidate>
          <BuyKeyField bind:value={key} error={keyError} />
          <span class="buy-key-submit">
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? $t('frameleaf_buy_activating') : $t('frameleaf_buy_activate')}
            </Button>
          </span>
        </form>
      </section>
    {/if}
  {/if}
</div>

<Dialog
  open={!!checkout}
  onRequestClose={() => (checkout = null)}
  title={$t('frameleaf_buy_checkout_title')}
  closeLabel={$t('close')}
>
  {#if checkout}
    <div class="auth-form">
      <p>
        {checkout.product.kind === 'credit'
          ? $t('frameleaf_buy_checkout_credit', { values: { amount: formatUsd(checkout.product.priceUsd) } })
          : checkout.product.kind === 'plan'
            ? $t('frameleaf_buy_checkout_plan', {
                values: {
                  plan: checkout.title,
                  price: formatUsd(cloudPlanPrice(checkout.product.priceUsd, discounted)),
                  period:
                    checkout.product.period === 'year'
                      ? $t('frameleaf_plan_period_year')
                      : $t('frameleaf_plan_period_month'),
                },
              })
            : $t('frameleaf_buy_checkout_supporter', {
                values: { product: checkout.title, price: formatUsd(checkout.product.priceUsd) },
              })}
        {$t('frameleaf_buy_checkout_where')}
      </p>
      {#if checkout.product.kind === 'supporter'}
        <p class="auth-note">{$t('frameleaf_buy_checkout_key_after')}</p>
      {/if}
    </div>
  {/if}
  {#snippet actions()}
    <Button onclick={() => (checkout = null)}>{$t('frameleaf_cloud_cancel')}</Button>
    {#if checkout}
      {@const product = checkout.product}
      <Button variant="primary" onclick={() => openStore(product)}>
        <Icon icon={mdiOpenInNew} size="18" />
        {$t('frameleaf_buy_continue')}
      </Button>
    {/if}
  {/snippet}
</Dialog>
