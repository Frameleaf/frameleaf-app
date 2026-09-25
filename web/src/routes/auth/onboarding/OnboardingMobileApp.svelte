<script lang="ts">
  /**
   * Onboarding → Get the mobile app (FL-80 ON-1, O-12): the prototype's step
   * (`AuthScreens.jsx:1111-1147`) — this server's address to enter in the app and store-style
   * choices. The prototype's App Store and Google Play tiles are store links only when the operator
   * configured them (FL-135: `ios.url` from the iOS store setting, `android.storeUrl` from
   * FRAMELEAF_ANDROID_STORE_URL, both validated https on the server); absent, they are hidden and
   * never fall back to another product's listing. Frameleaf's signed releases (FL-82) stay offered
   * through the existing application setup (downloads, or Obtainium) in a dialog; onboarding
   * continues afterwards.
   */
  import ApplicationSetup from '$lib/components/frameleaf/ApplicationSetup.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { getAppReleases, type ServerAppReleasesResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAndroid, mdiApple, mdiCellphoneArrowDownVariant, mdiOpenInNew, mdiPackageVariant } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  let releases = $state<ServerAppReleasesResponseDto | null>(null);
  onMount(async () => {
    try {
      releases = await getAppReleases();
    } catch {
      // without an answer no store is offered; the signed-release choices still work
      releases = null;
    }
  });

  /** Only an https destination is ever linked (the server validates too). */
  const httpsOnly = (url: string | undefined) => {
    try {
      return url && new URL(url).protocol === 'https:' ? url : undefined;
    } catch {
      return undefined;
    }
  };

  const isGooglePlay = (url: string | undefined) => {
    try {
      return !!url && new URL(url).hostname === 'play.google.com';
    } catch {
      return false;
    }
  };

  type StoreLink = { key: string; icon: string; label: Translations; hint: Translations; href?: string };
  const stores = $derived.by(() => {
    const all: StoreLink[] = [
      {
        key: 'ios',
        icon: mdiApple,
        label: 'frameleaf_onboarding_mobile_app_store',
        hint: 'frameleaf_onboarding_mobile_app_store_hint',
        href: releases?.ios.available ? httpsOnly(releases.ios.url) : undefined,
      },
      {
        key: 'android',
        icon: mdiAndroid,
        // The prototype's "Google Play"; the operator's listing may be another store (F-Droid…).
        label: isGooglePlay(releases?.android.storeUrl)
          ? 'frameleaf_onboarding_mobile_google_play'
          : 'frameleaf_onboarding_mobile_android_store',
        hint: 'frameleaf_onboarding_mobile_google_play_hint',
        href: httpsOnly(releases?.android.storeUrl),
      },
    ];
    return all.filter((store) => !!store.href);
  });

  let setup = $state<'downloads' | 'obtainium' | null>(null);
  let open = $state(false);
  const show = (tool: 'downloads' | 'obtainium') => {
    setup = tool;
    open = true;
  };

  const choices = [
    {
      tool: 'downloads',
      icon: mdiCellphoneArrowDownVariant,
      label: 'library_care_tool_downloads',
      hint: 'frameleaf_onboarding_mobile_downloads_hint',
    },
    {
      tool: 'obtainium',
      icon: mdiPackageVariant,
      label: 'library_care_tool_obtainium',
      hint: 'frameleaf_onboarding_mobile_obtainium_hint',
    },
  ] as const;
</script>

<p>
  {$t('frameleaf_onboarding_mobile_body_before')}
  <code class="auth-server">{location.origin}</code>
  {$t('frameleaf_onboarding_mobile_body_after')}
</p>
<div class="ob-stores">
  {#each stores as store (store.key)}
    <a class="ob-store" href={store.href} target="_blank" rel="noreferrer">
      <Icon icon={store.icon} size="26" aria-hidden={true} />
      <span>
        <strong>{$t(store.label)}</strong>
        <small>{$t(store.hint)}</small>
      </span>
      <Icon icon={mdiOpenInNew} size="16" aria-hidden={true} />
    </a>
  {/each}
  {#each choices as choice (choice.tool)}
    <button type="button" class="ob-store" onclick={() => show(choice.tool)}>
      <Icon icon={choice.icon} size="26" aria-hidden={true} />
      <span>
        <strong>{$t(choice.label)}</strong>
        <small>{$t(choice.hint)}</small>
      </span>
      <Icon icon={mdiOpenInNew} size="16" aria-hidden={true} />
    </button>
  {/each}
</div>

{#if setup}
  <Dialog
    title={setup === 'obtainium' ? $t('library_care_tool_obtainium') : $t('library_care_tool_downloads')}
    closeLabel={$t('close')}
    wide
    bind:open
  >
    {#key setup}
      <ApplicationSetup tool={setup} onLeave={() => (open = false)} />
    {/key}
  </Dialog>
{/if}
