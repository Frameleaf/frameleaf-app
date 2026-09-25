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
  import Button from '$lib/components/frameleaf/Button.svelte';
  import CommandCenterOverview from '$lib/components/frameleaf/settings/CommandCenterOverview.svelte';
  import SettingsChangeHistory from '$lib/components/frameleaf/settings/SettingsChangeHistory.svelte';
  import SettingsDirectory, { type DirectoryRow } from '$lib/components/frameleaf/settings/SettingsDirectory.svelte';
  import SettingsDraftNotices from '$lib/components/frameleaf/settings/SettingsDraftNotices.svelte';
  import SettingsOverline from '$lib/components/frameleaf/settings/SettingsOverline.svelte';
  import SettingsSaveBar from '$lib/components/frameleaf/settings/SettingsSaveBar.svelte';
  import UtilitiesArea from '$lib/components/frameleaf/settings/UtilitiesArea.svelte';
  import {
    AREA_TILE_COLORS,
    commandCenterUrl,
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
  import { sectionForConfigPath } from '$lib/frameleaf/system-config-draft';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { libraryCareToolsFor, utilityTool, utilityToolsFor } from '$lib/frameleaf/utilities';
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
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
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
    mdiDesktopTowerMonitor,
    mdiFolderOutline,
    mdiHarddisk,
    mdiHistory,
    mdiImageSearchOutline,
    mdiMagnify,
    mdiMovieOpenOutline,
    mdiServerOutline,
    mdiShieldCheckOutline,
    mdiShieldLockOutline,
    mdiTools,
  } from '@mdi/js';
  import { untrack, type Snippet } from 'svelte';
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
    storage: {
      title: $t('frameleaf_settings_area_storage'),
      description: $t('frameleaf_settings_area_storage_description'),
      icon: mdiHarddisk,
    },
    backup: {
      title: $t('frameleaf_settings_area_backup'),
      description: $t('frameleaf_settings_area_backup_description'),
      icon: mdiBackupRestore,
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
        (isScreenArea(item.id) || item.id === 'libraries' || sectionsForArea(sections, item.id).length > 0),
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
  // An area this account may not open falls back to the first one it may.
  const area = $derived(
    visibleAreas.some((item) => item.id === requestedArea) ? requestedArea : (visibleAreas[0]?.id ?? 'utilities'),
  );
  const areaDefinition = $derived(SETTINGS_AREAS.find((item) => item.id === area));
  const areaSections = $derived(sectionsForArea(sections, area));
  const selectedKey = $derived(
    resolveSettingsSection(area, { section: page.url.searchParams.get('section'), isOpen: legacyOpen }),
  );
  const selected = $derived(areaSections.find((section) => section.key === selectedKey));
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
    'cloud-ml',
    'deduplication',
    'mode',
    'backups',
    'integrity',
    'enrichment-care',
    'repair',
  ];
  // A page named like its area does not repeat the name as a breadcrumb (INTERACTION-REQUIREMENTS
  // "Settings"; CommandCenter.jsx:721-731): the overline names the area's group instead.
  const breadcrumb = $derived(selected !== undefined && selected.title !== areaCopy[area].title);
  // As in the template, the Users manager and the Job manager carry their own headings.
  const ownHeading = $derived(area === 'users' || (area === 'processing' && selected?.key === 'queues'));

  /** The navigation's pages under the current area: its sections, or the utility tools. */
  const utilityTools = $derived(utilityToolsFor(isAdmin));
  const children = $derived(
    area === 'utilities'
      ? utilityTools.map((tool) => ({ key: tool.id as string, title: $t(tool.titleKey) }))
      : area === 'libraries' || area === 'trash'
        ? []
        : areaSections.map((section) => ({ key: section.key, title: section.title })),
  );
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
          onSelect: () => void navigate('utilities', tool.id),
        });
      }
    }
    return rows;
  });
  const activeChild = $derived(
    area === 'utilities' ? utilityTool(page.url.searchParams.get('section'))?.id : selected?.key,
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
              overline: areaCopy[owner].title,
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

  /** Areas holding unsaved changes of the settings draft. */
  const pendingAreas = $derived.by(() => {
    const areas = new Set<SettingsAreaId>();
    for (const change of settingsDraft?.changes ?? []) {
      const key = sectionForConfigPath(change.path);
      const owner = key ? SETTINGS_AREAS.find((item) => item.sections.includes(key))?.id : undefined;
      if (owner) {
        areas.add(owner);
      }
    }
    return areas;
  });

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
  // Server identity & network; saved drafts apply at once, and an unnamed server shows its address.
  const serverName = $derived(
    settingsDraft?.baseline?.server?.name?.trim() || serverConfigManager.value.serverName?.trim() || page.url.host,
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

  /** Opens an area, or one of its sections, keeping the "Viewing" scope. */
  const navigate = async (next: SettingsAreaId, section?: string) => {
    query = '';
    sidebarStore.isOpen = false;
    const currentScope = page.url.searchParams.get('scope') ?? undefined;
    await goto(commandCenterUrl(next, section, { scope: currentScope }), { keepFocus: true });
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
              {#if item.id === 'history' && history && history.length > 0}
                <small class="count">{history.length}</small>
              {/if}
              {#if pendingAreas.has(item.id)}
                <span class="pending" title={$t('unsaved_change')}></span>
              {/if}
            </button>
            {#if item.id === area && !$sidebarCollapsed && children.length > 0}
              <div
                class="cc-nav-children"
                aria-label={$t('frameleaf_settings_nav_pages', { values: { area: areaCopy[item.id].title } })}
              >
                {#each children as child (child.key)}
                  <button
                    type="button"
                    aria-current={activeChild === child.key ? 'page' : undefined}
                    onclick={() => navigate(item.id, child.key)}>{child.title}</button
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
      {#if isAdmin && scopeGroups.length > 0}
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
      {:else}
        <div class="cc-account-scope">
          <span>{$t('frameleaf_cc_viewing')}</span>
          <span>{$t('frameleaf_cc_own_library', { values: { name: authManager.user.name } })}</span>
        </div>
      {/if}
      <label class="cc-search">
        <Icon icon={mdiMagnify} size="1rem" aria-hidden />
        <input
          id="settings-search"
          type="search"
          aria-label={$t('frameleaf_settings_search_label')}
          placeholder={$t('frameleaf_cc_search')}
          bind:value={query}
        />
        <kbd>{$t(searchShortcutHintKey())}</kbd>
      </label>
    </div>

    <main class="cc-main">
      {#if searching}
        <header class="cc-page-heading">
          <SettingsOverline>{$t('frameleaf_cc_search_overline')}</SettingsOverline>
          <h1>{$t('frameleaf_cc_search_title')}</h1>
          <p>{$t('frameleaf_settings_search_results', { values: { count: results.length } })}</p>
        </header>
        {#if results.length > 0}
          <div class="cc-search-results">
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
          <div class="cc-empty" role="status">
            <h2>{$t('frameleaf_cc_no_results')}</h2>
            <p>{$t('frameleaf_cc_search_help')}</p>
            <button type="button" onclick={() => (query = '')}>{$t('frameleaf_cc_clear')}</button>
          </div>
        {/if}
      {:else}
        {#if settingsDraft && disabled}
          <p class="cc-notice" role="alert">{$t('admin.config_set_by_file')}</p>
        {/if}
        {#if settingsDraft}
          <SettingsDraftNotices store={settingsDraft} />
        {/if}
        {#if libraryScopeOwner && (area === 'processing' || area === 'utilities')}
          <p class="cc-subtle">{$t('frameleaf_cc_library_scope_note', { values: { name: libraryScopeOwner } })}</p>
        {/if}
        {#if area === 'analytics'}
          <!-- As in the template, Library analytics carries its own heading instead of the area's. -->
          <AnalyticsArea />
        {:else if area === 'utilities'}
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
          {#if area === 'overview'}
            <CommandCenterOverview />
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
      {/if}

      {#if settingsDraft}
        <SettingsSaveBar store={settingsDraft} sections={serverSections} {areaTitles} {disabled} />
      {/if}
    </main>
  </div>
</div>

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
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .cc-nav {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    width: 228px;
    padding: 14px 0 0;
    background: var(--fl-panel);
    border-right: 1px solid var(--fl-border);
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
  .count {
    margin-inline-start: auto;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .count + .pending {
    margin-inline-start: 6px;
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
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
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
    font-variant-numeric: tabular-nums;
  }
  .cc-main > :global(*) {
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
  .cc-empty {
    padding: 50px;
    text-align: center;
  }
  .cc-empty h2 {
    margin: 0 0 8px;
    font-size: 18px;
    font-weight: 550;
  }
  .cc-empty p {
    margin: 0 0 16px;
    color: var(--fl-muted);
  }
  .cc-empty button {
    padding: 8px 12px;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  @media (min-width: 701px) {
    .cc-collapsed .cc-nav {
      width: 64px;
    }
    .cc-collapsed .cc-nav-title {
      justify-content: center;
      padding: 0 0 4px;
    }
    .cc-collapsed .cc-nav-title > span,
    .cc-collapsed .cc-back > span,
    .cc-collapsed .cc-nav-group > p,
    .cc-collapsed .area > span:not(.tile),
    .cc-collapsed .area > small,
    .cc-collapsed .cc-nav-foot > span {
      display: none;
    }
    .cc-collapsed .cc-back,
    .cc-collapsed .area,
    .cc-collapsed .cc-nav-foot {
      justify-content: center;
      padding: 12px;
    }
    .cc-collapsed .cc-back {
      margin: 0 0 6px;
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
    .cc-nav {
      display: none;
      position: fixed;
      top: var(--fl-topbar-height-phone);
      bottom: 0;
      left: 0;
      z-index: 60;
      width: 250px;
      padding-top: 10px;
    }
    .cc-nav-open .cc-nav {
      display: flex;
    }
    .cc-nav-open .cc-nav-scrim {
      display: block;
      position: fixed;
      inset: var(--fl-topbar-height-phone) 0 0;
      z-index: 59;
      background: #0007;
      border: 0;
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
