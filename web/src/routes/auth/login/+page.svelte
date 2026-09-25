<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiAlertCircleOutline, mdiInformationOutline, mdiShieldAccountOutline, mdiServerOutline } from '@mdi/js';
  import { goto } from '$app/navigation';
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import AuthPasswordField from '$lib/components/frameleaf/AuthPasswordField.svelte';
  import {
    clearRememberMePreference,
    clearOAuthContinue,
    getOAuthContinue,
    rememberMePreference,
    restoreOAuthRequest,
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
    await goto(oauth.isCallback(location) ? getOAuthContinue(data.continueUrl) : data.continueUrl, {
      invalidateAll: true,
    });
    clearRememberMePreference();
    eventManager.emit('AuthLogin', user);
  };

  const onFirstLogin = () => goto(Route.changePassword());
  const onOnboarding = () => goto(Route.onboarding());

  onMount(async () => {
    if (oauth.isCallback(location)) {
      // FL-80: a callback that lands in another tab takes the choices its sign-in started with
      restoreOAuthRequest(location.href);
    }
    rememberMe = rememberMePreference();
    if (!publicConfig.oauth.enabled) {
      oauthLoading = false;
      return;
    }

    if (oauth.isCallback(location)) {
      try {
        const user = await oauth.login(location, rememberMe);
        // Upstream behaviour: an OAuth user is never sent to the forced password change.
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
        const continueUrl = data.continueUrl;
        if (!setRememberMePreference(rememberMe) || !setOAuthContinue(continueUrl)) {
          oauthError = $t('frameleaf_auth_error_storage_sign_in');
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
    // The server validates the address (it accepts single-label hosts such as admin@localhost).
    const address = email.trim();
    if (!address) {
      errorMessage = $t('frameleaf_auth_error_email_required');
      return;
    }
    if (!password) {
      errorMessage = $t('frameleaf_auth_error_password_required');
      return;
    }
    if (!setRememberMePreference(rememberMe)) {
      errorMessage = $t('frameleaf_auth_error_storage_session_choice');
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
      oauthError = $t('frameleaf_auth_error_storage_sign_in');
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
    <h1>{$t('frameleaf_auth_welcome_title')}</h1>
    <p>{$t('frameleaf_auth_welcome_body')}</p>
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
      <Icon icon={mdiInformationOutline} size="16" /><span>{$t('frameleaf_auth_oauth_connecting')}</span>
    </p>
  {:else}
    <form class="auth-card auth-form" {onsubmit} novalidate>
      {#if publicConfig.passwordLogin.enabled}
        {#if errorMessage}<p class="auth-error" role="alert">
            <Icon icon={mdiAlertCircleOutline} size="16" /><span>{errorMessage}</span>
          </p>{/if}
        <div class="auth-field">
          <label for="auth-email">{$t('frameleaf_auth_email')}</label>
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
            placeholder={$t('frameleaf_auth_email_placeholder')}
          />
        </div>
        <AuthPasswordField
          id="auth-password"
          label={$t('frameleaf_auth_password')}
          autocomplete="current-password"
          bind:value={password}
          invalid={!!errorMessage}
        />
        <div class="auth-row">
          <label class="auth-check"
            ><input type="checkbox" bind:checked={rememberMe} />{$t('frameleaf_auth_keep_signed_in')}</label
          >
          <button type="button" class="auth-link" aria-expanded={forgot} onclick={() => (forgot = !forgot)}
            >{$t('frameleaf_auth_forgot_password')}</button
          >
        </div>
        {#if forgot}
          <p class="auth-info">
            <Icon icon={mdiInformationOutline} size="16" /><span>{$t('frameleaf_auth_forgot_password_help')}</span>
          </p>
        {/if}
        <button type="submit" class="button primary auth-submit" disabled={loading}
          >{loading ? $t('frameleaf_auth_signing_in') : $t('frameleaf_auth_sign_in')}</button
        >
      {/if}

      {#if publicConfig.oauth.enabled}
        {#if !publicConfig.passwordLogin.enabled}
          <label class="auth-check"
            ><input type="checkbox" bind:checked={rememberMe} />{$t('frameleaf_auth_keep_signed_in')}</label
          >
        {/if}
        {#if publicConfig.passwordLogin.enabled}<div class="auth-divider" aria-hidden="true">
            {$t('frameleaf_auth_or')}
          </div>{/if}
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
    <Icon icon={mdiServerOutline} size="16" /><span>{$t('frameleaf_auth_server')}</span><code>{data.serverUrl}</code>
  </div>
</AuthShell>
