import { mdiArchiveLockOutline, mdiDeleteOutline, mdiImport, mdiTools, mdiTwoFactorAuthentication } from '@mdi/js';
import type { MessageFormatter, Translations } from 'svelte-i18n';
import { USER_SETTINGS_AREAS } from '$lib/frameleaf/command-index';
import type { SettingsHostSection } from '$lib/frameleaf/settings-areas';

/**
 * The account's own Command Center sections (FL-71), drawn by `UserSettingsList.svelte`: the old
 * personal settings groups, the sign-in provider when the server offers one, and the per-account
 * imports and preservation (FL-65, FL-74) that sit in "Import & protection" for every account,
 * the repair queues of Library care and the account's Trash.
 */
export const personalSections = ($t: MessageFormatter, options: { oauth: boolean }): SettingsHostSection[] => [
  ...USER_SETTINGS_AREAS.map((area) =>
    // Partner sharing is the template's People & sharing → "Partners & recipient groups".
    area.key === 'sharing'
      ? {
          key: area.key,
          title: $t('frameleaf_cc_section_sharing'),
          subtitle: $t('frameleaf_cc_section_sharing_description'),
          icon: area.icon,
        }
      : {
          key: area.key,
          title: $t(area.titleKey as Translations),
          subtitle: $t(area.descriptionKey as Translations),
          icon: area.icon,
        },
  ),
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
  {
    key: 'repair',
    title: $t('frameleaf_cc_section_repair'),
    subtitle: $t('frameleaf_cc_section_repair_description'),
    icon: mdiTools,
  },
  {
    key: 'contents',
    title: $t('frameleaf_cc_section_contents'),
    subtitle: $t('frameleaf_cc_section_contents_description'),
    icon: mdiDeleteOutline,
  },
];
