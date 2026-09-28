<script lang="ts">
  /**
   * Revoke a render worker (FL-95). Revocation is immediate and permanent: every session the
   * worker holds ends, its next request is refused, and the claims it held lapse into recovery
   * rather than being trusted to finish. Like the maintenance restore (FL-81), the irreversible
   * action is confirmed by typing the name rather than by a second click.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { handleRevokeRenderWorker } from '$lib/services/render-worker.service';
  import type { RenderWorkerDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  let { worker, onClose }: { worker: RenderWorkerDto; onClose: (revoked: boolean) => void } = $props();

  let open = $state(true);
  let working = $state(false);
  let revoked = $state(false);
  let typed = $state('');

  const confirmed = $derived(typed.trim() === worker.name);
  const inputId = $props.id();

  $effect(() => {
    if (!open) {
      onClose(revoked);
    }
  });

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!confirmed || working) {
      return;
    }
    working = true;
    try {
      revoked = await handleRevokeRenderWorker(worker.id, worker.name);
      if (revoked) {
        open = false;
      }
    } finally {
      working = false;
    }
  };
</script>

<Dialog
  title={$t('frameleaf_render_workers_revoke_title', { values: { name: worker.name } })}
  closeLabel={$t('frameleaf_render_workers_form_close')}
  bind:open
>
  <form onsubmit={submit}>
    <p>{$t('frameleaf_render_workers_revoke_body')}</p>
    <label for={inputId}>
      <span>{$t('frameleaf_render_workers_revoke_type_label')}</span>
      <input id={inputId} type="text" autocomplete="off" bind:value={typed} />
    </label>
    <footer>
      <Button variant="quiet" onclick={() => (open = false)}>{$t('frameleaf_render_workers_form_cancel')}</Button>
      <Button type="submit" disabled={!confirmed || working}>{$t('frameleaf_render_workers_revoke_confirm')}</Button>
    </footer>
  </form>
</Dialog>

<style>
  form {
    display: grid;
    gap: 0.875rem;
    max-width: 32rem;
  }
  p {
    margin: 0;
  }
  label {
    display: grid;
    gap: 0.25rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  input {
    padding: 0.4375rem 0.6875rem;
    font: inherit;
    font-size: var(--fl-font-size);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  footer {
    display: flex;
    justify-content: end;
    gap: 0.5rem;
  }
</style>
