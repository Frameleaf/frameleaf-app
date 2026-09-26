<script lang="ts">
  import { Icon } from '@immich/ui';
  import {
    mdiAlertCircleOutline,
    mdiEarth,
    mdiInformationOutline,
    mdiLanConnect,
    mdiServerOutline,
    mdiShieldAccountOutline,
  } from '@mdi/js';
  import { goto } from '$app/navigation';
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import AuthPasswordField from '$lib/components/frameleaf/AuthPasswordField.svelte';
  import Logo from '$lib/components/frameleaf/Logo.svelte';
  import {
    clearRememberMePreference,
    clearOAuthContinue,
    getOAuthContinue,
    rememberMePreference,
    restoreOAuthRequest,
    setOAuthContinue,
    setRememberMePreference,
  } from '$lib/frameleaf/auth-session-preference';
  import { startFrameleaf, takeFrameleafCallback } from '$lib/frameleaf/frameleaf-sign-in';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { Route } from '$lib/route';
  import { oauth } from '$lib/utils';
  import { getServerErrorMessage, handleError } from '$lib/utils/handle-error';
  import { finishFrameleafSignIn, login, type LoginResponseDto } from '@immich/sdk';
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

  // FL-158: Sign in with Frameleaf. Through remote access it is the only way in; at home it is offered
  // when the administrator turned "Show Sign in with Frameleaf at home" on.
  const frameleaf = $derived(publicConfig.frameleaf);
  const relayOnly = $derived(frameleaf.signInRequired);
  const frameleafButtonText = $derived(publicConfig.frameleafCloud.signIn.buttonText);
  const showFrameleafAtHome = $derived(
    frameleaf.signInAvailable && publicConfig.frameleafCloud.signIn.showOnLocalLogin,
  );
  let frameleafLoading = $state(false);
  let frameleafError = $state('');
  let stayRemote = $state(false);
  const localHost = $derived.by(() => {
    try {
      return frameleaf.localUrl ? new URL(frameleaf.localUrl).host : '';
    } catch {
      return '';
    }
  });

  const onSuccess = async (user: LoginResponseDto) => {
    await goto(oauth.isCallback(location) ? getOAuthContinue(data.continueUrl) : data.continueUrl, {
      invalidateAll: true,
    });
    clearRememberMePreference();
    eventManager.emit('AuthLogin', user);
  };

  const onFirstLogin = () => goto(Route.changePassword());
  const onOnboarding = () => goto(Route.onboarding());

  const finishUser = async (user: LoginResponseDto) => {
    if (!user.isOnboarded) {
      await onOnboarding();
      return;
    }
    await onSuccess(user);
  };

  onMount(async () => {
    const frameleafCallback = oauth.isCallback(location) ? takeFrameleafCallback(location.href) : null;
    if (oauth.isCallback(location)) {
      // FL-80: a callback that lands in another tab takes the choices its sign-in started with
      restoreOAuthRequest(location.href);
    }
    rememberMe = rememberMePreference();
    if (frameleafCallback === 'sign-in') {
      try {
        await finishUser(await finishFrameleafSignIn({ oAuthCallbackDto: { url: location.href, rememberMe } }));
        return;
      } catch (error) {
        clearOAuthContinue();
        frameleafError = getServerErrorMessage(error) || $t('frameleaf_auth_frameleaf_failed');
        oauthLoading = false;
        return;
      }
    }
    // the administrator's own provider is not offered through remote access
    if (!publicConfig.oauth.enabled || relayOnly) {
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

  const handleFrameleafLogin = async () => {
    frameleafLoading = true;
    frameleafError = '';
    if (!setRememberMePreference(rememberMe) || !setOAuthContinue(data.continueUrl)) {
      frameleafError = $t('frameleaf_auth_error_storage_sign_in');
      frameleafLoading = false;
      return;
    }
    try {
      await startFrameleaf('sign-in', location);
    } catch (error) {
      clearOAuthContinue();
      frameleafLoading = false;
      frameleafError = getServerErrorMessage(error) || $t('frameleaf_auth_frameleaf_failed');
    }
  };

  const continueAtHome = () => {
    if (frameleaf.localUrl) {
      location.assign(new URL(Route.login(), frameleaf.localUrl).href);
    }
  };

  const onsubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    await handleLogin();
  };
</script>

{#snippet frameleafButton(autofocus: boolean)}
  {#if frameleafError}<p class="auth-error" role="alert">
      <Icon icon={mdiAlertCircleOutline} size="16" /><span>{frameleafError}</span>
    </p>{/if}
  <!-- svelte-ignore a11y_autofocus (the only sign-in action through remote access) -->
  <button
    type="button"
    class="button auth-frameleaf"
    {autofocus}
    disabled={loading || frameleafLoading}
    onclick={handleFrameleafLogin}
    ><Logo variant="icon" size="tiny" decorative />{frameleafLoading
      ? $t('frameleaf_auth_opening_frameleaf')
      : frameleafButtonText}</button
  >
{/snippet}

<AuthShell hero="summit">
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
  {:else if relayOnly}
    {#if frameleaf.sameNetwork && localHost && !stayRemote}
      <div class="auth-lan" role="status">
        <Icon icon={mdiLanConnect} size="18" />
        <div>
          <strong>{$t('frameleaf_auth_same_network_title')}</strong>
          <span>{$t('frameleaf_auth_same_network_body')}</span>
        </div>
        <div class="auth-lan-actions">
          <button type="button" class="button primary" onclick={continueAtHome}
            >{$t('frameleaf_auth_continue_on', { values: { host: localHost } })}</button
          >
          <button type="button" class="auth-link" onclick={() => (stayRemote = true)}
            >{$t('frameleaf_auth_stay_remote')}</button
          >
        </div>
      </div>
    {/if}
    <div class="auth-card auth-form">
      <p class="auth-info">
        <Icon icon={mdiInformationOutline} size="16" /><span>{$t('frameleaf_auth_relay_note')}</span>
      </p>
      {#if frameleaf.signInAvailable}
        {@render frameleafButton(true)}
        <label class="auth-check"
          ><input type="checkbox" bind:checked={rememberMe} />{$t('frameleaf_auth_keep_signed_in')}</label
        >
      {:else}
        <p class="auth-error" role="alert">
          <Icon icon={mdiAlertCircleOutline} size="16" /><span>{$t('frameleaf_auth_frameleaf_unavailable')}</span>
        </p>
      {/if}
    </div>
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

      {#if publicConfig.oauth.enabled || showFrameleafAtHome}
        {#if !publicConfig.passwordLogin.enabled}
          <label class="auth-check"
            ><input type="checkbox" bind:checked={rememberMe} />{$t('frameleaf_auth_keep_signed_in')}</label
          >
        {:else}
          <div class="auth-divider" aria-hidden="true">{$t('frameleaf_auth_or')}</div>
        {/if}
        {#if showFrameleafAtHome}
          {@render frameleafButton(false)}
        {/if}
        {#if publicConfig.oauth.enabled}
          {#if oauthError}<p class="auth-error" role="alert">
              <Icon icon={mdiAlertCircleOutline} size="16" /><span>{oauthError}</span>
            </p>{/if}
          <button type="button" class="button auth-oauth" disabled={loading || oauthLoading} onclick={handleOAuthLogin}
            ><Icon icon={mdiShieldAccountOutline} size="20" />{publicConfig.oauth.buttonText}</button
          >
        {/if}
        {#if showFrameleafAtHome}
          <p class="auth-note auth-frameleaf-note">{$t('frameleaf_auth_frameleaf_optional')}</p>
        {/if}
      {/if}
      {#if !publicConfig.passwordLogin.enabled && !publicConfig.oauth.enabled && !showFrameleafAtHome}
        <p class="auth-error" role="alert">
          <Icon icon={mdiAlertCircleOutline} size="16" /><span>{$t('login_has_been_disabled')}</span>
        </p>
      {/if}
    </form>
  {/if}

  {#if relayOnly}
    <div class="auth-server">
      <Icon icon={mdiEarth} size="16" /><span>{$t('frameleaf_auth_remote_access')}</span><code
        >{frameleaf.relayHost ?? new URL(data.serverUrl).host}</code
      >
    </div>
  {:else}
    <div class="auth-server">
      <Icon icon={mdiServerOutline} size="16" /><span>{$t('frameleaf_auth_server')}</span><code>{data.serverUrl}</code>
    </div>
  {/if}
</AuthShell>
