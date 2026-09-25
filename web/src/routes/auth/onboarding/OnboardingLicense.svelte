<script lang="ts">
  /**
   * Onboarding → Plan & licence (FL-157; AuthScreens.jsx:1298-1352, effd05ffb7): an optional,
   * skippable server step. "Self-hosted only" is the default and needs nothing; a Frameleaf Cloud
   * plan is finished in the store the server was deployed with (a new tab; nothing is charged
   * here); "I have a supporter key" points to Support Frameleaf, where keys are entered, never
   * through a link. Owner decision on FL-146: prices are US dollars, and cloud backup is not part of
   * a plan.
   */
  import { cloudPlanPrice, formatUsd, licensedDiscount } from '$lib/frameleaf/cloud';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { Route } from '$lib/route';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  onMount(() => cloudManager.listen());

  let choice = $state<string>('self-hosted');
  const name = $props.id();

  const products = $derived(cloudManager.products);
  const linked = $derived(cloudManager.status?.state === 'linked');
  const licensed = $derived(
    licensedDiscount({
      serverLicensed: !!cloudManager.license?.entitlements.supporter,
      personalKey: !!authManager.user.license,
    }) !== null,
  );
  const plans = $derived(products?.products.filter((product) => product.kind === 'plan') ?? []);
  const chosenPlan = $derived(plans.find((plan) => plan.id === choice) ?? null);

  const planTitle = (id: string) =>
    id === 'cloud-annual' ? $t('frameleaf_plan_annual_title') : $t('frameleaf_plan_monthly_title');
  const period = (value: string) =>
    value === 'year' ? $t('frameleaf_plan_period_year') : $t('frameleaf_plan_period_month');

  const options = $derived([
    {
      id: 'self-hosted',
      title: $t('frameleaf_onboarding_license_self_hosted'),
      hint: $t('frameleaf_onboarding_license_self_hosted_hint'),
    },
    ...plans.map((plan) => ({
      id: plan.id,
      title: `${planTitle(plan.id)} · ${formatUsd(cloudPlanPrice(plan.priceUsd, licensed))}/${period(plan.period)}`,
      hint:
        plan.id === 'cloud-annual'
          ? $t('frameleaf_buy_plan_annual_description')
          : $t('frameleaf_buy_plan_monthly_description'),
      badge: plan.id === 'cloud-annual' ? $t('frameleaf_onboarding_license_best_value') : null,
    })),
    {
      id: 'supporter-key',
      title: $t('frameleaf_onboarding_license_supporter'),
      hint: $t('frameleaf_onboarding_license_supporter_hint'),
    },
  ]);
</script>

<div class="ob-options" role="radiogroup" aria-label={$t('frameleaf_onboarding_license_title')}>
  {#each options as option (option.id)}
    <label class="ob-option">
      <input
        type="radio"
        {name}
        value={option.id}
        checked={choice === option.id}
        onchange={() => (choice = option.id)}
      />
      <span class="ob-radio" aria-hidden="true"></span>
      <span class="ob-plan">
        <strong>
          {option.title}
          {#if 'badge' in option && option.badge}
            <span class="ob-tag">{option.badge}</span>
          {/if}
        </strong>
        <small>{option.hint}</small>
      </span>
    </label>
  {/each}
</div>

{#if chosenPlan}
  <p class="auth-info">
    {#if !linked}
      {$t('frameleaf_onboarding_license_needs_account')}
    {:else if chosenPlan.storeUrl}
      {$t('frameleaf_onboarding_license_store')}
      <a class="auth-link" href={chosenPlan.storeUrl} target="_blank" rel="noopener noreferrer">
        {$t('frameleaf_buy_continue')}
      </a>
    {:else}
      {$t('frameleaf_plan_store_unavailable')}
    {/if}
  </p>
{/if}
{#if choice === 'supporter-key'}
  <p class="auth-info">
    {$t('frameleaf_onboarding_license_key_later')}
    <a class="auth-link" href={Route.buy()}>{$t('buy')}</a>
  </p>
{/if}
