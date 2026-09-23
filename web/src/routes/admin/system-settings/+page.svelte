<script lang="ts">
  /**
   * Admin settings (FL-71) on the Frameleaf settings host. Each section below is an existing
   * system-config form; the host groups them into the template's areas and carries the search.
   *
   * FL-66: the sections edit one settings draft, created here from the saved settings and their
   * revision. The settings bar saves every page together and the server refuses a save made
   * against settings another administrator changed since (the draft is kept for review). The
   * page follows other administrators' saves as they happen, recovers an unsaved draft after a
   * reload from this tab's session storage (never secrets), copies and exports the saved settings
   * without secrets, and imports a settings file into the draft for review instead of saving it.
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
  import ThemeSettings from './ThemeSettings.svelte';
  import TrashSettings from './TrashSettings.svelte';
  import UserSettings from './UserSettings.svelte';
  import SettingsHost from '$lib/components/frameleaf/settings/SettingsHost.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import type { SettingsHostSection } from '$lib/frameleaf/settings-areas';
  import { cloneConfig, SYSTEM_CONFIG_JOURNAL_PREFIX } from '$lib/frameleaf/system-config-draft';
  import {
    setSystemConfigDraft,
    SystemConfigDraftStore,
    type SystemConfigDraftStorage,
  } from '$lib/frameleaf/system-config-draft.svelte';
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { getSystemConfigActions } from '$lib/services/system-config.service';
  import { websocketEvents } from '$lib/stores/websocket';
  import { getAdminConfigWithRevision, updateAdminConfigWithRevision } from '@immich/sdk';
  import { Alert, CommandPaletteDefaultProvider, Container, Theme as AppTheme, themeManager } from '@immich/ui';
  import {
    mdiAccountOutline,
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
  import { onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  const { data }: Props = $props();
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');

  // The reload journal is per tab and per administrator, and holds no secrets or credentials.
  const journalKey = `${SYSTEM_CONFIG_JOURNAL_PREFIX}${authManager.user.id}`;
  const journal: SystemConfigDraftStorage = {
    read: () => sessionStorage.getItem(journalKey),
    write: (value) => sessionStorage.setItem(journalKey, value),
    remove: () => sessionStorage.removeItem(journalKey),
  };

  const settingsDraft = untrack(
    () =>
      new SystemConfigDraftStore(data.current, {
        defaults: data.defaultConfig,
        load: () => getAdminConfigWithRevision(),
        save: (update) => updateAdminConfigWithRevision({ adminConfigRevisionUpdateDto: update }),
        // Feature flags, the server config and every "saved" comparison follow the new baseline.
        onUpdated: (config) => eventManager.emit('SystemConfigUpdate', config),
        storage: journal,
      }),
  );
  setSystemConfigDraft(settingsDraft);
  systemConfigManager.value = cloneConfig(settingsDraft.baseline);
  // A draft left by a reload of this tab comes back before anything writes the journal again.
  settingsDraft.recover();

  // Keep the journal in step with the draft so a reload can recover it.
  $effect(() => {
    void settingsDraft.changes;
    void settingsDraft.revision;
    untrack(() => settingsDraft.persistJournal());
  });

  // The page loads the saved settings again when its URL changes (switching areas): follow them.
  $effect(() => {
    const latest = data.current;
    untrack(() => settingsDraft.follow(latest));
  });

  onMount(() => {
    // Another administrator (or another tab) saved settings: follow them. An unsaved draft is
    // carried onto them, or marked stale when it changes the same settings.
    return websocketEvents.on('on_config_update', () => void settingsDraft.refresh());
  });

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
    getSystemConfigActions($t, featureFlagsManager.value, settingsDraft.baseline, {
      onImport: (text) => settingsDraft.importFile(text),
    }),
  );
</script>

<CommandPaletteDefaultProvider name={$t('admin.system_settings')} actions={[CopyToClipboard, Upload, Download]} />

<AdminPageLayout breadcrumbs={[{ title: data.meta.title }]} actions={[CopyToClipboard, Download, Upload]}>
  <Container size="large" center class="my-4">
    <Theme theme={appTheme}>
      {#if featureFlagsManager.value.configFile}
        <Alert color="warning" class="mb-4 text-dark" title={$t('admin.config_set_by_file')} />
      {/if}
      <SettingsHost {sections} disabled={featureFlagsManager.value.configFile} />
    </Theme>
  </Container>
</AdminPageLayout>
