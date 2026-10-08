<script lang="ts">
  /**
   * The Frameleaf Command Center (FL-71), ported from the design template's `CommandCenter.jsx`
   * shell (lines 568-852): one full-screen settings screen for every account. The navigation has
   * the "Settings" title with its collapse control, "Back to library", the areas grouped as in
   * `settings-catalog.mjs` and the account foot; the context bar names the server, the "Viewing"
   * scope and the settings search; the page shows one area's section directory, or one section
   * with its breadcrumb. An area or section the account may not use is not offered at all: server
   * settings are only in the section list the page passes for an administrator.
   *
   * URL contract (`commandCenterUrl`): `?area=<id>&section=<key>`. Older `?isOpen=<key>` (and
   * `?open=oauth`) links still open the section that key names (nested groups keep reading `isOpen` through the accordion
   * manager), and `?scope=` carries the "Viewing" choice between areas.
   *
   * FL-66: every server section edits one settings draft (`system-config-draft.svelte.ts`), so
   * changes made in one area are kept while another is open. Areas with unsaved changes are marked
   * in the navigation, the draft's messages sit under the heading, and the settings bar saves every
   * page together. "Change history" lists the saved settings changes the server recorded.
   */
  import { searchShortcutHintKey } from '$lib/frameleaf/search-shortcuts';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AnalyticsArea from '$lib/components/frameleaf/analytics/AnalyticsArea.svelte';
  import BackupDestinationsSection from '$lib/components/frameleaf/cloud/BackupDestinationsSection.svelte';
  import CloudTourHost from '$lib/components/frameleaf/cloud/CloudTourHost.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import EmptyState from '$lib/components/frameleaf/EmptyState.svelte';
  import CommandCenterOverview from '$lib/components/frameleaf/settings/CommandCenterOverview.svelte';
  import { ownPreferencesPending } from '$lib/components/frameleaf/settings/own-preferences-pending.svelte';
  import SettingsChangeHistory from '$lib/components/frameleaf/settings/SettingsChangeHistory.svelte';
  import SettingsDirectory, { type DirectoryRow } from '$lib/components/frameleaf/settings/SettingsDirectory.svelte';
  import SettingsDraftNotices from '$lib/components/frameleaf/settings/SettingsDraftNotices.svelte';
  import SettingsOverline from '$lib/components/frameleaf/settings/SettingsOverline.svelte';
  import SettingsSaveBar from '$lib/components/frameleaf/settings/SettingsSaveBar.svelte';
  import UtilitiesArea from '$lib/components/frameleaf/settings/UtilitiesArea.svelte';
  import {
    AREA_TILE_COLORS,
    BACKUP_PAGES,
    backupPageFor,
    commandCenterUrl,
    honoursScope,
    isBackupSection,
    presentedArea,
    presentedAreaForSection,
    directoryGroup,
    isAreaAvailable,
    isScreenArea,
    resolveSettingsArea,
    resolveSettingsSection,
    searchSettingsSections,
    sectionScope,
    sectionsForArea,
    SETTINGS_AREAS,
    SETTINGS_GROUP_ORDER,
    type SettingsAreaId,
    type SettingsGroupId,
    type SettingsHostSection,
  } from '$lib/frameleaf/settings-areas';
  import { motionFade, motionSlide, reveal } from '$lib/frameleaf/motion';
  import { DURATION } from '$lib/frameleaf/tokens';
  import { sectionForConfigPath } from '$lib/frameleaf/system-config-draft';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { LIBRARY_CARE_TOOLS, libraryCareToolsFor, utilityTool, utilityToolsFor } from '$lib/frameleaf/utilities';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { Route } from '$lib/route';
  import { sidebarCollapsed } from '$lib/stores/preferences.store';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import {
    AnalyticsScopeKind,
    getAdminConfigHistory,
    getMyPreferenceHistory,
    getAnalyticsScopes,
    type AnalyticsScopeOptionDto,
    type SystemConfigHistoryEntryDto,
    type UserPreferenceHistoryEntryDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAccountMultipleOutline,
    mdiAccountOutline,
    mdiDeleteOutline,
    mdiViewDashboardOutline,
    mdiWrenchOutline,
    mdiArrowLeft,
    mdiBackupRestore,
    mdiBellOutline,
    mdiChartTimelineVariant,
    mdiChevronDoubleLeft,
    mdiChevronDoubleRight,
    mdiChevronRight,
    mdiClose,
    mdiCloudOutline,
    mdiDesktopTowerMonitor,
    mdiFolderOutline,
    mdiHarddisk,
    mdiHistory,
    mdiImageSearchOutline,
    mdiMagnify,
    mdiTrayArrowDown,
    mdiMovieOpenOutline,
    mdiServerOutline,
    mdiShieldCheckOutline,
    mdiShieldLockOutline,
    mdiTools,
  } from '@mdi/js';
  import { tick, untrack, type Snippet } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  let {
    sections,
    disabled = false,
    areaPanel,
    sectionBody,
  }: {
    sections: SettingsHostSection[];
    disabled?: boolean;
    /** An area's own manager inside the command center (the Libraries manager). */
    areaPanel?: Snippet<[SettingsAreaId]>;
    /** Draws an account section that has no `component` of its own. */
    sectionBody?: Snippet<[SettingsHostSection]>;
  } = $props();

  const isAdmin = $derived(authManager.user.isAdmin);
  /** FL-196: "Take the tour again …" after the linked-server tour was skipped. */
  let tourNotice = $state('');
  const settingsDraft = getSystemConfigDraft();

  const areaCopy: Record<SettingsAreaId, { title: string; description: string; icon: string }> = $derived({
    overview: {
      title: $t('frameleaf_settings_area_overview'),
      description: $t('frameleaf_settings_area_overview_description'),
      icon: mdiViewDashboardOutline,
    },
    analytics: {
      title: $t('frameleaf_settings_area_analytics'),
      description: $t('frameleaf_settings_area_analytics_description'),
      icon: mdiChartTimelineVariant,
    },
    backups: {
      title: $t('frameleaf_settings_area_backups'),
      description: $t('frameleaf_settings_area_backups_description'),
      icon: mdiBackupRestore,
    },
    storage: {
      title: $t('frameleaf_settings_area_storage'),
      description: $t('frameleaf_settings_area_storage_description'),
      icon: mdiHarddisk,
    },
    backup: {
      title: $t('frameleaf_settings_area_backup'),
      description: $t('frameleaf_settings_area_backup_description'),
      // Not Backup's icon: this area is imports and preservation (design review finding 66).
      icon: mdiTrayArrowDown,
    },
    intelligence: {
      title: $t('frameleaf_settings_area_intelligence'),
      description: $t('frameleaf_settings_area_intelligence_description'),
      icon: mdiImageSearchOutline,
    },
    editing: {
      title: $t('frameleaf_settings_area_editing'),
      description: $t('frameleaf_settings_area_editing_description'),
      icon: mdiMovieOpenOutline,
    },
    care: {
      title: $t('frameleaf_settings_area_care'),
      description: $t('frameleaf_settings_area_care_description'),
      icon: mdiShieldCheckOutline,
    },
    processing: {
      title: $t('frameleaf_settings_area_processing'),
      description: $t('frameleaf_settings_area_processing_description'),
      icon: mdiDesktopTowerMonitor,
    },
    // FL-154: the template's Frameleaf Cloud area (settings-catalog.mjs:125-131).
    cloud: {
      title: $t('frameleaf_settings_area_cloud'),
      description: $t('frameleaf_settings_area_cloud_description'),
      icon: mdiCloudOutline,
    },
    security: {
      title: $t('frameleaf_settings_area_security'),
      description: $t('frameleaf_settings_area_security_description'),
      icon: mdiShieldLockOutline,
    },
    notifications: {
      title: $t('frameleaf_settings_area_notifications'),
      description: $t('frameleaf_settings_area_notifications_description'),
      icon: mdiBellOutline,
    },
    server: {
      title: $t('frameleaf_settings_area_server'),
      description: $t('frameleaf_settings_area_server_description'),
      icon: mdiServerOutline,
    },
    sharing: {
      title: $t('frameleaf_settings_area_sharing'),
      description: $t('frameleaf_settings_area_sharing_description'),
      icon: mdiAccountMultipleOutline,
    },
    maintenance: {
      title: $t('frameleaf_settings_area_maintenance'),
      description: $t('frameleaf_settings_area_maintenance_description'),
      icon: mdiWrenchOutline,
    },
    users: {
      title: $t('frameleaf_settings_area_users'),
      description: $t('frameleaf_settings_area_users_description'),
      icon: mdiAccountMultipleOutline,
    },
    trash: {
      title: $t('frameleaf_settings_area_trash'),
      description: $t('frameleaf_settings_area_trash_description'),
      icon: mdiDeleteOutline,
    },
    preferences: {
      title: $t('frameleaf_settings_area_preferences'),
      description: $t('frameleaf_settings_area_preferences_description'),
      icon: mdiAccountOutline,
    },
    libraries: {
      title: $t('frameleaf_settings_area_libraries'),
      description: $t('frameleaf_settings_area_libraries_description'),
      icon: mdiFolderOutline,
    },
    utilities: {
      title: $t('utilities'),
      description: $t('frameleaf_utilities_description'),
      icon: mdiTools,
    },
    history: {
      title: $t('frameleaf_settings_area_history'),
      description: $t('frameleaf_settings_area_history_description'),
      icon: mdiHistory,
    },
  });

  const groupCopy: Record<SettingsGroupId, string> = $derived({
    command: $t('frameleaf_settings_group_command'),
    library: $t('frameleaf_settings_group_library'),
    server: $t('frameleaf_settings_group_server'),
    personal: $t('frameleaf_settings_group_personal'),
  });

  /** Areas this account may open: every area with a section it is offered, or a screen of its own. */
  const visibleAreas = $derived(
    SETTINGS_AREAS.filter(
      (item) =>
        isAreaAvailable(item, isAdmin) &&
        (isScreenArea(item.id) ||
          item.id === 'libraries' ||
          // Library care always lists the repair tools the account may run.
          item.id === 'care' ||
          sectionsForArea(sections, item.id).length > 0),
    ),
  );

  // Older links name a section with `isOpen`; the sign-in provider section also answers `?open=oauth`
  // and the provider's own return to this page (FL-67).
  const legacyOpen = $derived(
    [
      page.url.searchParams.get('isOpen'),
      page.url.searchParams.get('open'),
      !page.url.searchParams.has('area') && (page.url.searchParams.has('code') || page.url.searchParams.has('error'))
        ? 'oauth'
        : null,
    ]
      .filter(Boolean)
      .join(' '),
  );
  const requestedArea = $derived(
    resolveSettingsArea({ area: page.url.searchParams.get('area'), isOpen: legacyOpen, isAdmin }),
  );
  // An area this account may not open falls back to the first one it may. This is the area the
  // address names; `area` below is the one the page is shown in.
  const addressArea = $derived(
    visibleAreas.some((item) => item.id === requestedArea) ? requestedArea : (visibleAreas[0]?.id ?? 'utilities'),
  );
  const selectedKey = $derived(
    resolveSettingsSection(addressArea, { section: page.url.searchParams.get('section'), isOpen: legacyOpen }),
  );
  const selected = $derived(sectionsForArea(sections, addressArea).find((section) => section.key === selectedKey));
  /** A repair tool opened from Library care stays under Library care (`&from=care`). */
  const careTool = $derived.by(() => {
    if (addressArea !== 'utilities' || page.url.searchParams.get('from') !== 'care') {
      return;
    }
    const tool = utilityTool(page.url.searchParams.get('section'));
    return tool && LIBRARY_CARE_TOOLS.includes(tool.id) && visibleAreas.some((item) => item.id === 'care')
      ? tool
      : undefined;
  });
  /**
   * The area the page is shown in: the one its address names, except that every backup page is part
   * of Backup (design review finding 66) and a repair tool opened from Library care stays there.
   */
  const area = $derived(careTool ? 'care' : presentedArea(addressArea, selected?.key));
  const backupPage = $derived(area === 'backups' ? backupPageFor(addressArea, selected?.key) : undefined);
  const areaDefinition = $derived(SETTINGS_AREAS.find((item) => item.id === area));
  /** The sections listed under the shown area: Backup's pages are listed only under Backup. */
  const areaSections = $derived(
    sectionsForArea(sections, area).filter((section) => !isBackupSection(area, section.key)),
  );
  /**
   * Sections that are managers or administration tools with their own grouped containers, rather
   * than one grouped list of settings: they take the page width without a card around their cards
   * (command-center.css:1710-1717). Section D of the Sept 24 port plan: render workers, workers and
   * ML destinations, deduplication, maintenance, enrichment and repair queues.
   */
  const MANAGER_SECTIONS = [
    'accounts',
    'contents',
    'queues',
    'workers',
    'routing',
    'render-workers',
    'cloud-processing',
    'hardware',
    // FL-155..FL-158: the Frameleaf Cloud pages draw their own cards (frameleaf-cloud.css:3-7).
    'cloud-account',
    'cloud-plan',
    'cloud-license',
    'cloud-remote',
    'cloud-backup',
    'frameleaf-signin',
    'deduplication',
    'mode',
    'backups',
    'integrity',
    'enrichment-care',
    'repair',
  ];
  // A page named like its area does not repeat the name as a breadcrumb (CommandCenter.jsx:721-731):
  // the overline names the area's group instead.
  const breadcrumb = $derived(selected !== undefined && selected.title !== areaCopy[area].title);
  // As in the template, the Users manager and the Job manager carry their own headings.
  const ownHeading = $derived(area === 'users' || (area === 'processing' && selected?.key === 'queues'));

  /** The navigation's pages under the current area: its sections, or the utility tools. */
  const utilityTools = $derived(utilityToolsFor(isAdmin));
  type NavPage = { key: string; title: string; area: SettingsAreaId; section?: string };
  /** Backup's pages: off-site copies, then the schedule and the backups this account is offered. */
  const backupPages = $derived(
    BACKUP_PAGES.flatMap((item): NavPage[] => {
      if (!item.section) {
        return [{ key: item.id, title: $t('frameleaf_cc_backup_page_destinations'), area: item.area }];
      }
      const section = sections.find((candidate) => candidate.admin && candidate.key === item.section);
      return section ? [{ key: item.id, title: section.title, area: item.area, section: item.section }] : [];
    }),
  );
  const children = $derived.by((): NavPage[] => {
    if (area === 'utilities') {
      return utilityTools.map((tool) => ({ key: tool.id, title: $t(tool.titleKey), area, section: tool.id }));
    }
    if (area === 'backups') {
      return backupPages;
    }
    if (area === 'libraries' || area === 'trash') {
      return [];
    }
    return areaSections.map((section) => ({ key: section.key, title: section.title, area, section: section.key }));
  });
  /** The area directory's rows: its sections, and for Library care the repair tools (CommandCenter.jsx:2705-2722). */
  const directoryRows = $derived.by((): DirectoryRow[] => {
    const group = (key: string) => {
      const id = directoryGroup(area, key);
      return id ? $t(`frameleaf_cc_group_${id}` as Translations) : undefined;
    };
    const rows: DirectoryRow[] = areaSections.map((section) => ({
      id: `${section.admin ? 'server' : 'account'}:${section.key}`,
      title: section.title,
      description: section.subtitle,
      group: group(section.key),
      scope: sectionScope(section),
      // FL-168: every section row carries its icon, as the prototype's SectionDirectory draws it
      icon: section.icon,
      onSelect: () => void navigate(area, section.key),
    }));
    if (area === 'care') {
      for (const tool of libraryCareToolsFor(isAdmin)) {
        rows.push({
          id: `utilities:${tool.id}`,
          title: $t(tool.titleKey),
          description: $t(tool.descriptionKey),
          group: $t('frameleaf_cc_group_tools'),
          icon: tool.icon,
          // The tool stays under Library care: its breadcrumb and the navigation say so (finding 67).
          onSelect: () => void navigate('utilities', tool.id, { from: 'care' }),
        });
      }
    }
    return rows;
  });
  const activeChild = $derived(
    area === 'utilities'
      ? utilityTool(page.url.searchParams.get('section'))?.id
      : area === 'backups'
        ? backupPage
        : careTool
          ? undefined
          : selected?.key,
  );

  let query = $state('');
  const searching = $derived(query.trim().length > 0);
  const areaOfSection = (section: SettingsHostSection) =>
    SETTINGS_AREAS.find((item) =>
      section.admin ? item.sections.includes(section.key) : item.personal?.includes(section.key),
    )?.id;

  type SearchResult = {
    id: string;
    area: SettingsAreaId;
    section?: string;
    overline: string;
    title: string;
    subtitle: string;
  };
  const results = $derived.by((): SearchResult[] => {
    if (!searching) {
      return [];
    }
    const needle = query.trim().toLowerCase();
    const areaResults = visibleAreas
      .filter((item) => `${areaCopy[item.id].title} ${areaCopy[item.id].description}`.toLowerCase().includes(needle))
      .map((item) => ({
        id: `area:${item.id}`,
        area: item.id,
        overline: groupCopy[item.group],
        title: areaCopy[item.id].title,
        subtitle: areaCopy[item.id].description,
      }));
    const sectionResults = searchSettingsSections(sections, query).flatMap((section): SearchResult[] => {
      const owner = areaOfSection(section);
      return owner && visibleAreas.some((item) => item.id === owner)
        ? [
            {
              id: `${owner}:${section.key}`,
              area: owner,
              section: section.key,
              overline: areaCopy[presentedArea(owner, section.key)].title,
              title: section.title,
              subtitle: section.subtitle,
            },
          ]
        : [];
    });
    const toolResults = utilityTools
      .filter((tool) => `${$t(tool.titleKey)} ${$t(tool.descriptionKey)}`.toLowerCase().includes(needle))
      .map((tool) => ({
        id: `utilities:${tool.id}`,
        area: 'utilities' as const,
        section: tool.id,
        overline: areaCopy.utilities.title,
        title: $t(tool.titleKey),
        subtitle: $t(tool.descriptionKey),
      }));
    return [...areaResults, ...sectionResults, ...toolResults];
  });

  /** Settings pages (by section) holding unsaved changes of the settings draft. */
  const pendingSections = $derived(
    new Set((settingsDraft?.changes ?? []).flatMap((change) => sectionForConfigPath(change.path) ?? [])),
  );
  /**
   * Areas holding unsaved changes: the settings draft's, and the page on screen while one of the
   * account's own preference forms has changes (design review finding 70).
   */
  const pendingAreas = $derived.by(() => {
    const areas = new Set<SettingsAreaId>();
    for (const key of pendingSections) {
      const owner = presentedAreaForSection(key);
      if (owner) {
        areas.add(owner);
      }
    }
    if (ownPreferencesPending.dirty) {
      areas.add(area);
    }
    return areas;
  });
  const isChildPending = (child: NavPage) =>
    (child.section !== undefined && pendingSections.has(child.section)) ||
    (ownPreferencesPending.dirty && activeChild === child.key);

  // The settings change history, loaded with the page, after every save and when its area opens.
  let history = $state<SystemConfigHistoryEntryDto[] | null>(null);
  let historyError = $state(false);
  let historyRequest = 0;

  const loadHistory = async () => {
    const request = ++historyRequest;
    try {
      const { entries } = await getAdminConfigHistory();
      if (request === historyRequest) {
        history = entries;
        historyError = false;
      }
    } catch {
      if (request === historyRequest) {
        historyError = true;
      }
    }
  };

  $effect(() => {
    if (!settingsDraft) {
      return;
    }
    void settingsDraft.revision;
    untrack(() => void loadHistory());
  });

  $effect(() => {
    if (settingsDraft && area === 'history') {
      untrack(() => void loadHistory());
    }
  });

  // FL-71 (CC-10): every account's own preference history, read when the area opens.
  let preferenceHistory = $state<UserPreferenceHistoryEntryDto[] | null>(null);
  let preferenceHistoryError = $state(false);
  const loadPreferenceHistory = async () => {
    try {
      preferenceHistory = (await getMyPreferenceHistory()).entries;
      preferenceHistoryError = false;
    } catch {
      preferenceHistoryError = true;
    }
  };
  $effect(() => {
    if (area === 'history') {
      untrack(() => void loadPreferenceHistory());
    }
  });

  // The "Viewing" choices an administrator has: the server, each account and each library.
  let scopes = $state<AnalyticsScopeOptionDto[]>([]);
  $effect(() => {
    if (!isAdmin) {
      return;
    }
    let cancelled = false;
    void getAnalyticsScopes()
      .then((result) => {
        if (!cancelled) {
          scopes = result.scopes;
        }
      })
      .catch(() => {
        if (!cancelled) {
          scopes = [];
        }
      });
    return () => {
      cancelled = true;
    };
  });
  const scope = $derived(page.url.searchParams.get('scope') ?? 'all');
  const SCOPE_GROUPS = [AnalyticsScopeKind.Host, AnalyticsScopeKind.Account, AnalyticsScopeKind.Library] as const;
  const scopeGroups = $derived(
    SCOPE_GROUPS.map((kind) => ({ kind, options: scopes.filter((option) => option.kind === kind) })).filter(
      (group) => group.options.length > 0,
    ),
  );

  // CC-4: the template's `settings.serverName` (CommandCenter.jsx:657), which an administrator sets in
  // Server identity; saved drafts apply at once. An unnamed server reads "This server", never its
  // host and port (design review, section 1 item 4).
  const serverName = $derived(
    settingsDraft?.baseline?.server?.name?.trim() ||
      serverConfigManager.value.serverName?.trim() ||
      $t('frameleaf_cc_this_server'),
  );

  /**
   * The "Viewing" picker is offered only where the page reads it: Overview, Library analytics,
   * Library care and the Job manager (design review finding 65). Elsewhere a quiet label says who
   * the page applies to.
   */
  const scoped = $derived(isAdmin && scopeGroups.length > 0 && honoursScope(addressArea, selected?.key));
  const appliesToAccount = $derived(
    careTool || addressArea === 'utilities'
      ? true
      : selected
        ? !selected.admin
        : (areaDefinition?.sections.length ?? 0) === 0 && !areaDefinition?.adminOnly,
  );

  // The template's library-scope note (CommandCenter.jsx:772-779): queues filter by account, not library.
  const libraryScope = $derived(
    scopes.find((option) => option.kind === AnalyticsScopeKind.Library && option.value === scope),
  );
  const libraryScopeOwner = $derived(
    libraryScope
      ? scopes.find((option) => option.kind === AnalyticsScopeKind.Account && option.userId === libraryScope.userId)
          ?.label
      : undefined,
  );

  const areaTitles = $derived(
    Object.fromEntries(Object.entries(areaCopy).map(([id, copy]) => [id, copy.title])) as Record<string, string>,
  );
  const serverSections = $derived(sections.filter((section) => section.admin));

  let main = $state<HTMLElement>();

  /** Moves focus to the page's heading, so a keyboard or screen reader hears that the page changed. */
  const focusHeading = async () => {
    await tick();
    const heading = main?.querySelector('h1');
    if (heading instanceof HTMLElement) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  };

  /** Opens an area, or one of its sections, keeping the "Viewing" scope. */
  const navigate = async (next: SettingsAreaId, section?: string, params: Record<string, string> = {}) => {
    query = '';
    sidebarStore.isOpen = false;
    const currentScope = page.url.searchParams.get('scope') ?? undefined;
    await goto(commandCenterUrl(next, section, { ...params, scope: currentScope }), { keepFocus: true });
    await focusHeading();
  };

  // The page scrolls inside `.cc-main`, which the router does not reset: a new page starts at its top
  // (design review finding 71). Also covers Back and Forward.
  const pageKey = $derived(`${addressArea}:${selectedKey ?? ''}`);
  const scrollKey = $derived(`${pageKey}:${addressArea === 'utilities' ? page.url.searchParams.get('section') : ''}`);
  $effect(() => {
    void scrollKey;
    if (main) {
      main.scrollTop = 0;
    }
  });

  // Search keyboard path: Down from the field moves into the results, Enter opens the first one, and
  // the arrow keys walk the list.
  let resultList = $state<HTMLElement>();
  const resultButtons = () => [...(resultList?.querySelectorAll<HTMLElement>('button') ?? [])];
  const onSearchKeydown = (event: KeyboardEvent) => {
    if (!searching || results.length === 0) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      resultButtons()[0]?.focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void navigate(results[0].area, results[0].section);
    }
  };
  const onResultsKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    const buttons = resultButtons();
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    if (event.key === 'ArrowUp' && index <= 0) {
      document.querySelector<HTMLElement>('#settings-search')?.focus();
      return;
    }
    buttons[Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))]?.focus();
  };

  const changeScope = async (value: string) => {
    const url = new URL(page.url);
    if (value === 'all') {
      url.searchParams.delete('scope');
    } else {
      url.searchParams.set('scope', value);
    }
    await goto(`${url.pathname}${url.search}`, { replaceState: true, noScroll: true, keepFocus: true });
  };
</script>

<div class="command-center" class:cc-collapsed={$sidebarCollapsed} class:cc-nav-open={sidebarStore.isOpen}>
  <aside class="cc-nav">
    <div class="cc-nav-title">
      <span>{$t('settings')}</span>
      <button
        type="button"
        aria-label={$sidebarCollapsed ? $t('frameleaf_cc_expand') : $t('frameleaf_cc_collapse')}
        title={$sidebarCollapsed ? $t('frameleaf_cc_expand') : $t('frameleaf_cc_collapse')}
        onclick={() => ($sidebarCollapsed = !$sidebarCollapsed)}
      >
        <Icon icon={$sidebarCollapsed ? mdiChevronDoubleRight : mdiChevronDoubleLeft} size="1.125rem" aria-hidden />
      </button>
    </div>
    <a class="cc-back" href={Route.photos()} title={$t('frameleaf_cc_back')}>
      <Icon icon={mdiArrowLeft} size="1.125rem" aria-hidden />
      <span>{$t('frameleaf_cc_back')}</span>
    </a>
    <nav id="settings-navigation" aria-label={$t('frameleaf_settings_nav_label')}>
      {#each SETTINGS_GROUP_ORDER.filter((group) => visibleAreas.some((item) => item.group === group)) as group (group)}
        <div class="cc-nav-group">
          <p>{groupCopy[group]}</p>
          {#each visibleAreas.filter((item) => item.group === group) as item (item.id)}
            <button
              type="button"
              class="area"
              class:selected={item.id === area}
              aria-label={areaCopy[item.id].title}
              title={areaCopy[item.id].title}
              aria-current={item.id === area ? 'page' : undefined}
              onclick={() => navigate(item.id)}
            >
              <!-- FL-76: a coloured icon tile per area, like System Settings (apple-style.css:565-640). -->
              <span class="tile fl-continuous-corners" style:--tile={AREA_TILE_COLORS[item.id]}>
                <Icon icon={areaCopy[item.id].icon} size="16" aria-hidden />
              </span>
              <span>{areaCopy[item.id].title}</span>
              {#if pendingAreas.has(item.id)}
                <span class="pending" title={$t('unsaved_change')}></span>
              {/if}
            </button>
            {#if item.id === area && !$sidebarCollapsed && children.length > 0}
              <div
                class="cc-nav-children"
                aria-label={$t('frameleaf_settings_nav_pages', { values: { area: areaCopy[item.id].title } })}
                transition:motionSlide={{ duration: DURATION.base }}
              >
                {#each children as child (child.key)}
                  <button
                    type="button"
                    aria-current={activeChild === child.key ? 'page' : undefined}
                    class:has-pending={isChildPending(child)}
                    onclick={() => navigate(child.area, child.section)}>{child.title}</button
                  >
                {/each}
              </div>
            {/if}
          {/each}
        </div>
      {/each}
    </nav>
    <div class="cc-nav-foot">
      <Icon icon={isAdmin ? mdiShieldCheckOutline : mdiAccountOutline} size="1.125rem" aria-hidden />
      <span>
        {isAdmin ? $t('frameleaf_cc_administrator') : authManager.user.name}
        <small>{isAdmin ? serverName : $t('frameleaf_cc_own')}</small>
      </span>
    </div>
  </aside>
  {#if sidebarStore.isOpen}
    <button
      type="button"
      class="cc-nav-scrim"
      aria-label={$t('frameleaf_cc_close')}
      transition:motionFade={{ duration: DURATION.fade }}
      onclick={() => (sidebarStore.isOpen = false)}
    ></button>
  {/if}

  <div class="cc-body">
    <div class="cc-context-bar">
      <span class="cc-context">
        <Icon icon={mdiServerOutline} size="1rem" aria-hidden />
        {serverName}
        <span class="cc-context-divider">/</span>
        {$t('settings')}
      </span>
      {#if scoped}
        <label class="cc-account-scope">
          <span>{$t('frameleaf_cc_viewing')}</span>
          <select
            aria-label={$t('frameleaf_cc_scope')}
            value={scope}
            onchange={(event) => changeScope(event.currentTarget.value)}
          >
            {#each scopeGroups as group (group.kind)}
              <optgroup label={$t(`frameleaf_cc_scope_group_${group.kind}` as Translations)}>
                {#each group.options as option (option.value)}
                  <option value={option.value}
                    >{option.kind === AnalyticsScopeKind.Host ? $t('frameleaf_cc_server') : option.label}</option
                  >
                {/each}
              </optgroup>
            {/each}
          </select>
        </label>
      {:else if !isAdmin}
        <div class="cc-account-scope">
          <span>{$t('frameleaf_cc_viewing')}</span>
          <span>{$t('frameleaf_cc_own_library', { values: { name: authManager.user.name } })}</span>
        </div>
      {:else}
        <!-- An administrator outside the scoped pages: say who the page applies to instead of offering a picker it ignores. -->
        <p class="cc-account-scope cc-scope-fixed">
          {appliesToAccount ? $t('frameleaf_cc_scope_applies_account') : $t('frameleaf_cc_scope_applies_server')}
        </p>
      {/if}
      <label class="cc-search">
        <Icon icon={mdiMagnify} size="1rem" aria-hidden />
        <input
          id="settings-search"
          type="search"
          aria-label={$t('frameleaf_settings_search_label')}
          placeholder={$t('frameleaf_cc_search')}
          aria-controls={searching && results.length > 0 ? 'settings-search-results' : undefined}
          bind:value={query}
          onkeydown={onSearchKeydown}
        />
        <kbd>{$t(searchShortcutHintKey())}</kbd>
      </label>
    </div>

    <main class="cc-main" bind:this={main}>
      {#if searching}
        <header class="cc-page-heading">
          <SettingsOverline>{$t('frameleaf_cc_search_overline')}</SettingsOverline>
          <h1>{$t('frameleaf_cc_search_title')}</h1>
          <p>{$t('frameleaf_settings_search_results', { values: { count: results.length } })}</p>
        </header>
        {#if results.length > 0}
          <!-- svelte-ignore a11y_no_static_element_interactions (arrow keys walk the result buttons inside) -->
          <div
            class="cc-search-results"
            id="settings-search-results"
            bind:this={resultList}
            onkeydown={onResultsKeydown}
          >
            {#each results as result (result.id)}
              <button type="button" onclick={() => navigate(result.area, result.section)}>
                <Icon icon={areaCopy[result.area].icon} size="1.25rem" aria-hidden />
                <span>
                  <small>{result.overline}</small>
                  <strong>{result.title}</strong>
                  <span>{result.subtitle}</span>
                </span>
                <Icon icon={mdiChevronRight} size="1.125rem" aria-hidden />
              </button>
            {/each}
          </div>
        {:else}
          <EmptyState
            icon={mdiMagnify}
            title={$t('frameleaf_cc_no_results')}
            message={$t('frameleaf_cc_search_help')}
            action={{ label: $t('frameleaf_cc_clear'), onClick: () => (query = '') }}
          />
        {/if}
      {:else}
        {#if settingsDraft && disabled}
          <p class="cc-notice" role="alert">{$t('admin.config_set_by_file')}</p>
        {/if}
        {#if settingsDraft}
          <SettingsDraftNotices store={settingsDraft} />
        {/if}
        {#if libraryScopeOwner && addressArea === 'processing' && selected?.key === 'queues'}
          <p class="cc-subtle">{$t('frameleaf_cc_library_scope_note', { values: { name: libraryScopeOwner } })}</p>
        {/if}
        {#key pageKey}
          <div class="cc-page" in:reveal>
            {#if area === 'analytics'}
              <!-- As in the template, Library analytics carries its own heading instead of the area's. -->
              <AnalyticsArea />
            {:else if addressArea === 'utilities'}
              <UtilitiesArea />
            {:else if area === 'libraries'}
              <!-- The template hides the heading on the Libraries manager, which carries its own. -->
              {@render areaPanel?.(area)}
              {#each areaSections as section (section.key)}
                <section class="cc-section fl-continuous-corners" id="setting-{section.key}">
                  {#if section.component}
                    <section.component />
                  {:else}
                    {@render sectionBody?.(section)}
                  {/if}
                </section>
              {/each}
            {:else}
              {#if !ownHeading}
                <header class="cc-page-heading">
                  <SettingsOverline>
                    {#if selected && breadcrumb}
                      <button type="button" onclick={() => navigate(area)}>{areaCopy[area].title}</button>
                      <Icon icon={mdiChevronRight} size="0.875rem" aria-hidden />
                      {selected.title}
                    {:else}
                      {groupCopy[areaDefinition?.group ?? 'library']}
                    {/if}
                  </SettingsOverline>
                  <h1>{selected?.title ?? areaCopy[area].title}</h1>
                  <p>{selected?.subtitle ?? areaCopy[area].description}</p>
                </header>
              {/if}
              {#if tourNotice}
                <div class="cc-tour-notice" role="status">
                  <p>{tourNotice}</p>
                  <button
                    type="button"
                    aria-label={$t('frameleaf_cloud_tour_dismiss')}
                    onclick={() => (tourNotice = '')}
                  >
                    <Icon icon={mdiClose} size="1rem" aria-hidden />
                  </button>
                </div>
              {/if}
              {#if area === 'backups' && backupPages.length > 1}
                <!-- One Backup area: its pages side by side, wherever the rail is collapsed or closed. -->
                <nav
                  class="cc-subnav"
                  aria-label={$t('frameleaf_settings_nav_pages', { values: { area: areaCopy.backups.title } })}
                >
                  {#each backupPages as item (item.key)}
                    <a
                      href={commandCenterUrl(item.area, item.section)}
                      aria-current={backupPage === item.key ? 'page' : undefined}>{item.title}</a
                    >
                  {/each}
                </nav>
              {/if}
              {#if area === 'overview'}
                <CommandCenterOverview />
              {:else if area === 'backups' && !selected}
                <BackupDestinationsSection />
              {:else if area === 'history'}
                <SettingsChangeHistory
                  entries={settingsDraft ? history : undefined}
                  preferences={preferenceHistory}
                  ownName={authManager.user.name}
                  error={historyError || preferenceHistoryError}
                  onRetry={() => {
                    if (settingsDraft) {
                      void loadHistory();
                    }
                    void loadPreferenceHistory();
                  }}
                  onConfigure={() => navigate(settingsDraft ? 'processing' : 'preferences')}
                  configureLabel={settingsDraft
                    ? $t('frameleaf_settings_history_empty_action')
                    : $t('frameleaf_settings_history_empty_preferences_action')}
                />
              {:else if selected}
                <div class="cc-settings-content">
                  <section
                    class="cc-section fl-continuous-corners"
                    class:cc-manager={MANAGER_SECTIONS.includes(selected.key)}
                    id="setting-{selected.key}"
                  >
                    {#if area === 'storage' && selected.key === 'trash'}
                      <!-- The template's Storage → Trash & retention links to the account's own trash. -->
                      <div class="cc-section-link">
                        <Button onclick={() => navigate('trash', 'contents')}>
                          <Icon icon={mdiDeleteOutline} size="1rem" aria-hidden />
                          {$t('frameleaf_cc_open_trash')}
                        </Button>
                      </div>
                    {/if}
                    {#if selected.component}
                      <selected.component />
                    {:else}
                      {@render sectionBody?.(selected)}
                    {/if}
                  </section>
                </div>
              {:else}
                <div class="cc-settings-content">
                  <SettingsDirectory rows={directoryRows} areaTitle={areaCopy[area].title} />
                </div>
              {/if}
            {/if}
          </div>
        {/key}
      {/if}

      {#if settingsDraft}
        <SettingsSaveBar store={settingsDraft} sections={serverSections} {areaTitles} {disabled} />
      {/if}
    </main>
  </div>
</div>

{#if isAdmin}
  <CloudTourHost {navigate} onNotice={(text) => (tourNotice = text)} />
{/if}

<style>
  /* The template's `command-center.css` shell. */
  .command-center {
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    color: var(--fl-text);
    background: var(--fl-canvas);
  }
  button,
  a,
  input,
  select {
    font: inherit;
  }
  button {
    cursor: pointer;
    color: inherit;
  }
  button:focus-visible,
  a:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  /*
   * One settings search (design review, section 1 item 4): the field in the context bar below is
   * the search, and Ctrl/Cmd+K focuses it. The top bar's "Search settings" entry only focused this
   * same field, so it is not shown beside it. It keeps its place so the top bar does not shift.
   */
  :global(body:has(.command-center) .search-entry) {
    visibility: hidden;
  }
  .cc-nav {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    width: 228px;
    padding: 14px 0 0;
    overflow: hidden;
    white-space: nowrap;
    background: var(--fl-panel);
    border-inline-end: 1px solid var(--fl-border);
    transition: width var(--fl-duration) var(--fl-snappy);
  }
  /* Labels fade while the rail changes width; the icon tiles do not move. */
  .cc-nav-title > span,
  .cc-back > span,
  .cc-nav-group > p,
  .area > span:not(.tile, .pending),
  .cc-nav-foot > span {
    transition: opacity var(--fl-motion-fast) var(--fl-ease);
  }
  .cc-nav-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px 4px 22px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .cc-nav-title button {
    display: inline-flex;
    padding: 6px;
    background: none;
    border: 0;
    border-radius: var(--fl-radius-control);
  }
  .cc-nav-title button:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .cc-back {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 12px 6px;
    padding: 8px 10px;
    color: var(--fl-muted);
    text-decoration: none;
    border-radius: var(--fl-radius-control);
  }
  .cc-back:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .cc-nav nav {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .cc-nav-group {
    margin-top: 7px;
    padding-bottom: 6px;
    border-top: 1px solid var(--fl-border);
  }
  /*
   * The rendered template keeps the uppercase group labels: command-center.css:62-69 loads after
   * apple-style.css:641-648 and wins the cascade, so the running prototype shows them this way.
   */
  .cc-nav-group > p {
    margin: 12px 22px 6px;
    color: var(--fl-muted);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 1.1px;
    text-transform: uppercase;
  }
  .area {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 34px;
    padding: 8px 22px;
    line-height: 1.3;
    text-align: start;
    color: var(--fl-muted);
    background: none;
    border: 0;
  }
  .area:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .area.selected {
    background: color-mix(in srgb, var(--fl-accent) 10%, var(--fl-panel));
    color: var(--fl-text);
    box-shadow: inset 3px 0 var(--fl-accent);
  }
  .tile {
    display: grid;
    flex: none;
    place-items: center;
    width: 24px;
    height: 24px;
    color: #fff;
    background: var(--tile, #8e8e93);
    border-radius: 7px;
    box-shadow: inset 0 0 0 0.5px #ffffff40;
  }
  @supports (corner-shape: squircle) {
    .tile {
      border-radius: 10px;
    }
  }
  @media (prefers-contrast: more) {
    .tile {
      box-shadow: inset 0 0 0 1px var(--fl-text);
    }
  }
  .pending {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    margin-inline-start: auto;
    background: var(--fl-warning);
    border-radius: 50%;
  }
  .cc-nav-children {
    display: flex;
    flex-direction: column;
    padding: 2px 12px 6px 44px;
  }
  /* A page with unsaved changes carries the area's pending dot at its end (finding 70). */
  .cc-nav-children button.has-pending {
    position: relative;
    padding-inline-end: 22px;
  }
  .cc-nav-children button.has-pending::after {
    content: '';
    position: absolute;
    inset-block-start: calc(50% - 3px);
    inset-inline-end: 8px;
    width: 6px;
    height: 6px;
    background: var(--fl-warning);
    border-radius: 50%;
  }
  .cc-nav-children button {
    min-height: 32px;
    padding: 4px 8px;
    text-align: start;
    color: var(--fl-muted);
    background: none;
    border: 0;
    border-radius: var(--fl-radius-control);
    font-size: var(--fl-font-micro);
  }
  /* The rail keeps labels on one line so they clip cleanly while it changes width. */
  .area > span:not(.tile, .pending),
  .cc-nav-children button,
  .cc-nav-foot > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cc-nav-children button:hover,
  .cc-nav-children button[aria-current='page'] {
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  .cc-nav-foot {
    display: flex;
    gap: 10px;
    padding: 14px 22px;
    color: var(--fl-muted);
    border-top: 1px solid var(--fl-border);
    font-size: var(--fl-font-micro);
  }
  .cc-nav-foot small {
    display: block;
    margin-top: 4px;
    font-size: 10px;
  }
  .cc-nav-scrim {
    display: none;
  }
  .cc-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .cc-context-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    min-height: 53px;
    padding: 10px 28px;
    background: var(--fl-panel);
    border-bottom: 1px solid var(--fl-border);
    font-size: var(--fl-font-micro);
  }
  .cc-context {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--fl-muted);
    white-space: nowrap;
  }
  .cc-context-divider {
    padding: 0 5px;
  }
  .cc-account-scope {
    display: flex;
    /* Its caption sits beside the select, not over it as the base.css field labels do. */
    flex-direction: row;
    align-items: center;
    gap: 8px;
    color: var(--fl-muted);
    white-space: nowrap;
  }
  .cc-account-scope select {
    max-width: 190px;
    padding: 5px;
    color: var(--fl-text);
    background: var(--fl-canvas);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .cc-account-scope > span:last-child {
    color: var(--fl-text);
  }
  .cc-scope-fixed {
    margin: 0;
  }
  /* Backup's pages, as one row of links under its heading. */
  .cc-subnav {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-1);
    margin: 0 0 var(--fl-space-5);
    padding: var(--fl-space-1);
    width: fit-content;
    max-width: 100%;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-control);
  }
  .cc-subnav a {
    display: inline-flex;
    align-items: center;
    min-height: var(--fl-control-height-compact);
    padding: 0 var(--fl-space-3);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    text-decoration: none;
    border-radius: var(--fl-radius-sm);
    transition:
      background-color var(--fl-motion-fast) var(--fl-ease),
      color var(--fl-motion-fast) var(--fl-ease);
  }
  .cc-subnav a:hover {
    color: var(--fl-text);
  }
  .cc-subnav a[aria-current='page'] {
    color: var(--fl-text);
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-1);
  }
  /* The heading takes focus when the page changes so it is announced; it is not a control. */
  .cc-main :global(h1[tabindex='-1']:focus) {
    outline: none;
  }
  .cc-search {
    display: flex;
    align-items: center;
    gap: 10px;
    width: min(410px, 55%);
    padding: 5px 10px;
    color: var(--fl-muted);
    background: var(--fl-canvas);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .cc-search:focus-within {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .cc-search input {
    width: 100%;
    min-width: 0;
    margin: 0;
    padding: 3px 0;
    color: var(--fl-text);
    background: none;
    border: 0;
    outline: 0;
    font-size: var(--fl-font-small);
  }
  .cc-search kbd {
    font-size: 10px;
    white-space: nowrap;
  }
  .cc-main {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 28px 30px 12px;
    scrollbar-width: thin;
    /* Counts, sizes, times and table columns line up everywhere in settings (apple-style.css:59-69). */
    font-variant-numeric: var(--fl-numeric);
  }
  /* Not a dialog: the review and confirmation sheets mount here and keep their own width. */
  .cc-main > :global(*:not(dialog)) {
    max-width: 1480px;
    margin-inline: auto;
  }
  .cc-page-heading {
    margin-bottom: 22px;
  }
  .cc-page-heading h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 550;
    letter-spacing: -0.9px;
  }
  .cc-page-heading > p:last-child {
    margin: 8px 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  /*
   * apple-style.css:1014-1045: a settings page is one calm grouped list in a single column. The
   * shared Setting* fields lay themselves out as compact rows with right-aligned controls inside
   * this `settings` container, and stack on a narrow one.
   */
  .cc-section {
    container: settings / inline-size;
    min-width: 0;
    max-width: 820px;
    padding: 4px 18px;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  @supports (corner-shape: squircle) {
    .cc-section {
      border-radius: calc(var(--fl-radius-card) * 1.8);
    }
  }
  /* Managers and administration tools carry their own grouped containers (command-center.css:1710-1717). */
  .cc-section.cc-manager {
    max-width: none;
    padding: 0;
    background: none;
    border: 0;
  }
  .cc-section-link {
    margin: 14px 0;
  }
  .cc-section + .cc-section {
    margin-top: 16px;
  }
  /* The ported forms still carry the legacy inset; keep them flush inside the card. */
  .cc-section :global(.ms-4) {
    margin-inline-start: 0;
  }
  /* command-center.css `.cc-subtle`. */
  .cc-subtle {
    color: var(--fl-muted);
    font-size: 11px;
    line-height: 1.65;
    margin: 12px 0 0;
  }
  /* FL-196: the prototype's notice after skipping the tour (SettingsDraftNotices' look). */
  .cc-tour-notice {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    margin: 0 0 16px;
    padding: 0.75rem 0.875rem;
    background: var(--fl-raised);
    border-inline-start: 2px solid var(--fl-accent);
    font-size: var(--fl-font-small);
    line-height: 1.6;
  }
  .cc-tour-notice p {
    margin: 0;
  }
  .cc-tour-notice button {
    margin-inline-start: auto;
    display: inline-flex;
    padding: 0.25rem;
    color: var(--fl-muted);
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius);
  }
  .cc-tour-notice button:hover {
    color: var(--fl-text);
    background: var(--fl-panel);
  }
  .cc-notice {
    margin: 0 0 16px;
    padding: 12px 14px;
    color: var(--fl-text);
    background: color-mix(in srgb, var(--fl-warning) 12%, var(--fl-panel));
    border: 1px solid color-mix(in srgb, var(--fl-warning) 40%, var(--fl-border));
    border-radius: var(--fl-radius-card);
    font-size: var(--fl-font-small);
  }
  .cc-search-results {
    display: grid;
    overflow: hidden;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .cc-search-results button {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 18px;
    text-align: start;
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 0;
    border-bottom: 1px solid var(--fl-border);
  }
  .cc-search-results button:last-child {
    border-bottom: 0;
  }
  .cc-search-results button:hover {
    background: var(--fl-raised);
  }
  .cc-search-results button > span {
    display: grid;
    flex: 1;
    gap: 4px;
  }
  .cc-search-results small,
  .cc-search-results button > span > span {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .cc-search-results button:focus-visible {
    outline-offset: var(--fl-focus-inset);
  }
  @media (min-width: 701px) {
    /*
     * Collapsing keeps every icon where it is and fades the labels out, so the rail narrows as one
     * move instead of snapping (design review finding 72). The 24px tiles sit centred in 64px.
     */
    .cc-collapsed .cc-nav {
      width: 64px;
    }
    .cc-collapsed .cc-nav-title {
      padding-inline: 17px;
    }
    .cc-collapsed .cc-nav-title > span {
      display: none;
    }
    .cc-collapsed .cc-back > span,
    .cc-collapsed .cc-nav-group > p,
    .cc-collapsed .area > span:not(.tile, .pending),
    .cc-collapsed .cc-nav-foot > span {
      opacity: 0;
    }
    .cc-collapsed .cc-back {
      margin-inline: 0;
      padding-inline: 23px;
    }
    .cc-collapsed .area {
      padding-inline: 20px;
    }
    .cc-collapsed .cc-nav-foot {
      padding-inline: 23px;
    }
    /* The unsaved-changes dot rides the tile's corner when there is no label to follow. */
    .cc-collapsed .pending {
      position: absolute;
      top: 6px;
      inset-inline-start: 40px;
      margin: 0;
    }
  }
  @media (max-width: 1000px) {
    .cc-context-bar {
      flex-wrap: wrap;
      gap: 10px;
    }
    .cc-search {
      flex: 1;
      min-width: 200px;
    }
    .cc-main {
      padding: 20px;
    }
  }
  @media (max-width: 700px) {
    /*
     * The phone drawer stays mounted and slides in on the spring; closed, it is hidden from the
     * keyboard and assistive technology once it has left (design review finding 72). Under Reduce
     * Motion the shared clamp makes the move instant.
     */
    .cc-nav {
      position: fixed;
      top: var(--fl-topbar-height-phone);
      bottom: 0;
      inset-inline-start: 0;
      z-index: 60;
      width: 250px;
      padding-top: 10px;
      visibility: hidden;
      transform: translateX(-100%);
      box-shadow: var(--fl-shadow-4);
      transition:
        transform var(--fl-duration-dock-out) var(--fl-snappy),
        visibility 0s linear var(--fl-duration-dock-out);
    }
    :global([dir='rtl']) .cc-nav {
      transform: translateX(100%);
    }
    .cc-nav-open .cc-nav {
      visibility: visible;
      transform: none;
      transition:
        transform var(--fl-duration) var(--fl-spring),
        visibility 0s;
    }
    .cc-nav-open .cc-nav-scrim {
      display: block;
      position: fixed;
      inset: var(--fl-topbar-height-phone) 0 0;
      z-index: 59;
      background: var(--fl-scrim);
      border: 0;
    }
    .cc-subnav {
      width: 100%;
    }
    .cc-subnav a {
      flex: 1;
      justify-content: center;
      min-height: var(--fl-control-height);
    }
    .area {
      min-height: 44px;
    }
    .cc-context-bar {
      padding: 9px 14px;
    }
    .cc-search {
      flex-basis: 100%;
      width: 100%;
    }
    .cc-search kbd {
      display: none;
    }
    .cc-main {
      padding: 18px 14px;
    }
  }
</style>
