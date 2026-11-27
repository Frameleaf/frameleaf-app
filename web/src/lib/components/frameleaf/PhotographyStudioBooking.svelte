<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { formatMoney } from '$lib/frameleaf/number-format';
  import { locale } from '$lib/stores/preferences.store';
  import { photographyRequestBooking, type PhotographyPublicBookingTypeListDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiCheckCircleOutline, mdiClockOutline, mdiInformationOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type BookingType = PhotographyPublicBookingTypeListDto['types'][number];

  /**
   * FL-1053: the studio website's booking form (FL-1000 mock). The total shown is computed the way the server
   * computes it; the server's own total is what is charged. A deposit opens Stripe's page on the studio's account.
   */
  let {
    open = $bindable(false),
    site,
    types,
    sent = false,
    chosen = '',
  }: {
    open?: boolean;
    site: string;
    types: BookingType[];
    sent?: boolean;
    /** FL-1606: the session the website's Booking card was for; the first one otherwise. */
    chosen?: string;
  } = $props();

  type Phase = 'ready' | 'sending' | 'sent';
  // svelte-ignore state_referenced_locally
  let phase = $state<Phase>(sent ? 'sent' : 'ready');
  let failed = $state(false);
  // svelte-ignore state_referenced_locally
  let typeId = $state(chosen);
  let name = $state('');
  let email = $state('');
  let date = $state('');
  let message = $state('');
  let quantities = $state<Record<string, number>>({});

  const type = $derived(types.find((item) => item.id === typeId) ?? types[0]);
  const total = $derived(
    type ? type.price + type.addOns.reduce((sum, a) => sum + a.price * (quantities[a.id] ?? 0), 0) : 0,
  );
  const money = (amount: number, currency: string) => formatMoney(amount, currency, $locale);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!type || phase === 'sending') {
      return;
    }
    phase = 'sending';
    failed = false;
    try {
      const answer = await photographyRequestBooking({
        site,
        photographyBookingRequestDto: {
          bookingTypeId: type.id,
          name,
          email,
          preferredDates: date ? [date] : [],
          addOns: type.addOns
            .filter((a) => (quantities[a.id] ?? 0) > 0)
            .map((a) => ({ id: a.id, quantity: quantities[a.id] })),
          message,
        },
      });
      if (answer.checkoutUrl) {
        const target = new URL(answer.checkoutUrl);
        if (target.protocol === 'https:' && target.hostname === 'checkout.stripe.com') {
          location.assign(target.href);
          return;
        }
      }
      phase = 'sent';
    } catch {
      // The form keeps everything the visitor typed.
      failed = true;
      phase = 'ready';
    }
  }
</script>

<Dialog
  bind:open
  title={$t('frameleaf_clients_booking_book')}
  closeLabel={$t('close')}
  size="medium"
  onRequestClose={() => {
    if (phase !== 'sending') {
      open = false;
    }
  }}
>
  {#if phase === 'sending'}
    <div class="status" role="status">
      <Icon icon={mdiClockOutline} size="1.5rem" aria-hidden={true} />
      <h3>{$t('frameleaf_clients_booking_sending')}</h3>
    </div>
  {:else if phase === 'sent'}
    <div class="status" role="status">
      <Icon icon={mdiCheckCircleOutline} size="1.5rem" aria-hidden={true} />
      <h3>{$t('frameleaf_clients_booking_sent_title')}</h3>
      <p>{$t('frameleaf_clients_booking_sent_body')}</p>
      <Button onclick={() => (open = false)}>{$t('frameleaf_clients_booking_back')}</Button>
    </div>
  {:else if !type}
    <div class="status" role="status">
      <Icon icon={mdiInformationOutline} size="1.5rem" aria-hidden={true} />
      <h3>{$t('frameleaf_clients_booking_none_title')}</h3>
      <p>{$t('frameleaf_clients_booking_none_body')}</p>
    </div>
  {:else}
    <form class="form" onsubmit={submit}>
      <label
        ><span>{$t('frameleaf_clients_booking_session')}</span>
        <select
          value={type.id}
          onchange={(event) => {
            typeId = event.currentTarget.value;
            quantities = {};
          }}
        >
          {#each types as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
        </select></label
      >
      <div class="fields">
        <label
          ><span>{$t('frameleaf_clients_booking_your_name')}</span>
          <input required maxlength="120" autocomplete="name" bind:value={name} /></label
        >
        <label
          ><span>{$t('frameleaf_clients_booking_email')}</span>
          <input type="email" required maxlength="254" autocomplete="email" bind:value={email} /></label
        >
        <label
          ><span>{$t('frameleaf_clients_booking_date')}</span>
          <input type="date" required bind:value={date} /></label
        >
      </div>
      {#if type.addOns.length > 0}
        <h3>{$t('frameleaf_clients_booking_add_ons')}</h3>
        <ul class="list">
          {#each type.addOns as addOn (addOn.id)}
            <li>
              <div>
                <strong>{addOn.name}</strong>
                <small
                  >{$t('frameleaf_clients_booking_each', {
                    values: { price: money(addOn.price, type.currency) },
                  })}</small
                >
              </div>
              <label class="quantity"
                ><span>{$t('frameleaf_clients_booking_quantity_for', { values: { name: addOn.name } })}</span>
                <select
                  value={quantities[addOn.id] ?? 0}
                  onchange={(event) => (quantities = { ...quantities, [addOn.id]: Number(event.currentTarget.value) })}
                >
                  {#each Array.from({ length: addOn.maxQuantity + 1 }, (_, n) => n) as n (n)}<option value={n}
                      >{n}</option
                    >{/each}
                </select></label
              >
            </li>
          {/each}
        </ul>
      {/if}
      <dl class="total" aria-live="polite">
        <div>
          <dt>{$t('frameleaf_clients_booking_total')}</dt>
          <dd>{money(total, type.currency)}</dd>
        </div>
        {#if type.deposit > 0}
          <div>
            <dt>{$t('frameleaf_clients_booking_deposit_label')}</dt>
            <dd>{money(type.deposit, type.currency)}</dd>
          </div>
        {/if}
      </dl>
      {#if failed}<p class="error" role="alert">{$t('frameleaf_clients_booking_send_failed')}</p>{/if}
      <div class="actions">
        <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
        <Button variant="primary" type="submit">{$t('frameleaf_clients_booking_request')}</Button>
      </div>
    </form>
  {/if}
</Dialog>

<style>
  .status {
    display: grid;
    justify-items: start;
    gap: 0.5rem;
    padding: 1rem 0;
  }
  .status > :global(svg) {
    color: var(--fl-accent);
  }
  h3,
  p {
    margin: 0;
  }
  .status p {
    color: var(--fl-muted);
  }
  .form,
  label {
    display: grid;
    gap: 0.75rem;
  }
  .form {
    gap: 1.125rem;
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(10rem, 100%), 1fr));
    gap: 0.75rem;
  }
  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .list > li {
    padding: 0.9375rem 1.125rem;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.625rem 1rem;
  }
  .list > li + li {
    border-top: 1px solid var(--fl-border);
  }
  .list > li > div {
    flex: 1 1 9rem;
  }
  .list small {
    display: block;
    color: var(--fl-muted);
  }
  .quantity span {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .total {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    border-top: 1px solid var(--fl-border);
    padding-top: 0.75rem;
  }
  .total div {
    display: flex;
    justify-content: space-between;
  }
  .total dd {
    margin: 0;
    font-weight: 600;
  }
  .error {
    color: var(--fl-danger);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
  }
  input,
  select {
    padding: 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: 0.5rem;
    background: var(--fl-panel);
    color: inherit;
  }
</style>
