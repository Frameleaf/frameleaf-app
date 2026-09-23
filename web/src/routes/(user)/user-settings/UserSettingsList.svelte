<script lang="ts">
  import { page } from '$app/stores';
  import ChangePinCodeSettings from './PinCodeSettings.svelte';
  import DownloadSettings from './DownloadSettings.svelte';
  import FeatureSettings from './FeatureSettings.svelte';
  import NotificationsSettings from './NotificationsSettings.svelte';
  import LockedRulesPanel from '$lib/components/frameleaf/access/LockedRulesPanel.svelte';
  import UserPurchaseSettings from './UserPurchaseSettings.svelte';
  import UserUsageStatistic from './UserUsageStatistic.svelte';
  import { OpenQueryParam, QueryParameter } from '$lib/constants';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { oauth } from '$lib/utils';
  import { type ApiKeyResponseDto, type SessionResponseDto } from '@immich/sdk';
  import {
    mdiAccountGroupOutline,
    mdiAccountOutline,
    mdiApi,
    mdiBellOutline,
    mdiCogOutline,
    mdiDevices,
    mdiDownload,
    mdiFeatureSearchOutline,
    mdiFormTextboxPassword,
    mdiKeyOutline,
    mdiLockSmart,
    mdiServerOutline,
    mdiShieldLockOutline,
    mdiTwoFactorAuthentication,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import SettingGroup from '$lib/components/frameleaf/settings/SettingGroup.svelte';
  import AppSettings from './AppSettings.svelte';
  import ChangePasswordSettings from './ChangePasswordSettings.svelte';
  import DeviceList from './DeviceList.svelte';
  import OauthSettings from './OauthSettings.svelte';
  import SharingSettings from './SharingSettings.svelte';
  import UserApiKeyList from './UserApiKeyList.svelte';
  import UserProfileSettings from './UserProfileSettings.svelte';

  interface Props {
    keys?: ApiKeyResponseDto[];
    sessions?: SessionResponseDto[];
  }

  let { keys = $bindable([]), sessions = $bindable([]) }: Props = $props();

  let oauthOpen =
    oauth.isCallback(location) || $page.url.searchParams.get(QueryParameter.OPEN_SETTING) === OpenQueryParam.OAUTH;
</script>

<SettingGroup
  icon={mdiCogOutline}
  key="app-settings"
  title={$t('app_settings')}
  subtitle={$t('manage_the_app_settings')}
>
  <AppSettings />
</SettingGroup>

<SettingGroup icon={mdiAccountOutline} key="account" title={$t('account')} subtitle={$t('manage_your_account')}>
  <UserProfileSettings />
</SettingGroup>

<SettingGroup
  icon={mdiServerOutline}
  key="user-usage-info"
  title={$t('user_usage_stats')}
  subtitle={$t('user_usage_stats_description')}
>
  <UserUsageStatistic />
</SettingGroup>

<SettingGroup icon={mdiApi} key="api-keys" title={$t('api_keys')} subtitle={$t('manage_your_api_keys')}>
  <UserApiKeyList bind:keys />
</SettingGroup>

<SettingGroup
  icon={mdiDevices}
  key="authorized-devices"
  title={$t('authorized_devices')}
  subtitle={$t('manage_your_devices')}
>
  <DeviceList bind:devices={sessions} />
</SettingGroup>

<SettingGroup
  icon={mdiDownload}
  key="download-settings"
  title={$t('download_settings')}
  subtitle={$t('download_settings_description')}
>
  <DownloadSettings />
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
    title={$t('oauth')}
    subtitle={$t('manage_your_oauth_connection')}
    isOpen={oauthOpen || undefined}
  >
    <OauthSettings />
  </SettingGroup>
{/if}

<SettingGroup
  icon={mdiFormTextboxPassword}
  key="password"
  title={$t('password')}
  subtitle={$t('change_your_password')}
>
  <ChangePasswordSettings />
</SettingGroup>

<SettingGroup
  icon={mdiLockSmart}
  key="user-pin-code-settings"
  title={$t('user_pin_code_settings')}
  subtitle={$t('user_pin_code_settings_description')}
  autoScrollTo={true}
>
  <ChangePinCodeSettings />
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
  title={$t('user_purchase_settings')}
  subtitle={$t('user_purchase_settings_description')}
  autoScrollTo={true}
>
  <UserPurchaseSettings />
</SettingGroup>

<SettingGroup
  icon={mdiAccountGroupOutline}
  key={OpenQueryParam.SHARING}
  title={$t('sharing')}
  subtitle={$t('manage_sharing_with_other_users')}
>
  <SharingSettings />
</SettingGroup>
