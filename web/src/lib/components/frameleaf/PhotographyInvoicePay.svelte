<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import {
    isHttpError,
    photographyInvoiceCheckout,
    photographyInvoicePaymentStatus,
    photographyPublicInvoice,
    type PhotographyPublicInvoiceDto,
  } from '@frameleaf/sdk';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /** FL-1081: the public invoice page. `paymentId` is set when Stripe sends the client back. */
  let { token, paymentId }: { token: string; paymentId: string | null } = $props();

  type Phase = 'loading' | 'ready' | 'paying' | 'checking' | 'unavailable' | 'error';
  let phase = $state<Phase>('loading');
  let invoice = $state<PhotographyPublicInvoiceDto>();
  let failed = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  onDestroy(() => {
    disposed = true;
    clearTimeout(timer);
  });

  const money = (cents: number) =>
    new Intl.NumberFormat($locale, { style: 'currency', currency: invoice!.currency }).format(cents / 100);
  const date = (value: string) =>
    new Intl.DateTimeFormat($locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(value));

  async function load() {
    phase = 'loading';
    try {
      invoice = await photographyPublicInvoice({ token });
      phase = 'ready';
    } catch (error) {
      phase = isHttpError(error) && error.status === 404 ? 'unavailable' : 'error';
    }
  }
  /** Waits for the studio's server to hear from Stripe (about two minutes), then shows the invoice as it stands. */
  async function check(id: string, tries = 0) {
    try {
      const { status } = await photographyInvoicePaymentStatus({ token, paymentId: id });
      if (disposed) {
        return;
      }
      if (status !== 'pending' || tries >= 40) {
        failed = status === 'failed' || status === 'expired';
        await load();
        return;
      }
    } catch {
      // keep waiting
    }
    if (!disposed) {
      timer = setTimeout(() => void check(id, tries + 1), 3000);
    }
  }
  async function pay() {
    phase = 'paying';
    failed = false;
    try {
      const { url } = await photographyInvoiceCheckout({ token });
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
  onMount(() => {
    if (paymentId) {
      phase = 'checking';
      void check(paymentId);
    } else {
      void load();
    }
  });
</script>

<svelte:head><title>{invoice?.label ?? $t('frameleaf_clients_invoice_title')}</title></svelte:head>

<main class="invoice" style:--studio={invoice?.studio.color}>
  <div class="inner">
    {#if invoice}
      <header><span aria-hidden="true">{invoice.studio.name.slice(0, 1)}</span>{invoice.studio.name}</header>
    {/if}
    <section class="card" aria-busy={['loading', 'paying', 'checking'].includes(phase)}>
      {#if ['loading', 'paying', 'checking'].includes(phase)}
        <p role="status">
          {phase === 'loading' ? $t('frameleaf_clients_invoice_opening') : $t('frameleaf_clients_invoice_checking')}
        </p>
      {:else if phase === 'unavailable'}
        <h1>{$t('frameleaf_clients_invoice_unavailable')}</h1>
        <p>{$t('frameleaf_clients_invoice_unavailable_body')}</p>
      {:else if phase === 'error' || !invoice}
        <h1>{$t('frameleaf_clients_invoice_open_error')}</h1>
        <Button onclick={load}>{$t('frameleaf_clients_contract_try_again')}</Button>
      {:else}
        <h1>{$t('frameleaf_clients_invoice_heading', { values: { number: invoice.label } })}</h1>
        <p>{$t('frameleaf_clients_invoice_prepared_for', { values: { name: invoice.clientName } })}</p>
        <ul class="lines">
          {#each invoice.lines as line, index (index)}
            <li>
              <div>
                <strong>{line.description}</strong>
                <small>{line.quantity} × {money(line.unitPrice)}</small>
              </div>
              <span>{money(line.quantity * line.unitPrice)}</span>
            </li>
          {/each}
        </ul>
        <dl>
          <div>
            <dt>{$t('frameleaf_clients_invoice_subtotal')}</dt>
            <dd>{money(invoice.subtotal)}</dd>
          </div>
          <div>
            <dt>
              {$t('frameleaf_clients_invoice_tax_amount', { values: { rate: String(invoice.taxBasisPoints / 100) } })}
            </dt>
            <dd>{money(invoice.tax)}</dd>
          </div>
          <div>
            <dt>{$t('total')}</dt>
            <dd>{money(invoice.total)}</dd>
          </div>
        </dl>
        {#if !invoice.next}
          <div class="paid" role="status">
            <h2>{$t('frameleaf_clients_invoice_paid_heading')}</h2>
            <p>{$t('frameleaf_clients_invoice_paid_body')}</p>
          </div>
        {:else}
          <p role="status">
            {invoice.paid > 0
              ? $t('frameleaf_clients_invoice_part_paid', {
                  values: { amount: money(invoice.next.amount), date: date(invoice.next.dueOn) },
                })
              : $t('frameleaf_clients_invoice_due', {
                  values: { amount: money(invoice.next.amount), date: date(invoice.next.dueOn) },
                })}
          </p>
          {#if failed}<p role="alert" class="error">{$t('frameleaf_clients_invoice_pay_error')}</p>{/if}
          {#if invoice.payOnline}
            <Button variant="primary" onclick={pay}
              >{$t('frameleaf_clients_invoice_pay', { values: { amount: money(invoice.next.amount) } })}</Button
            >
          {/if}
        {/if}
        <a href="/api/photography/invoices/view/{token}/pdf" download>{$t('frameleaf_clients_invoice_pdf')}</a>
      {/if}
    </section>
    {#if invoice?.studio.email}
      <a class="contact" href="mailto:{invoice.studio.email}"
        >{$t('frameleaf_clients_contract_contact', { values: { studio: invoice.studio.name } })}</a
      >
    {/if}
  </div>
</main>

<style>
  .invoice {
    min-height: 100dvh;
    padding-block: clamp(20px, 8vh, 80px) 30px;
    background: #f3f5f0;
    color: #1d1d1f;
    --fl-panel: #fff;
    --fl-raised: #f2f5ef;
  }
  .inner {
    max-width: 560px;
    margin: 0 auto;
    padding-inline: 16px;
    display: grid;
    gap: 20px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 11px;
    font:
      1.25rem Georgia,
      serif;
  }
  header span {
    display: grid;
    place-items: center;
    width: 35px;
    height: 35px;
    border: 1px solid var(--fl-border);
    border-radius: 50%;
    color: var(--studio, inherit);
  }
  .card {
    display: grid;
    gap: 18px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    padding: clamp(20px, 5vw, 36px);
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
  .lines {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .lines > li {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.9rem 1.1rem;
  }
  .lines > li + li {
    border-top: 1px solid var(--fl-border);
  }
  .lines small {
    display: block;
    color: var(--fl-muted);
  }
  dl {
    display: grid;
    gap: 8px;
    margin: 0;
    border-top: 1px solid var(--fl-border);
    padding-top: 12px;
  }
  dl > div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  dd {
    margin: 0;
    font-weight: 600;
  }
  .paid {
    display: grid;
    gap: 0.5rem;
    padding: 1rem;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  a {
    color: var(--studio, var(--fl-accent));
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .contact {
    justify-self: center;
  }
  .error {
    color: var(--fl-error, #c23442);
  }
</style>
