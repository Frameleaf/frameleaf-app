<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { paymentsView, type PaymentsView } from '$lib/frameleaf/photography/payments';
  import { handleError } from '$lib/utils/handle-error';
  import { clientsPaymentAccount, clientsPaymentAccountConnect, type ClientsPaymentAccountDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiCheckCircleOutline, mdiClockOutline, mdiInformationOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let { studioName }: { studioName: string } = $props();

  let account = $state<ClientsPaymentAccountDto>();
  let failed = $state(false);
  let busy = $state(false);
  const view = $derived<PaymentsView>(failed ? 'error' : account ? paymentsView(account) : 'loading');

  async function load() {
    failed = false;
    account = undefined;
    try {
      account = await clientsPaymentAccount();
    } catch {
      failed = true;
    }
  }

  async function connect() {
    busy = true;
    try {
      const returnUrl = new URL('/photography?section=payments', location.origin).href;
      const { url } = await clientsPaymentAccountConnect({ clientsPaymentConnectDto: { returnUrl } });
      location.assign(url);
    } catch (error) {
      handleError(error, $t('frameleaf_clients_payments_connect_failed'));
      busy = false;
    }
  }

  /** While Stripe finishes setting the account up, check again every 10 seconds without blanking the card. */
  async function refresh() {
    try {
      account = await clientsPaymentAccount();
    } catch {
      // keep what is shown; the next check tries again
    }
  }
  $effect(() => {
    if (view !== 'connecting') {
      return;
    }
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  });

  onMount(load);

  const currency = $derived(account?.defaultCurrency?.toUpperCase() ?? '');
</script>

<div class="payments">
  <div class="status" role={view === 'error' || view === 'attention' ? 'alert' : 'status'}>
    {#if view === 'loading'}
      <Icon icon={mdiClockOutline} size="1.5rem" aria-hidden={true} />
      <h2>{$t('frameleaf_clients_payments_loading')}</h2>
    {:else if view === 'error'}
      <Icon icon={mdiAlertCircleOutline} size="1.5rem" aria-hidden={true} />
      <h2>{$t('frameleaf_clients_payments_load_failed')}</h2>
      <p>{$t('frameleaf_clients_payments_try_again_later')}</p>
      <Button onclick={load}>{$t('frameleaf_clients_payments_try_again')}</Button>
    {:else if view === 'unavailable'}
      <Icon icon={mdiInformationOutline} size="1.5rem" aria-hidden={true} />
      <h2>{$t('frameleaf_clients_payments_empty_title')}</h2>
      <p>{$t('frameleaf_clients_payments_needs_cloud')}</p>
    {:else if view === 'empty'}
      <Icon icon={mdiInformationOutline} size="1.5rem" aria-hidden={true} />
      <h2>{$t('frameleaf_clients_payments_empty_title')}</h2>
      <p>{$t('frameleaf_clients_payments_empty_body')}</p>
      <Button variant="primary" disabled={busy} onclick={connect}>{$t('frameleaf_clients_payments_connect')}</Button>
    {:else if view === 'connecting'}
      <Icon icon={mdiClockOutline} size="1.5rem" aria-hidden={true} />
      <h2>{$t('frameleaf_clients_payments_connecting_title')}</h2>
      <p>{$t('frameleaf_clients_payments_connecting_body')}</p>
    {:else if view === 'connected'}
      <Icon icon={mdiCheckCircleOutline} size="1.5rem" aria-hidden={true} />
      <h2>{$t('frameleaf_clients_payments_connected_title')}</h2>
      <p>{$t('frameleaf_clients_payments_connected_body', { values: { studio: studioName, currency } })}</p>
    {:else}
      <Icon icon={mdiAlertCircleOutline} size="1.5rem" aria-hidden={true} />
      <h2>{$t('frameleaf_clients_payments_attention_title')}</h2>
      <p>{$t('frameleaf_clients_payments_attention_body')}</p>
      <Button variant="primary" disabled={busy} onclick={connect}>{$t('frameleaf_clients_payments_continue')}</Button>
    {/if}
  </div>
</div>

<style>
  .payments {
    display: grid;
    gap: 1.125rem;
    max-width: 51.25rem;
    margin: 0.75rem auto;
    padding: 1.5rem;
  }
  .status {
    min-height: 11rem;
    display: grid;
    align-content: center;
    justify-items: start;
    gap: 0.5rem;
    padding: clamp(1.125rem, 5vw, 2rem);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .status > :global(svg) {
    color: var(--fl-accent);
  }
  h2 {
    margin: 0;
  }
  p {
    margin: 0 0 0.5rem;
    color: var(--fl-muted);
  }
</style>
