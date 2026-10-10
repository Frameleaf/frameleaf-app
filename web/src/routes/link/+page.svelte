<script lang="ts">
  /**
   * CLD-004: the Frameleaf account site's hand-over. The address is cleared with
   * `history.replaceState` before anything else happens, so nothing in it stays in the address bar or
   * the history. A one-time link code (`?linkCode=flc_…`) is kept in session storage for Support
   * Frameleaf, which has this server redeem it. A key in the address (an old link) is never used:
   * Support Frameleaf asks for it to be pasted instead.
   *
   * FL-158: Frameleaf's return from linking an account (`/link?code=…&state=…`, recorded when the
   * link started): the account is linked here and the person lands back on Your preferences →
   * Frameleaf account. The code is dropped from the address before anything else happens.
   */
  import { goto } from '$app/navigation';
  import { takeFrameleafCallback } from '$lib/frameleaf/frameleaf-sign-in';
  import { holdLinkNotice, holdPendingLinkCode, readLinkAddress } from '$lib/frameleaf/license-relay';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { Route } from '$lib/route';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { linkFrameleafAccount } from '@frameleaf/sdk';
  import { toastManager } from '@frameleaf/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  const finishAccountLink = async (url: string) => {
    try {
      await linkFrameleafAccount({ frameleafLinkDto: { url } });
      toastManager.primary($t('frameleaf_personal_linked_toast'));
    } catch (error) {
      toastManager.danger(getServerErrorMessage(error) ?? $t('frameleaf_personal_link_failed'));
    }
    await goto(commandCenterUrl('preferences', 'frameleaf-account'), { replaceState: true });
  };

  onMount(() => {
    const href = location.href;
    history.replaceState(history.state, '', location.pathname);
    // the address is clean now: requests may carry the default referrer again (see app.html)
    document.querySelector('#link-referrer-policy')?.setAttribute('content', 'strict-origin-when-cross-origin');
    if (takeFrameleafCallback(href) === 'link') {
      void finishAccountLink(href);
      return;
    }
    const { linkCode, carriedKey, invalidLinkCode } = readLinkAddress(href);
    if (carriedKey || invalidLinkCode) {
      // an old link with the key in it is never used (and a code beside it is not trusted either); a
      // code that is not shaped like one is never sent: either way, ask for the key to be pasted
      holdLinkNotice(carriedKey ? 'key-in-link' : 'invalid-code');
      void goto(Route.buy(), { replaceState: true });
      return;
    }
    if (linkCode && holdPendingLinkCode(linkCode)) {
      void goto(Route.buy(), { replaceState: true });
      return;
    }
    void goto(Route.photos(), { replaceState: true });
  });
</script>
