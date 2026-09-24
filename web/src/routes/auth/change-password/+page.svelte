<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiAlertCircleOutline } from '@mdi/js';
  import { goto } from '$app/navigation';
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import AuthPasswordField from '$lib/components/frameleaf/AuthPasswordField.svelte';
  import AuthPasswordQuality from '$lib/components/frameleaf/AuthPasswordQuality.svelte';
  import { passwordStrength } from '$lib/frameleaf/auth-password';
  import { preservePreferenceForPasswordChange } from '$lib/frameleaf/auth-session-preference';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { updateMyUser } from '@immich/sdk';

  let password = $state('');
  let passwordConfirm = $state('');
  let loading = $state(false);
  let errorMessage = $state('');
  const mismatch = $derived(passwordConfirm.length > 0 && password !== passwordConfirm);
  const ready = $derived(!!passwordStrength(password).acceptable && password === passwordConfirm);

  const onSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!ready || loading) {
      return;
    }
    if (!preservePreferenceForPasswordChange()) {
      errorMessage = 'Allow tab storage in this browser to keep your session choice.';
      return;
    }
    loading = true;
    errorMessage = '';
    try {
      await updateMyUser({ userUpdateMeDto: { password } });
      await goto(Route.logout());
    } catch (error) {
      errorMessage = getServerErrorMessage(error) || 'Unable to save your password.';
    } finally {
      loading = false;
    }
  };
</script>

<AuthShell attribution>
  <div class="auth-heading">
    <h1>Choose a new password</h1>
    <p>Your administrator asked you to set a new password before you continue.</p>
  </div>
  <form class="auth-card auth-form" onsubmit={onSubmit} novalidate>
    {#if errorMessage}<p class="auth-error" role="alert">
        <Icon icon={mdiAlertCircleOutline} size="16" /><span>{errorMessage}</span>
      </p>{/if}
    <div class="auth-field">
      <label for="account-email">Account</label><input
        id="account-email"
        value={authManager.user.email}
        readonly
        autocomplete="username"
      />
    </div>
    <AuthPasswordField
      id="new-password"
      label="New password"
      autofocus
      bind:value={password}
      describedBy="new-password-quality"
    />
    <AuthPasswordQuality id="new-password-quality" {password} />
    <AuthPasswordField
      id="confirm-password"
      label="Confirm new password"
      bind:value={passwordConfirm}
      invalid={mismatch}
      describedBy={mismatch ? 'new-password-match' : undefined}
    />
    {#if mismatch}<span class="auth-field-hint" id="new-password-match">The passwords don't match yet.</span>{/if}
    <button type="submit" class="button primary auth-submit" disabled={!ready || loading}
      >{loading ? 'Saving…' : 'Save and continue'}</button
    >
    <a href={Route.logout()} class="auth-link">Sign out instead</a>
  </form>
</AuthShell>
