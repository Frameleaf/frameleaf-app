<script lang="ts">
  /**
   * Sign-in provider, from the `oauth` section of the design template's `PersonalAccess`: connect
   * or disconnect this account's provider sign-in, and open the provider's account page when the
   * administrator configured its address. Connecting goes through the provider and comes back to
   * this page, which then links the account (`linkOAuthAccount`); a failed link says so here.
   * Disconnecting asks first, and warns when password sign-in is off.
   *
   * Drawn as one row of "How you sign in" (the approved prototype's `MySignIn`, which folds the
   * provider into the page's "Ways into your account" list); the page renders it inside its ItemList.
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
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import { mdiAccountKeyOutline } from '@mdi/js';

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

<Item
  icon={mdiAccountKeyOutline}
  name={serverConfigManager.value.oauthButtonText || $t('frameleaf_access_provider_title')}
  detail={$t('frameleaf_how_provider_detail')}
  off={!linked}
  tone={error ? 'warn' : linked ? 'good' : 'off'}
  status={linking
    ? $t('frameleaf_access_provider_connecting')
    : linked
      ? $t('frameleaf_how_provider_connected')
      : $t('frameleaf_how_provider_not_connected')}
  note={error || (linked ? undefined : $t('frameleaf_access_provider_not_linked'))}
>
  {#snippet action()}
    <div class="actions">
      {#if linked && managementLink}
        <a class="manage" href={managementLink} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">
          {$t('frameleaf_access_provider_manage')}
        </a>
      {/if}
      {#if linked}
        <Button disabled={working || linking} onclick={disconnect}>{$t('frameleaf_how_disconnect')}</Button>
      {:else}
        <Button disabled={working || linking} onclick={connect}>{$t('frameleaf_access_provider_connect')}</Button>
      {/if}
    </div>
  {/snippet}
</Item>

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--fl-space-2);
  }
  .manage {
    display: inline-flex;
    align-items: center;
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    text-decoration: none;
  }
</style>
