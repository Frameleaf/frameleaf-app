<script lang="ts">
  /**
   * The Frameleaf settings host (FL-71), ported from the design template's `CommandCenter.jsx`
   * shell: a rail of areas grouped as "Your library" and "Your server", one search over every
   * section, an area heading with plain headline copy, and the area's sections as cards. Every
   * section is an existing system-config form; the host only decides which ones are on screen.
   *
   * URL contract: `?area=<id>` selects an area. The older `?isOpen=<key>` links from the queue
   * and storage pages still work: the first known key selects its area and the page scrolls to
   * that section; nested groups keep reading `isOpen` through the accordion manager.
   *
   * FL-66: every section edits one settings draft (`system-config-draft.svelte.ts`), so changes
   * made in one area are kept while another is open. Areas with unsaved changes are marked in the
   * rail, the draft's messages sit under the heading, and the settings bar at the bottom saves
   * every page together. The "Change history" area lists the saved settings changes the server
   * recorded; it reloads after every save.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import UtilitiesArea from '$lib/components/frameleaf/settings/UtilitiesArea.svelte';
  import { utilityToolsFor } from '$lib/frameleaf/utilities';
  import AnalyticsArea from '$lib/components/frameleaf/analytics/AnalyticsArea.svelte';
  import SettingsChangeHistory from '$lib/components/frameleaf/settings/SettingsChangeHistory.svelte';
  import SettingsDraftNotices from '$lib/components/frameleaf/settings/SettingsDraftNotices.svelte';
  import SettingsSaveBar from '$lib/components/frameleaf/settings/SettingsSaveBar.svelte';
  import SettingsSection from '$lib/components/frameleaf/settings/SettingsSection.svelte';
  import {
    isScreenArea,
    resolveSettingsArea,
    searchSettingsSections,
    sectionsForArea,
    SETTINGS_AREAS,
    SETTINGS_GROUP_ORDER,
    type SettingsAreaId,
    type SettingsGroupId,
    type SettingsHostSection,
  } from '$lib/frameleaf/settings-areas';
  import { sectionForConfigPath } from '$lib/frameleaf/system-config-draft';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { QueryParameter } from '$lib/constants';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { getAdminConfigHistory, type SystemConfigHistoryEntryDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiAccountOutline,
    mdiTools,
    mdiBackupRestore,
    mdiBellOutline,
    mdiChartTimelineVariant,
    mdiDesktopTowerMonitor,
    mdiHarddisk,
    mdiHistory,
    mdiImageSearchOutline,
    mdiMagnify,
    mdiMovieOpenOutline,
    mdiServerOutline,
    mdiShieldCheckOutline,
    mdiShieldLockOutline,
  } from '@mdi/js';
  import { onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    sections,
    disabled = false,
    utilityOnly = false,
  }: { sections: SettingsHostSection[]; disabled?: boolean; utilityOnly?: boolean } = $props();
  const visibleAreas = $derived(SETTINGS_AREAS.filter((item) => authManager.user.isAdmin || item.id === 'utilities'));
  const utilityMatches = $derived(
    utilityToolsFor(authManager.user.isAdmin).filter((tool) =>
      `${$t(tool.titleKey)} ${$t(tool.descriptionKey)}`.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );

  const settingsDraft = getSystemConfigDraft();

  const AREA_PARAM = 'area';

  const areaCopy: Record<SettingsAreaId, { title: string; description: string; icon: string }> = $derived({
    utilities: { title: $t('utilities'), description: $t('frameleaf_utilities_description'), icon: mdiTools },
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

  const area = $derived(
    resolveSettingsArea({
      area: page.url.searchParams.get(AREA_PARAM),
      isOpen: page.url.searchParams.get(QueryParameter.IS_OPEN),
    }),
  );
  const areaSections = $derived(sectionsForArea(sections, area));

  let query = $state('');
  const results = $derived(searchSettingsSections(sections, query));
  const searching = $derived(query.trim().length > 0);

  const areaOf = (key: string) => SETTINGS_AREAS.find((item) => item.sections.includes(key))?.id;

  /** Areas holding unsaved changes of the settings draft. */
  const pendingAreas = $derived.by(() => {
    const areas = new Set<SettingsAreaId>();
    for (const change of settingsDraft?.changes ?? []) {
      const section = sectionForConfigPath(change.path);
      const area = section ? areaOf(section) : undefined;
      if (area) {
        areas.add(area);
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

  const areaTitles = $derived(
    Object.fromEntries(Object.entries(areaCopy).map(([id, copy]) => [id, copy.title])) as Record<string, string>,
  );

  const selectArea = async (next: SettingsAreaId, sectionKey?: string) => {
    query = '';
    const url = new URL(utilityOnly && next !== 'utilities' ? Route.systemSettings() : page.url, page.url);
    for (const key of ['section', 'status', 'assetId', 'at', 'index']) url.searchParams.delete(key);
    url.searchParams.set(AREA_PARAM, next);
    if (next === 'utilities' && sectionKey) url.searchParams.set('section', sectionKey);
    await goto(`${url.pathname}${url.search}`, { replaceState: true, noScroll: true, keepFocus: true });
    if (sectionKey && next !== 'utilities') {
      scrollTo(sectionKey);
    }
  };

  const scrollTo = (key: string) => {
    setTimeout(
      () => document.querySelector(`#setting-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      50,
    );
  };

  onMount(() => {
    const requested = (page.url.searchParams.get(QueryParameter.IS_OPEN) ?? '')
      .split(' ')
      .find((key) => areaOf(key) === area);
    if (requested) {
      scrollTo(requested);
    }
  });
</script>

<div class="host">
  <nav class="rail" aria-label={$t('frameleaf_settings_nav_label')}>
    {#each SETTINGS_GROUP_ORDER.filter((group) => visibleAreas.some((item) => item.group === group)) as group (group)}
      <div class="rail-group">
        <p>{groupCopy[group]}</p>
        {#each visibleAreas.filter((item) => item.group === group) as item (item.id)}
          <button
            type="button"
            class="area"
            class:selected={!searching && item.id === area}
            aria-current={!searching && item.id === area ? 'page' : undefined}
            onclick={() => selectArea(item.id)}
          >
            <Icon icon={areaCopy[item.id].icon} size="1.125rem" aria-hidden={true} />
            <span>{areaCopy[item.id].title}</span>
            {#if item.id === 'history' && history && history.length > 0}
              <small class="count">{history.length}</small>
            {/if}
            {#if pendingAreas.has(item.id)}
              <span class="pending" title={$t('unsaved_change')}>
                <span class="sr-only">{$t('unsaved_change')}</span>
              </span>
            {/if}
          </button>
          {#if !searching && item.id === area && areaSections.length > 1}
            <div
              class="children"
              aria-label={$t('frameleaf_settings_nav_pages', { values: { area: areaCopy[item.id].title } })}
            >
              {#each areaSections as section (section.key)}
                <button type="button" onclick={() => selectArea(item.id, section.key)}>{section.title}</button>
              {/each}
            </div>
          {/if}
        {/each}
      </div>
    {/each}
    <a class="area" href={Route.userSettings()}
      ><Icon icon={mdiAccountOutline} size="1.125rem" aria-hidden={true} /><span
        >{$t('frameleaf_utilities_preferences')}</span
      ></a
    >
  </nav>

  <div class="main">
    <label class="search">
      <Icon icon={mdiMagnify} size="1.125rem" aria-hidden={true} />
      <input
        id="settings-search"
        type="search"
        aria-label={$t('frameleaf_settings_search_label')}
        placeholder={$t('frameleaf_settings_search_placeholder')}
        bind:value={query}
      />
    </label>

    {#if settingsDraft}
      <SettingsDraftNotices store={settingsDraft} />
    {/if}

    {#if area === 'utilities'}
      <UtilitiesArea
        {query}
        onNavigate={() => {
          query = '';
        }}
      />
    {:else if searching}
      <p class="results" role="status">
        {results.length + utilityMatches.length > 0
          ? $t('frameleaf_settings_search_results', { values: { count: results.length + utilityMatches.length } })
          : $t('frameleaf_settings_search_empty', { values: { query: query.trim() } })}
      </p>
      <div class="sections">
        {#each utilityMatches as tool (tool.id)}
          <button type="button" class="utility-result" onclick={() => selectArea('utilities', tool.id)}
            ><strong>{$t('utilities')} › {$t(tool.titleKey)}</strong><span>{$t(tool.descriptionKey)}</span></button
          >
        {/each}
        {#each results as section (section.key)}
          {@const owner = areaOf(section.key)}
          <SettingsSection
            key={section.key}
            title={section.title}
            subtitle={section.subtitle}
            icon={section.icon}
            overline={owner ? areaCopy[owner].title : undefined}
          >
            <section.component />
          </SettingsSection>
        {/each}
      </div>
    {:else if isScreenArea(area)}
      <!-- As in the template, Library analytics carries its own heading instead of the area's. -->
      {#if area === 'analytics'}
        <AnalyticsArea />
      {/if}
    {:else}
      <header class="heading">
        <p class="overline">{groupCopy[SETTINGS_AREAS.find((item) => item.id === area)?.group ?? 'library']}</p>
        <h2>{areaCopy[area].title}</h2>
        <p class="description">{areaCopy[area].description}</p>
        {#if area === 'care'}
          <!-- The prototype's health and duplicate sections open the Library Care tools (FL-69). -->
          <div class="area-actions">
            {#if authManager.user.isAdmin}
              <a href={Route.missingMediaUtility()}>{$t('library_care_review_missing')}</a>
              <a href={Route.corruptMediaUtility()}>{$t('library_care_review_damaged')}</a>
            {/if}
            <a href={Route.duplicatesUtility()}>{$t('library_care_open_duplicates')}</a>
          </div>
        {/if}
      </header>
      {#if area === 'history'}
        <SettingsChangeHistory
          entries={history}
          error={historyError}
          onRetry={() => void loadHistory()}
          onConfigure={() => selectArea('processing')}
        />
      {:else}
        <div class="sections">
          {#each areaSections as section (section.key)}
            <SettingsSection key={section.key} title={section.title} subtitle={section.subtitle} icon={section.icon}>
              <section.component />
            </SettingsSection>
          {/each}
        </div>
      {/if}
    {/if}

    {#if settingsDraft}
      <SettingsSaveBar store={settingsDraft} {sections} {areaTitles} {disabled} />
    {/if}
  </div>
</div>

<style>
  .utility-result {
    display: grid;
    gap: 0.5rem;
    padding: 1rem;
    text-align: left;
    background: var(--fl-panel);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: 0.25rem;
  }
  .utility-result span {
    color: var(--fl-muted);
  }
  .host {
    display: grid;
    grid-template-columns: 14.25rem minmax(0, 1fr);
    gap: 1.25rem;
    align-items: start;
    color: var(--fl-text);
  }
  .rail {
    position: sticky;
    top: 1rem;
    display: flex;
    flex-direction: column;
    padding: 0.5rem 0;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .rail-group + .rail-group {
    margin-top: 0.4375rem;
    border-top: 1px solid var(--fl-border);
  }
  .rail-group > p {
    margin: 0.75rem 1.375rem 0.375rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .area {
    display: flex;
    align-items: center;
    gap: 0.6875rem;
    width: 100%;
    padding: 0.5rem 1.375rem;
    text-align: start;
    line-height: 1.3;
    color: var(--fl-muted);
    background: transparent;
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
  .area.selected :global(svg) {
    color: var(--fl-accent);
  }
  .count {
    margin-inline-start: auto;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .count + .pending {
    margin-inline-start: 0.375rem;
  }
  .pending {
    width: 0.375rem;
    height: 0.375rem;
    margin-inline-start: auto;
    flex-shrink: 0;
    background: var(--fl-warning);
    border-radius: 50%;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .children {
    display: flex;
    flex-direction: column;
    padding: 0.125rem 0 0.375rem 2.75rem;
  }
  .children button {
    min-height: 2rem;
    padding: 0.25rem 0.5rem;
    text-align: start;
    color: var(--fl-muted);
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius);
    font-size: var(--fl-font-small);
  }
  .children button:hover {
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  .main {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-width: 0;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    max-width: 26rem;
    padding: 0.3125rem 0.625rem;
    color: var(--fl-muted);
    background: var(--fl-canvas);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .search:focus-within {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .search input {
    width: 100%;
    min-width: 0;
    margin: 0;
    padding: 0.1875rem 0;
    color: var(--fl-text);
    background: none;
    border: 0;
    outline: 0;
    font: inherit;
  }
  .results {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .heading {
    margin-bottom: 0.25rem;
  }
  .overline {
    margin: 0 0 0.5rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .heading h2 {
    margin: 0;
    font-size: 1.75rem;
    font-weight: 550;
    letter-spacing: -0.02em;
  }
  .description {
    margin: 0.5rem 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .sections {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .area-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .area-actions a {
    padding: 0.4375rem 0.6875rem;
    color: var(--fl-text);
    text-decoration: none;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .area-actions a:hover {
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 8%);
  }
  @media (max-width: 56rem) {
    .utility-result {
      display: grid;
      gap: 0.5rem;
      padding: 1rem;
      text-align: left;
      background: var(--fl-panel);
      color: var(--fl-text);
      border: 1px solid var(--fl-border);
      border-radius: 0.25rem;
    }
    .utility-result span {
      color: var(--fl-muted);
    }
    .host {
      grid-template-columns: 1fr;
    }
    .rail {
      position: static;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 0.25rem;
      padding: 0.5rem;
    }
    .rail-group {
      display: contents;
    }
    .rail-group > p,
    .children {
      display: none;
    }
    .area {
      width: auto;
      padding: 0.375rem 0.75rem;
      border-radius: var(--fl-radius-pill);
    }
    .area.selected {
      box-shadow: inset 0 0 0 1px var(--fl-accent);
    }
  }
</style>
