<script lang="ts">
  /**
   * Delete an account (FL-76), from the `delete-user` branch of the design template's
   * `ResourceAction` in `design/frameleaf/template/src/AccountsLibraries.jsx`.
   *
   * The default is the configured soft delete: the server marks the account deleted, trashes
   * its albums and keeps the files for `userDeleteDelay` days, which Restore undoes. Ticking
   * "skip recovery" sends `force`, which queues the real removal job instead and cannot be
   * undone, so that path additionally demands the account's email typed exactly. Both go
   * through `deleteUserAdmin`, which refuses the calling administrator's own account.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { handleDeleteUserAdmin } from '$lib/services/user-admin.service';
  import type { UserAdminResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  let { user, onClose }: { user: UserAdminResponseDto; onClose: () => void } = $props();

  let open = $state(true);
  let force = $state(false);
  let confirmation = $state('');
  let working = $state(false);

  const delay = $derived(serverConfigManager.value.userDeleteDelay);
  const valid = $derived(!force || confirmation.trim().toLowerCase() === user.email.toLowerCase());
  const confirmId = $props.id();

  $effect(() => {
    if (!open) {
      onClose();
    }
  });

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!valid || working) {
      return;
    }

    working = true;
    try {
      const success = await handleDeleteUserAdmin(user, { force });
      if (success) {
        open = false;
      }
    } finally {
      working = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_users_delete_title', { values: { name: user.name } })} closeLabel={$t('close')} bind:open>
  <form onsubmit={submit}>
    <p>{$t('frameleaf_users_delete_body', { values: { name: user.name, delay } })}</p>

    <label class="check">
      <input type="checkbox" bind:checked={force} disabled={working} />
      <span>{$t('frameleaf_users_delete_force_label')}</span>
    </label>

    {#if force}
      <p class="danger" role="alert">{$t('frameleaf_users_delete_force_warning')}</p>
      <label class="field" for={confirmId}>
        <span>{$t('frameleaf_users_delete_confirm_label', { values: { email: user.email } })}</span>
        <input
          id={confirmId}
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder={user.email}
          bind:value={confirmation}
          disabled={working}
        />
      </label>
    {/if}

    <footer>
      <Button type="button" disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button type="submit" variant="primary" disabled={!valid || working}>
        {force ? $t('frameleaf_users_delete_confirm_force') : $t('frameleaf_users_delete_confirm')}
      </Button>
    </footer>
  </form>
</Dialog>

<style>
  form {
    margin-top: 0.75rem;
    min-width: min(26rem, 100%);
  }
  p {
    margin: 0 0 0.75rem;
    color: var(--fl-text);
  }
  .danger {
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
    color: var(--fl-text);
  }
  .field {
    display: grid;
    gap: 0.375rem;
    margin-bottom: 1rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .field input {
    padding: 0.4375rem 0.6875rem;
    font: inherit;
    font-size: var(--fl-font-size);
    color: var(--fl-text);
    background: var(--fl-canvas);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
