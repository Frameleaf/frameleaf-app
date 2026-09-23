<script lang="ts">
  /**
   * The signed-in account's settings. FL-67: profile, password, PIN, API keys, sign-in provider,
   * signed-in devices, Locked tags and people, and supporter status are the design template's
   * `PersonalAccess` and `ProtectedContent` sections (`$lib/components/frameleaf/access`). Each
   * keeps its group key, so existing `?isOpen=` and `?open=oauth` links still land on it.
   */
  import { page } from '$app/stores';
  import ApiKeysSection from '$lib/components/frameleaf/access/ApiKeysSection.svelte';
  import DevicesSection from '$lib/components/frameleaf/access/DevicesSection.svelte';
  import LockedRulesPanel from '$lib/components/frameleaf/access/LockedRulesPanel.svelte';
  import PasswordSection from '$lib/components/frameleaf/access/PasswordSection.svelte';
  import PinSection from '$lib/components/frameleaf/access/PinSection.svelte';
  import ProfileSection from '$lib/components/frameleaf/access/ProfileSection.svelte';
  import SignInProviderSection from '$lib/components/frameleaf/access/SignInProviderSection.svelte';
  import SupporterSection from '$lib/components/frameleaf/access/SupporterSection.svelte';
  import SettingGroup from '$lib/components/frameleaf/settings/SettingGroup.svelte';
  import TakeoutSettingsSection from '$lib/components/frameleaf/settings/TakeoutSettingsSection.svelte';
  import { OpenQueryParam, QueryParameter } from '$lib/constants';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { oauth } from '$lib/utils';
  import { getSessions, type ApiKeyResponseDto, type SessionResponseDto } from '@immich/sdk';
  import {
    mdiAccountGroupOutline,
    mdiAccountOutline,
    mdiApi,
    mdiArchiveLockOutline,
    mdiBellOutline,
    mdiCogOutline,
    mdiDevices,
    mdiDownload,
    mdiFeatureSearchOutline,
    mdiFormTextboxPassword,
    mdiImport,
    mdiKeyOutline,
    mdiLockSmart,
    mdiServerOutline,
    mdiShieldLockOutline,
    mdiTwoFactorAuthentication,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import PreservationPanel from '$lib/components/frameleaf/PreservationPanel.svelte';
  import AppSettings from './AppSettings.svelte';
  import DownloadSettings from './DownloadSettings.svelte';
  import FeatureSettings from './FeatureSettings.svelte';
  import NotificationsSettings from './NotificationsSettings.svelte';
  import SharingSettings from './SharingSettings.svelte';
  import UserUsageStatistic from './UserUsageStatistic.svelte';

  interface Props {
    keys?: ApiKeyResponseDto[];
    sessions?: SessionResponseDto[];
  }

  let { keys = $bindable([]), sessions = $bindable([]) }: Props = $props();

  let oauthOpen =
    oauth.isCallback(location) || $page.url.searchParams.get(QueryParameter.OPEN_SETTING) === OpenQueryParam.OAUTH;

  /** After a password change signed out the other devices. */
  const refreshSessions = async () => {
    try {
      sessions = await getSessions();
    } catch {
      // The device list keeps what it showed; it refreshes on its next action.
    }
  };
</script>

<SettingGroup
  icon={mdiCogOutline}
  key="app-settings"
  title={$t('app_settings')}
  subtitle={$t('manage_the_app_settings')}
>
  <AppSettings />
</SettingGroup>

<SettingGroup
  icon={mdiAccountOutline}
  key="account"
  title={$t('frameleaf_access_profile_title')}
  subtitle={$t('frameleaf_access_profile_description')}
>
  <ProfileSection />
</SettingGroup>

<SettingGroup
  icon={mdiServerOutline}
  key="user-usage-info"
  title={$t('user_usage_stats')}
  subtitle={$t('user_usage_stats_description')}
>
  <UserUsageStatistic />
</SettingGroup>

<SettingGroup
  icon={mdiApi}
  key="api-keys"
  title={$t('frameleaf_access_keys_title')}
  subtitle={$t('frameleaf_access_keys_description')}
>
  <ApiKeysSection bind:keys />
</SettingGroup>

<SettingGroup
  icon={mdiDevices}
  key="authorized-devices"
  title={$t('frameleaf_access_devices_title')}
  subtitle={$t('frameleaf_access_devices_description')}
>
  <DevicesSection bind:sessions />
</SettingGroup>

<SettingGroup
  icon={mdiDownload}
  key="download-settings"
  title={$t('download_settings')}
  subtitle={$t('download_settings_description')}
>
  <DownloadSettings />
</SettingGroup>

<!-- FL-74: every account preserves and restores its own originals, not only administrators. -->
<SettingGroup
  icon={mdiArchiveLockOutline}
  key={OpenQueryParam.PRESERVATION}
  title={$t('frameleaf_preservation_section_title')}
  subtitle={$t('frameleaf_preservation_section_description')}
  autoScrollTo={true}
>
  <PreservationPanel />
</SettingGroup>

<SettingGroup
  icon={mdiImport}
  key="takeout"
  title={$t('frameleaf_takeout_settings_title')}
  subtitle={$t('frameleaf_takeout_settings_subtitle')}
>
  <TakeoutSettingsSection showRoots={authManager.user.isAdmin} />
</SettingGroup>

<SettingGroup
  icon={mdiFeatureSearchOutline}
  key="feature"
  title={$t('features')}
  subtitle={$t('features_setting_description')}
>
  <FeatureSettings />
</SettingGroup>

<SettingGroup
  icon={mdiBellOutline}
  key={OpenQueryParam.NOTIFICATIONS}
  title={$t('notifications')}
  subtitle={$t('notifications_setting_description')}
>
  <NotificationsSettings />
</SettingGroup>

{#if featureFlagsManager.value.oauth}
  <SettingGroup
    icon={mdiTwoFactorAuthentication}
    key={OpenQueryParam.OAUTH}
    title={$t('frameleaf_access_provider_title')}
    subtitle={$t('frameleaf_access_provider_description')}
    isOpen={oauthOpen || undefined}
  >
    <SignInProviderSection />
  </SettingGroup>
{/if}

<SettingGroup
  icon={mdiFormTextboxPassword}
  key="password"
  title={$t('frameleaf_access_password_title')}
  subtitle={$t('frameleaf_access_password_group_description')}
>
  <PasswordSection onSessionsChanged={refreshSessions} />
</SettingGroup>

<SettingGroup
  icon={mdiLockSmart}
  key="user-pin-code-settings"
  title={$t('frameleaf_access_pin_title')}
  subtitle={$t('frameleaf_access_pin_group_description')}
  autoScrollTo={true}
>
  <PinSection />
</SettingGroup>

<SettingGroup
  icon={mdiShieldLockOutline}
  key="suppressed-content"
  title={$t('frameleaf_locked_rules_section_title')}
  subtitle={$t('frameleaf_locked_rules_section_description')}
  autoScrollTo={true}
>
  <LockedRulesPanel />
</SettingGroup>

<SettingGroup
  icon={mdiKeyOutline}
  key={OpenQueryParam.PURCHASE_SETTINGS}
  title={$t('frameleaf_access_supporter_title')}
  subtitle={$t('frameleaf_access_supporter_group_description')}
  autoScrollTo={true}
>
  <SupporterSection />
</SettingGroup>

<SettingGroup
  icon={mdiAccountGroupOutline}
  key={OpenQueryParam.SHARING}
  title={$t('sharing')}
  subtitle={$t('manage_sharing_with_other_users')}
>
  <SharingSettings />
</SettingGroup>
