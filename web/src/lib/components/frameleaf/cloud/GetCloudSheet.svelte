<script lang="ts">
  /**
   * FL-544: "Get Frameleaf Cloud", the one sheet every cloud gate opens (prototype
   * `src/settings-v2/cloud/GetCloudSheet.jsx` on branch aj/cloud-one-step). It works out what this
   * server still lacks for the feature it was opened from (a link, Frameleaf Cloud, AI credit),
   * shows the done steps ticked, starts the combined licence-and-plan purchase, waits for the
   * server to pick the plan up, and ends on the feature's own button. Payment happens in the
   * Frameleaf store, never here.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import CloudPendingCode from '$lib/components/frameleaf/cloud/CloudPendingCode.svelte';
  import { cloudPlanPrice, formatUsd } from '$lib/frameleaf/cloud';
  import { topUpCheckoutUrl } from '$lib/frameleaf/cloud-ml';
  import { FEATURES, haveFrom, missing, type CloudFeature, type CloudLack } from '$lib/frameleaf/cloud-rules';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { Licence, Plan, getCloudMlStatus, startLicenseCheckout, type CloudMlWalletDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiArrowRight, mdiCartOutline, mdiCheck, mdiCheckCircle, mdiClockOutline } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    feature: CloudFeature | null;
    /** Called when the person presses the feature's own button on the done step. */
    onDone?: () => void;
    /** FL-544: the top-up page a job refusal carried, so a member who may spend is not sent to an administrator. */
    topUpUrl?: string | null;
    close: () => void;
  };
  let { feature, onDone, topUpUrl = null, close }: Props = $props();

  /** The sheet polls this often while the store tab is open. */
  const POLL_MS = 5000;
  /** A checkout page is valid for 30 minutes; polling stops with it. */
  const POLL_LIMIT_MS = 30 * 60 * 1000;
  const CREDIT_AMOUNTS = [25, 50, 100];

  const isAdmin = authManager.user.isAdmin;
  const spec = $derived(feature ? FEATURES[feature] : null);

  let wallet = $state<Pick<CloudMlWalletDto, 'availableUsd' | 'topUpUrl'> | null>(null);
  /** This sheet's own read of the server has landed; the manager may hold an older page's state until then. */
  let ready = $state(false);
  const have = $derived(haveFrom(cloudManager.status, cloudManager.license, cloudManager.products, wallet));

  /** What was missing when the sheet opened: it stays the list of steps after a purchase changes `have`. */
  let lacks = $state<CloudLack[] | null>(null);
  let stage = $state<'link' | 'needs' | 'paying' | 'done'>('needs');
  let billing = $state<'annual' | 'monthly'>('annual');
  let who = $state<'everyone' | 'me'>('everyone');
  let amount = $state(25);
  let failure = $state('');
  let busy = $state(false);
  let checkoutUrl = $state<string | null>(null);
  let codeExpired = $state(false);
  /** What this sheet's purchase bought, for the done step's wording. */
  let bought = $state<{ cloud: boolean; licence: boolean; credit: boolean }>({
    cloud: false,
    licence: false,
    credit: false,
  });

  const loadWallet = async () => {
    try {
      wallet = (await getCloudMlStatus()).wallet ?? null;
    } catch {
      wallet = null;
    }
  };

  let stopListening: (() => void) | undefined;
  onMount(() => {
    if (!isAdmin) {
      return;
    }
    stopListening = cloudManager.listen();
    const settle = async () => {
      await Promise.all([cloudManager.refresh(), feature === 'processing' ? loadWallet() : null]);
      ready = true;
    };
    void settle();
  });

  const stepsFor = (list: CloudLack[]) => list.filter((item) => item !== 'link');

  // the steps are fixed the first time the server's state is known
  $effect(() => {
    if (lacks !== null || !ready || !cloudManager.status) {
      return;
    }
    const current = feature ? missing(feature, have) : missing('remote', have);
    lacks = current;
    stage = current[0] === 'link' ? 'link' : stepsFor(current).length > 0 ? 'needs' : 'done';
  });

  // the link step ends by itself once the code is approved, and comes back if the link is lost
  $effect(() => {
    if (!lacks || !ready) {
      return;
    }
    if (stage === 'link' && have.linked) {
      stage = stepsFor(lacks).length > 0 ? 'needs' : 'done';
    } else if (stage !== 'link' && stage !== 'done' && !have.linked && have.configured) {
      stopWaiting();
      stage = 'link';
    }
  });

  const buysCloud = $derived(!!lacks?.includes('cloud'));
  const buysLicence = $derived(!!lacks?.includes('licence') && !bought.licence && !bought.cloud);
  const buysCredit = $derived(!!lacks?.includes('credit') && !bought.credit);
  /** The store trip at hand: licence and plan first, AI credit on its own trip after. */
  const buyingStore = $derived((buysCloud && !bought.cloud) || buysLicence);

  const price = (id: string) => cloudManager.products?.products.find((product) => product.id === id)?.priceUsd ?? 0;
  const share = $derived(
    who === 'me' ? (cloudManager.products?.individualDiscount ?? 0) : (cloudManager.products?.licensedDiscount ?? 0),
  );
  const licencePrice = $derived(price(who === 'me' ? 'supporter-individual' : 'supporter-server'));
  const planPrice = (period: 'annual' | 'monthly') =>
    cloudPlanPrice(price(period === 'annual' ? 'cloud-annual' : 'cloud-monthly'), share);
  const priceLine = (period: 'annual' | 'monthly') =>
    $t(period === 'annual' ? 'frameleaf_gc_price_year' : 'frameleaf_gc_price_month', {
      values: { once: formatUsd(licencePrice), renew: formatUsd(planPrice(period)) },
    });
  const toPay = $derived(
    [
      buysCloud && !bought.cloud ? `${formatUsd(licencePrice)} + ${formatUsd(planPrice(billing))}` : null,
      buysLicence ? formatUsd(price('supporter-server')) : null,
      !buyingStore && buysCredit ? formatUsd(amount) : null,
    ]
      .filter(Boolean)
      .join(' + '),
  );

  const open = (url: string) => globalThis.open(url, '_blank', 'noopener,noreferrer');

  const continueToStore = async () => {
    failure = '';
    if (buyingStore && !buysCloud) {
      // a licence alone (cloud processing, Buddy Backup): the store's own page, never the plan checkout
      checkoutUrl =
        cloudManager.products?.products.find((product) => product.id === 'supporter-server')?.storeUrl ?? null;
      if (!checkoutUrl) {
        failure = $t('frameleaf_plan_store_unavailable');
        return;
      }
    } else if (buyingStore) {
      busy = true;
      try {
        const answer = await startLicenseCheckout({
          licenseCheckoutDto: {
            licence: buysCloud && who === 'me' ? Licence.SupporterIndividual : Licence.SupporterServer,
            plan: billing === 'annual' ? Plan.CloudAnnual : Plan.CloudMonthly,
          },
        });
        checkoutUrl = answer.url;
      } catch (error) {
        failure = getServerErrorMessage(error) ?? $t('frameleaf_gc_failed');
        busy = false;
        return;
      }
      busy = false;
    } else {
      checkoutUrl = topUpCheckoutUrl(wallet?.topUpUrl, amount);
      if (!checkoutUrl) {
        failure = $t('frameleaf_plan_store_unavailable');
        return;
      }
    }
    open(checkoutUrl);
    startWaiting();
  };

  let poll: ReturnType<typeof setInterval> | undefined;
  let pollStarted = 0;
  const stopWaiting = () => {
    if (poll) {
      clearInterval(poll);
      poll = undefined;
    }
    removeEventListener('focus', onFocus);
  };
  const startWaiting = () => {
    stage = 'paying';
    pollStarted = Date.now();
    stopWaiting();
    poll = setInterval(() => void check(), POLL_MS);
    addEventListener('focus', onFocus);
  };
  const onFocus = () => void check();
  /** One look at the server: did the plan, licence or credit arrive? */
  const check = async () => {
    if (stage !== 'paying') {
      return;
    }
    if (Date.now() - pollStarted > POLL_LIMIT_MS) {
      stopWaiting();
      stage = 'needs';
      return;
    }
    try {
      if (buyingStore) {
        await cloudManager.refreshLicense();
      } else {
        await loadWallet();
      }
    } catch {
      // the next check tries again; a lost link shows up in the status and sends the sheet back a step
      await cloudManager.refresh();
    }
    arrived();
  };
  const arrived = () => {
    if (!lacks || !feature) {
      if (have.plan) {
        finishPaying();
      }
      return;
    }
    const remaining = new Set(missing(feature, have).filter((item) => item !== 'link'));
    const storeDone = buyingStore && !remaining.has('cloud') && !remaining.has('licence');
    const creditDone = !buyingStore && !remaining.has('credit');
    if (storeDone || creditDone) {
      finishPaying();
    }
  };
  const finishPaying = () => {
    stopWaiting();
    bought = {
      cloud: bought.cloud || buysCloud,
      licence: bought.licence || buysLicence,
      credit: bought.credit || (!buyingStore && buysCredit),
    };
    const remaining = feature ? missing(feature, have).filter((item) => item !== 'link') : [];
    // AI credit is a second store trip, after the licence that it needs
    stage = remaining.length > 0 ? 'needs' : 'done';
  };
  onDestroy(() => {
    stopWaiting();
    stopListening?.();
  });

  const turnOn = () => {
    onDone?.();
    close();
  };

  const status = $derived(cloudManager.status);
  const account = $derived(status?.account?.label ?? '');
  const notConfigured = $derived(ready && !have.configured);
  const unavailable = $derived(lacks !== null && stage === 'needs' && !have.store);
  const title = $derived(
    stage === 'done' && (bought.cloud || have.plan) ? $t('frameleaf_gc_done_title') : $t('frameleaf_gc_title'),
  );
  const canChooseMe = $derived(feature !== 'buddy');
</script>

<Dialog {title} closeLabel={$t('close')} open={true} onRequestClose={close} size="medium">
  {#if !isAdmin}
    {#if topUpUrl}
      <p class="gc-lead">
        <a class="gc-link" href={topUpUrl} target="_blank" rel="noopener noreferrer"
          >{$t('frameleaf_gc_member_top_up')}</a
        >
      </p>
    {:else}
      <p class="gc-lead">{$t('frameleaf_gc_admin_only')}</p>
    {/if}
  {:else if notConfigured}
    <p class="gc-lead">{$t('frameleaf_cloud_not_configured_title')}</p>
  {:else if lacks === null}
    <p class="gc-lead" aria-busy="true">{$t('frameleaf_gc_intro')}</p>
  {:else}
    {#if stage === 'done'}
      <p class="gc-lead is-done">
        <Icon icon={mdiCheckCircle} size="20" />
        {spec ? $t('frameleaf_gc_done_lead', { values: { feature: $t(spec.nameKey) } }) : $t('frameleaf_gc_done_all')}
      </p>
    {:else if stage === 'paying'}
      <p class="gc-lead">{$t('frameleaf_gc_paying')}</p>
    {:else if spec}
      <p class="gc-lead">
        <strong class="gc-gate">{$t(spec.gateKey)}</strong>
        {stage === 'link' ? $t('frameleaf_gc_lead_link') : $t('frameleaf_gc_lead_needs')}
      </p>
    {:else}
      <p class="gc-lead">{$t('frameleaf_gc_intro')}</p>
    {/if}

    {#if stage === 'link'}
      <div class="gc-link-step">
        {#if status?.state === 'pending' && status.pending}
          <CloudPendingCode
            pending={status.pending}
            keyFingerprint={status.keyFingerprint}
            lastError={status.lastError}
            pollError={!!cloudManager.pollError}
            bind:expired={codeExpired}
            compact
          />
          <div class="gc-actions">
            <Button
              variant={codeExpired ? 'primary' : 'default'}
              disabled={busy}
              onclick={() => void cloudManager.startLink()}>{$t('frameleaf_gc_new_code')}</Button
            >
            <Button disabled={busy} onclick={() => void cloudManager.cancelLink()}
              >{$t('frameleaf_gc_cancel_link')}</Button
            >
          </div>
        {:else}
          <Button variant="primary" disabled={busy || !have.configured} onclick={() => void cloudManager.startLink()}
            >{$t('frameleaf_gc_link_button')}</Button
          >
        {/if}
      </div>
    {/if}

    <ol class="gc-steps">
      <li class:is-have={have.linked} class:is-now={!have.linked}>
        <span class="gc-step-icon" aria-hidden="true"
          ><Icon icon={have.linked ? mdiCheck : mdiArrowRight} size="14" /></span
        >
        <div>
          <strong>
            {have.linked ? $t('frameleaf_gc_step_linked', { values: { account } }) : $t('frameleaf_gc_step_link')}
            <span class="gc-pill" class:is-good={have.linked}
              >{have.linked ? $t('frameleaf_gc_have') : $t('frameleaf_gc_next')}</span
            >
          </strong>
          <small>{have.linked ? $t('frameleaf_gc_step_linked_detail') : $t('frameleaf_gc_step_link_detail')}</small>
        </div>
      </li>

      {#if buysCloud}
        {@const done = bought.cloud}
        <li class:is-have={done} class:is-buy={!done}>
          <span class="gc-step-icon" aria-hidden="true"><Icon icon={done ? mdiCheck : mdiCartOutline} size="14" /></span
          >
          <div>
            <strong>
              {$t('frameleaf_gc_step_cloud')}
              <span class="gc-pill" class:is-good={done} class:is-warn={!done && stage === 'paying'}>
                {done
                  ? $t('frameleaf_gc_have')
                  : stage === 'paying'
                    ? $t('frameleaf_gc_waiting')
                    : formatUsd(licencePrice)}
              </span>
            </strong>
            <small>
              {done
                ? $t(who === 'me' ? 'frameleaf_gc_step_cloud_done_me' : 'frameleaf_gc_step_cloud_done_everyone')
                : $t('frameleaf_gc_step_cloud_detail', {
                    values: {
                      licence: who === 'me' ? $t('frameleaf_license_individual') : $t('frameleaf_license_server'),
                    },
                  })}
            </small>
            {#if !done && stage === 'needs'}
              <div class="gc-choice" role="radiogroup" aria-label={$t('frameleaf_gc_step_cloud')}>
                {#each ['annual', 'monthly'] as const as period (period)}
                  <label class:is-on={billing === period}>
                    <input
                      type="radio"
                      name="gc-billing"
                      value={period}
                      aria-label={$t(period === 'annual' ? 'frameleaf_gc_yearly' : 'frameleaf_gc_monthly')}
                      checked={billing === period}
                      onchange={() => (billing = period)}
                    />
                    <span>
                      <strong>{$t(period === 'annual' ? 'frameleaf_gc_yearly' : 'frameleaf_gc_monthly')}</strong>
                      <small>{$t(period === 'annual' ? 'frameleaf_gc_yearly_line' : 'frameleaf_gc_monthly_line')}</small
                      >
                    </span>
                    <b>{priceLine(period)}</b>
                  </label>
                {/each}
                {#if canChooseMe}
                  <div class="gc-who" role="radiogroup" aria-label={$t('frameleaf_gc_covers')}>
                    <span>{$t('frameleaf_gc_covers')}</span>
                    {#each ['everyone', 'me'] as const as option (option)}
                      <button
                        type="button"
                        role="radio"
                        aria-checked={who === option}
                        class:is-on={who === option}
                        onclick={() => (who = option)}
                      >
                        {$t(option === 'me' ? 'frameleaf_gc_me' : 'frameleaf_gc_everyone')}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        </li>
      {/if}

      {#if lacks.includes('licence') && !buysCloud}
        {@const done = bought.licence}
        <li class:is-have={done} class:is-buy={!done}>
          <span class="gc-step-icon" aria-hidden="true"><Icon icon={done ? mdiCheck : mdiCartOutline} size="14" /></span
          >
          <div>
            <strong>
              {$t('frameleaf_gc_step_licence')}
              <span class="gc-pill" class:is-good={done} class:is-warn={!done && stage === 'paying'}>
                {done
                  ? $t('frameleaf_gc_have')
                  : stage === 'paying' && buyingStore
                    ? $t('frameleaf_gc_waiting')
                    : formatUsd(price('supporter-server'))}
              </span>
            </strong>
            <small>{done ? $t('frameleaf_gc_step_licence_done') : $t('frameleaf_gc_step_licence_detail')}</small>
          </div>
        </li>
      {/if}

      {#if lacks.includes('credit')}
        {@const done = bought.credit}
        <li class:is-have={done} class:is-buy={!done}>
          <span class="gc-step-icon" aria-hidden="true"><Icon icon={done ? mdiCheck : mdiCartOutline} size="14" /></span
          >
          <div>
            <strong>
              {$t('frameleaf_gc_step_credit')}
              <span class="gc-pill" class:is-good={done} class:is-warn={!done && stage === 'paying' && !buyingStore}>
                {done
                  ? $t('frameleaf_gc_have')
                  : stage === 'paying' && !buyingStore
                    ? $t('frameleaf_gc_waiting')
                    : formatUsd(amount)}
              </span>
            </strong>
            <small
              >{done
                ? $t('frameleaf_gc_step_credit_done', { values: { amount: formatUsd(amount) } })
                : $t('frameleaf_gc_step_credit_detail')}</small
            >
            {#if !done && stage === 'needs' && !buyingStore}
              <div class="gc-who" role="radiogroup" aria-label={$t('frameleaf_gc_amount')}>
                <span>{$t('frameleaf_gc_amount')}</span>
                {#each CREDIT_AMOUNTS as option (option)}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={amount === option}
                    class:is-on={amount === option}
                    onclick={() => (amount = option)}>{formatUsd(option)}</button
                  >
                {/each}
              </div>
            {/if}
          </div>
        </li>
      {/if}

      {#if spec}
        <li class:is-now={stage === 'done'} class:is-later={stage !== 'done'}>
          <span class="gc-step-icon" aria-hidden="true"
            ><Icon icon={stage === 'done' ? mdiArrowRight : mdiClockOutline} size="14" /></span
          >
          <div>
            <strong>
              {spec.onKey === 'frameleaf_on_signin' || !onDone ? $t(spec.nameKey) : $t(spec.onKey)}
              <span class="gc-pill" class:is-good={stage === 'done'}
                >{stage === 'done' ? $t('frameleaf_gc_next') : $t('frameleaf_gc_last')}</span
              >
            </strong>
            <small>{$t(spec.whyKey)}</small>
          </div>
        </li>
      {/if}
    </ol>

    {#if stage === 'done' && spec && spec.needs === 'cloud' && (who === 'everyone' || have.licence === 'server')}
      <p class="gc-note">{$t('frameleaf_gc_done_others')}</p>
    {/if}
    {#if unavailable}
      <p class="gc-note">{$t('frameleaf_plan_store_unavailable')}</p>
    {:else if stage === 'needs'}
      <p class="gc-note">{$t('frameleaf_gc_pay_note')}</p>
    {:else if stage === 'paying'}
      <p class="gc-note">{$t('frameleaf_gc_paying_note')}</p>
    {/if}
    {#if failure}
      <InlineError message={failure} />
    {/if}
  {/if}

  {#snippet actions()}
    {#if !isAdmin || notConfigured || lacks === null}
      <Button onclick={close}>{$t('close')}</Button>
    {:else if stage === 'link'}
      <Button onclick={close}>{$t('frameleaf_gc_not_now')}</Button>
    {:else if stage === 'needs'}
      {#if toPay && !unavailable}
        <span class="gc-to-pay">{$t('frameleaf_gc_to_pay', { values: { amount: toPay } })}</span>
      {/if}
      <Button onclick={close}>{$t('frameleaf_gc_not_now')}</Button>
      {#if !unavailable}
        <Button variant="primary" disabled={busy} onclick={() => void continueToStore()}
          >{$t('frameleaf_gc_store')}</Button
        >
      {/if}
    {:else if stage === 'paying'}
      <Button
        onclick={() => {
          stopWaiting();
          stage = 'needs';
        }}>{$t('frameleaf_gc_back')}</Button
      >
      <Button onclick={() => checkoutUrl && open(checkoutUrl)}>{$t('frameleaf_gc_store_again')}</Button>
    {:else}
      {#if spec && onDone && spec.onKey !== 'frameleaf_on_signin'}
        <Button onclick={close}>{$t('frameleaf_gc_later')}</Button>
      {/if}
      <Button variant="primary" onclick={turnOn}
        >{spec && onDone ? $t(spec.onKey) : $t('frameleaf_gc_done_all_button')}</Button
      >
    {/if}
  {/snippet}
</Dialog>

<style>
  .gc-lead {
    margin: 0 0 14px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .gc-gate {
    display: block;
    color: var(--fl-text);
    font-weight: 600;
  }
  .gc-link {
    color: var(--fl-accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .gc-lead.is-done {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--fl-text);
    font-weight: 600;
  }
  .gc-link-step {
    display: grid;
    gap: 12px;
    margin-bottom: 14px;
  }
  .gc-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .gc-steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .gc-steps > li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 12px;
    padding: 14px 16px;
  }
  .gc-steps > li + li {
    border-top: 1px solid var(--fl-border);
  }
  .gc-step-icon {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--fl-border);
    color: var(--fl-muted);
  }
  .is-have .gc-step-icon,
  .is-now .gc-step-icon {
    background: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  .gc-steps > li > div > strong {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 4px 12px;
    min-height: 24px;
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  .gc-steps small {
    display: block;
    margin-top: 4px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.45;
  }
  .gc-pill {
    padding: 2px 9px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-border);
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    font-weight: 600;
  }
  .gc-pill.is-good {
    background: color-mix(in srgb, var(--fl-accent) 18%, transparent);
    color: var(--fl-accent);
  }
  .gc-pill.is-warn {
    background: color-mix(in srgb, var(--fl-warning) 18%, transparent);
    color: var(--fl-warning);
  }
  .gc-choice {
    display: grid;
    gap: 8px;
    margin-top: 12px;
  }
  .gc-choice label {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    min-height: 52px;
    margin: 0;
    padding: 8px 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
    cursor: pointer;
  }
  .gc-choice label.is-on {
    border-color: var(--fl-accent);
  }
  .gc-choice input {
    width: 18px;
    height: 18px;
    margin: 0;
    accent-color: var(--fl-accent);
  }
  .gc-choice label strong {
    display: block;
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .gc-choice label b {
    font-size: var(--fl-font-small);
    white-space: nowrap;
  }
  .gc-who {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .gc-who button {
    padding: 4px 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-panel);
    color: var(--fl-text);
    font: inherit;
    cursor: pointer;
  }
  .gc-who button.is-on {
    border-color: var(--fl-accent);
    background: color-mix(in srgb, var(--fl-accent) 18%, transparent);
  }
  .gc-note {
    margin: 14px 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .gc-to-pay {
    margin-inline-end: auto;
    align-self: center;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
</style>
