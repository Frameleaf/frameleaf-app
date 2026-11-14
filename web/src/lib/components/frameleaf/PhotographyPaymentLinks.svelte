<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import {
    photographyCreatePaymentLink,
    photographyPaymentLinks,
    type PhotographyPaymentLinkCreateDto,
    type PhotographyPaymentLinkListDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiClockOutline, mdiInformationOutline, mdiPlus } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let { onSetUpPayments }: { onSetUpPayments: () => void } = $props();

  const currencies = ['CAD', 'USD', 'EUR', 'GBP'] as const;
  const blank = () => ({
    title: '',
    amount: '',
    currency: 'CAD' as (typeof currencies)[number],
    note: '',
    use: 'reusable',
  });

  let data = $state<PhotographyPaymentLinkListDto>();
  let failed = $state(false);
  let editing = $state(false);
  let busy = $state(false);
  let draft = $state(blank());

  const money = (cents: number, currency: string) =>
    new Intl.NumberFormat($locale, { style: 'currency', currency }).format(cents / 100);

  async function load() {
    failed = false;
    data = undefined;
    try {
      data = await photographyPaymentLinks();
    } catch {
      failed = true;
    }
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !draft.title.trim()) {
      return;
    }
    busy = true;
    try {
      const dto: PhotographyPaymentLinkCreateDto = {
        title: draft.title.trim(),
        description: draft.note.trim(),
        amount: Math.round(Number(draft.amount) * 100),
        currency: draft.currency,
        reusable: draft.use === 'reusable',
      };
      const link = await photographyCreatePaymentLink({ photographyPaymentLinkCreateDto: dto });
      if (data) {
        data.links = [link, ...data.links];
      }
      draft = blank();
      editing = false;
    } catch (error) {
      handleError(error, $t('frameleaf_clients_payment_links_create_failed'));
    } finally {
      busy = false;
    }
  }

  onMount(load);
</script>

<div class="links">
  {#if failed}
    <div class="status" role="alert">
      <Icon icon={mdiAlertCircleOutline} size="1.5rem" aria-hidden={true} />
      <h2>{$t('frameleaf_clients_payment_links_load_failed')}</h2>
      <p>{$t('frameleaf_clients_payments_try_again_later')}</p>
      <Button onclick={load}>{$t('frameleaf_clients_payments_try_again')}</Button>
    </div>
  {:else if !data}
    <div class="status" role="status">
      <Icon icon={mdiClockOutline} size="1.5rem" aria-hidden={true} />
      <h2>{$t('frameleaf_clients_payment_links_loading')}</h2>
    </div>
  {:else if !data.ready && data.links.length === 0}
    <div class="status" role="status">
      <Icon icon={mdiInformationOutline} size="1.5rem" aria-hidden={true} />
      <h2>{$t('frameleaf_clients_payments_empty_title')}</h2>
      <p>{$t('frameleaf_clients_payment_links_needs_account')}</p>
      <Button variant="primary" onclick={onSetUpPayments}>{$t('frameleaf_clients_payment_links_set_up')}</Button>
    </div>
  {:else if data.links.length === 0}
    <div class="status" role="status">
      <Icon icon={mdiInformationOutline} size="1.5rem" aria-hidden={true} />
      <h2>{$t('frameleaf_clients_payment_links_empty_title')}</h2>
      <p>{$t('frameleaf_clients_payment_links_empty_body')}</p>
      <Button variant="primary" onclick={() => (editing = true)}>{$t('frameleaf_clients_payment_links_create')}</Button>
    </div>
  {:else}
    <div class="heading">
      <h2>{$t('frameleaf_clients_payment_links_heading')}</h2>
      {#if data.ready}
        <Button variant="primary" onclick={() => (editing = true)}
          ><Icon icon={mdiPlus} size="1rem" aria-hidden={true} />{$t('frameleaf_clients_payment_links_create')}</Button
        >
      {:else}
        <Button onclick={onSetUpPayments}>{$t('frameleaf_clients_payment_links_set_up')}</Button>
      {/if}
    </div>
    <ul class="list">
      {#each data.links as link (link.id)}
        <li>
          <div>
            <strong>{link.title}</strong>
            <small
              >{link.reusable
                ? $t('frameleaf_clients_payment_links_reusable')
                : $t('frameleaf_clients_payment_links_single')} · {money(link.amount, link.currency)}</small
            >
          </div>
          <div>
            <strong>{money(link.collected, link.currency)}</strong>
            <small>{$t('frameleaf_clients_payment_links_collected')}</small>
          </div>
          <span class="pill"
            >{!link.reusable && link.payments > 0
              ? $t('frameleaf_clients_payment_links_paid')
              : $t('frameleaf_clients_payment_links_active')}</span
          >
          <a href={`/photography/pay/${link.slug}`} target="_blank" rel="noopener"
            >{$t('frameleaf_clients_payment_links_preview')}</a
          >
        </li>
      {/each}
    </ul>
  {/if}
</div>

<Dialog
  bind:open={editing}
  title={$t('frameleaf_clients_payment_links_create')}
  closeLabel={$t('close')}
  onRequestClose={() => {
    if (!busy) {
      editing = false;
    }
  }}
>
  <form class="form" onsubmit={create}>
    <label
      ><span>{$t('frameleaf_clients_payment_links_title')}</span>
      <input required maxlength="80" bind:value={draft.title} /></label
    >
    <div class="fields">
      <label
        ><span>{$t('frameleaf_clients_payment_links_amount')}</span>
        <input type="number" min="0.50" step="0.01" required bind:value={draft.amount} /></label
      >
      <label
        ><span>{$t('frameleaf_clients_payment_links_currency')}</span>
        <select bind:value={draft.currency}>
          {#each currencies as code (code)}<option value={code}>{code}</option>{/each}
        </select></label
      >
    </div>
    <label
      ><span>{$t('frameleaf_clients_payment_links_note')}</span>
      <textarea rows="3" maxlength="300" bind:value={draft.note}></textarea></label
    >
    <label
      ><span>{$t('frameleaf_clients_payment_links_who')}</span>
      <select bind:value={draft.use}>
        <option value="reusable">{$t('frameleaf_clients_payment_links_anyone')}</option>
        <option value="single">{$t('frameleaf_clients_payment_links_once')}</option>
      </select></label
    >
    <div class="actions">
      <Button disabled={busy} onclick={() => (editing = false)}>{$t('cancel')}</Button>
      <Button variant="primary" type="submit" disabled={busy}>{$t('frameleaf_clients_payment_links_submit')}</Button>
    </div>
  </form>
</Dialog>

<style>
  .links {
    display: grid;
    gap: 1.125rem;
    max-width: 51.25rem;
    margin: 0.75rem auto;
    padding: 1.5rem;
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
    overflow-wrap: anywhere;
  }
  .list a {
    color: var(--fl-accent);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .pill {
    border-radius: 999px;
    padding: 0.1875rem 0.5625rem;
    background: var(--fl-raised);
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
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(8.5rem, 100%), 1fr));
    gap: 0.75rem;
    align-items: end;
  }
  input,
  select,
  textarea {
    padding: 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: 0.5rem;
    background: var(--fl-panel);
    color: inherit;
  }
</style>
