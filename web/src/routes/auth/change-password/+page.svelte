<script lang="ts">
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline } from '@mdi/js';
  import { goto, invalidateAll } from '$app/navigation';
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import AuthPasswordField from '$lib/components/frameleaf/AuthPasswordField.svelte';
  import AuthPasswordQuality from '$lib/components/frameleaf/AuthPasswordQuality.svelte';
  import { passwordStrength } from '$lib/frameleaf/auth-password';
  import { preservePreferenceForPasswordChange } from '$lib/frameleaf/auth-session-preference';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { changePassword, updateMyUser } from '@frameleaf/sdk';
  import { setAuthNotice } from '../auth-notice';
  import { t } from 'svelte-i18n';

  let { data }: import('./$types').PageProps = $props();

  let password = $state('');
  let passwordConfirm = $state('');
  let loading = $state(false);
  let errorMessage = $state('');
  const mismatch = $derived(passwordConfirm.length > 0 && password !== passwordConfirm);
  // FL-708: the one rule is length (the server enforces the same minimum); the meter only advises.
  const ready = $derived(passwordStrength(password).acceptable && password === passwordConfirm);

  const onSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!ready || loading) {
      return;
    }
    if (!data.local && !preservePreferenceForPasswordChange()) {
      errorMessage = $t('frameleaf_auth_error_storage_session_choice');
      return;
    }
    loading = true;
    errorMessage = '';
    try {
      if (data.local) {
        await changePassword({ changePasswordDto: { password: '', newPassword: password, invalidateSessions: true } });
        await goto(data.destination, { invalidateAll: true });
        return;
      }
      await updateMyUser({ userUpdateMeDto: { password } });
      // Changing the password ends this session: the sign-in page says so and fills the email in.
      setAuthNotice({ kind: 'password-changed', email: authManager.user.email });
      await goto(Route.logout());
    } catch (error) {
      errorMessage = getServerErrorMessage(error) || $t('frameleaf_auth_change_password_failed');
    } finally {
      loading = false;
    }
  };
</script>

<AuthShell>
  <div class="auth-heading">
    <h1>{$t(data.local ? 'frameleaf_auth_local_password_title' : 'frameleaf_auth_change_password_title')}</h1>
    <p>{$t(data.local ? 'frameleaf_auth_local_password_body' : 'frameleaf_auth_change_password_body')}</p>
  </div>
  {#if data.statusUnavailable}
    <div class="auth-card auth-form">
      <p class="auth-error" role="alert">{$t('frameleaf_auth_local_password_status_unavailable')}</p>
      <button type="button" class="button primary auth-submit" onclick={() => invalidateAll()}>{$t('retry')}</button>
    </div>
  {:else}
    <form class="auth-card auth-form" onsubmit={onSubmit} novalidate>
      {#if errorMessage}<p class="auth-error" role="alert">
          <Icon icon={mdiAlertCircleOutline} size="16" /><span>{errorMessage}</span>
        </p>{/if}
      <div class="auth-field">
        <label for="account-email">{$t('frameleaf_auth_account')}</label><input
          id="account-email"
          value={authManager.user.email}
          readonly
          autocomplete="username"
        />
      </div>
      <AuthPasswordField
        id="new-password"
        label={$t('frameleaf_auth_new_password')}
        autofocus
        bind:value={password}
        describedBy="new-password-quality"
      />
      <AuthPasswordQuality id="new-password-quality" {password} />
      <AuthPasswordField
        id="confirm-password"
        label={$t('frameleaf_auth_confirm_new_password')}
        bind:value={passwordConfirm}
        invalid={mismatch}
        describedBy={mismatch ? 'new-password-match' : undefined}
      />
      {#if mismatch}<span class="auth-field-hint" id="new-password-match"
          >{$t('frameleaf_auth_passwords_mismatch_hint')}</span
        >{/if}
      <button type="submit" class="button primary auth-submit" disabled={!ready || loading}
        >{loading
          ? $t('frameleaf_auth_saving')
          : $t(data.local ? 'frameleaf_auth_local_password_continue' : 'frameleaf_auth_save_and_sign_in')}</button
      >
      {#if !data.local}<p class="auth-note">{$t('frameleaf_auth_change_password_signs_out')}</p>{/if}
      <a href={Route.logout()} class="auth-link sign-out-instead">{$t('frameleaf_auth_sign_out_instead')}</a>
    </form>
  {/if}
</AuthShell>

<style>
  /* AuthScreens.jsx ChangePassword: "Sign out instead" sits centred under the button. */
  .sign-out-instead {
    justify-self: center;
  }
</style>
