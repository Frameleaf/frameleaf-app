<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import EmptyState from '$lib/components/frameleaf/EmptyState.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import ListSkeleton from '$lib/components/frameleaf/ListSkeleton.svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { formatMoney } from '$lib/frameleaf/number-format';
  import { locale } from '$lib/stores/preferences.store';
  import {
    PhotographyInvoiceCurrency,
    photographyCreateInvoice,
    photographyInvoices,
    photographyMarkInvoicePaid,
    photographySendInvoice,
    photographyUpdateInvoice,
    photographyVoidInvoice,
    type PhotographyInvoiceDto,
    type PhotographyInvoiceListDto,
  } from '@frameleaf/sdk';
  import { mdiFileDocumentOutline } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Line = { description: string; quantity: string; price: string };
  type Draft = {
    id?: string;
    label?: string;
    clientName: string;
    clientEmail: string;
    currency: PhotographyInvoiceCurrency;
    lines: Line[];
    tax: string;
    deposit: string;
    depositDue: string;
    balanceDue: string;
    reminders: boolean;
  };
  const statusLabels = {
    draft: 'frameleaf_clients_invoice_status_draft',
    sent: 'frameleaf_clients_invoice_status_sent',
    part: 'frameleaf_clients_invoice_status_part',
    paid: 'frameleaf_clients_invoice_status_paid',
    void: 'frameleaf_clients_invoice_status_void',
  } as const;

  let data = $state<PhotographyInvoiceListDto>();
  let busy = $state(false);
  let error = $state(false);
  let draft = $state<Draft>();
  let editorOpen = $state(false);
  let saveError = $state(false);
  let paying = $state<{ invoice: PhotographyInvoiceDto; amount: string }>();
  let payOpen = $state(false);
  let disposed = false;
  let generation = 0;
  onDestroy(() => {
    disposed = true;
    generation++;
  });

  const cents = (value: string) => Math.round((Number(value) || 0) * 100);
  const amount = (value: number) => (value / 100).toFixed(2);
  const money = (value: number, currency: string) => formatMoney(value, currency, $locale);
  /** Display only: the server computes the stored totals with the same integer rules. */
  const totals = (value: Draft) => {
    const subtotal = value.lines.reduce(
      (sum, line) => sum + (Number.parseInt(line.quantity) || 0) * cents(line.price),
      0,
    );
    const basisPoints = Math.round((Number(value.tax) || 0) * 100);
    const tax = Math.floor((subtotal * basisPoints + 5000) / 10_000);
    return { subtotal, tax, total: subtotal + tax, deposit: cents(value.deposit) };
  };

  async function run(action: () => Promise<void>, onError = () => (error = true)) {
    const current = generation;
    busy = true;
    error = false;
    try {
      await action();
    } catch {
      if (!disposed && current === generation) {
        onError();
      }
    } finally {
      if (!disposed && current === generation) {
        busy = false;
      }
    }
  }
  async function reload() {
    const current = generation;
    const result = await photographyInvoices();
    if (!disposed && current === generation) {
      data = result;
    }
  }
  onMount(() => {
    void run(reload);
    return onLibraryAccessChange(() => {
      generation++;
      data = undefined;
      editorOpen = false;
      payOpen = false;
    });
  });

  function open(invoice?: PhotographyInvoiceDto) {
    const [first, second] = invoice?.schedule ?? [];
    draft = invoice
      ? {
          id: invoice.id,
          label: invoice.label,
          clientName: invoice.clientName,
          clientEmail: invoice.clientEmail,
          currency: invoice.currency as PhotographyInvoiceCurrency,
          lines: invoice.lines.map((line) => ({
            description: line.description,
            quantity: String(line.quantity),
            price: amount(line.unitPrice),
          })),
          tax: String(invoice.taxBasisPoints / 100),
          deposit: second ? amount(first.amount) : '0',
          depositDue: second ? first.dueOn : '',
          balanceDue: (second ?? first).dueOn,
          reminders: invoice.reminders,
        }
      : {
          clientName: '',
          clientEmail: '',
          currency: PhotographyInvoiceCurrency.Cad,
          lines: [{ description: '', quantity: '1', price: '' }],
          tax: '0',
          deposit: '0',
          depositDue: '',
          balanceDue: '',
          reminders: true,
        };
    saveError = false;
    editorOpen = true;
  }
  async function save(send: boolean) {
    if (!draft) {
      return;
    }
    const dto = {
      clientName: draft.clientName,
      clientEmail: draft.clientEmail,
      currency: draft.currency,
      lines: draft.lines.map((line) => ({
        description: line.description,
        quantity: Number.parseInt(line.quantity) || 1,
        unitPrice: cents(line.price),
      })),
      taxBasisPoints: Math.round((Number(draft.tax) || 0) * 100),
      deposit: cents(draft.deposit),
      depositDue: cents(draft.deposit) > 0 ? draft.depositDue || null : null,
      balanceDue: draft.balanceDue,
      reminders: draft.reminders,
    };
    const saved = draft.id
      ? await photographyUpdateInvoice({ id: draft.id, photographyInvoiceSaveDto: dto })
      : await photographyCreateInvoice({ photographyInvoiceSaveDto: dto });
    if (send) {
      await photographySendInvoice({ id: saved.id });
    }
    editorOpen = false;
    await reload();
  }
  function act(action: () => Promise<unknown>) {
    void run(async () => {
      await action();
      await reload();
    });
  }
  const editable = (invoice: PhotographyInvoiceDto) => ['draft', 'sent'].includes(invoice.status) && invoice.paid === 0;
</script>

<section class="invoices" aria-busy={busy}>
  {#if error && !data}
    <InlineError compact message={$t('frameleaf_clients_invoice_error')} onRetry={() => run(reload)} retrying={busy} />
  {:else if error}
    <p role="alert" class="error">{$t('frameleaf_clients_invoice_error')}</p>
  {:else if !data}
    <ListSkeleton rows={3} avatar={false} />
  {/if}
  {#if data && !data.mailReady}<p role="status" class="muted">{$t('frameleaf_clients_invoice_mail_needed')}</p>{/if}
  {#if data && data.items.length === 0}
    <EmptyState
      icon={mdiFileDocumentOutline}
      title={$t('frameleaf_clients_invoice_empty_heading')}
      message={$t('frameleaf_clients_invoice_empty_body')}
      action={{ label: $t('frameleaf_clients_invoice_new'), onClick: () => open() }}
    />
  {:else if data}
    <div class="heading">
      <h2>{$t('frameleaf_clients_invoice_title')}</h2>
      <Button variant="primary" disabled={busy} onclick={() => open()}>{$t('frameleaf_clients_invoice_new')}</Button>
    </div>
    <ul class="list">
      {#each data.items as invoice (invoice.id)}
        <li>
          <div>
            <strong>{invoice.label}</strong>
            <small>{invoice.clientName}</small>
          </div>
          <span>{money(invoice.total, invoice.currency)}</span>
          <span class="pill" data-status={invoice.overdue ? 'overdue' : invoice.status}
            >{invoice.overdue ? $t('frameleaf_clients_invoice_status_overdue') : $t(statusLabels[invoice.status])}</span
          >
          {#if editable(invoice)}<Button disabled={busy} onclick={() => open(invoice)}>{$t('edit')}</Button>{/if}
          {#if ['draft', 'sent', 'part'].includes(invoice.status)}
            <Button
              disabled={busy || !data.mailReady}
              onclick={() => act(() => photographySendInvoice({ id: invoice.id }))}
              >{invoice.status === 'draft'
                ? $t('frameleaf_clients_invoice_send')
                : $t('frameleaf_clients_invoice_resend')}</Button
            >
          {/if}
          {#if ['sent', 'part'].includes(invoice.status)}
            <Button
              disabled={busy}
              onclick={() => {
                paying = { invoice, amount: amount(invoice.total - invoice.paid) };
                payOpen = true;
              }}>{$t('frameleaf_clients_invoice_mark_paid')}</Button
            >
          {/if}
          <a href="/api/photography/invoices/{invoice.id}/pdf" download>{$t('frameleaf_clients_invoice_pdf')}</a>
          {#if ['draft', 'sent', 'part'].includes(invoice.status)}
            <Button
              variant="danger"
              disabled={busy}
              onclick={() => act(() => photographyVoidInvoice({ id: invoice.id }))}
              >{$t('frameleaf_clients_invoice_void')}</Button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

{#if draft}
  {@const sums = totals(draft)}
  <Dialog
    bind:open={editorOpen}
    title={draft.label
      ? $t('frameleaf_clients_invoice_edit', { values: { number: draft.label } })
      : $t('frameleaf_clients_invoice_new')}
    closeLabel={$t('close')}
    wide
    onRequestClose={() => {
      if (!busy) {
        editorOpen = false;
      }
    }}
    onClosed={() => (draft = undefined)}
  >
    <form
      class="stack"
      onsubmit={(event) => {
        event.preventDefault();
        const send = (event.submitter as HTMLButtonElement | null)?.value === 'send';
        void run(
          () => save(send),
          () => (saveError = true),
        );
      }}
    >
      <div class="fields">
        <label
          >{$t('frameleaf_clients_invoice_client')}<input
            required
            maxlength="200"
            bind:value={draft.clientName}
          /></label
        >
        <label>{$t('email')}<input type="email" required maxlength="254" bind:value={draft.clientEmail} /></label>
        <label
          >{$t('frameleaf_clients_invoice_currency')}<select bind:value={draft.currency}
            >{#each Object.values(PhotographyInvoiceCurrency) as currency (currency)}<option value={currency}
                >{currency}</option
              >{/each}</select
          ></label
        >
      </div>
      <div class="heading">
        <h3>{$t('frameleaf_clients_invoice_lines')}</h3>
        <Button
          onclick={() => {
            draft!.lines.push({ description: '', quantity: '1', price: '' });
          }}>{$t('frameleaf_clients_invoice_add_line')}</Button
        >
      </div>
      {#each draft.lines as line, index (index)}
        <div class="line">
          <label
            >{$t('frameleaf_clients_invoice_description')}<input
              required
              maxlength="200"
              bind:value={line.description}
            /></label
          >
          <label
            >{$t('frameleaf_clients_invoice_quantity')}<input
              type="number"
              min="1"
              step="1"
              required
              bind:value={line.quantity}
            /></label
          >
          <label
            >{$t('frameleaf_clients_invoice_unit_price', { values: { currency: draft.currency } })}<input
              type="number"
              min="0"
              step="0.01"
              required
              bind:value={line.price}
            /></label
          >
          <Button
            label={$t('frameleaf_clients_invoice_remove_line', { values: { line: index + 1 } })}
            disabled={draft.lines.length < 2}
            onclick={() => draft!.lines.splice(index, 1)}>×</Button
          >
        </div>
      {/each}
      <h3>{$t('frameleaf_clients_invoice_schedule')}</h3>
      <div class="fields">
        <label
          >{$t('frameleaf_clients_invoice_tax')}<input
            type="number"
            min="0"
            max="100"
            step="0.01"
            bind:value={draft.tax}
          /></label
        >
        <label
          >{$t('frameleaf_clients_invoice_deposit', { values: { currency: draft.currency } })}<input
            type="number"
            min="0"
            step="0.01"
            bind:value={draft.deposit}
          /></label
        >
        <label
          >{$t('frameleaf_clients_invoice_deposit_due')}<input
            type="date"
            required={sums.deposit > 0}
            bind:value={draft.depositDue}
          /></label
        >
        <label
          >{$t('frameleaf_clients_invoice_balance_due')}<input
            type="date"
            required
            min={draft.depositDue || undefined}
            bind:value={draft.balanceDue}
          /></label
        >
      </div>
      <dl class="totals">
        <div>
          <dt>{$t('frameleaf_clients_invoice_subtotal')}</dt>
          <dd>{money(sums.subtotal, draft.currency)}</dd>
        </div>
        <div>
          <dt>{$t('frameleaf_clients_invoice_tax_amount', { values: { rate: draft.tax || '0' } })}</dt>
          <dd>{money(sums.tax, draft.currency)}</dd>
        </div>
        <div>
          <dt>{$t('total')}</dt>
          <dd>{money(sums.total, draft.currency)}</dd>
        </div>
        {#if sums.deposit > 0}
          <div>
            <dt>{$t('frameleaf_clients_invoice_remaining')}</dt>
            <dd>{money(Math.max(sums.total - sums.deposit, 0), draft.currency)}</dd>
          </div>
        {/if}
      </dl>
      <label class="check"
        ><input type="checkbox" bind:checked={draft.reminders} />{$t('frameleaf_clients_invoice_reminders')}</label
      >
      {#if draft.reminders}<small class="muted">{$t('frameleaf_clients_invoice_reminders_hint')}</small>{/if}
      {#if saveError}<p role="alert" class="error">{$t('frameleaf_clients_invoice_save_error')}</p>{/if}
      <div class="actions">
        <Button disabled={busy} onclick={() => (editorOpen = false)}>{$t('cancel')}</Button>
        <button class="submit" type="submit" value="save" disabled={busy}>{$t('frameleaf_clients_invoice_save')}</button
        >
        <button class="submit primary" type="submit" value="send" disabled={busy || !data?.mailReady}
          >{$t('frameleaf_clients_invoice_send')}</button
        >
      </div>
    </form>
  </Dialog>
{/if}

{#if paying}
  <Dialog
    bind:open={payOpen}
    title={$t('frameleaf_clients_invoice_mark_paid')}
    closeLabel={$t('close')}
    onRequestClose={() => {
      if (!busy) {
        payOpen = false;
      }
    }}
    onClosed={() => (paying = undefined)}
  >
    <form
      class="stack"
      onsubmit={(event) => {
        event.preventDefault();
        const { invoice, amount: value } = paying!;
        void run(async () => {
          await photographyMarkInvoicePaid({ id: invoice.id, photographyInvoicePaidDto: { amount: cents(value) } });
          payOpen = false;
          await reload();
        });
      }}
    >
      <p>{$t('frameleaf_clients_invoice_mark_paid_body')}</p>
      <label
        >{$t('frameleaf_clients_invoice_amount', { values: { currency: paying.invoice.currency } })}<input
          type="number"
          min="0.01"
          step="0.01"
          max={amount(paying.invoice.total - paying.invoice.paid)}
          required
          bind:value={paying.amount}
        /></label
      >
      <div class="actions">
        <Button disabled={busy} onclick={() => (payOpen = false)}>{$t('cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy}>{$t('frameleaf_clients_invoice_record')}</Button>
      </div>
    </form>
  </Dialog>
{/if}

<style>
  .invoices {
    display: grid;
    gap: 1.5rem;
    padding: 1.5rem;
    max-width: 60rem;
  }
  .heading,
  .actions,
  .fields {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.75rem;
  }
  .heading {
    justify-content: space-between;
    align-items: center;
  }
  .actions {
    justify-content: flex-end;
  }
  .fields > label {
    flex: 1 1 10rem;
  }
  h2,
  h3 {
    margin: 0;
  }
  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .list > li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem 1rem;
    padding: 1rem 1.25rem;
  }
  .list > li + li {
    border-top: 1px solid var(--fl-border);
  }
  .list > li > div {
    flex: 1 1 10rem;
    min-width: 0;
  }
  .list small {
    display: block;
    color: var(--fl-muted);
  }
  .list a {
    color: var(--fl-accent);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .pill {
    border-radius: 999px;
    padding: 0.2rem 0.6rem;
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .pill[data-status='paid'] {
    color: var(--fl-accent);
  }
  .pill[data-status='overdue'] {
    color: var(--fl-error, #c23442);
  }
  .stack {
    display: grid;
    gap: 1.25rem;
  }
  label {
    display: grid;
    gap: 0.5rem;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .line {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(4rem, 0.65fr) minmax(6rem, 1fr) auto;
    align-items: end;
    gap: 0.75rem;
  }
  input:not([type='checkbox']),
  select {
    padding: 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: 0.5rem;
    background: var(--fl-surface);
    color: inherit;
    font: inherit;
  }
  .totals {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    border-top: 1px solid var(--fl-border);
    padding-top: 0.75rem;
  }
  .totals > div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }
  .totals dd {
    margin: 0;
    font-weight: 600;
  }
  .submit {
    padding: 0.4375rem 0.6875rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .submit.primary {
    font-weight: 600;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .muted {
    color: var(--fl-muted);
  }
  .error {
    color: var(--fl-error, #c23442);
  }
  @media (max-width: 500px) {
    .line {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr) auto;
    }
    .line > :first-child {
      grid-column: 1 / -1;
    }
  }
</style>
