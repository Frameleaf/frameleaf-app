<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiAlertCircleOutline } from '@mdi/js';
  import { goto } from '$app/navigation';
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import AuthPasswordField from '$lib/components/frameleaf/AuthPasswordField.svelte';
  import AuthPasswordQuality from '$lib/components/frameleaf/AuthPasswordQuality.svelte';
  import { passwordStrength } from '$lib/frameleaf/auth-password';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { Route } from '$lib/route';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { signUpAdmin } from '@immich/sdk';

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
      return (errorMessage = 'Enter your name.');
    }
    const address = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      return (errorMessage = 'Enter a valid email address.');
    }
    if (!passwordStrength(password).acceptable) {
      return (errorMessage = 'Choose a stronger password that meets the requirements.');
    }
    if (password !== confirmPassword) {
      return (errorMessage = "The passwords don't match.");
    }

    loading = true;
    errorMessage = '';
    try {
      await signUpAdmin({ signUpDto: { email: address, password, name: name.trim() } });
      await serverConfigManager.loadServerConfig();
      await goto(Route.login());
    } catch (error) {
      errorMessage = getServerErrorMessage(error) || 'Unable to create the admin account.';
    } finally {
      loading = false;
    }
  };
</script>

<AuthShell hero="cabin" attribution>
  <!-- The prototype's optional Back to sign in action is unavailable during first-admin setup:
       login/+page.ts redirects an uninitialized server straight back to this guarded route. -->
  <div class="auth-heading">
    <h1>Create the admin account</h1>
    <p>This account manages the server, its members and libraries.</p>
  </div>
  <form class="auth-card auth-form" onsubmit={onSubmit} novalidate>
    {#if errorMessage}<p class="auth-error" role="alert">
        <Icon icon={mdiAlertCircleOutline} size="16" /><span>{errorMessage}</span>
      </p>{/if}
    <div class="auth-field">
      <label for="admin-name">Name</label>
      <!-- svelte-ignore a11y_autofocus (first registration field) -->
      <input id="admin-name" name="name" autocomplete="name" autofocus bind:value={name} />
    </div>
    <div class="auth-field">
      <label for="admin-email">Email</label>
      <input id="admin-email" name="email" type="email" inputmode="email" autocomplete="username" bind:value={email} />
    </div>
    <AuthPasswordField
      id="admin-password"
      label="Password"
      bind:value={password}
      describedBy="admin-password-quality"
    />
    <AuthPasswordQuality id="admin-password-quality" {password} />
    <AuthPasswordField
      id="admin-password-confirm"
      label="Confirm password"
      bind:value={confirmPassword}
      invalid={mismatch}
      describedBy={mismatch ? 'admin-password-match' : undefined}
    />
    {#if mismatch}<span class="auth-field-hint" id="admin-password-match">The passwords don't match yet.</span>{/if}
    <button type="submit" class="button primary auth-submit" disabled={loading}
      >{loading ? 'Creating account…' : 'Create account'}</button
    >
  </form>
  {#snippet footer()}
    <span
      >Frameleaf builds on Immich's open-source photo library. Licences and acknowledgements are listed in About.</span
    >
  {/snippet}
</AuthShell>
