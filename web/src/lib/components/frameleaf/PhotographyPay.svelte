<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import {
    photographyPayCheckout,
    photographyPayStatus,
    photographyPublicPaymentLink,
    type PhotographyPayStatusDto,
    type PhotographyPublicPaymentLinkDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiCheckCircleOutline, mdiClockOutline, mdiInformationOutline } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /** FL-1041: the public page a payment link opens. `paymentId` is set when Stripe sends the payer back. */
  let { slug, paymentId }: { slug: string; paymentId: string | null } = $props();

  type Phase = 'loading' | 'ready' | 'paying' | 'checking' | 'later' | 'thanks' | 'refunded' | 'unavailable';
  let phase = $state<Phase>('loading');
  let link = $state<PhotographyPublicPaymentLinkDto>();
  let paid = $state<PhotographyPayStatusDto>();
  let email = $state('');
  let failed = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  onDestroy(() => {
    disposed = true;
    clearTimeout(timer);
  });

  const money = (cents: number, currency: string) =>
    new Intl.NumberFormat($locale, { style: 'currency', currency }).format(cents / 100);

  /** Waits for the studio's server to hear from Stripe: about two minutes, then the page says to check later. */
  async function check(id: string, tries = 0) {
    try {
      const status = await photographyPayStatus({ slug, paymentId: id });
      if (disposed) {
        return;
      }
      if (status.status === 'paid') {
        paid = status;
        phase = 'thanks';
        return;
      }
      if (status.status === 'refunded') {
        phase = 'refunded';
        return;
      }
      if (status.status !== 'pending') {
        failed = true;
        phase = link ? 'ready' : 'unavailable';
        return;
      }
    } catch {
      // keep waiting; the page stays on "Checking your payment"
    }
    if (disposed) {
      return;
    }
    if (tries < 40) {
      timer = setTimeout(() => void check(id, tries + 1), 3000);
    } else {
      // Two minutes without an answer: the page says so and lets the payer check again.
      phase = 'later';
    }
  }

  async function pay(event: SubmitEvent) {
    event.preventDefault();
    phase = 'paying';
    failed = false;
    try {
      const { url } = await photographyPayCheckout({ slug, photographyPayCheckoutDto: { email } });
      const target = new URL(url);
      if (target.protocol !== 'https:' || target.hostname !== 'checkout.stripe.com') {
        throw new Error('unexpected checkout address');
      }
      if (!disposed) {
        location.assign(target.href);
      }
    } catch {
      if (!disposed) {
        failed = true;
        phase = 'ready';
      }
    }
  }

  onMount(async () => {
    try {
      link = await photographyPublicPaymentLink({ slug });
    } catch {
      link = undefined;
    }
    if (paymentId) {
      phase = 'checking';
      await check(paymentId);
    } else {
      phase = link ? 'ready' : 'unavailable';
    }
  });
</script>

<main class="pay" style:--pay-studio={link?.brand.color}>
  <div class="inner">
    {#if link}
      <header class="brand">
        {#if link.brand.logoInitials}<span>{link.brand.logoInitials}</span>{/if}
        {link.brand.name}
      </header>
    {/if}
    {#if phase === 'ready' && link}
      <section class="card">
        <h1>{link.title}</h1>
        {#if link.description}<p>{link.description}</p>{/if}
        <div class="amount">{money(link.amount, link.currency)} <small>{link.currency}</small></div>
        <form onsubmit={pay}>
          <label
            ><span>{$t('frameleaf_clients_pay_email')}</span>
            <input type="email" required autocomplete="email" maxlength="254" bind:value={email} /></label
          >
          {#if failed}<p class="error" role="alert">{$t('frameleaf_clients_pay_failed')}</p>{/if}
          <Button variant="primary" type="submit">{$t('frameleaf_clients_pay_continue')}</Button>
        </form>
      </section>
    {:else if phase === 'loading' || phase === 'paying'}
      <div class="status" role="status">
        <Icon icon={mdiClockOutline} size="1.5rem" aria-hidden={true} />
        <h2>{$t('frameleaf_clients_pay_loading')}</h2>
      </div>
    {:else if phase === 'checking'}
      <div class="status" role="status">
        <Icon icon={mdiClockOutline} size="1.5rem" aria-hidden={true} />
        <h2>{$t('frameleaf_clients_pay_checking_title')}</h2>
        <p>{$t('frameleaf_clients_pay_checking_body')}</p>
      </div>
    {:else if phase === 'later' && paymentId}
      <div class="status" role="status">
        <Icon icon={mdiClockOutline} size="1.5rem" aria-hidden={true} />
        <h2>{$t('frameleaf_clients_pay_later_title')}</h2>
        <p>{$t('frameleaf_clients_pay_later_body')}</p>
        <Button
          onclick={() => {
            phase = 'checking';
            void check(paymentId);
          }}>{$t('frameleaf_clients_pay_check_again')}</Button
        >
      </div>
    {:else if phase === 'refunded'}
      <div class="status" role="status">
        <Icon icon={mdiInformationOutline} size="1.5rem" aria-hidden={true} />
        <h2>{$t('frameleaf_clients_pay_refunded_title')}</h2>
        <p>{$t('frameleaf_clients_pay_refunded_body')}</p>
      </div>
    {:else if phase === 'thanks' && paid}
      <div class="status" role="status">
        <Icon icon={mdiCheckCircleOutline} size="1.5rem" aria-hidden={true} />
        <h2>{$t('frameleaf_clients_pay_thanks_title')}</h2>
        <p>
          {link
            ? $t('frameleaf_clients_pay_thanks_body', {
                values: { amount: money(paid.amount, paid.currency), studio: link.brand.name },
              })
            : $t('frameleaf_clients_pay_thanks_body_plain', { values: { amount: money(paid.amount, paid.currency) } })}
        </p>
      </div>
    {:else}
      <div class="status" role="status">
        <Icon icon={mdiInformationOutline} size="1.5rem" aria-hidden={true} />
        <h2>{$t('frameleaf_clients_pay_unavailable_title')}</h2>
        <p>{$t('frameleaf_clients_pay_unavailable_body')}</p>
      </div>
    {/if}
    {#if link?.brand.email}
      <a href={`mailto:${link.brand.email}`}
        >{$t('frameleaf_clients_pay_contact', { values: { studio: link.brand.name } })}</a
      >
    {/if}
  </div>
</main>

<style>
  .pay {
    min-height: 100dvh;
    width: 100%;
    overflow: auto;
    background: #f3f5f0;
    color: #252e29;
    --pay-panel: #fff;
    --pay-border: #d6ded4;
    --pay-muted: #525d54;
    --pay-accent: var(--pay-studio, #33483f);
  }
  .inner {
    max-width: 31.25rem;
    margin: clamp(1.25rem, 8vh, 5rem) auto 1.875rem;
    padding-inline: 1rem;
    display: grid;
    gap: 1.25rem;
  }
  .inner > a {
    color: var(--pay-accent);
    text-decoration: underline;
    justify-self: center;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.6875rem;
    font:
      1.25rem Georgia,
      serif;
    color: var(--pay-accent);
  }
  .brand span {
    display: grid;
    place-items: center;
    width: 2.1875rem;
    height: 2.1875rem;
    border: 1px solid var(--pay-border);
    border-radius: 50%;
    font-size: 0.875rem;
  }
  .card,
  .status {
    border: 1px solid var(--pay-border);
    border-radius: 1rem;
    background: var(--pay-panel);
    padding: clamp(1.25rem, 5vw, 2.25rem);
    display: grid;
    gap: 1.125rem;
  }
  .status {
    min-height: 11rem;
    align-content: center;
    justify-items: start;
    gap: 0.5rem;
  }
  .status > :global(svg) {
    color: var(--pay-accent);
  }
  h1 {
    margin: 0;
    font:
      2rem/1.15 Georgia,
      serif;
  }
  h2,
  p {
    margin: 0;
  }
  .status p,
  .amount small {
    color: var(--pay-muted);
  }
  .amount {
    font-size: 1.8rem;
    font-weight: 600;
  }
  .amount small {
    font-size: 0.875rem;
    font-weight: normal;
  }
  form,
  label {
    display: grid;
    gap: 0.75rem;
  }
  form {
    gap: 1.125rem;
  }
  form :global(button) {
    width: 100%;
  }
  input {
    padding: 0.75rem;
    border: 1px solid var(--pay-border);
    border-radius: 0.5rem;
    background: #fff;
    color: inherit;
  }
  .error {
    color: #c23442;
  }
</style>
