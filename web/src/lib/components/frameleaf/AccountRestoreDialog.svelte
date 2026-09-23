<script lang="ts">
  /**
   * Restore a soft-deleted account (FL-76), from the `restore-user` branch of the design
   * template's `ResourceAction` in `design/frameleaf/template/src/AccountsLibraries.jsx`.
   *
   * `restoreUserAdmin` undoes the soft delete and restores the albums that were trashed with
   * it. An account already being removed by force has no restore path, which is why the
   * lifecycle panel only offers this while `canRestoreAccount` holds.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { handleRestoreUserAdmin } from '$lib/services/user-admin.service';
  import type { UserAdminResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  let { user, onClose }: { user: UserAdminResponseDto; onClose: () => void } = $props();

  let open = $state(true);
  let working = $state(false);

  $effect(() => {
    if (!open) {
      onClose();
    }
  });

  const confirm = async () => {
    working = true;
    try {
      const success = await handleRestoreUserAdmin(user);
      if (success) {
        open = false;
      }
    } finally {
      working = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_users_restore_title', { values: { name: user.name } })} closeLabel={$t('close')} bind:open>
  <div class="body">
    <p>{$t('frameleaf_users_restore_body', { values: { name: user.name } })}</p>
    <footer>
      <Button disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={working} onclick={confirm}>{$t('frameleaf_users_restore')}</Button>
    </footer>
  </div>
</Dialog>

<style>
  .body {
    margin-top: 0.75rem;
    min-width: min(24rem, 100%);
  }
  p {
    margin: 0 0 1rem;
    color: var(--fl-text);
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
