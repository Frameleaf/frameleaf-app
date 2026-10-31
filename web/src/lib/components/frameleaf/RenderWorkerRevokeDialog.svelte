<script lang="ts">
  /**
   * Revoke a render worker (FL-95). Revocation is immediate and permanent: every session the
   * worker holds ends, its next request is refused, and the claims it held lapse into recovery
   * rather than being trusted to finish. Like the maintenance restore (FL-81), the irreversible
   * action is confirmed by typing the name rather than by a second click, in the shared typed
   * confirmation with the danger button (design review finding 74).
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import TypedConfirmation from '$lib/components/frameleaf/settings/TypedConfirmation.svelte';
  import { matchesTyped } from '$lib/components/frameleaf/settings/typed-confirmation';
  import { handleRevokeRenderWorker } from '$lib/services/render-worker.service';
  import type { RenderWorkerDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  let { worker, onClose }: { worker: RenderWorkerDto; onClose: (revoked: boolean) => void } = $props();

  let open = $state(true);
  let working = $state(false);
  let revoked = $state(false);
  let typed = $state('');

  const confirmed = $derived(matchesTyped(worker.name, typed));

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
    <TypedConfirmation
      label={$t('frameleaf_render_workers_revoke_type_label')}
      placeholder={worker.name}
      initialFocus
      disabled={working}
      bind:value={typed}
    />
    <footer>
      <Button disabled={working} onclick={() => (open = false)}>{$t('frameleaf_render_workers_form_cancel')}</Button>
      <Button type="submit" variant="danger" disabled={!confirmed || working}>
        {$t('frameleaf_render_workers_revoke_confirm')}
      </Button>
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
  footer {
    display: flex;
    justify-content: end;
    gap: 0.5rem;
  }
</style>
