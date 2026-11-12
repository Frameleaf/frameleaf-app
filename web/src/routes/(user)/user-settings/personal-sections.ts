import {
  mdiArchiveLockOutline,
  mdiBroom,
  mdiCalendarClock,
  mdiCloudOutline,
  mdiDeleteOutline,
  mdiFileAlertOutline,
  mdiFileClockOutline,
  mdiImport,
  mdiMapMarkerOutline,
  mdiTools,
  mdiTwoFactorAuthentication,
} from '@mdi/js';
import type { MessageFormatter, Translations } from 'svelte-i18n';
import { USER_SETTINGS_AREAS } from '$lib/frameleaf/command-index';
import type { SettingsHostSection } from '$lib/frameleaf/settings-areas';

/**
 * The account's own Command Center sections (FL-71), drawn by `UserSettingsList.svelte`: the old
 * personal settings groups, the sign-in provider when the server offers one, and the per-account
 * imports and preservation (FL-65, FL-74) that sit in "Import & protection" for every account,
 * Library care's repair suggestions (administrators), its damaged and missing files (every account) and
 * the account's Trash.
 */
export const personalSections = (
  $t: MessageFormatter,
  options: { oauth: boolean; isAdmin?: boolean },
): SettingsHostSection[] => [
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
  // FL-362: every account chooses what Cloud Backup keeps of its own library.
  {
    key: 'cloud-backup-choice',
    title: $t('frameleaf_backup_keeps_title'),
    subtitle: $t('frameleaf_backup_keeps_subtitle'),
    icon: mdiCloudOutline,
  },
  // Library care lists each repair tool once, in its Tools group. This page holds only the
  // suggestion switches, which are server settings, so it is offered to administrators alone
  // (design review finding 67).
  ...(options.isAdmin
    ? [
        {
          key: 'repair',
          title: $t('frameleaf_cc_section_repair'),
          subtitle: $t('frameleaf_cc_section_repair_description'),
          icon: mdiTools,
        },
      ]
    : []),
  // FL-1338: Library care → Damaged and missing files, for every account: a member sees their own files, an
  // administrator also the household's, without their pictures.
  {
    key: 'files',
    title: $t('frameleaf_cc_section_files'),
    subtitle: $t('frameleaf_cc_section_files_description'),
    icon: mdiFileAlertOutline,
  },
  // FL-862: Library care → Couldn't process, for every account: a member sees their own files, an
  // administrator also the household's, without their pictures.
  {
    key: 'couldnt-process',
    title: $t('frameleaf_cc_section_couldnt_process'),
    subtitle: $t('frameleaf_cc_section_couldnt_process_description'),
    icon: mdiFileClockOutline,
  },
  // FL-943: Library care → Dates that look wrong (the Date & Time Doctor), for every account's own photos.
  {
    key: 'dates',
    title: $t('frameleaf_date_doctor_title'),
    subtitle: $t('frameleaf_cc_section_date_doctor_description'),
    icon: mdiCalendarClock,
  },
  // FL-1470: Library care → Tidy up and its review, for every account's own photos.
  {
    key: 'tidy-up',
    title: $t('frameleaf_tidy_title'),
    subtitle: $t('frameleaf_cc_section_tidy_up_description'),
    icon: mdiBroom,
  },
  {
    key: 'tidy-up-review',
    title: $t('frameleaf_tidy_review_title'),
    subtitle: $t('frameleaf_cc_section_tidy_up_review_description'),
    icon: mdiBroom,
  },
  // Library care → Identify photo locations, for every account (its own library).
  {
    key: 'location-scan',
    title: $t('frameleaf_location_scan_title'),
    subtitle: $t('frameleaf_cc_section_location_scan_description'),
    icon: mdiMapMarkerOutline,
  },
  {
    key: 'contents',
    title: $t('frameleaf_cc_section_contents'),
    subtitle: $t('frameleaf_cc_section_contents_description'),
    icon: mdiDeleteOutline,
  },
];
