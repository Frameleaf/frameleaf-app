<script lang="ts">
  /**
   * Delete an account (FL-76), from the `delete-user` branch of the design template's
   * `ResourceAction` in `design/frameleaf/template/src/AccountsLibraries.jsx`.
   *
   * The default is the configured soft delete: the server marks the account deleted, trashes
   * its albums and keeps the files for `userDeleteDelay` days, which Restore undoes. Ticking
   * "skip recovery" sends `force`, which queues the real removal job instead and cannot be
   * undone. As in the template (CC-32, `AccountsLibraries.jsx` 632-659), both paths ask for the
   * account's email typed exactly. Both go through `deleteUserAdmin`, which refuses the calling
   * administrator's own account.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import TypedConfirmation from '$lib/components/frameleaf/settings/TypedConfirmation.svelte';
  import { matchesTyped } from '$lib/components/frameleaf/settings/typed-confirmation';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { handleDeleteUserAdmin } from '$lib/services/user-admin.service';
  import type { UserAdminResponseDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  let { user, onClose }: { user: UserAdminResponseDto; onClose: () => void } = $props();

  let open = $state(true);
  let force = $state(false);
  let confirmation = $state('');
  let working = $state(false);

  const delay = $derived(serverConfigManager.value.userDeleteDelay);
  const valid = $derived(matchesTyped(user.email, confirmation));

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
      const success = await handleDeleteUserAdmin(user, { force, confirmEmail: confirmation.trim() });
      if (success) {
        open = false;
      }
    } finally {
      working = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_users_delete')} closeLabel={$t('close')} bind:open>
  <form onsubmit={submit}>
    <p>{$t('frameleaf_users_delete_body', { values: { name: user.name, delay } })}</p>

    <label class="check">
      <input type="checkbox" bind:checked={force} disabled={working} />
      <span>{$t('frameleaf_users_delete_force_label')}</span>
    </label>

    {#if force}
      <p class="danger" role="alert">{$t('frameleaf_users_delete_force_warning')}</p>
    {/if}
    <TypedConfirmation
      label={$t('frameleaf_users_delete_confirm_label')}
      placeholder={user.email}
      initialFocus
      disabled={working}
      bind:value={confirmation}
    />

    <footer>
      <Button type="button" disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
      <!-- The template's danger confirm (AccountsLibraries.jsx:724-729); the force path keeps its own label. -->
      <Button type="submit" variant="danger" disabled={!valid || working}>
        {force ? $t('frameleaf_users_delete_confirm_force') : $t('frameleaf_users_delete')}
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
  footer {
    display: flex;
    margin-top: 1rem;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
