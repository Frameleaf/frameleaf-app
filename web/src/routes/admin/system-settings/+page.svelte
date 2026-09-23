<script lang="ts">
  /**
   * Admin settings (FL-71) on the Frameleaf settings host. Each section below is an existing
   * system-config form bound to the same endpoints as before; the host groups them into the
   * template's areas and carries the search. The header actions and command palette entries
   * are unchanged.
   */
  import AuthSettings from './AuthSettings.svelte';
  import BackupSettings from './BackupSettings.svelte';
  import FFmpegSettings from './FFmpegSettings.svelte';
  import ImageSettings from './ImageSettings.svelte';
  import IntegrityChecksSettings from './IntegrityChecksSettings.svelte';
  import JobSettings from './JobSettings.svelte';
  import LibrarySettings from './LibrarySettings.svelte';
  import LoggingSettings from './LoggingSettings.svelte';
  import MachineLearningSettings from './MachineLearningSettings.svelte';
  import MapSettings from './MapSettings.svelte';
  import MetadataSettings from './MetadataSettings.svelte';
  import NewVersionCheckSettings from './NewVersionCheckSettings.svelte';
  import NightlyTasksSettings from './NightlyTasksSettings.svelte';
  import NotificationSettings from './NotificationSettings.svelte';
  import ServerSettings from './ServerSettings.svelte';
  import SmartAlbumsSettings from './SmartAlbumsSettings.svelte';
  import StorageTemplateSettings from '$lib/components/admin-settings/StorageTemplateSettings.svelte';
  import TakeoutSettings from './TakeoutSettings.svelte';
  import ThemeSettings from './ThemeSettings.svelte';
  import TrashSettings from './TrashSettings.svelte';
  import UserSettings from './UserSettings.svelte';
  import PreservationPanel from '$lib/components/frameleaf/PreservationPanel.svelte';
  import SettingsHost from '$lib/components/frameleaf/settings/SettingsHost.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import type { SettingsHostSection } from '$lib/frameleaf/settings-areas';
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { getSystemConfigActions } from '$lib/services/system-config.service';
  import { Alert, CommandPaletteDefaultProvider, Container, Theme as AppTheme, themeManager } from '@immich/ui';
  import {
    mdiAccountOutline,
    mdiArchiveLockOutline,
    mdiBackupRestore,
    mdiBellOutline,
    mdiBookshelf,
    mdiClockOutline,
    mdiDatabaseOutline,
    mdiFileCheckOutline,
    mdiFileDocumentOutline,
    mdiFolderOutline,
    mdiImageMultipleOutline,
    mdiImageOutline,
    mdiImport,
    mdiLockOutline,
    mdiMapMarkerOutline,
    mdiPaletteOutline,
    mdiRobotOutline,
    mdiServerOutline,
    mdiSync,
    mdiTrashCanOutline,
    mdiUpdate,
    mdiVideoOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  const { data }: Props = $props();
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');

  const sections: SettingsHostSection[] = $derived([
    {
      component: AuthSettings,
      title: $t('admin.authentication_settings'),
      subtitle: $t('admin.authentication_settings_description'),
      key: 'authentication',
      icon: mdiLockOutline,
    },
    {
      component: BackupSettings,
      title: $t('admin.backup_settings'),
      subtitle: $t('admin.backup_settings_description'),
      key: 'backup',
      icon: mdiBackupRestore,
    },
    {
      component: ImageSettings,
      title: $t('admin.image_settings'),
      subtitle: $t('admin.image_settings_description'),
      key: 'image',
      icon: mdiImageOutline,
    },
    {
      component: IntegrityChecksSettings,
      title: $t('admin.integrity_checks_settings'),
      subtitle: $t('admin.integrity_checks_settings_description'),
      key: 'integrity-checks',
      icon: mdiFileCheckOutline,
    },
    {
      component: JobSettings,
      title: $t('admin.job_settings'),
      subtitle: $t('admin.job_settings_description'),
      key: 'job',
      icon: mdiSync,
    },
    {
      component: LibrarySettings,
      title: $t('admin.library_settings'),
      subtitle: $t('admin.library_settings_description'),
      key: 'external-library',
      icon: mdiBookshelf,
    },
    {
      component: LoggingSettings,
      title: $t('admin.logging_settings'),
      subtitle: $t('admin.manage_log_settings'),
      key: 'logging',
      icon: mdiFileDocumentOutline,
    },
    {
      component: MachineLearningSettings,
      title: $t('admin.machine_learning_settings'),
      subtitle: $t('admin.machine_learning_settings_description'),
      key: 'machine-learning',
      icon: mdiRobotOutline,
    },
    {
      component: MapSettings,
      title: $t('admin.map_gps_settings'),
      subtitle: $t('admin.map_gps_settings_description'),
      key: 'location',
      icon: mdiMapMarkerOutline,
    },
    {
      component: MetadataSettings,
      title: $t('admin.metadata_settings'),
      subtitle: $t('admin.metadata_settings_description'),
      key: 'metadata',
      icon: mdiDatabaseOutline,
    },
    {
      component: NightlyTasksSettings,
      title: $t('admin.nightly_tasks_settings'),
      subtitle: $t('admin.nightly_tasks_settings_description'),
      key: 'nightly-tasks',
      icon: mdiClockOutline,
    },
    {
      component: NotificationSettings,
      title: $t('admin.notification_settings'),
      subtitle: $t('admin.notification_settings_description'),
      key: 'notifications',
      icon: mdiBellOutline,
    },
    {
      // FL-74: the design's "Originals & preservation" section of Import & protection.
      component: PreservationPanel,
      title: $t('frameleaf_preservation_section_title'),
      subtitle: $t('frameleaf_preservation_section_description'),
      key: 'preservation',
      icon: mdiArchiveLockOutline,
    },
    {
      component: ServerSettings,
      title: $t('admin.server_settings'),
      subtitle: $t('admin.server_settings_description'),
      key: 'server',
      icon: mdiServerOutline,
    },
    {
      component: SmartAlbumsSettings,
      title: $t('admin.smart_albums_settings'),
      subtitle: $t('admin.smart_albums_settings_description'),
      key: 'smart-albums',
      icon: mdiImageMultipleOutline,
    },
    {
      component: StorageTemplateSettings,
      title: $t('admin.storage_template_settings'),
      subtitle: $t('admin.storage_template_settings_description'),
      key: 'storage-template',
      icon: mdiFolderOutline,
    },
    {
      component: TakeoutSettings,
      title: $t('frameleaf_takeout_settings_title'),
      subtitle: $t('frameleaf_takeout_settings_subtitle'),
      key: 'takeout',
      icon: mdiImport,
    },
    {
      component: ThemeSettings,
      title: $t('admin.theme_settings'),
      subtitle: $t('admin.theme_settings_description'),
      key: 'theme',
      icon: mdiPaletteOutline,
    },
    {
      component: TrashSettings,
      title: $t('admin.trash_settings'),
      subtitle: $t('admin.trash_settings_description'),
      key: 'trash',
      icon: mdiTrashCanOutline,
    },
    {
      component: UserSettings,
      title: $t('admin.user_settings'),
      subtitle: $t('admin.user_settings_description'),
      key: 'user-settings',
      icon: mdiAccountOutline,
    },
    {
      component: NewVersionCheckSettings,
      title: $t('admin.version_check_settings'),
      subtitle: $t('admin.version_check_settings_description'),
      key: 'version-check',
      icon: mdiUpdate,
    },
    {
      component: FFmpegSettings,
      title: $t('admin.transcoding_settings'),
      subtitle: $t('admin.transcoding_settings_description'),
      key: 'video-transcoding',
      icon: mdiVideoOutline,
    },
  ]);

  const { CopyToClipboard, Upload, Download } = $derived(
    getSystemConfigActions($t, featureFlagsManager.value, systemConfigManager.value),
  );
</script>

<CommandPaletteDefaultProvider name={$t('admin.system_settings')} actions={[CopyToClipboard, Upload, Download]} />

<AdminPageLayout breadcrumbs={[{ title: data.meta.title }]} actions={[CopyToClipboard, Download, Upload]}>
  <Container size="large" center class="my-4">
    <Theme theme={appTheme}>
      {#if featureFlagsManager.value.configFile}
        <Alert color="warning" class="mb-4 text-dark" title={$t('admin.config_set_by_file')} />
      {/if}
      <SettingsHost {sections} />
    </Theme>
  </Container>
</AdminPageLayout>
