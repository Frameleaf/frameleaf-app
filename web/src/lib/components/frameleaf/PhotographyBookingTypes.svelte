<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { formatMoney } from '$lib/frameleaf/number-format';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import {
    PhotographyPaymentLinkCurrency,
    photographyBookingTypes,
    photographyCreateBookingType,
    photographyUpdateBookingType,
    type PhotographyBookingTypeDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiClockOutline, mdiClose, mdiInformationOutline, mdiPlus } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /** FL-1053: Clients > Booking types, built to the FL-1000 mock. Prices are typed in the currency's main unit. */
  type AddOnDraft = { id: string; name: string; price: string; max: string };
  type Draft = {
    name: string;
    minutes: string;
    price: string;
    deposit: string;
    currency: PhotographyPaymentLinkCurrency;
    addOns: AddOnDraft[];
  };

  const currencies = Object.values(PhotographyPaymentLinkCurrency);
  const blank = (): Draft => ({
    name: '',
    minutes: '60',
    price: '',
    deposit: '0',
    currency: PhotographyPaymentLinkCurrency.Cad,
    addOns: [],
  });
  const cents = (value: string) => Math.round(Number(value || 0) * 100);
  const units = (value: number) => (value / 100).toFixed(2);
  const newId = () => `x${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;

  /** FL-1606: inside Bookings' tab, which already gives the page its width and padding. */
  let { embedded = false }: { embedded?: boolean } = $props();

  let types = $state<PhotographyBookingTypeDto[]>();
  let failed = $state(false);
  let busy = $state(false);
  let open = $state(false);
  let editing = $state<PhotographyBookingTypeDto | null>(null);
  let draft = $state<Draft>(blank());

  const money = (amount: number, currency: string) => formatMoney(amount, currency, $locale);

  async function load() {
    failed = false;
    types = undefined;
    try {
      types = (await photographyBookingTypes()).types;
    } catch {
      failed = true;
    }
  }

  function edit(type: PhotographyBookingTypeDto | null) {
    editing = type;
    draft = type
      ? {
          name: type.name,
          minutes: String(type.durationMinutes),
          price: units(type.price),
          deposit: units(type.deposit ?? 0),
          currency: type.currency as PhotographyPaymentLinkCurrency,
          addOns: (type.addOns ?? []).map((a) => ({
            id: a.id,
            name: a.name,
            price: units(a.price),
            max: String(a.maxQuantity),
          })),
        }
      : blank();
    open = true;
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !draft.name.trim() || draft.addOns.some((a) => !a.name.trim())) {
      return;
    }
    busy = true;
    try {
      const dto = {
        name: draft.name.trim(),
        description: editing?.description ?? '',
        durationMinutes: Number(draft.minutes),
        price: cents(draft.price),
        deposit: cents(draft.deposit),
        currency: draft.currency,
        active: editing?.active ?? true,
        addOns: draft.addOns.map((a) => ({
          id: a.id,
          name: a.name.trim(),
          price: cents(a.price),
          maxQuantity: Number(a.max),
        })),
        order: editing?.order ?? types?.length ?? 0,
      };
      const saved = editing
        ? await photographyUpdateBookingType({ id: editing.id, photographyBookingTypeSaveDto: dto })
        : await photographyCreateBookingType({ photographyBookingTypeSaveDto: dto });
      types = editing ? types?.map((t) => (t.id === saved.id ? saved : t)) : [...(types ?? []), saved];
      open = false;
    } catch (error) {
      handleError(error, $t('frameleaf_clients_booking_save_failed'));
    } finally {
      busy = false;
    }
  }

  onMount(load);
</script>

<div class="bookings" class:embedded>
  {#if failed}
    <div class="status" role="alert">
      <Icon icon={mdiAlertCircleOutline} size="1.5rem" aria-hidden={true} />
      <h2>{$t('frameleaf_clients_booking_load_failed')}</h2>
      <p>{$t('frameleaf_clients_payments_try_again_later')}</p>
      <Button onclick={load}>{$t('frameleaf_clients_payments_try_again')}</Button>
    </div>
  {:else if !types}
    <div class="status" role="status">
      <Icon icon={mdiClockOutline} size="1.5rem" aria-hidden={true} />
      <h2>{$t('frameleaf_clients_booking_loading')}</h2>
    </div>
  {:else if types.length === 0}
    <div class="status" role="status">
      <Icon icon={mdiInformationOutline} size="1.5rem" aria-hidden={true} />
      <h2>{$t('frameleaf_clients_booking_empty_title')}</h2>
      <p>{$t('frameleaf_clients_booking_empty_body')}</p>
      <Button variant="primary" onclick={() => edit(null)}>{$t('frameleaf_clients_booking_new')}</Button>
    </div>
  {:else}
    <div class="heading">
      <h2>{$t('frameleaf_clients_booking_sessions')}</h2>
      <Button variant="primary" onclick={() => edit(null)}
        ><Icon icon={mdiPlus} size="1rem" aria-hidden={true} />{$t('frameleaf_clients_booking_new')}</Button
      >
    </div>
    <ul class="list">
      {#each types as type (type.id)}
        <li>
          <div>
            <strong>{type.name}</strong>
            <small
              >{$t('frameleaf_clients_booking_summary', {
                values: { minutes: type.durationMinutes, count: type.addOns?.length ?? 0 },
              })}</small
            >
          </div>
          <span>{money(type.price, type.currency)}</span>
          <Button onclick={() => edit(type)}>{$t('frameleaf_clients_booking_edit')}</Button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<Dialog
  bind:open
  title={editing ? $t('frameleaf_clients_booking_edit_title') : $t('frameleaf_clients_booking_new')}
  closeLabel={$t('close')}
  size="medium"
  onRequestClose={() => {
    if (!busy) {
      open = false;
    }
  }}
>
  <form class="form" onsubmit={save}>
    <label
      ><span>{$t('frameleaf_clients_booking_name')}</span><input
        required
        maxlength="80"
        bind:value={draft.name}
      /></label
    >
    <div class="fields">
      <label
        ><span>{$t('frameleaf_clients_booking_length')}</span>
        <input type="number" min="5" step="5" required bind:value={draft.minutes} /></label
      >
      <label
        ><span>{$t('frameleaf_clients_payment_links_currency')}</span>
        <select bind:value={draft.currency}>
          {#each currencies as code (code)}<option value={code}>{code}</option>{/each}
        </select></label
      >
      <label
        ><span>{$t('frameleaf_clients_booking_price', { values: { currency: draft.currency } })}</span>
        <input type="number" min="0" step="0.01" required bind:value={draft.price} /></label
      >
      <label
        ><span>{$t('frameleaf_clients_booking_deposit', { values: { currency: draft.currency } })}</span>
        <input type="number" min="0" max={draft.price || 0} step="0.01" required bind:value={draft.deposit} /></label
      >
    </div>
    <div class="heading">
      <h3>{$t('frameleaf_clients_booking_add_ons')}</h3>
      <Button onclick={() => (draft.addOns = [...draft.addOns, { id: newId(), name: '', price: '', max: '1' }])}
        ><Icon icon={mdiPlus} size="1rem" aria-hidden={true} />{$t('frameleaf_clients_booking_add_extra')}</Button
      >
    </div>
    {#each draft.addOns as addOn, index (addOn.id)}
      <div class="fields extra">
        <label
          ><span>{$t('frameleaf_clients_booking_add_on_name')}</span><input
            required
            maxlength="80"
            bind:value={addOn.name}
          /></label
        >
        <label
          ><span>{$t('frameleaf_clients_booking_price', { values: { currency: draft.currency } })}</span>
          <input type="number" min="0" step="0.01" required bind:value={addOn.price} /></label
        >
        <label
          ><span>{$t('frameleaf_clients_booking_max')}</span>
          <input type="number" min="1" max="20" required bind:value={addOn.max} /></label
        >
        <Button
          variant="quiet"
          label={$t('frameleaf_clients_booking_remove_add_on', { values: { number: index + 1 } })}
          onclick={() => (draft.addOns = draft.addOns.filter((a) => a.id !== addOn.id))}
          ><Icon icon={mdiClose} size="1rem" aria-hidden={true} /></Button
        >
      </div>
    {/each}
    <div class="actions">
      <Button disabled={busy} onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button variant="primary" type="submit" disabled={busy}>{$t('frameleaf_clients_booking_save')}</Button>
    </div>
  </form>
</Dialog>

<style>
  .bookings {
    display: grid;
    gap: 1.125rem;
    max-width: 51.25rem;
    margin: 0.75rem auto;
    padding: 1.5rem;
  }
  .bookings.embedded {
    max-width: none;
    margin: 0;
    padding: 0;
  }
  .status,
  .list {
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .status {
    min-height: 11rem;
    display: grid;
    align-content: center;
    justify-items: start;
    gap: 0.5rem;
    padding: clamp(1.125rem, 5vw, 2rem);
  }
  .status > :global(svg) {
    color: var(--fl-accent);
  }
  h2,
  h3 {
    margin: 0;
  }
  .status p {
    margin: 0 0 0.5rem;
    color: var(--fl-muted);
  }
  .heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .list {
    margin: 0;
    padding: 0;
    list-style: none;
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
  .list > li > div:first-child {
    flex: 1 1 9rem;
    min-width: 0;
  }
  .list small {
    display: block;
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
    grid-template-columns: repeat(auto-fit, minmax(min(8.5rem, 100%), 1fr));
    gap: 0.75rem;
    align-items: end;
  }
  .extra {
    padding-block: 0.5rem;
    border-top: 1px solid var(--fl-border);
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
