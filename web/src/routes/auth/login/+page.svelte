<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiAlertCircleOutline, mdiInformationOutline, mdiShieldAccountOutline, mdiServerOutline } from '@mdi/js';
  import { goto } from '$app/navigation';
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import AuthPasswordField from '$lib/components/frameleaf/AuthPasswordField.svelte';
  import {
    clearRememberMePreference,
    clearOAuthContinue,
    getForcedPasswordContinue,
    getOAuthContinue,
    preserveOAuthContinueForPasswordChange,
    rememberMePreference,
    setOAuthContinue,
    setRememberMePreference,
  } from '$lib/frameleaf/auth-session-preference';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { Route } from '$lib/route';
  import { oauth } from '$lib/utils';
  import { getServerErrorMessage, handleError } from '$lib/utils/handle-error';
  import { login, type LoginResponseDto } from '@immich/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  let errorMessage = $state('');
  let email = $state('');
  let password = $state('');
  let oauthError = $state('');
  let loading = $state(false);
  let oauthLoading = $state(true);
  let forgot = $state(false);
  let rememberMe = $state(true);

  const serverConfig = $derived(serverConfigManager.value);
  const publicConfig = $derived(data.publicConfig);

  const onSuccess = async (user: LoginResponseDto) => {
    await goto(
      oauth.isCallback(location) ? getOAuthContinue(data.continueUrl) : getForcedPasswordContinue(data.continueUrl),
      {
        invalidateAll: true,
      },
    );
    clearRememberMePreference();
    eventManager.emit('AuthLogin', user);
  };

  const onFirstLogin = () => goto(Route.changePassword());
  const onOnboarding = () => goto(Route.onboarding());

  onMount(async () => {
    rememberMe = rememberMePreference();
    if (!publicConfig.oauth.enabled) {
      oauthLoading = false;
      return;
    }

    if (oauth.isCallback(location)) {
      try {
        const user = await oauth.login(location, rememberMe);
        if (!user.isAdmin && user.shouldChangePassword) {
          preserveOAuthContinueForPasswordChange();
          await onFirstLogin();
          return;
        }
        if (!user.isOnboarded) {
          await onOnboarding();
          return;
        }
        await onSuccess(user);
        return;
      } catch (error) {
        console.error('Error [login-form] [oauth.callback]', error);
        clearOAuthContinue();
        oauthError = getServerErrorMessage(error) || $t('errors.unable_to_complete_oauth_login');
        oauthLoading = false;
        return;
      }
    }

    try {
      if (
        (publicConfig.oauth.autoLaunch && !oauth.isAutoLaunchDisabled(location)) ||
        oauth.isAutoLaunchEnabled(location)
      ) {
        const continueUrl = getForcedPasswordContinue(data.continueUrl);
        if (!setRememberMePreference(rememberMe) || !setOAuthContinue(continueUrl)) {
          oauthError = 'Allow tab storage in this browser to complete sign in.';
          oauthLoading = false;
          return;
        }
        await goto(Route.login({ continue: String(continueUrl), autoLaunch: 0 }), { replaceState: true });
        await oauth.authorize(location);
        return;
      }
    } catch (error) {
      handleError(error, $t('errors.unable_to_connect'));
    }
    oauthLoading = false;
  });

  const handleLogin = async () => {
    if (loading) {
      return;
    }
    const address = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      errorMessage = 'Enter a valid email address.';
      return;
    }
    if (!password) {
      errorMessage = 'Enter your password.';
      return;
    }
    if (!setRememberMePreference(rememberMe)) {
      errorMessage = 'Allow tab storage in this browser to keep this session choice.';
      return;
    }
    try {
      errorMessage = '';
      loading = true;
      const user = await login({ loginCredentialDto: { email: address, password, rememberMe } });
      if (user.isAdmin && !serverConfig.isOnboarded) {
        await onOnboarding();
        return;
      }
      if (!user.isAdmin && user.shouldChangePassword) {
        await onFirstLogin();
        return;
      }
      if (!user.isOnboarded) {
        await onOnboarding();
        return;
      }
      await onSuccess(user);
    } catch (error) {
      errorMessage = getServerErrorMessage(error) || $t('errors.incorrect_email_or_password');
      password = '';
    } finally {
      loading = false;
    }
  };

  const handleOAuthLogin = async () => {
    oauthLoading = true;
    oauthError = '';
    if (!setRememberMePreference(rememberMe) || !setOAuthContinue(data.continueUrl)) {
      oauthError = 'Allow tab storage in this browser to complete sign in.';
      oauthLoading = false;
      return;
    }
    const success = await oauth.authorize(location);
    if (!success) {
      clearOAuthContinue();
      oauthLoading = false;
      oauthError = $t('errors.unable_to_login_with_oauth');
    }
  };

  const onsubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    await handleLogin();
  };
</script>

<AuthShell hero="summit" attribution>
  <div class="auth-heading">
    <h1>Welcome back</h1>
    <p>Sign in to your photo library.</p>
  </div>

  {#if publicConfig.server.loginPageMessage}
    <!-- The server's admin-configured login message intentionally supports markup. -->
    <!-- eslint-disable svelte/no-at-html-tags -->
    <div class="auth-info">
      {@html publicConfig.server.loginPageMessage}
    </div>
    <!-- eslint-enable svelte/no-at-html-tags -->
  {/if}

  {#if oauthLoading}
    <p class="auth-info" role="status">
      <Icon icon={mdiInformationOutline} size="16" /><span>Connecting to your sign-in provider…</span>
    </p>
  {:else}
    <form class="auth-card auth-form" {onsubmit} novalidate>
      {#if publicConfig.passwordLogin.enabled}
        {#if errorMessage}<p class="auth-error" role="alert">
            <Icon icon={mdiAlertCircleOutline} size="16" /><span>{errorMessage}</span>
          </p>{/if}
        <div class="auth-field">
          <label for="auth-email">Email</label>
          <!-- svelte-ignore a11y_autofocus (first sign-in field) -->
          <input
            id="auth-email"
            name="email"
            type="email"
            inputmode="email"
            autocomplete="username"
            autofocus
            bind:value={email}
            aria-invalid={!!errorMessage || undefined}
            placeholder="you@example.test"
          />
        </div>
        <AuthPasswordField
          id="auth-password"
          label="Password"
          autocomplete="current-password"
          bind:value={password}
          invalid={!!errorMessage}
        />
        <div class="auth-row">
          <label class="auth-check"><input type="checkbox" bind:checked={rememberMe} />Keep me signed in</label>
          <button type="button" class="auth-link" aria-expanded={forgot} onclick={() => (forgot = !forgot)}
            >Forgot your password?</button
          >
        </div>
        {#if forgot}
          <p class="auth-info">
            <Icon icon={mdiInformationOutline} size="16" /><span>
              Passwords are reset by your server administrator. Ask them for a temporary password from Users, then sign
              in and choose your own.
            </span>
          </p>
        {/if}
        <button type="submit" class="button primary auth-submit" disabled={loading}
          >{loading ? 'Signing in…' : 'Sign in'}</button
        >
      {/if}

      {#if publicConfig.oauth.enabled}
        {#if !publicConfig.passwordLogin.enabled}
          <label class="auth-check"><input type="checkbox" bind:checked={rememberMe} />Keep me signed in</label>
        {/if}
        {#if publicConfig.passwordLogin.enabled}<div class="auth-divider" aria-hidden="true">or</div>{/if}
        {#if oauthError}<p class="auth-error" role="alert">
            <Icon icon={mdiAlertCircleOutline} size="16" /><span>{oauthError}</span>
          </p>{/if}
        <button type="button" class="button auth-oauth" disabled={loading || oauthLoading} onclick={handleOAuthLogin}
          ><Icon icon={mdiShieldAccountOutline} size="20" />{publicConfig.oauth.buttonText}</button
        >
      {/if}
      {#if !publicConfig.passwordLogin.enabled && !publicConfig.oauth.enabled}
        <p class="auth-error" role="alert">
          <Icon icon={mdiAlertCircleOutline} size="16" /><span>{$t('login_has_been_disabled')}</span>
        </p>
      {/if}
    </form>
  {/if}

  <div class="auth-server">
    <Icon icon={mdiServerOutline} size="16" /><span>Server</span><code>{data.serverUrl}</code>
  </div>
</AuthShell>
