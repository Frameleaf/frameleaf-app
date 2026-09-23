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
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import SettingsSection from '$lib/components/frameleaf/settings/SettingsSection.svelte';
  import {
    resolveSettingsArea,
    searchSettingsSections,
    sectionsForArea,
    SETTINGS_AREAS,
    SETTINGS_GROUP_ORDER,
    type SettingsAreaId,
    type SettingsGroupId,
    type SettingsHostSection,
  } from '$lib/frameleaf/settings-areas';
  import { QueryParameter } from '$lib/constants';
  import { Route } from '$lib/route';
  import { Icon } from '@immich/ui';
  import {
    mdiBackupRestore,
    mdiBellOutline,
    mdiDesktopTowerMonitor,
    mdiHarddisk,
    mdiImageSearchOutline,
    mdiMagnify,
    mdiMovieOpenOutline,
    mdiServerOutline,
    mdiShieldCheckOutline,
    mdiShieldLockOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let { sections }: { sections: SettingsHostSection[] } = $props();

  const AREA_PARAM = 'area';

  const areaCopy: Record<SettingsAreaId, { title: string; description: string; icon: string }> = $derived({
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
  });

  const groupCopy: Record<SettingsGroupId, string> = $derived({
    library: $t('frameleaf_settings_group_library'),
    server: $t('frameleaf_settings_group_server'),
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

  const selectArea = async (next: SettingsAreaId, sectionKey?: string) => {
    query = '';
    const url = new URL(page.url);
    url.searchParams.set(AREA_PARAM, next);
    await goto(`${url.pathname}${url.search}`, { replaceState: true, noScroll: true, keepFocus: true });
    if (sectionKey) {
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
    {#each SETTINGS_GROUP_ORDER as group (group)}
      <div class="rail-group">
        <p>{groupCopy[group]}</p>
        {#each SETTINGS_AREAS.filter((item) => item.group === group) as item (item.id)}
          <button
            type="button"
            class="area"
            class:selected={!searching && item.id === area}
            aria-current={!searching && item.id === area ? 'page' : undefined}
            onclick={() => selectArea(item.id)}
          >
            <Icon icon={areaCopy[item.id].icon} size="1.125rem" aria-hidden={true} />
            <span>{areaCopy[item.id].title}</span>
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

    {#if searching}
      <p class="results" role="status">
        {results.length > 0
          ? $t('frameleaf_settings_search_results', { values: { count: results.length } })
          : $t('frameleaf_settings_search_empty', { values: { query: query.trim() } })}
      </p>
      <div class="sections">
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
    {:else}
      <header class="heading">
        <p class="overline">{groupCopy[SETTINGS_AREAS.find((item) => item.id === area)?.group ?? 'library']}</p>
        <h2>{areaCopy[area].title}</h2>
        <p class="description">{areaCopy[area].description}</p>
        {#if area === 'care'}
          <!-- The prototype's health and duplicate sections open the Library Care tools (FL-69). -->
          <div class="area-actions">
            <a href={Route.missingMediaUtility()}>{$t('library_care_review_missing')}</a>
            <a href={Route.corruptMediaUtility()}>{$t('library_care_review_damaged')}</a>
            <a href={Route.duplicatesUtility()}>{$t('library_care_open_duplicates')}</a>
          </div>
        {/if}
      </header>
      <div class="sections">
        {#each areaSections as section (section.key)}
          <SettingsSection key={section.key} title={section.title} subtitle={section.subtitle} icon={section.icon}>
            <section.component />
          </SettingsSection>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
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
