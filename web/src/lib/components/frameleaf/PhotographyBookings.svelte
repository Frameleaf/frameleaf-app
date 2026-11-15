<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PhotographyBookingTypes from '$lib/components/frameleaf/PhotographyBookingTypes.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { websocketEvents } from '$lib/stores/websocket';
  import { handleError } from '$lib/utils/handle-error';
  import {
    photographyBookings,
    photographyUpdateBookingStatus,
    type PhotographyBookingListDto,
    type PhotographyBookingStatus,
  } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiCalendarOutline, mdiCheckCircleOutline, mdiClockOutline } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * FL-1606: Clients › Bookings, built to the approved mock (frameleaf-prototype#67). Requests from the studio website
   * wait here to be confirmed or declined; new ones arrive without a reload (`on_photography_booking`).
   */
  type Booking = PhotographyBookingListDto['bookings'][number];
  type Filter = PhotographyBookingStatus | 'all';

  let { initialTab = 'requests' }: { initialTab?: 'requests' | 'types' } = $props();

  // svelte-ignore state_referenced_locally
  let tab = $state(initialTab);
  let bookings = $state<Booking[]>();
  let mailReady = $state(false);
  let failed = $state(false);
  let filter = $state<Filter>('requested');
  let fresh = $state<string[]>([]);
  let openId = $state<string | null>(null);
  let declining = $state(false);
  let tell = $state(true);
  let busy = $state(false);
  /** Only the newest list read applies; a confirm or decline starts a new read, which outdates older ones. */
  let generation = 0;
  /** Bookings that arrived while the list was open, announced by whichever read first includes them. */
  const announce = new Set<string>();

  const filters: [Filter, string][] = [
    ['requested', 'frameleaf_clients_bookings_waiting'],
    ['confirmed', 'frameleaf_clients_bookings_confirmed'],
    ['declined', 'frameleaf_clients_bookings_declined'],
    ['all', 'frameleaf_clients_bookings_all'],
  ];
  const statusKeys: Record<PhotographyBookingStatus, string> = {
    requested: 'frameleaf_clients_bookings_waiting',
    confirmed: 'frameleaf_clients_bookings_confirmed',
    declined: 'frameleaf_clients_bookings_declined',
    cancelled: 'frameleaf_clients_bookings_cancelled',
  };
  const depositKeys: Record<Booking['depositStatus'], string> = {
    none: 'frameleaf_clients_bookings_deposit_none',
    unpaid: 'frameleaf_clients_bookings_deposit_unpaid',
    pending: 'frameleaf_clients_bookings_deposit_unpaid',
    expired: 'frameleaf_clients_bookings_deposit_unpaid',
    failed: 'frameleaf_clients_bookings_deposit_failed',
    paid: 'frameleaf_clients_bookings_deposit_paid',
    refunded: 'frameleaf_clients_bookings_deposit_refunded',
  };

  const shown = $derived((bookings ?? []).filter((b) => filter === 'all' || b.status === filter));
  const count = (id: Filter) => (bookings ?? []).filter((b) => id === 'all' || b.status === id).length;
  const current = $derived(bookings?.find((b) => b.id === openId));
  const first = (name: string) => name.trim().split(/\s+/, 1)[0];
  const money = (amount: number, currency: string) =>
    new Intl.NumberFormat($locale, { style: 'currency', currency }).format(amount / 100);
  const dates = (booking: Booking) =>
    new Intl.ListFormat($locale, { type: 'disjunction' }).format(
      booking.preferredDates.map((date) =>
        new Intl.DateTimeFormat($locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
          new Date(`${date}T00:00:00Z`),
        ),
      ),
    );
  const when = (value: string) =>
    new Intl.DateTimeFormat($locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

  async function load() {
    const request = ++generation;
    try {
      const answer = await photographyBookings();
      if (request !== generation) {
        return;
      }
      bookings = answer.bookings;
      mailReady = answer.mailReady;
      failed = false;
      for (const booking of answer.bookings) {
        if (announce.delete(booking.id)) {
          announced(booking);
        }
      }
    } catch {
      if (request === generation) {
        failed = !bookings;
      }
    }
  }

  /** A new booking, or a change to one already listed (its deposit was paid): only a new one is announced. */
  async function arrived(id: string) {
    if (!bookings?.some((b) => b.id === id)) {
      announce.add(id);
    }
    await load();
  }

  function announced(booking: Booking) {
    const id = booking.id;
    fresh = [...fresh, id];
    toastManager.primary(
      {
        description: $t('frameleaf_clients_bookings_arrived', { values: { name: booking.clientName } }),
        button: (close) => ({
          label: $t('frameleaf_clients_bookings_review'),
          onclick: () => {
            close();
            tab = 'requests';
            review(id);
          },
        }),
      },
      { timeout: 6000 },
    );
  }

  function review(id: string) {
    fresh = fresh.filter((item) => item !== id);
    declining = false;
    tell = mailReady;
    openId = id;
  }

  async function decide(status: 'confirmed' | 'declined') {
    const booking = current;
    if (!booking || busy) {
      return;
    }
    busy = true;
    try {
      const notifyClient = mailReady && tell;
      const saved = await photographyUpdateBookingStatus({
        id: booking.id,
        photographyBookingStatusDto: { status, notifyClient },
      });
      bookings = bookings?.map((b) => (b.id === saved.id ? { ...b, status: saved.status } : b));
      // A read already on its way may predate this decision; a new one replaces it, with anything that arrived since.
      void load();
      const values = { values: { name: booking.clientName } };
      toastManager.primary(
        status === 'confirmed'
          ? $t(
              saved.clientEmailed
                ? 'frameleaf_clients_bookings_confirmed_emailed'
                : 'frameleaf_clients_bookings_confirmed_done',
              values,
            )
          : $t(
              saved.clientEmailed
                ? 'frameleaf_clients_bookings_declined_emailed'
                : 'frameleaf_clients_bookings_declined_done',
              values,
            ),
      );
      declining = false;
      openId = null;
    } catch (error) {
      handleError(error, $t('frameleaf_clients_bookings_update_failed'));
    } finally {
      busy = false;
    }
  }

  let unsubscribe: (() => void) | undefined;
  onMount(() => {
    void load();
    unsubscribe = websocketEvents.on('on_photography_booking', (id) => void arrived(id));
  });
  onDestroy(() => unsubscribe?.());
</script>

<div class="bookings">
  <div class="tabs" role="tablist" aria-label={$t('frameleaf_clients_bookings')}>
    <button type="button" role="tab" aria-selected={tab === 'requests'} onclick={() => (tab = 'requests')}
      >{$t('frameleaf_clients_bookings_requests')}</button
    >
    <button type="button" role="tab" aria-selected={tab === 'types'} onclick={() => (tab = 'types')}
      >{$t('frameleaf_clients_booking_types')}</button
    >
  </div>

  {#if tab === 'types'}
    <PhotographyBookingTypes embedded />
  {:else if failed}
    <div class="status" role="alert">
      <Icon icon={mdiAlertCircleOutline} size="1.5rem" aria-hidden={true} />
      <h2>{$t('frameleaf_clients_bookings_load_failed')}</h2>
      <p>{$t('frameleaf_clients_payments_try_again_later')}</p>
      <Button onclick={load}>{$t('frameleaf_clients_payments_try_again')}</Button>
    </div>
  {:else if !bookings}
    <div class="status" role="status">
      <Icon icon={mdiClockOutline} size="1.5rem" aria-hidden={true} />
      <h2>{$t('frameleaf_clients_bookings_loading')}</h2>
    </div>
  {:else if bookings.length === 0}
    <div class="status" role="status">
      <Icon icon={mdiCalendarOutline} size="1.5rem" aria-hidden={true} />
      <h2>{$t('frameleaf_clients_bookings_none_title')}</h2>
      <p>{$t('frameleaf_clients_bookings_none_body')}</p>
    </div>
  {:else}
    <div class="filters" role="group" aria-label={$t('frameleaf_clients_bookings_show')}>
      {#each filters as [id, key] (id)}
        <button type="button" aria-pressed={filter === id} onclick={() => (filter = id)}
          >{$t(key)}<span>{count(id)}</span></button
        >
      {/each}
    </div>
    {#if shown.length > 0}
      <ul class="list" aria-live="polite">
        {#each shown as booking (booking.id)}
          <li class:fresh={fresh.includes(booking.id)}>
            <div>
              <strong
                >{booking.clientName}{#if fresh.includes(booking.id)}<span class="pill new"
                    >{$t('frameleaf_clients_bookings_new')}</span
                  >{/if}</strong
              >
              <small
                >{booking.typeName}{#if booking.preferredDates.length > 0}{` · ${dates(booking)}`}{/if}</small
              >
            </div>
            <span class="money"
              >{money(booking.total, booking.currency)}<small>{$t(depositKeys[booking.depositStatus])}</small></span
            >
            {#if filter === 'all'}
              <span class="pill" data-status={booking.status}>{$t(statusKeys[booking.status])}</span>
            {/if}
            <Button variant={booking.status === 'requested' ? 'primary' : 'default'} onclick={() => review(booking.id)}
              >{booking.status === 'requested'
                ? $t('frameleaf_clients_bookings_review')
                : $t('frameleaf_clients_bookings_view')}</Button
            >
          </li>
        {/each}
      </ul>
    {:else}
      <div class="status" role="status">
        <Icon icon={mdiCheckCircleOutline} size="1.5rem" aria-hidden={true} />
        {#if filter === 'requested'}
          <h2>{$t('frameleaf_clients_bookings_clear_title')}</h2>
          <p>{$t('frameleaf_clients_bookings_clear_body')}</p>
        {:else}
          <h2>{$t('frameleaf_clients_bookings_filter_empty')}</h2>
        {/if}
      </div>
    {/if}
  {/if}
</div>

{#if current}
  <Dialog
    open={!!current}
    title={declining
      ? $t('frameleaf_clients_bookings_decline_title')
      : $t('frameleaf_clients_bookings_title', { values: { name: current.clientName } })}
    closeLabel={$t('close')}
    onRequestClose={() => {
      if (busy) {
        return;
      }
      if (declining) {
        declining = false;
      } else {
        openId = null;
      }
    }}
  >
    {#if declining}
      <div class="stack">
        {#if current.preferredDates.length > 0}
          <p>
            {$t('frameleaf_clients_bookings_decline_dates', {
              values: { name: current.clientName, dates: dates(current) },
            })}
          </p>
        {/if}
        {#if current.depositStatus === 'paid'}
          <p>
            {$t('frameleaf_clients_bookings_decline_deposit', {
              values: { amount: money(current.deposit, current.currency) },
            })}
          </p>
        {/if}
        {#if mailReady}
          <label class="check"
            ><input type="checkbox" bind:checked={tell} />{$t('frameleaf_clients_bookings_decline_email', {
              values: { name: first(current.clientName) },
            })}</label
          >
        {/if}
      </div>
    {:else}
      <div class="stack">
        <dl class="facts">
          <dt>{$t('frameleaf_clients_booking_session')}</dt>
          <dd>{current.typeName}</dd>
          {#if current.preferredDates.length > 0}
            <dt>{$t('frameleaf_clients_bookings_dates')}</dt>
            <dd>{dates(current)}</dd>
          {/if}
          {#if current.addOns.length > 0}
            <dt>{$t('frameleaf_clients_booking_add_ons')}</dt>
            <dd>{current.addOns.map((addOn) => `${addOn.name} × ${addOn.quantity}`).join(', ')}</dd>
          {/if}
          <dt>{$t('frameleaf_clients_bookings_total')}</dt>
          <dd>{money(current.total, current.currency)}</dd>
          {#if current.deposit > 0}
            <dt>{$t('frameleaf_clients_booking_deposit_label')}</dt>
            <dd>{money(current.deposit, current.currency)} · {$t(depositKeys[current.depositStatus])}</dd>
          {/if}
          <dt>{$t('frameleaf_clients_booking_email')}</dt>
          <dd><a href={`mailto:${current.clientEmail}`}>{current.clientEmail}</a></dd>
          <dt>{$t('frameleaf_clients_bookings_requested')}</dt>
          <dd>{when(current.requestedAt)}</dd>
        </dl>
        {#if current.message}<blockquote class="message">{current.message}</blockquote>{/if}
        {#if current.status === 'requested'}
          {#if mailReady}
            <label class="check"
              ><input type="checkbox" bind:checked={tell} />{$t('frameleaf_clients_bookings_email_client', {
                values: { name: first(current.clientName) },
              })}</label
            >
          {/if}
        {:else}
          <p class="muted">{$t(`frameleaf_clients_bookings_${current.status}_note`)}</p>
        {/if}
      </div>
    {/if}
    {#snippet actions()}
      {#if declining}
        <Button disabled={busy} onclick={() => (declining = false)}>{$t('frameleaf_clients_bookings_keep')}</Button>
        <Button variant="danger" disabled={busy} onclick={() => decide('declined')}
          >{$t('frameleaf_clients_bookings_decline_confirm')}</Button
        >
      {:else if current?.status === 'requested'}
        <Button disabled={busy} onclick={() => (declining = true)}>{$t('frameleaf_clients_bookings_decline')}</Button>
        <Button variant="primary" disabled={busy} onclick={() => decide('confirmed')}
          >{$t('frameleaf_clients_bookings_confirm')}</Button
        >
      {:else}
        <Button onclick={() => (openId = null)}>{$t('close')}</Button>
      {/if}
    {/snippet}
  </Dialog>
{/if}

<style>
  .bookings {
    display: grid;
    gap: 1.125rem;
    max-width: 51.25rem;
    margin: 0.75rem auto;
    padding: 1.5rem;
  }
  .tabs {
    display: flex;
    gap: 0.25rem;
    border-bottom: 1px solid var(--fl-border);
  }
  .tabs button {
    padding: 0.625rem 0.875rem;
    margin-bottom: -1px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--fl-muted);
    font: inherit;
    font-weight: 500;
    cursor: pointer;
  }
  .tabs button[aria-selected='true'] {
    color: var(--fl-text);
    border-bottom-color: var(--fl-accent);
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
  h2 {
    margin: 0;
  }
  .status p {
    margin: 0 0 0.5rem;
    color: var(--fl-muted);
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .filters button {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.25rem;
    padding: 0 0.875rem;
    border: 1px solid var(--fl-border);
    border-radius: 999px;
    background: var(--fl-panel);
    color: var(--fl-muted);
    font: inherit;
    cursor: pointer;
  }
  .filters button[aria-pressed='true'] {
    border-color: var(--fl-accent);
    background: var(--fl-accent-soft);
    color: var(--fl-text);
  }
  .filters span {
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
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
    flex: 1 1 13.75rem;
    min-width: 0;
    display: grid;
    gap: 0.125rem;
  }
  .list strong {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .list small {
    display: block;
    color: var(--fl-muted);
  }
  .list > li.fresh {
    background: var(--fl-accent-soft);
  }
  @media (prefers-reduced-motion: no-preference) {
    .list > li.fresh {
      animation: booking-arrive var(--fl-motion) var(--fl-ease);
    }
  }
  @keyframes booking-arrive {
    from {
      opacity: 0;
      transform: translateY(0.375rem);
    }
  }
  .money {
    display: grid;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .money small {
    font-size: 0.8125rem;
  }
  .pill {
    border-radius: 999px;
    padding: 0.1875rem 0.5625rem;
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .pill.new,
  .pill[data-status='confirmed'] {
    background: var(--fl-accent-soft);
    color: var(--fl-accent);
  }
  .pill.new {
    font-size: 0.8125rem;
    font-weight: 400;
    padding: 0.0625rem 0.5rem;
  }
  .stack {
    display: grid;
    gap: 1rem;
  }
  .stack p {
    margin: 0;
  }
  .facts {
    display: grid;
    grid-template-columns: 7.5rem minmax(0, 1fr);
    gap: 0.625rem 1rem;
    margin: 0;
  }
  .facts dt {
    color: var(--fl-muted);
  }
  .facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .facts a {
    color: var(--fl-accent);
  }
  .message {
    margin: 0;
    padding: 0.75rem 1rem;
    border-left: 3px solid var(--fl-border);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-control);
    white-space: pre-wrap;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }
  .muted {
    color: var(--fl-muted);
  }
  @media (max-width: 35rem) {
    .bookings {
      padding: 1rem;
    }
    .filters {
      flex-wrap: nowrap;
      overflow-x: auto;
      margin: 0 -1rem;
      padding: 0 1rem;
      scrollbar-width: none;
    }
    .filters button {
      flex: none;
    }
    .list > li {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .list > li > div:first-child {
      grid-column: 1 / -1;
    }
    .money {
      text-align: left;
    }
    .facts {
      grid-template-columns: minmax(0, 1fr);
      gap: 0.25rem;
    }
    .facts dd + dt {
      margin-top: 0.5rem;
    }
  }
</style>
