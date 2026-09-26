<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiAlertCircleOutline } from '@mdi/js';
  import { goto } from '$app/navigation';
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import AuthPasswordField from '$lib/components/frameleaf/AuthPasswordField.svelte';
  import AuthPasswordQuality from '$lib/components/frameleaf/AuthPasswordQuality.svelte';
  import { preservePreferenceForPasswordChange } from '$lib/frameleaf/auth-session-preference';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { updateMyUser } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  let password = $state('');
  let passwordConfirm = $state('');
  let loading = $state(false);
  let errorMessage = $state('');
  const mismatch = $derived(passwordConfirm.length > 0 && password !== passwordConfirm);
  // The strength meter is advisory only: the server decides which passwords it accepts.
  const ready = $derived(password.length > 0 && password === passwordConfirm);

  const onSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!ready || loading) {
      return;
    }
    if (!preservePreferenceForPasswordChange()) {
      errorMessage = $t('frameleaf_auth_error_storage_session_choice');
      return;
    }
    loading = true;
    errorMessage = '';
    try {
      await updateMyUser({ userUpdateMeDto: { password } });
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
    <h1>{$t('frameleaf_auth_change_password_title')}</h1>
    <p>{$t('frameleaf_auth_change_password_body')}</p>
  </div>
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
      >{loading ? $t('frameleaf_auth_saving') : $t('frameleaf_auth_save_and_continue')}</button
    >
    <a href={Route.logout()} class="auth-link">{$t('frameleaf_auth_sign_out_instead')}</a>
  </form>
</AuthShell>
