<script lang="ts">
  /**
   * Administrator password reset (FL-76), from the `reset-password` branch of the design
   * template's `ResourceAction` in `design/frameleaf/template/src/AccountsLibraries.jsx`.
   *
   * There is no server-side reset endpoint, so this keeps production's existing approach:
   * generate a password in the browser and send it through the admin update endpoint with
   * `shouldChangePassword`, which hashes it and forces a change at the next sign-in. The
   * generated value is shown once, in this dialog, and is never stored or logged; closing
   * the dialog drops it. The confirm step comes first so a mis-click cannot invalidate
   * somebody's password.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { handleResetPasswordUserAdmin } from '$lib/services/user-admin.service';
  import { copyToClipboard } from '$lib/utils';
  import type { UserAdminResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  let { user, onClose }: { user: UserAdminResponseDto; onClose: () => void } = $props();

  let open = $state(true);
  let issued = $state('');
  let copied = $state(false);
  let working = $state(false);

  $effect(() => {
    if (!open) {
      onClose();
    }
  });

  const confirm = async () => {
    working = true;
    try {
      const password = await handleResetPasswordUserAdmin(user);
      if (password) {
        issued = password;
      } else {
        open = false;
      }
    } finally {
      working = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_users_password_reset')} closeLabel={$t('close')} bind:open>
  <div class="body">
    {#if issued}
      <p>{$t('frameleaf_users_password_issued_description', { values: { name: user.name } })}</p>
      <div class="secret">
        <code aria-label={$t('frameleaf_users_password_issued_label')}>{issued}</code>
        <Button
          onclick={async () => {
            await copyToClipboard(issued);
            copied = true;
          }}
        >
          {$t('copy_password')}
        </Button>
      </div>
      <p class="footnote" role="status">
        {copied ? $t('frameleaf_users_password_issued_copied') : $t('frameleaf_users_password_issued_warning')}
      </p>
      <div class="actions">
        <Button variant="primary" onclick={() => (open = false)}>{$t('done')}</Button>
      </div>
    {:else}
      <p>{$t('frameleaf_users_password_reset_description', { values: { name: user.name } })}</p>
      <p class="footnote">{$t('frameleaf_users_password_reset_footnote')}</p>
      <div class="actions">
        <Button disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
        <Button variant="primary" disabled={working} onclick={confirm}>
          {$t('frameleaf_users_password_reset_confirm')}
        </Button>
      </div>
    {/if}
  </div>
</Dialog>

<style>
  .body {
    margin-top: 0.75rem;
    min-width: min(26rem, 100%);
  }
  .body p {
    margin: 0 0 0.75rem;
    color: var(--fl-text);
  }
  .footnote {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .secret {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }
  .secret code {
    padding: 0.4375rem 0.6875rem;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    word-break: break-all;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
