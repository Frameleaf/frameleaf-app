<script lang="ts">
  /**
   * Settings → Computers → Advanced → Connections → Faster model downloads (FL-1825, prototype
   * `ModelDownloadKey` in settings-v2/computers/Computers.jsx). AI models download from Frameleaf's
   * library on Hugging Face; an optional Hugging Face key makes those downloads faster.
   *
   * The typed key lives only in this component's local state, is sent once to
   * `PUT /admin/model-download-key` (which checks it with Hugging Face before keeping it) and is
   * dropped when the dialog closes. The server never returns it.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import {
    getModelDownloadKey,
    isHttpError,
    removeModelDownloadKey,
    setModelDownloadKey,
    ModelDownloadKeyStatus,
    type ModelDownloadKeyResponseDto,
  } from '@frameleaf/sdk';
  import { toastManager } from '@frameleaf/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  const KEY_PATTERN = /^hf_[A-Za-z0-9]{20,200}$/;

  let status = $state<ModelDownloadKeyResponseDto | null>(null);
  let dialog = $state<'add' | 'remove' | null>(null);
  let open = $state(false);
  let draft = $state('');
  let working = $state(false);
  let problem = $state<'refused' | 'unreachable' | 'failed' | null>(null);
  const inputId = $props.id();
  const hintId = `${inputId}-hint`;

  const looksRight = $derived(KEY_PATTERN.test(draft.trim()));
  const hint = $derived.by(() => {
    if (!draft || looksRight) {
      return '';
    }
    return draft.trimStart().startsWith('hf_')
      ? $t('frameleaf_model_download_key_hint_partial')
      : $t('frameleaf_model_download_key_hint_prefix');
  });

  onMount(async () => {
    try {
      status = await getModelDownloadKey();
    } catch {
      status = null;
    }
  });

  const show = (next: 'add' | 'remove') => {
    dialog = next;
    open = true;
  };

  const closed = () => {
    // The typed key never outlives the dialog.
    draft = '';
    problem = null;
    working = false;
    dialog = null;
  };

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (working || !looksRight) {
      return;
    }
    working = true;
    problem = null;
    try {
      status = await setModelDownloadKey({ modelDownloadKeyUpdateDto: { key: draft.trim() } });
      draft = '';
      open = false;
      toastManager.primary($t('frameleaf_model_download_key_saved_toast'));
    } catch (error) {
      const code = isHttpError(error) ? error.status : undefined;
      problem = code === 400 ? 'refused' : code === 503 ? 'unreachable' : 'failed';
    } finally {
      working = false;
    }
  };

  const remove = async () => {
    working = true;
    problem = null;
    try {
      await removeModelDownloadKey();
      status = { status: ModelDownloadKeyStatus.None, savedAt: null, checkedAt: null };
      open = false;
      toastManager.primary($t('frameleaf_model_download_key_removed_toast'));
    } catch {
      problem = 'failed';
    } finally {
      working = false;
    }
  };
</script>

{#if status}
  <Row label={$t('frameleaf_model_download_key_label')} help={$t('frameleaf_model_download_key_help')}>
    {#if status.status === ModelDownloadKeyStatus.None}
      <Button onclick={() => show('add')}>{$t('frameleaf_model_download_key_add')}</Button>
    {:else}
      <span class="actions">
        {#if status.status === ModelDownloadKeyStatus.Saved}
          <Pill tone="good">{$t('frameleaf_model_download_key_saved')}</Pill>
        {:else}
          <Pill tone="warn">{$t('frameleaf_model_download_key_refused')}</Pill>
        {/if}
        <Button onclick={() => show('add')}>{$t('frameleaf_model_download_key_replace')}</Button>
        <Button onclick={() => show('remove')}>{$t('frameleaf_model_download_key_remove')}</Button>
      </span>
    {/if}
  </Row>
  {#if status.status === ModelDownloadKeyStatus.Refused}
    <Notice tone="warn" title={$t('frameleaf_model_download_key_stopped_title')}>
      {$t('frameleaf_model_download_key_stopped_body')}
    </Notice>
  {/if}
{/if}

{#if dialog === 'add'}
  <Dialog
    title={status?.status === ModelDownloadKeyStatus.None
      ? $t('frameleaf_model_download_key_add_title')
      : $t('frameleaf_model_download_key_replace_title')}
    closeLabel={$t('close')}
    bind:open
    onClosed={closed}
  >
    <form class="key-form" autocomplete="off" onsubmit={save}>
      <p>{$t('frameleaf_model_download_key_intro')}</p>
      <label for={inputId}>{$t('frameleaf_model_download_key_field')}</label>
      <input
        id={inputId}
        type="password"
        autocomplete="off"
        spellcheck="false"
        maxlength={256}
        placeholder="hf_…"
        aria-describedby={hint ? hintId : undefined}
        aria-invalid={problem === 'refused' || undefined}
        data-initial-focus
        disabled={working}
        bind:value={draft}
        oninput={() => (problem = null)}
      />
      {#if hint}
        <p id={hintId} class="footnote">{hint}</p>
      {/if}
      {#if problem === 'refused'}
        <Notice tone="warn" title={$t('frameleaf_model_download_key_not_accepted_title')}>
          {$t('frameleaf_model_download_key_not_accepted_body')}
        </Notice>
      {:else if problem}
        <p class="error" role="alert">
          {problem === 'unreachable'
            ? $t('frameleaf_model_download_key_unreachable')
            : $t('frameleaf_model_download_key_failed')}
        </p>
      {/if}
      <p class="footnote">{$t('frameleaf_model_download_key_footnote')}</p>
      <footer>
        <Button disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
        <Button type="submit" variant="primary" disabled={working || !looksRight}>
          {working ? $t('frameleaf_model_download_key_checking') : $t('frameleaf_model_download_key_check_and_save')}
        </Button>
      </footer>
    </form>
  </Dialog>
{:else if dialog === 'remove'}
  <Dialog title={$t('frameleaf_model_download_key_remove_title')} closeLabel={$t('close')} bind:open onClosed={closed}>
    <p class="body">{$t('frameleaf_model_download_key_remove_body')}</p>
    {#if problem}
      <p class="error" role="alert">{$t('frameleaf_model_download_key_failed')}</p>
    {/if}
    {#snippet actions()}
      <Button disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={working} onclick={remove}>
        {$t('frameleaf_model_download_key_remove_confirm')}
      </Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .actions {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fl-space-2);
  }
  .key-form {
    display: grid;
    gap: var(--fl-space-4);
    min-width: min(26rem, 100%);
  }
  .key-form p,
  .body {
    margin: 0;
    color: var(--fl-text);
  }
  label {
    margin-bottom: calc(-1 * var(--fl-space-2));
    font-weight: 600;
    color: var(--fl-text);
  }
  input {
    width: 100%;
    padding: 0.5rem 0.75rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font: inherit;
  }
  .key-form .footnote {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--fl-space-2);
  }
  .error {
    margin: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-danger);
  }
</style>
