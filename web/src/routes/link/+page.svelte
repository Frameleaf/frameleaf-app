<script lang="ts">
  /**
   * FL-157: the Frameleaf store's key relay. The key is read from the fragment, kept in session
   * storage for Support Frameleaf, and the fragment is cleared with `history.replaceState` before
   * leaving, so it never stays in the address bar or the history.
   */
  import { goto } from '$app/navigation';
  import { holdPendingLicenseKey, parseLinkFragment } from '$lib/frameleaf/license-relay';
  import { Route } from '$lib/route';
  import { onMount } from 'svelte';

  onMount(() => {
    const { target, key } = parseLinkFragment(location.hash);
    history.replaceState(history.state, '', location.pathname);
    if (target === 'frameleaf_license' && key) {
      holdPendingLicenseKey(key);
      void goto(Route.buy(), { replaceState: true });
      return;
    }
    void goto(Route.photos(), { replaceState: true });
  });
</script>
