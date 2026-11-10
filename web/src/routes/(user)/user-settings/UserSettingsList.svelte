<script lang="ts">
  /**
   * The signed-in account's settings, one Command Center section at a time (FL-71). FL-67: profile,
   * password, PIN, API keys, sign-in provider, signed-in devices, Locked tags and people, and
   * supporter status are the design template's `PersonalAccess` and `ProtectedContent` sections
   * (`$lib/components/frameleaf/access`). Each keeps its old group key as its section key, so
   * existing `?isOpen=` and `?open=oauth` links still land on it.
   */
  import ApiKeysSection from '$lib/components/frameleaf/access/ApiKeysSection.svelte';
  import ConnectedAppsSection from '$lib/components/frameleaf/access/ConnectedAppsSection.svelte';
  import DevicesSection from '$lib/components/frameleaf/access/DevicesSection.svelte';
  import FrameleafAccountSection from '$lib/components/frameleaf/access/FrameleafAccountSection.svelte';
  import LockedRulesPanel from '$lib/components/frameleaf/access/LockedRulesPanel.svelte';
  import LockedEncryptionPage from '$lib/components/frameleaf/settings/security/locked-encryption/LockedEncryptionPage.svelte';
  import HowYouSignInPage from '$lib/components/frameleaf/access/HowYouSignInPage.svelte';
  import PinSection from '$lib/components/frameleaf/access/PinSection.svelte';
  import ProfileSection from '$lib/components/frameleaf/access/ProfileSection.svelte';
  import SupporterSection from '$lib/components/frameleaf/access/SupporterSection.svelte';
  import TakeoutSettingsSection from '$lib/components/frameleaf/settings/TakeoutSettingsSection.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getApiKeys, getSessions, type ApiKeyResponseDto, type SessionResponseDto } from '@frameleaf/sdk';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import CloudBackupChoiceSection from '$lib/components/frameleaf/backup/CloudBackupChoiceSection.svelte';
  import PreservationPanel from '$lib/components/frameleaf/PreservationPanel.svelte';
  import AppSettings from './AppSettings.svelte';
  import DownloadSettings from './DownloadSettings.svelte';
  import FeatureSettings from './FeatureSettings.svelte';
  import NotificationsSettings from './NotificationsSettings.svelte';
  import SharingSettings from './SharingSettings.svelte';
  import UserUsageStatistic from './UserUsageStatistic.svelte';

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
</script>

{#if section === 'app-settings'}
  <AppSettings />
{:else if section === 'account'}
  <ProfileSection />
{:else if section === 'user-usage-info'}
  <UserUsageStatistic />
{:else if section === 'api-keys'}
  <ApiKeysSection bind:keys />
{:else if section === 'authorized-devices'}
  <DevicesSection bind:sessions />
{:else if section === 'connected-apps'}
  <!-- FL-860: apps you allowed through OAuth (FL-803), and how to connect an AI assistant. -->
  <ConnectedAppsSection />
{:else if section === 'download-settings'}
  <DownloadSettings />
{:else if section === 'preservation'}
  <!-- FL-74: every account preserves and restores its own originals, not only administrators. -->
  <PreservationPanel />
{:else if section === 'cloud-backup-choice'}
  <!-- FL-362: what Cloud Backup keeps of this account's own library. -->
  <!-- In the kit's page frame, so the card keeps the width of the pages beside it. -->
  <KitPage><CloudBackupChoiceSection /></KitPage>
{:else if section === 'takeout'}
  <TakeoutSettingsSection showRoots={authManager.user.isAdmin} />
{:else if section === 'feature'}
  <FeatureSettings />
{:else if section === 'email-preferences'}
  <NotificationsSettings />
{:else if section === 'password' || section === 'oauth'}
  <!-- The prototype's "How you sign in": password, Frameleaf account and sign-in provider on one page. -->
  <HowYouSignInPage onSessionsChanged={refreshSessions} />
{:else if section === 'frameleaf-account'}
  <FrameleafAccountSection view="page" />
{:else if section === 'user-pin-code-settings'}
  <PinSection />
{:else if section === 'suppressed-content'}
  <LockedRulesPanel />
{:else if section === 'locked-encryption'}
  <!-- FL-721: optional encryption of this person's own Locked files -->
  <LockedEncryptionPage />
{:else if section === 'user-purchase-settings'}
  <SupporterSection />
{:else if section === 'sharing'}
  <SharingSettings />
{/if}
