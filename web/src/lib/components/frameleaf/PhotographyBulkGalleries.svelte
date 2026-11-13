<script lang="ts">
  import { getFolderSummary, type PhotographyBulkCreateDto, type PhotographyBulkDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { newRequestKey } from '$lib/frameleaf/request-key';
  import { parseBulkClients } from '$lib/frameleaf/photography/bulk';
  import { photographyBulkRequest } from '$lib/frameleaf/photography/workflow-api';

  let {
    open = $bindable(),
    shoots,
    onCreated,
  }: {
    open: boolean;
    shoots: { id: string; name: string }[];
    onCreated: () => void;
  } = $props();

  let text = $state('');
  let templateId = $state('');
  let stage = $state<'input' | 'review' | 'result'>('input');
  let choices = $state<Record<number, string>>({});
  let folders = $state<{ path: string }[]>([]);
  let loadingFolders = $state(false);
  let foldersFailed = $state(false);
  let error = $state(false);
  let copyFailed = $state(false);
  let busy = $state(false);
  let preview = $state<number>();
  let batch = $state<PhotographyBulkDto>();
  let submitted = $state<PhotographyBulkCreateDto>();
  let loadedFolders = false;
  const rows = $derived(parseBulkClients(text));
  const complete = $derived(
    batch?.rows.filter(({ status }) => status !== 'queued' && status !== 'publishing').length ?? 0,
  );
  const statusLabel = {
    queued: 'frameleaf_photography_bulk_queued',
    publishing: 'frameleaf_photography_bulk_publishing',
    draft: 'frameleaf_photography_bulk_draft',
    ready: 'frameleaf_photography_bulk_ready',
    'mail-queued': 'frameleaf_photography_bulk_email_queued',
    failed: 'frameleaf_photography_bulk_failed',
  } as const;
  const errorLabel = {
    'photos-unavailable': 'frameleaf_photography_bulk_photos_unavailable',
    'publication-failed': 'frameleaf_photography_bulk_publish_failed',
    'setup-failed': 'frameleaf_photography_bulk_failed',
    'email-unavailable': 'frameleaf_photography_bulk_email_unavailable',
  } as const;

  $effect(() => {
    if (open && !loadedFolders) void loadFolders();
  });

  $effect(() => {
    const id = batch?.id;
    if (!open || !id || complete === batch?.rows.length || error) return;
    const timer = setTimeout(() => void refresh(id), 2000);
    return () => clearTimeout(timer);
  });

  async function loadFolders() {
    loadedFolders = true;
    loadingFolders = true;
    foldersFailed = false;
    try {
      folders = (await getFolderSummary()).filter(({ path }) => path.startsWith('/'));
    } catch {
      foldersFailed = true;
    } finally {
      loadingFolders = false;
    }
  }

  async function refresh(id: string) {
    try {
      batch = await photographyBulkRequest(`/${id}`);
      error = false;
      if (batch.rows.every(({ status }) => status !== 'queued' && status !== 'publishing')) onCreated();
    } catch {
      error = true;
    }
  }

  async function submit() {
    if (busy) return;
    busy = true;
    error = false;
    try {
      submitted ??= {
        requestId: newRequestKey(),
        templateId,
        rows: rows.map(({ clientName, clientEmail, index }) => ({
          title: clientName,
          clientName,
          clientEmail,
          ...(choices[index] && { folderPath: choices[index] }),
        })),
      };
      batch = await photographyBulkRequest('', 'POST', submitted);
      stage = 'result';
      if (batch.rows.every(({ status }) => status !== 'queued' && status !== 'publishing')) onCreated();
    } catch {
      error = true;
    } finally {
      busy = false;
    }
  }

  async function retry(id: string) {
    if (!batch || busy) return;
    busy = true;
    error = false;
    try {
      batch = await photographyBulkRequest(`/${batch.id}/rows/${id}/retry`, 'POST');
    } catch {
      error = true;
    } finally {
      busy = false;
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      copyFailed = false;
    } catch {
      copyFailed = true;
    }
  }
</script>

<Dialog title={$t('frameleaf_photography_bulk_title')} closeLabel={$t('close')} bind:open wide>
  <div class="bulk">
    {#if stage === 'input'}
      <label>
        {$t('frameleaf_photography_bulk_template')}
        <select bind:value={templateId}>
          <option value="" disabled>{$t('frameleaf_photography_choose_shoot')}</option>
          {#each shoots as shoot (shoot.id)}
            <option value={shoot.id}>{shoot.name}</option>
          {/each}
        </select>
      </label>
      <label>
        {$t('frameleaf_photography_bulk_clients')}
        <textarea
          bind:value={text}
          rows="6"
          maxlength="100000"
          placeholder="Morgan Ellis, morgan@example.test"
          data-initial-focus
          oninput={() => {
            choices = {};
            submitted = undefined;
          }}></textarea>
      </label>
      <p>{$t('frameleaf_photography_bulk_paste_help')}</p>
      {#if rows.length > 200 || rows.some((row) => !row.valid)}
        <p role="alert">{$t('frameleaf_photography_bulk_invalid')}</p>
      {/if}
      <div class="actions">
        <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
        <Button
          variant="primary"
          disabled={!templateId || !rows.length || rows.length > 200 || rows.some((row) => !row.valid)}
          onclick={() => {
            error = false;
            stage = 'review';
          }}>{$t('frameleaf_photography_bulk_review')}</Button
        >
      </div>
    {:else if stage === 'review'}
      <p>{$t('frameleaf_photography_bulk_choose_folder')}</p>
      {#if loadingFolders}
        <p role="status">{$t('loading')}</p>
      {:else if foldersFailed}
        <Button onclick={loadFolders}>{$t('retry')}</Button>
      {/if}
      <ul>
        {#each rows as row (row.index)}
          <li>
            <div><strong>{row.clientName}</strong><small>{row.clientEmail}</small></div>
            <label>
              {$t('folder')}
              <select bind:value={choices[row.index]} onchange={() => (submitted = undefined)}>
                <option value="">{$t('frameleaf_photography_bulk_no_folder')}</option>
                {#each folders as folder (folder.path)}
                  <option value={folder.path}>{folder.path}</option>
                {/each}
              </select>
            </label>
            <Button pressed={preview === row.index} onclick={() => (preview = row.index)}>
              {$t('frameleaf_photography_bulk_preview_email')}
            </Button>
            {#if preview === row.index}
              <aside>
                <strong>{row.clientName}</strong>
                <p>{row.clientEmail}</p>
                <p>{$t('frameleaf_photography_bulk_preview_body')}</p>
              </aside>
            {/if}
          </li>
        {/each}
      </ul>
      <div class="actions">
        <Button
          disabled={busy}
          onclick={() => {
            submitted = undefined;
            stage = 'input';
          }}>{$t('back')}</Button
        >
        <Button variant="primary" disabled={busy} onclick={submit}>
          {$t('frameleaf_photography_bulk_create', { values: { count: rows.length } })}
        </Button>
      </div>
    {:else if batch}
      <p role="status">
        {$t('frameleaf_photography_bulk_progress', { values: { completed: complete, total: batch.rows.length } })}
      </p>
      <progress value={complete} max={batch.rows.length} aria-label={$t('frameleaf_photography_bulk_title')}></progress>
      <ul>
        {#each batch.rows as row (row.id)}
          <li>
            <div><strong>{row.title}</strong><small>{row.clientEmail}</small></div>
            <div>
              {$t(statusLabel[row.status])}
              {#if row.error && row.error !== 'setup-failed'}<small>{$t(errorLabel[row.error])}</small>{/if}
            </div>
            <div class="actions">
              {#if row.link && row.password}
                <Button onclick={() => copy(new URL(row.link!, location.origin).href)}>{$t('copy_link')}</Button>
                <Button onclick={() => copy(row.password!)}>{$t('copy_password')}</Button>
              {/if}
              {#if row.status === 'failed' || row.status === 'draft'}
                <Button disabled={busy} onclick={() => retry(row.id)}>{$t('retry')}</Button>
              {:else if row.status === 'ready' || row.status === 'mail-queued'}
                <Button disabled={busy} onclick={() => retry(row.id)}>{$t('frameleaf_photography_bulk_resend')}</Button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
      <div class="actions">
        {#if complete === batch.rows.length}
          <Button
            onclick={() => {
              submitted = undefined;
              batch = undefined;
              stage = 'input';
              text = '';
              choices = {};
            }}
          >
            {$t('frameleaf_photography_bulk_new_batch')}
          </Button>
        {/if}
        <Button variant="primary" onclick={() => (open = false)}>{$t('done')}</Button>
      </div>
    {/if}
    {#if error}
      <p role="alert">{$t('frameleaf_photography_bulk_request_failed')}</p>
      {#if stage === 'result' && batch}
        <Button onclick={() => refresh(batch!.id)}>{$t('retry')}</Button>
      {/if}
    {/if}
    {#if copyFailed}<p role="alert">{$t('copy_error')}</p>{/if}
  </div>
</Dialog>

<style>
  .bulk {
    display: grid;
    gap: 1rem;
  }
  label {
    display: grid;
    gap: 0.35rem;
  }
  textarea,
  select {
    min-width: 0;
    width: 100%;
  }
  textarea {
    resize: vertical;
  }
  p,
  ul {
    margin: 0;
  }
  ul {
    display: grid;
    gap: 0.5rem;
    padding: 0;
  }
  li {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.65rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 0.8rem;
  }
  li > div:first-child {
    flex: 1 1 9rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  li > label {
    flex: 1 1 8rem;
    min-width: 0;
  }
  small {
    display: block;
    color: var(--fl-muted);
  }
  aside {
    display: grid;
    gap: 0.35rem;
    flex: 1 0 100%;
    padding: 0.75rem;
    background: var(--fl-raised);
    border-radius: var(--fl-radius);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: end;
    gap: 0.5rem;
  }
  progress {
    width: 100%;
    accent-color: var(--fl-accent);
  }
</style>
