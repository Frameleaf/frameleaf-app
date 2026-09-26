<script lang="ts">
  /**
   * Change your own password (FL-67), from the `personal-password` form of the design template's
   * `PersonalForm`: current password, new password, confirmation and "Sign out my other devices"
   * (on by default). The server verifies the current password and, when asked, signs out every
   * other session. The fields live only in this dialog and are cleared whatever the outcome.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    passwordFormError,
    type PasswordFormError,
  } from '$lib/frameleaf/personal-access';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { changePassword } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import './access.css';

  let { onClose }: { onClose: (result?: { signedOutOthers: boolean }) => void } = $props();

  let open = $state(true);
  let current = $state('');
  let next = $state('');
  let confirm = $state('');
  let signOutOthers = $state(true);
  let working = $state(false);
  let error = $state('');
  let result: { signedOutOthers: boolean } | undefined;

  const formError = $derived(passwordFormError({ current, next, confirm }));
  const visibleError = $derived<PasswordFormError | undefined>(
    formError === 'required' || (formError === 'mismatch' && confirm.length < next.length) ? undefined : formError,
  );
  const messages: Record<PasswordFormError, string> = $derived({
    required: '',
    too_short: $t('frameleaf_access_password_too_short', { values: { count: PASSWORD_MIN_LENGTH } }),
    mismatch: $t('frameleaf_access_password_mismatch'),
    unchanged: $t('frameleaf_access_password_unchanged'),
  });

  const clear = () => {
    current = '';
    next = '';
    confirm = '';
  };

  $effect(() => {
    if (open) {
      return;
    }

    clear();
    onClose(result);
  });

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (working || formError) {
      return;
    }

    working = true;
    error = '';
    try {
      const user = await changePassword({
        changePasswordDto: { password: current, newPassword: next, invalidateSessions: signOutOthers },
      });
      authManager.setUser(user);
      result = { signedOutOthers: signOutOthers };
      toastManager.primary($t('frameleaf_access_password_changed'));
      open = false;
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('frameleaf_access_password_failed');
      clear();
    } finally {
      working = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_access_password_change')} closeLabel={$t('close')} bind:open>
  <form class="fl-access-form" onsubmit={submit}>
    <label class="fl-access-field">
      <span>{$t('frameleaf_access_password_current')}</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="password"
        required
        autofocus
        autocomplete="current-password"
        maxlength={PASSWORD_MAX_LENGTH}
        disabled={working}
        bind:value={current}
      />
    </label>
    <label class="fl-access-field">
      <span>{$t('frameleaf_access_password_new')}</span>
      <input
        type="password"
        required
        minlength={PASSWORD_MIN_LENGTH}
        maxlength={PASSWORD_MAX_LENGTH}
        autocomplete="new-password"
        disabled={working}
        bind:value={next}
      />
    </label>
    <label class="fl-access-field">
      <span>{$t('frameleaf_access_password_confirm')}</span>
      <input
        type="password"
        required
        maxlength={PASSWORD_MAX_LENGTH}
        autocomplete="new-password"
        disabled={working}
        bind:value={confirm}
      />
    </label>
    <label class="fl-access-check">
      <input type="checkbox" disabled={working} bind:checked={signOutOthers} />
      <span>{$t('frameleaf_access_password_sign_out_others')}</span>
    </label>
    {#if visibleError}
      <p class="fl-access-error" role="alert">{messages[visibleError]}</p>
    {/if}
    {#if error}
      <p class="fl-access-error" role="alert">{error}</p>
    {/if}
    <footer>
      <Button disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button type="submit" variant="primary" disabled={working || !!formError}>
        {$t('frameleaf_access_password_change')}
      </Button>
    </footer>
  </form>
</Dialog>
