<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { locale } from '$lib/stores/preferences.store';
  import {
    photographyContracts,
    photographyContractTemplates,
    photographyCreateContract,
    photographyCreateContractTemplate,
    photographySendContract,
    photographyUpdateContractTemplate,
    photographyVoidContract,
    type PhotographyContractDto,
    type PhotographyContractListDto,
    type PhotographyContractTemplateDto,
    type PhotographyContractTemplateListDto,
  } from '@frameleaf/sdk';
  import { onDestroy, onMount, tick } from 'svelte';
  import { t } from 'svelte-i18n';

  const fieldLabels = {
    client_name: 'frameleaf_clients_contract_field_client_name',
    session_date: 'frameleaf_clients_contract_field_session_date',
    total: 'frameleaf_clients_contract_field_total',
  } as const;
  const statusLabels = {
    draft: 'frameleaf_clients_contract_status_draft',
    sent: 'frameleaf_clients_contract_status_sent',
    viewed: 'frameleaf_clients_contract_status_viewed',
    signed: 'frameleaf_clients_contract_status_signed',
    void: 'frameleaf_clients_contract_status_void',
  } as const;
  const sampleValues = { client_name: 'Morgan Ellis', session_date: '2027-05-22', total: '$350.00' };

  let templates = $state<PhotographyContractTemplateListDto>();
  let contracts = $state<PhotographyContractListDto>();
  let busy = $state(false);
  let error = $state(false);
  let editor = $state<{ id?: string; name: string; body: string }>();
  let editorOpen = $state(false);
  let sending = $state<{
    template: PhotographyContractTemplateDto;
    client: string;
    email: string;
    date: string;
    total: string;
  }>();
  let sendOpen = $state(false);
  let sendError = $state(false);
  let bodyInput = $state<HTMLTextAreaElement>();
  let disposed = false;
  let generation = 0;
  onDestroy(() => {
    disposed = true;
    generation++;
  });

  const uses = (body: string, field: keyof typeof fieldLabels) => body.includes(`{${field}}`);
  const longDate = (value: string) =>
    value ? new Intl.DateTimeFormat($locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(value)) : '';
  const merged = (body: string, values: Record<string, string>) =>
    body.replaceAll(/\{([a-z_]+)\}/g, (token, field: string) =>
      field === 'session_date' ? longDate(values[field]) || token : values[field] || token,
    );

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
    const [nextTemplates, nextContracts] = await Promise.all([photographyContractTemplates(), photographyContracts()]);
    if (!disposed && current === generation) {
      templates = nextTemplates;
      contracts = nextContracts;
    }
  }
  onMount(() => {
    void run(reload);
    return onLibraryAccessChange(() => {
      generation++;
      templates = undefined;
      contracts = undefined;
      editorOpen = false;
      sendOpen = false;
    });
  });

  function openEditor(template?: PhotographyContractTemplateDto) {
    editor = template ? { id: template.id, name: template.name, body: template.body } : { name: '', body: '' };
    editorOpen = true;
  }
  async function insertField(field: string) {
    if (!editor || !bodyInput) {
      return;
    }
    const { selectionStart: start, selectionEnd: end } = bodyInput;
    const value = `{${field}}`;
    editor.body = editor.body.slice(0, start) + value + editor.body.slice(end);
    await tick();
    bodyInput.focus();
    bodyInput.setSelectionRange(start + value.length, start + value.length);
  }
  async function saveTemplate() {
    if (!editor) {
      return;
    }
    const dto = { name: editor.name, body: editor.body };
    await (editor.id
      ? photographyUpdateContractTemplate({ id: editor.id, photographyContractTemplateSaveDto: dto })
      : photographyCreateContractTemplate({ photographyContractTemplateSaveDto: dto }));
    editorOpen = false;
    await reload();
  }

  function openSend(template: PhotographyContractTemplateDto) {
    sending = { template, client: '', email: '', date: '', total: '' };
    sendError = false;
    sendOpen = true;
  }
  async function send() {
    if (!sending) {
      return;
    }
    const { template, client, email, date, total } = sending;
    const created = await photographyCreateContract({
      photographyContractCreateDto: {
        templateId: template.id,
        clientName: client,
        clientEmail: email,
        ...(uses(template.body, 'session_date') && { sessionDate: date }),
        ...(uses(template.body, 'total') && { total }),
      },
    });
    await photographySendContract({ id: created.id });
    sendOpen = false;
    await reload();
  }
  function changeContract(contract: PhotographyContractDto, action: 'send' | 'void') {
    void run(async () => {
      await (action === 'send'
        ? photographySendContract({ id: contract.id })
        : photographyVoidContract({ id: contract.id }));
      await reload();
    });
  }
</script>

<section class="contracts" aria-busy={busy}>
  {#if error}<p role="alert" class="error">{$t('frameleaf_clients_contract_error')}</p>{/if}
  {#if contracts && !contracts.mailReady}<p role="status" class="muted">
      {$t('frameleaf_clients_contract_mail_needed')}
    </p>{/if}
  {#if templates && templates.items.length === 0}
    <div class="empty">
      <h2>{$t('frameleaf_clients_contract_empty_heading')}</h2>
      <p>{$t('frameleaf_clients_contract_empty_body')}</p>
      <Button variant="primary" disabled={busy} onclick={() => openEditor()}
        >{$t('frameleaf_clients_contract_new_template')}</Button
      >
    </div>
  {:else if templates}
    <div class="heading">
      <h2>{$t('frameleaf_clients_contract_templates')}</h2>
      <Button variant="primary" disabled={busy} onclick={() => openEditor()}
        >{$t('frameleaf_clients_contract_new_template')}</Button
      >
    </div>
    <ul class="list">
      {#each templates.items as template (template.id)}
        <li>
          <div>
            <strong>{template.name}</strong>
            <small>{$t('frameleaf_clients_contract_template_kind')}</small>
          </div>
          <Button disabled={busy} onclick={() => openEditor(template)}>{$t('edit')}</Button>
          <Button disabled={busy} onclick={() => openSend(template)}>{$t('frameleaf_clients_contract_send')}</Button>
        </li>
      {/each}
    </ul>
    <h2>{$t('frameleaf_clients_contract_sent_heading')}</h2>
    {#if contracts?.items.length}
      <ul class="list">
        {#each contracts.items as contract (contract.id)}
          <li>
            <div>
              <strong>{contract.name}</strong>
              <small>{contract.clientName} · {contract.clientEmail}</small>
            </div>
            <span class="pill" data-status={contract.status}>{$t(statusLabels[contract.status])}</span>
            {#if contract.status === 'signed'}
              <a href="/api/photography/contracts/{contract.id}/pdf" download
                >{$t('frameleaf_clients_contract_download')}</a
              >
              <a href="/api/photography/contracts/{contract.id}/export" download
                >{$t('frameleaf_clients_contract_export')}</a
              >
            {:else if contract.status !== 'void'}
              <Button disabled={busy || !contracts.mailReady} onclick={() => changeContract(contract, 'send')}
                >{contract.status === 'draft'
                  ? $t('frameleaf_clients_contract_send')
                  : $t('frameleaf_clients_contract_resend')}</Button
              >
              <Button variant="danger" disabled={busy} onclick={() => changeContract(contract, 'void')}
                >{$t('frameleaf_clients_contract_void')}</Button
              >
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted">{$t('frameleaf_clients_contract_sent_empty')}</p>
    {/if}
  {/if}
</section>

{#if editor}
  <Dialog
    bind:open={editorOpen}
    title={editor.id ? $t('frameleaf_clients_contract_edit_template') : $t('frameleaf_clients_contract_new_template')}
    closeLabel={$t('close')}
    wide
    onRequestClose={() => {
      if (!busy) {
        editorOpen = false;
      }
    }}
    onClosed={() => (editor = undefined)}
  >
    <form
      class="stack"
      onsubmit={(event) => {
        event.preventDefault();
        void run(saveTemplate);
      }}
    >
      {#if error}<p role="alert" class="error">{$t('frameleaf_clients_contract_error')}</p>{/if}
      <label
        >{$t('frameleaf_clients_contract_template_name')}<input
          required
          maxlength="200"
          bind:value={editor.name}
        /></label
      >
      <label
        >{$t('frameleaf_clients_contract_agreement_text')}<textarea
          required
          maxlength="50000"
          rows="8"
          bind:this={bodyInput}
          bind:value={editor.body}></textarea></label
      >
      <div class="chips" role="group" aria-label={$t('frameleaf_clients_contract_insert_field')}>
        {#each templates?.fields ?? [] as field (field)}
          <Button onclick={() => insertField(field)}>{$t(fieldLabels[field])}</Button>
        {/each}
      </div>
      <aside class="panel">
        <h3>{$t('frameleaf_clients_contract_sample')}</h3>
        <p class="body">{merged(editor.body, sampleValues)}</p>
      </aside>
      <div class="actions">
        <Button disabled={busy} onclick={() => (editorOpen = false)}>{$t('cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy}>{$t('frameleaf_clients_contract_save_template')}</Button
        >
      </div>
    </form>
  </Dialog>
{/if}

{#if sending}
  <Dialog
    bind:open={sendOpen}
    title={$t('frameleaf_clients_contract_send')}
    closeLabel={$t('close')}
    onRequestClose={() => {
      if (!busy) {
        sendOpen = false;
      }
    }}
    onClosed={() => (sending = undefined)}
  >
    <form
      class="stack"
      onsubmit={(event) => {
        event.preventDefault();
        void run(send, () => (sendError = true));
      }}
    >
      {#if contracts && !contracts.mailReady}<p role="status" class="muted">
          {$t('frameleaf_clients_contract_mail_needed')}
        </p>{/if}
      <label
        >{$t('frameleaf_clients_contract_client')}<input
          required
          maxlength="200"
          autocomplete="off"
          bind:value={sending.client}
        /></label
      >
      <label>{$t('email')}<input type="email" required maxlength="254" bind:value={sending.email} /></label>
      {#if uses(sending.template.body, 'session_date')}
        <label
          >{$t('frameleaf_clients_contract_session_date')}<input
            type="date"
            required
            bind:value={sending.date}
          /></label
        >
      {/if}
      {#if uses(sending.template.body, 'total')}
        <label>{$t('total')}<input required maxlength="50" bind:value={sending.total} /></label>
      {/if}
      <aside class="panel">
        <strong>{sending.template.name}</strong>
        <p class="body">
          {merged(sending.template.body, {
            client_name: sending.client,
            session_date: sending.date,
            total: sending.total,
          })}
        </p>
      </aside>
      {#if sendError}<p role="alert" class="error">{$t('frameleaf_clients_contract_send_error')}</p>{/if}
      <div class="actions">
        <Button disabled={busy} onclick={() => (sendOpen = false)}>{$t('cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy || !contracts?.mailReady}
          >{$t('frameleaf_clients_contract_send')}</Button
        >
      </div>
    </form>
  </Dialog>
{/if}

<style>
  .contracts {
    display: grid;
    gap: 1.5rem;
    padding: 1.5rem;
    max-width: 60rem;
  }
  .heading,
  .actions,
  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
  }
  .heading {
    justify-content: space-between;
  }
  .actions {
    justify-content: flex-end;
  }
  h2,
  h3 {
    margin: 0;
  }
  .empty {
    display: grid;
    justify-items: start;
    gap: 1rem;
    padding: 2rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
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
    overflow-wrap: anywhere;
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
  .pill[data-status='signed'] {
    color: var(--fl-accent);
  }
  .stack {
    display: grid;
    gap: 1.25rem;
  }
  label {
    display: grid;
    gap: 0.5rem;
  }
  input,
  textarea {
    padding: 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: 0.5rem;
    background: var(--fl-surface);
    color: inherit;
    font: inherit;
  }
  .panel {
    display: grid;
    gap: 0.75rem;
    padding: 1.25rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .body {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .muted {
    color: var(--fl-muted);
  }
  .error {
    color: var(--fl-error, #c23442);
  }
</style>
