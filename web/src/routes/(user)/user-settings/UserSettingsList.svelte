<script lang="ts">
  /**
   * The signed-in account's settings, one Command Center section at a time (FL-71). FL-67: profile,
   * password, PIN, API keys, sign-in provider, signed-in devices, Locked tags and people, and
   * supporter status are the design template's `PersonalAccess` and `ProtectedContent` sections
   * (`$lib/components/frameleaf/access`). Each keeps its old group key as its section key, so
   * existing `?isOpen=` and `?open=oauth` links still land on it.
   */
  import ApiKeysSection from '$lib/components/frameleaf/access/ApiKeysSection.svelte';
  import DevicesSection from '$lib/components/frameleaf/access/DevicesSection.svelte';
  import FrameleafAccountSection from '$lib/components/frameleaf/access/FrameleafAccountSection.svelte';
  import LockedRulesPanel from '$lib/components/frameleaf/access/LockedRulesPanel.svelte';
  import PasswordSection from '$lib/components/frameleaf/access/PasswordSection.svelte';
  import PinSection from '$lib/components/frameleaf/access/PinSection.svelte';
  import ProfileSection from '$lib/components/frameleaf/access/ProfileSection.svelte';
  import SignInProviderSection from '$lib/components/frameleaf/access/SignInProviderSection.svelte';
  import SupporterSection from '$lib/components/frameleaf/access/SupporterSection.svelte';
  import TakeoutSettingsSection from '$lib/components/frameleaf/settings/TakeoutSettingsSection.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getApiKeys, getSessions, type ApiKeyResponseDto, type SessionResponseDto } from '@immich/sdk';
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
{:else if section === 'download-settings'}
  <DownloadSettings />
{:else if section === 'preservation'}
  <!-- FL-74: every account preserves and restores its own originals, not only administrators. -->
  <PreservationPanel />
{:else if section === 'takeout'}
  <TakeoutSettingsSection showRoots={authManager.user.isAdmin} />
{:else if section === 'feature'}
  <FeatureSettings />
{:else if section === 'email-preferences'}
  <NotificationsSettings />
{:else if section === 'oauth'}
  <SignInProviderSection />
{:else if section === 'frameleaf-account'}
  <FrameleafAccountSection />
{:else if section === 'password'}
  <PasswordSection onSessionsChanged={refreshSessions} />
{:else if section === 'user-pin-code-settings'}
  <PinSection />
{:else if section === 'suppressed-content'}
  <LockedRulesPanel />
{:else if section === 'user-purchase-settings'}
  <SupporterSection />
{:else if section === 'sharing'}
  <SharingSettings />
{/if}
