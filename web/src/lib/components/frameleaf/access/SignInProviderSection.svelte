<script lang="ts">
  /**
   * Sign-in provider, from the `oauth` section of the design template's `PersonalAccess`: connect
   * or disconnect this account's provider sign-in, and open the provider's account page when the
   * administrator configured its address. Connecting goes through the provider and comes back to
   * this page, which then links the account (`linkOAuthAccount`); a failed link says so here.
   * Disconnecting asks first, and warns when password sign-in is off.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { providerAccountLink } from '$lib/frameleaf/personal-access';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { oauth } from '$lib/utils';
  import { getServerErrorMessage, handleError } from '$lib/utils/handle-error';
  import { toastManager } from '@frameleaf/ui';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import './access.css';

  let alive = true;
  const isCurrentSession = authManager.captureSession();
  const isCurrent = () => alive && isCurrentSession();
  onDestroy(() => {
    alive = false;
  });

  let linking = $state(false);
  let working = $state(false);
  let error = $state('');

  const linked = $derived(!!authManager.user.oauthId);
  const managementLink = $derived(providerAccountLink(serverConfigManager.value.oauthAccountManagementUrl));

  onMount(async () => {
    if (!oauth.isCallback(location)) {
      return;
    }

    linking = true;
    try {
      const updated = await oauth.link(location);
      if (!isCurrent()) {
        return;
      }
      authManager.setUser(updated);
      toastManager.primary($t('frameleaf_access_provider_connected'));
    } catch (error_) {
      if (!isCurrent()) {
        return;
      }
      error = getServerErrorMessage(error_) ?? $t('frameleaf_access_provider_connect_failed');
    } finally {
      linking = false;
      if (isCurrent()) {
        await goto('?open=oauth', { replaceState: true });
      }
    }
  });

  const connect = async () => {
    if (!isCurrent()) {
      return;
    }
    error = '';
    working = true;
    try {
      await oauth.authorize(location, isCurrent);
    } finally {
      if (isCurrent()) {
        working = false;
      }
    }
  };

  const disconnect = async () => {
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_access_provider_disconnect_title'),
      prompt: featureFlagsManager.value.passwordLogin
        ? $t('frameleaf_access_provider_disconnect_prompt')
        : $t('frameleaf_access_provider_disconnect_no_password_prompt'),
      confirmText: $t('frameleaf_access_provider_disconnect'),
      danger: true,
    });
    if (!confirmed || !isCurrent()) {
      return;
    }

    working = true;
    error = '';
    try {
      const updated = await oauth.unlink();
      if (!isCurrent()) {
        return;
      }
      authManager.setUser(updated);
      toastManager.primary($t('frameleaf_access_provider_disconnected'));
    } catch (error_) {
      if (!isCurrent()) {
        return;
      }
      handleError(error_, $t('errors.unable_to_unlink_account'));
    } finally {
      if (isCurrent()) {
        working = false;
      }
    }
  };
</script>

<section class="fl-access-section" aria-labelledby="fl-access-provider">
  <div class="fl-access-head">
    <div>
      <h3 id="fl-access-provider">{$t('frameleaf_access_provider_title')}</h3>
      <p>
        {linking
          ? $t('frameleaf_access_provider_connecting')
          : linked
            ? $t('frameleaf_access_provider_linked')
            : $t('frameleaf_access_provider_not_linked')}
      </p>
    </div>
    {#if linked}
      <Button disabled={working || linking} onclick={disconnect}>{$t('frameleaf_access_provider_disconnect')}</Button>
    {:else}
      <Button disabled={working || linking} onclick={connect}>{$t('frameleaf_access_provider_connect')}</Button>
    {/if}
  </div>
  {#if error}
    <p class="fl-access-error" role="alert">{error}</p>
  {/if}
  <div>
    {#if managementLink}
      <a class="manage" href={managementLink} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">
        {$t('frameleaf_access_provider_manage')}
      </a>
    {:else}
      <Button disabled>{$t('frameleaf_access_provider_manage')}</Button>
      <p class="fl-access-footnote">{$t('frameleaf_access_provider_manage_unset')}</p>
    {/if}
  </div>
</section>

<style>
  .manage {
    display: inline-flex;
    align-items: center;
    padding: 0.4375rem 0.6875rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    text-decoration: none;
  }
</style>
