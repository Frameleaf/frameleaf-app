<script lang="ts" module>
  import type { Component } from 'svelte';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each page declares its own props
  type Page = () => Promise<{ default: Component<any> }>;

  const loadHowYouSignIn: Page = () => import('$lib/components/frameleaf/access/HowYouSignInPage.svelte');

  // FL-1799: each page's code loads when the page opens, not with the Command Center.
  const PAGES: Record<string, Page> = {
    'app-settings': () => import('./AppSettings.svelte'),
    account: () => import('$lib/components/frameleaf/access/ProfileSection.svelte'),
    'user-usage-info': () => import('./UserUsageStatistic.svelte'),
    // FL-860: apps you allowed through OAuth (FL-803), and how to connect an AI assistant.
    'connected-apps': () => import('$lib/components/frameleaf/access/ConnectedAppsSection.svelte'),
    // FL-824: your own sign-ins and account changes, newest first (FL-808).
    'account-activity': () => import('$lib/components/frameleaf/settings/security/AccountActivity.svelte'),
    'download-settings': () => import('./DownloadSettings.svelte'),
    // FL-922: how long new shared links last by default.
    'shared-link-defaults': () => import('./SharedLinkDefaults.svelte'),
    // FL-1484: whether AI work on your own photos may use Frameleaf Cloud.
    'cloud-processing': () => import('./CloudProcessingSettings.svelte'),
    // FL-74: every account preserves and restores its own originals, not only administrators.
    preservation: () => import('$lib/components/frameleaf/PreservationPanel.svelte'),
    feature: () => import('./FeatureSettings.svelte'),
    'email-preferences': () => import('./NotificationsSettings.svelte'),
    // The prototype's "How you sign in": password, Frameleaf account and sign-in provider on one page.
    password: loadHowYouSignIn,
    oauth: loadHowYouSignIn,
    // FL-859: add, rename and remove passkeys (FL-767 prototype `Passkeys.jsx`).
    passkeys: () => import('$lib/components/frameleaf/access/PasskeysSection.svelte'),
    // FL-831: two-step sign-in with an authenticator app (FL-776 prototype `TwoStep.jsx`).
    'two-step': () => import('$lib/components/frameleaf/access/TwoStepSection.svelte'),
    'frameleaf-account': () => import('$lib/components/frameleaf/access/FrameleafAccountSection.svelte'),
    'user-pin-code-settings': () => import('$lib/components/frameleaf/access/PinSection.svelte'),
    'suppressed-content': () => import('$lib/components/frameleaf/access/LockedRulesPanel.svelte'),
    // FL-721: optional encryption of this person's own Locked files
    'locked-encryption': () =>
      import('$lib/components/frameleaf/settings/security/locked-encryption/LockedEncryptionPage.svelte'),
    'user-purchase-settings': () => import('$lib/components/frameleaf/access/SupporterSection.svelte'),
    sharing: () => import('./SharingSettings.svelte'),
    takeout: () => import('$lib/components/frameleaf/settings/TakeoutSettingsSection.svelte'),
    'cloud-backup-choice': () => import('$lib/components/frameleaf/backup/CloudBackupChoiceSection.svelte'),
  };
  const loadApiKeys: Page = () => import('$lib/components/frameleaf/access/ApiKeysSection.svelte');
  const loadDevices: Page = () => import('$lib/components/frameleaf/access/DevicesSection.svelte');
</script>

<script lang="ts">
  /**
   * The signed-in account's settings, one Command Center section at a time (FL-71). FL-67: profile,
   * password, PIN, API keys, sign-in provider, signed-in devices, Locked tags and people, and
   * supporter status are the design template's `PersonalAccess` and `ProtectedContent` sections
   * (`$lib/components/frameleaf/access`). Each keeps its old group key as its section key, so
   * existing `?isOpen=` and `?open=oauth` links still land on it.
   */
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Lazy from '$lib/components/frameleaf/settings/Lazy.svelte';
  import Loader from '$lib/components/frameleaf/settings/Loader.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getApiKeys, getSessions, type ApiKeyResponseDto, type SessionResponseDto } from '@frameleaf/sdk';

  interface Props {
    /** The account section to show (its old accordion key). */
    section: string;
    keys?: ApiKeyResponseDto[];
    sessions?: SessionResponseDto[];
  }

  let { section, keys = $bindable([]), sessions = $bindable([]) }: Props = $props();

  // The key and device lists load when their section opens, not with every Command Center page.
  $effect(() => {
    if (section === 'api-keys') {
      void getApiKeys()
        .then((result) => (keys = result))
        .catch(() => {});
    } else if (section === 'authorized-devices') {
      void refreshSessions();
    }
  });

  /** After a password change signed out the other devices. */
  const refreshSessions = async () => {
    try {
      sessions = await getSessions();
    } catch {
      // The device list keeps what it showed; it refreshes on its next action.
    }
  };

  const page = $derived(Object.hasOwn(PAGES, section) ? PAGES[section] : undefined);
  /** What a page is given; only these pages take anything. */
  const pageProps = $derived.by((): Record<string, unknown> => {
    switch (section) {
      case 'takeout': {
        return { showRoots: authManager.user.isAdmin };
      }
      case 'password':
      case 'oauth':
      case 'two-step': {
        return { onSessionsChanged: refreshSessions };
      }
      case 'frameleaf-account': {
        return { view: 'page' };
      }
      default: {
        return {};
      }
    }
  });
</script>

{#if section === 'api-keys'}
  <Loader load={loadApiKeys}>
    {#snippet children({ default: ApiKeysSection })}
      <ApiKeysSection bind:keys />
    {/snippet}
  </Loader>
{:else if section === 'authorized-devices'}
  <Loader load={loadDevices}>
    {#snippet children({ default: DevicesSection })}
      <DevicesSection bind:sessions />
    {/snippet}
  </Loader>
{:else if section === 'cloud-backup-choice' && page}
  <!-- FL-362: what Cloud Backup keeps of this account's own library. -->
  <!-- In the kit's page frame, so the card keeps the width of the pages beside it. -->
  <KitPage><Lazy load={page} /></KitPage>
{:else if page}
  <Lazy load={page} props={pageProps} />
{/if}
