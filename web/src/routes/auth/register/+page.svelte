<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiAlertCircleOutline } from '@mdi/js';
  import { goto } from '$app/navigation';
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import AuthPasswordField from '$lib/components/frameleaf/AuthPasswordField.svelte';
  import AuthPasswordQuality from '$lib/components/frameleaf/AuthPasswordQuality.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { Route } from '$lib/route';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { signUpAdmin } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  let email = $state('');
  let password = $state('');
  let confirmPassword = $state('');
  let name = $state('');
  let loading = $state(false);
  let errorMessage = $state('');
  const mismatch = $derived(confirmPassword.length > 0 && password !== confirmPassword);

  const onSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (loading) {
      return;
    }
    if (!name.trim()) {
      return (errorMessage = $t('frameleaf_auth_error_name_required'));
    }
    // The server validates the address and the password; the strength meter is advisory only.
    const address = email.trim();
    if (!address) {
      return (errorMessage = $t('frameleaf_auth_error_email_required'));
    }
    if (!password) {
      return (errorMessage = $t('frameleaf_auth_error_password_required'));
    }
    if (password !== confirmPassword) {
      return (errorMessage = $t('frameleaf_auth_passwords_mismatch'));
    }

    loading = true;
    errorMessage = '';
    try {
      await signUpAdmin({ signUpDto: { email: address, password, name: name.trim() } });
      await serverConfigManager.loadServerConfig();
      await goto(Route.login());
    } catch (error) {
      errorMessage = getServerErrorMessage(error) || $t('frameleaf_auth_register_failed');
    } finally {
      loading = false;
    }
  };
</script>

<AuthShell hero="cabin" attribution>
  <!-- The prototype's optional Back to sign in action is unavailable during first-admin setup:
       login/+page.ts redirects an uninitialized server straight back to this guarded route. -->
  <div class="auth-heading">
    <h1>{$t('frameleaf_auth_register_title')}</h1>
    <p>{$t('frameleaf_auth_register_body')}</p>
  </div>
  <form class="auth-card auth-form" onsubmit={onSubmit} novalidate>
    {#if errorMessage}<p class="auth-error" role="alert">
        <Icon icon={mdiAlertCircleOutline} size="16" /><span>{errorMessage}</span>
      </p>{/if}
    <div class="auth-field">
      <label for="admin-name">{$t('frameleaf_auth_name')}</label>
      <!-- svelte-ignore a11y_autofocus (first registration field) -->
      <input id="admin-name" name="name" autocomplete="name" autofocus bind:value={name} />
    </div>
    <div class="auth-field">
      <label for="admin-email">{$t('frameleaf_auth_email')}</label>
      <input id="admin-email" name="email" type="email" inputmode="email" autocomplete="username" bind:value={email} />
    </div>
    <AuthPasswordField
      id="admin-password"
      label={$t('frameleaf_auth_password')}
      bind:value={password}
      describedBy="admin-password-quality"
    />
    <AuthPasswordQuality id="admin-password-quality" {password} />
    <AuthPasswordField
      id="admin-password-confirm"
      label={$t('frameleaf_auth_confirm_password')}
      bind:value={confirmPassword}
      invalid={mismatch}
      describedBy={mismatch ? 'admin-password-match' : undefined}
    />
    {#if mismatch}<span class="auth-field-hint" id="admin-password-match"
        >{$t('frameleaf_auth_passwords_mismatch_hint')}</span
      >{/if}
    <button type="submit" class="button primary auth-submit" disabled={loading}
      >{loading ? $t('frameleaf_auth_creating_account') : $t('frameleaf_auth_create_account')}</button
    >
  </form>
  {#snippet footer()}
    <span>{$t('frameleaf_auth_register_footer')}</span>
  {/snippet}
</AuthShell>
