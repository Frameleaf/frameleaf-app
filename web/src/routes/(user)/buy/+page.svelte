<script lang="ts">
  /**
   * Support Frameleaf (FL-157) folded into Your Frameleaf Cloud (FL-544). The address stays, so
   * older links and the account site's link codes still work: a link code from the Frameleaf
   * account site (held in session storage by `+page.ts`, never read from this address, CLD-004) is
   * redeemed here, then an administrator goes on to Settings → Frameleaf Cloud → Your Frameleaf
   * Cloud and anyone else to their own Supporter settings.
   */
  import { goto } from '$app/navigation';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { redeemLicenseLinkCode } from '@frameleaf/sdk';
  import { toastManager } from '@frameleaf/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const destination = () =>
    authManager.user.isAdmin
      ? commandCenterUrl('cloud', 'cloud-plan')
      : commandCenterUrl('preferences', 'user-purchase-settings');

  onMount(async () => {
    if (data.linkNotice) {
      toastManager.danger(
        data.linkNotice === 'key-in-link' ? $t('frameleaf_buy_key_in_link') : $t('frameleaf_buy_link_code_invalid'),
      );
    }
    if (data.linkCode) {
      try {
        await redeemLicenseLinkCode({ licenseLinkCodeDto: { code: data.linkCode } });
        toastManager.primary($t('frameleaf_buy_activated'));
      } catch (error) {
        toastManager.danger(getServerErrorMessage(error) ?? $t('frameleaf_buy_link_failed'));
      }
    }
    await goto(destination(), { replaceState: true });
  });
</script>

<svelte:head>
  <title>{data.meta.title}</title>
</svelte:head>
