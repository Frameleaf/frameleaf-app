import { mdiArchiveLockOutline, mdiImport, mdiTwoFactorAuthentication } from '@mdi/js';
import type { MessageFormatter, Translations } from 'svelte-i18n';
import { USER_SETTINGS_AREAS } from '$lib/frameleaf/command-index';
import type { SettingsHostSection } from '$lib/frameleaf/settings-areas';

/**
 * The account's own Command Center sections (FL-71), drawn by `UserSettingsList.svelte`: the old
 * personal settings groups, the sign-in provider when the server offers one, and the per-account
 * imports and preservation (FL-65, FL-74) that sit in "Import & protection" for every account.
 */
export const personalSections = ($t: MessageFormatter, options: { oauth: boolean }): SettingsHostSection[] => [
  ...USER_SETTINGS_AREAS.map((area) => ({
    key: area.key,
    title: $t(area.titleKey as Translations),
    subtitle: $t(area.descriptionKey as Translations),
    icon: area.icon,
  })),
  ...(options.oauth
    ? [
        {
          key: 'oauth',
          title: $t('frameleaf_access_provider_title'),
          subtitle: $t('frameleaf_access_provider_description'),
          icon: mdiTwoFactorAuthentication,
        },
      ]
    : []),
  {
    key: 'takeout',
    title: $t('frameleaf_takeout_settings_title'),
    subtitle: $t('frameleaf_takeout_settings_subtitle'),
    icon: mdiImport,
  },
  {
    key: 'preservation',
    title: $t('frameleaf_preservation_section_title'),
    subtitle: $t('frameleaf_preservation_section_description'),
    icon: mdiArchiveLockOutline,
  },
];
