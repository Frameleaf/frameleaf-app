<script lang="ts">
  /**
   * FL-157: the Frameleaf store's key relay. The key is read from the fragment, kept in session
   * storage for Support Frameleaf, and the fragment is cleared with `history.replaceState` before
   * leaving, so it never stays in the address bar or the history.
   *
   * FL-158: Frameleaf's return from linking an account (`/link?code=…&state=…`, recorded when the
   * link started): the account is linked here and the person lands back on Your preferences →
   * Frameleaf account. The code is dropped from the address before anything else happens.
   */
  import { goto } from '$app/navigation';
  import { takeFrameleafCallback } from '$lib/frameleaf/frameleaf-sign-in';
  import { holdPendingLicenseKey, parseLinkFragment } from '$lib/frameleaf/license-relay';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { Route } from '$lib/route';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { linkFrameleafAccount } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  const finishAccountLink = async (url: string) => {
    try {
      await linkFrameleafAccount({ oAuthCallbackDto: { url } });
      toastManager.primary($t('frameleaf_personal_linked_toast'));
    } catch (error) {
      toastManager.danger(getServerErrorMessage(error) ?? $t('frameleaf_personal_link_failed'));
    }
    await goto(commandCenterUrl('preferences', 'frameleaf-account'), { replaceState: true });
  };

  onMount(() => {
    const href = location.href;
    const { target, key } = parseLinkFragment(location.hash);
    history.replaceState(history.state, '', location.pathname);
    if (takeFrameleafCallback(href) === 'link') {
      void finishAccountLink(href);
      return;
    }
    if (target === 'frameleaf_license' && key) {
      holdPendingLicenseKey(key);
      void goto(Route.buy(), { replaceState: true });
      return;
    }
    void goto(Route.photos(), { replaceState: true });
  });
</script>
