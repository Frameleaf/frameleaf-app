<script lang="ts">
  /**
   * The administrator's Command Center (FL-71): the one Command Center with the server settings
   * added to the account's own sections. Each server section below is an existing system-config
   * form; the host groups them into the template's areas and carries the search. This used to be
   * the separate `/admin/system-settings` page, which now only redirects here.
   *
   * FL-66: the sections edit one settings draft, created here from the saved settings and their
   * revision. The settings bar saves every page together and the server refuses a save made
   * against settings another administrator changed since (the draft is kept for review). The
   * page follows other administrators' saves as they happen, recovers an unsaved draft after a
   * reload from this tab's session storage (never secrets), copies and exports the saved settings
   * without secrets, and imports a settings file into the draft for review instead of saving it.
   */
  import AuthSettings from '../../admin/system-settings/AuthSettings.svelte';
  import FFmpegSettings from '../../admin/system-settings/FFmpegSettings.svelte';
  import ImageSettings from '../../admin/system-settings/ImageSettings.svelte';
  import LibrarySettings from '../../admin/system-settings/LibrarySettings.svelte';
  import LoggingSettings from '../../admin/system-settings/LoggingSettings.svelte';
  import MapSettings from '../../admin/system-settings/MapSettings.svelte';
  import MigrationSettingsSection from '$lib/components/frameleaf/settings/MigrationSettingsSection.svelte';
  import NewVersionCheckSettings from '../../admin/system-settings/NewVersionCheckSettings.svelte';
  import NightlyTasksSettings from '../../admin/system-settings/NightlyTasksSettings.svelte';
  import NotificationSettings from '../../admin/system-settings/NotificationSettings.svelte';
  import ServerSettings from '../../admin/system-settings/ServerSettings.svelte';
  import StorageTemplateSettings from '$lib/components/admin-settings/StorageTemplateSettings.svelte';
  import ThemeSettings from '../../admin/system-settings/ThemeSettings.svelte';
  import TrashSettings from '../../admin/system-settings/TrashSettings.svelte';
  import UserSettings from '../../admin/system-settings/UserSettings.svelte';
  import Duplicates from '$lib/components/frameleaf/settings/care/Duplicates.svelte';
  import FileChecks from '$lib/components/frameleaf/settings/care/FileChecks.svelte';
  import Descriptions from '$lib/components/frameleaf/settings/intelligence/Descriptions.svelte';
  import Faces from '$lib/components/frameleaf/settings/intelligence/Faces.svelte';
  import LockedDetection from '$lib/components/frameleaf/settings/intelligence/LockedDetection.svelte';
  import SmartAlbums from '$lib/components/frameleaf/settings/intelligence/SmartAlbums.svelte';
  import TextInPhotos from '$lib/components/frameleaf/settings/intelligence/TextInPhotos.svelte';
  import VisualSearch from '$lib/components/frameleaf/settings/intelligence/VisualSearch.svelte';
  import AiRestoration from '$lib/components/frameleaf/settings/editing/AiRestoration.svelte';
  import EditedMasters from '$lib/components/frameleaf/settings/editing/EditedMasters.svelte';
  import StudioStatus from '$lib/components/frameleaf/settings/editing/StudioStatus.svelte';
  import LibrariesArea from '$lib/components/frameleaf/LibrariesArea.svelte';
  import ConfigurationTransferSection from '$lib/components/frameleaf/settings/ConfigurationTransferSection.svelte';
  import SettingsHost from '$lib/components/frameleaf/settings/SettingsHost.svelte';
  import { SETTINGS_SECTION_KEYWORDS } from '$lib/frameleaf/command-index';
  import { forConfigSave } from '$lib/frameleaf/credentials';
  import type { SettingsHostSection } from '$lib/frameleaf/settings-areas';
  import { cloneConfig, SYSTEM_CONFIG_JOURNAL_PREFIX } from '$lib/frameleaf/system-config-draft';
  import {
    setSystemConfigDraft,
    SystemConfigDraftStore,
    type SystemConfigDraftStorage,
  } from '$lib/frameleaf/system-config-draft.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import AuthDisableLoginConfirmModal from '$lib/modals/AuthDisableLoginConfirmModal.svelte';
  import { getSystemConfigActions } from '$lib/services/system-config.service';
  import { websocketEvents } from '$lib/stores/websocket';
  import {
    getAdminConfigWithRevision,
    updateAdminConfigWithRevision,
    type AdminConfigRevisionResponseDto,
    type AdminConfigDto,
  } from '@frameleaf/sdk';
  import { CommandPaletteDefaultProvider, modalManager } from '@frameleaf/ui';
  import {
    mdiAccountMultipleOutline,
    mdiAccountOutline,
    mdiAutoFix,
    mdiContentCopy,
    mdiFaceRecognition,
    mdiImageSearchOutline,
    mdiTextRecognition,
    mdiCertificateOutline,
    mdiCloudSyncOutline,
    mdiCloudUploadOutline,
    mdiCreditCardOutline,
    mdiEarth,
    mdiExpansionCard,
    mdiLinkVariant,
    mdiContentDuplicate,
    mdiDesktopTowerMonitor,
    mdiTransitConnectionVariant,
    mdiShieldAccountOutline,
    mdiTrayFull,
    mdiWrench,
    mdiBackupRestore,
    mdiBellAlertOutline,
    mdiBellOutline,
    mdiBookshelf,
    mdiClockOutline,
    mdiDatabaseOutline,
    mdiFileCheckOutline,
    mdiFileDocumentOutline,
    mdiFolderOutline,
    mdiImageEditOutline,
    mdiImageMultipleOutline,
    mdiImageOutline,
    mdiLockOutline,
    mdiMapMarkerOutline,
    mdiMovieEditOutline,
    mdiPaletteOutline,
    mdiRobotOutline,
    mdiServerOutline,
    mdiTrashCanOutline,
    mdiTruckOutline,
    mdiUpdate,
    mdiSwapVertical,
    mdiVideoOutline,
  } from '@mdi/js';
  import { onMount, untrack, type Snippet } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';
  import { clampEnhancedVideoFrames } from '../../admin/system-settings/machine-learning/machine-learning-helpers';

  type Props = {
    current: AdminConfigRevisionResponseDto;
    defaultConfig: AdminConfigDto;
    /** The account's own sections, offered to every account. */
    personal: SettingsHostSection[];
    sectionBody: Snippet<[SettingsHostSection]>;
  };

  const { current, defaultConfig, personal, sectionBody }: Props = $props();

  // The reload journal is per tab and per administrator, and holds no secrets or credentials.
  const journalKey = `${SYSTEM_CONFIG_JOURNAL_PREFIX}${authManager.user.id}`;
  const journal: SystemConfigDraftStorage = {
    read: () => sessionStorage.getItem(journalKey),
    write: (value) => sessionStorage.setItem(journalKey, value),
    remove: () => sessionStorage.removeItem(journalKey),
  };

  const settingsDraft = untrack(
    () =>
      new SystemConfigDraftStore(current, {
        defaults: defaultConfig,
        load: () => getAdminConfigWithRevision(),
        // A draft never carries a credential value (FL-67): they are sent empty ("keep the stored
        // credential") and change only through their own dialogs.
        save: ({ config, expectedRevision }) =>
          updateAdminConfigWithRevision({
            adminConfigRevisionUpdateDto: { config: forConfigSave(config), expectedRevision },
          }),
        // Feature flags, the server config and every "saved" comparison follow the new baseline.
        onUpdated: (config) => eventManager.emit('SystemConfigUpdate', config),
        storage: journal,
      }),
  );
  setSystemConfigDraft(settingsDraft);
  systemConfigManager.value = cloneConfig(settingsDraft.baseline);
  // A draft left by a reload of this tab comes back before anything writes the journal again.
  settingsDraft.recover();

  // Checks before a save, registered here so they run whichever settings area is open (a draft
  // can change any page, including through an imported file).
  settingsDraft.registerGuard({
    keys: ['passwordLogin', 'oauth'],
    beforeSave: async () => {
      const { oauth, passwordLogin } = settingsDraft.draft;
      if (oauth.enabled || passwordLogin.enabled) {
        return true;
      }
      return Boolean(await modalManager.show(AuthDisableLoginConfirmModal));
    },
  });
  settingsDraft.registerGuard({
    keys: ['machineLearning'],
    beforeSave: () => {
      clampEnhancedVideoFrames(settingsDraft.draft.machineLearning);
      return true;
    },
  });

  // Keep the journal in step with the draft so a reload can recover it.
  $effect(() => {
    void settingsDraft.changes;
    void settingsDraft.revision;
    untrack(() => settingsDraft.persistJournal());
  });

  onMount(() => {
    // Another administrator (or another tab) saved settings: follow them. An unsaved draft is
    // carried onto them, or marked stale when it changes the same settings.
    return websocketEvents.on('on_config_update', () => void settingsDraft.refresh());
  });

  const serverSections: SettingsHostSection[] = $derived([
    {
      admin: true,
      component: AuthSettings,
      title: $t('frameleaf_cc_section_signin'),
      subtitle: $t('frameleaf_cc_section_signin_description'),
      key: 'authentication',
      icon: mdiLockOutline,
    },
    {
      admin: true,
      // Drawn by the Backup area (FL-362); listed here so search and older links still find it.
      title: $t('frameleaf_cc_section_database_backup'),
      subtitle: $t('frameleaf_cc_section_database_backup_description'),
      key: 'backup',
      icon: mdiBackupRestore,
    },
    {
      admin: true,
      component: ImageSettings,
      title: $t('frameleaf_cc_section_previews'),
      subtitle: $t('frameleaf_cc_section_previews_description'),
      key: 'image',
      icon: mdiImageOutline,
    },
    {
      // FL-366: Library care → File checks, the one checker (Maintenance's address opens it too).
      admin: true,
      component: FileChecks,
      title: $t('frameleaf_cc_section_health'),
      subtitle: $t('frameleaf_cc_section_health_description'),
      key: 'integrity-checks',
      icon: mdiFileCheckOutline,
    },
    {
      admin: true,
      component: LibrarySettings,
      title: $t('admin.library_settings'),
      subtitle: $t('admin.library_settings_description'),
      key: 'external-library',
      icon: mdiBookshelf,
    },
    {
      admin: true,
      component: LoggingSettings,
      title: $t('frameleaf_cc_section_diagnostics'),
      subtitle: $t('frameleaf_cc_section_diagnostics_description'),
      key: 'logging',
      icon: mdiFileDocumentOutline,
    },
    // FL-366: Search & intelligence, one page per feature under the area's landing page.
    {
      admin: true,
      component: VisualSearch,
      title: $t('frameleaf_cc_section_visual_search'),
      subtitle: $t('frameleaf_cc_section_visual_search_description'),
      key: 'smart-search',
      icon: mdiImageSearchOutline,
    },
    {
      admin: true,
      component: Faces,
      title: $t('frameleaf_cc_section_faces'),
      subtitle: $t('frameleaf_cc_section_faces_description'),
      key: 'faces',
      icon: mdiFaceRecognition,
    },
    {
      admin: true,
      component: TextInPhotos,
      title: $t('frameleaf_cc_section_documents'),
      subtitle: $t('frameleaf_cc_section_documents_description'),
      key: 'documents',
      icon: mdiTextRecognition,
    },
    {
      admin: true,
      component: LockedDetection,
      title: $t('frameleaf_cc_section_locked_detection'),
      subtitle: $t('frameleaf_cc_section_locked_detection_description'),
      key: 'sensitive-detection',
      icon: mdiLockOutline,
    },
    {
      admin: true,
      component: Descriptions,
      title: $t('frameleaf_cc_section_descriptions'),
      subtitle: $t('frameleaf_cc_section_descriptions_description'),
      key: 'descriptions',
      icon: mdiRobotOutline,
    },
    {
      // FL-366: Library care → Duplicates (look-alike matching; exact copies are merged on Merge older copies).
      admin: true,
      component: Duplicates,
      title: $t('frameleaf_cc_section_duplicates'),
      subtitle: $t('frameleaf_cc_section_duplicates_description'),
      key: 'duplicates',
      icon: mdiContentCopy,
    },
    {
      admin: true,
      component: MapSettings,
      title: $t('frameleaf_cc_section_maps'),
      subtitle: $t('frameleaf_cc_section_maps_description'),
      key: 'location',
      icon: mdiMapMarkerOutline,
    },
    {
      admin: true,
      component: MigrationSettingsSection,
      title: $t('admin.frameleaf_migration_settings_title'),
      subtitle: $t('admin.frameleaf_migration_settings_subtitle'),
      key: 'migration',
      icon: mdiTruckOutline,
    },
    {
      admin: true,
      component: NightlyTasksSettings,
      title: $t('frameleaf_computers_page_overnight'),
      subtitle: $t('frameleaf_computers_page_overnight_description'),
      key: 'nightly-tasks',
      icon: mdiClockOutline,
    },
    {
      admin: true,
      component: NotificationSettings,
      title: $t('frameleaf_cc_section_email'),
      subtitle: $t('frameleaf_cc_section_email_description'),
      key: 'notifications',
      icon: mdiBellOutline,
    },
    {
      admin: true,
      component: ServerSettings,
      title: $t('frameleaf_cc_section_identity'),
      subtitle: $t('frameleaf_cc_section_identity_description'),
      key: 'server',
      icon: mdiServerOutline,
    },
    {
      admin: true,
      component: SmartAlbums,
      title: $t('frameleaf_cc_section_smart_albums'),
      subtitle: $t('frameleaf_cc_section_smart_albums_description'),
      key: 'smart-albums',
      icon: mdiImageMultipleOutline,
    },
    {
      admin: true,
      component: StorageTemplateSettings,
      title: $t('frameleaf_cc_section_organization'),
      subtitle: $t('frameleaf_cc_section_organization_description'),
      key: 'storage-template',
      icon: mdiFolderOutline,
    },
    {
      admin: true,
      component: ThemeSettings,
      title: $t('frameleaf_cc_section_branding'),
      subtitle: $t('frameleaf_cc_section_branding_description'),
      key: 'theme',
      icon: mdiPaletteOutline,
    },
    {
      admin: true,
      component: TrashSettings,
      title: $t('frameleaf_cc_section_retention'),
      subtitle: $t('frameleaf_cc_section_retention_description'),
      key: 'trash',
      icon: mdiTrashCanOutline,
    },
    {
      admin: true,
      component: UserSettings,
      title: $t('admin.user_settings'),
      subtitle: $t('admin.user_settings_description'),
      key: 'user-settings',
      icon: mdiAccountOutline,
    },
    {
      admin: true,
      component: NewVersionCheckSettings,
      title: $t('frameleaf_cc_section_versions'),
      subtitle: $t('frameleaf_cc_section_versions_description'),
      key: 'version-check',
      icon: mdiUpdate,
    },
    {
      admin: true,
      component: FFmpegSettings,
      title: $t('frameleaf_cc_section_playback'),
      subtitle: $t('frameleaf_cc_section_playback_description'),
      key: 'video-transcoding',
      icon: mdiVideoOutline,
    },
    // FL-422: Editing & playback's Editing group (settings-catalog.mjs:740-822).
    {
      admin: true,
      component: EditedMasters,
      title: $t('frameleaf_cc_section_masters'),
      subtitle: $t('frameleaf_cc_section_masters_description'),
      key: 'masters',
      icon: mdiImageEditOutline,
    },
    {
      admin: true,
      component: AiRestoration,
      title: $t('frameleaf_cc_section_restoration'),
      subtitle: $t('frameleaf_cc_section_restoration_description'),
      key: 'restoration',
      icon: mdiAutoFix,
    },
    {
      admin: true,
      component: StudioStatus,
      title: $t('frameleaf_cc_section_studio'),
      subtitle: $t('frameleaf_cc_section_studio_description'),
      key: 'studio',
      icon: mdiMovieEditOutline,
    },
    {
      // The template's Server & updates → "Configuration transfer" (`ConfigurationTransfer.jsx`).
      admin: true,
      component: ConfigurationTransferSection,
      title: $t('frameleaf_cc_config_transfer_title'),
      subtitle: $t('frameleaf_cc_config_transfer_description'),
      key: 'configuration',
      icon: mdiSwapVertical,
    },
    // FL-71: the old administration pages, as sections drawn by `sections/SectionBody.svelte`.
    ...(
      [
        ['deduplication', 'frameleaf_cc_section_deduplication', mdiContentDuplicate],
        ['enrichment-care', 'frameleaf_cc_section_enrichment', mdiAutoFix],
        // FL-421: Notifications → What needs your attention.
        ['signals', 'frameleaf_cc_section_signals', mdiBellAlertOutline],
        // FL-364: Computers & background work. Computers also answers the addresses of the pages it
        // replaced (Workers & endpoints, Render workers).
        ['computers', 'frameleaf_computers_page_computers', mdiDesktopTowerMonitor],
        ['routing', 'frameleaf_computers_page_routing', mdiTransitConnectionVariant],
        ['queues', 'frameleaf_computers_page_queues', mdiTrayFull],
        ['hardware', 'frameleaf_computers_page_hardware', mdiExpansionCard],
        ['cloud-processing', 'frameleaf_cc_section_cloud_processing', mdiCloudSyncOutline],
        // FL-154..FL-156: Frameleaf Cloud → Account & link, Plan and Licence (settings-catalog.mjs:1713-1752).
        ['cloud-account', 'frameleaf_cc_section_cloud_account', mdiLinkVariant],
        ['cloud-plan', 'frameleaf_cc_section_cloud_plan', mdiCreditCardOutline],
        ['cloud-license', 'frameleaf_cc_section_cloud_license', mdiCertificateOutline],
        // FL-161: Frameleaf Cloud → Remote access, who can connect and what the relay carries.
        ['cloud-remote', 'frameleaf_cc_section_cloud_remote', mdiEarth],
        // FL-160: Frameleaf Cloud → Cloud backup.
        ['cloud-backup', 'frameleaf_cc_section_cloud_backup', mdiCloudUploadOutline],
        // FL-158: Access & security → Sign in with Frameleaf, beside the own-provider form.
        ['frameleaf-signin', 'frameleaf_cc_section_frameleaf_signin', mdiShieldAccountOutline],
        ['mode', 'frameleaf_cc_section_mode', mdiWrench],
        ['backups', 'frameleaf_cc_section_backups', mdiDatabaseOutline],
        ['integrity', 'frameleaf_cc_section_integrity', mdiFileCheckOutline],
        ['accounts', 'frameleaf_cc_section_accounts', mdiAccountMultipleOutline],
      ] as const
    ).map(([key, titleKey, icon]) => ({
      admin: true,
      key,
      title: $t(titleKey),
      subtitle: $t(`${titleKey}_description` as Translations),
      icon,
      keywords: (SETTINGS_SECTION_KEYWORDS[key] ?? []).map((keyword) => $t(keyword)),
    })),
  ]);
  // Server sections first, so a key both lists use (notifications) resolves to the server's form.
  const sections = $derived([...serverSections, ...personal]);

  const { CopyToClipboard, Upload, Download } = $derived(
    getSystemConfigActions($t, featureFlagsManager.value, settingsDraft.baseline, {
      onImport: (text) => settingsDraft.importFile(text),
    }),
  );
</script>

<CommandPaletteDefaultProvider name={$t('admin.system_settings')} actions={[CopyToClipboard, Upload, Download]} />

<SettingsHost {sections} {sectionBody} disabled={featureFlagsManager.value.configFile}>
  {#snippet areaPanel(area)}
    {#if area === 'libraries'}
      <LibrariesArea />
    {/if}
  {/snippet}
</SettingsHost>
