<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { shortcuts } from '$lib/actions/shortcut';
  import CommandPalette from '$lib/components/frameleaf/CommandPalette.svelte';
  import SearchPalette from '$lib/components/frameleaf/SearchPalette.svelte';
  import type { DiscoveryFilterSection } from '$lib/components/discovery/query';
  import {
    buildCatalogueCommands,
    buildPageCommands,
    buildSettingsCommands,
    emptyCommandCatalogue,
    loadCommandCatalogue,
    type CommandCatalogue,
  } from '$lib/frameleaf/command-index';
  import { buildCommandIndex, type CommandItem } from '$lib/frameleaf/command-palette';
  import { isSettingsRoute } from '$lib/frameleaf/navigation';
  import { searchContextFor } from '$lib/frameleaf/search-context';
  import {
    announceFilterPanel,
    FILTER_PANEL_CLOSE_EVENT,
    FILTER_PANEL_EVENT,
    SEARCH_SHORTCUT_EVENT,
    searchShortcutHintKey,
    type FilterPanelRequest,
  } from '$lib/frameleaf/search-shortcuts';
  import '$lib/frameleaf/tokens.css';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Icon, themeManager, ThemePreference } from '@immich/ui';
  import { handlePromiseError } from '$lib/utils';
  import { mdiMagnify, mdiThemeLightDark } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The library's single search entry point (FL-49).
   *
   * The September 22, 2026 revision leaves exactly one place to start a search: this control in
   * the top bar. Since the September 24 Apple-style refinements it opens the glass search palette
   * (`SearchPalette.jsx`, ⌘K or "/"), and a ">" prefix — or the palette shortcut — opens the command
   * palette over the same index. The legacy search bar with its inline suggestion dropdown, the
   * separate search-options modal and the September 22 search dialog are gone.
   *
   * The command index is assembled here because this is where the account context lives: the
   * server's feature flags and the account's own feature preferences decide which rail
   * destinations exist, and administrator status decides whether the admin pages and system
   * settings areas are offered at all.
   */

  let {
    /** Deep-links the palette's Advanced filters into a section, for the results toolbar's Filter control. */
    section,
    onOpen,
  }: { section?: DiscoveryFilterSection; onOpen?: () => void } = $props();

  let showSearch = $state(false);
  /** The section the results toolbar's Filter control asked for, while the palette it opened is up. */
  let requestedSection = $state<DiscoveryFilterSection>();
  let paletteQuery = $state<string | null>(null);
  /** Which entries the open palette offers: everything, or just the settings group (admin/settings routes). */
  let paletteScope = $state<'all' | 'settings'>('all');
  let catalogue = $state<CommandCatalogue>(emptyCommandCatalogue());

  let catalogueController: AbortController | undefined;

  const preferences = $derived(authManager.authenticated ? authManager.preferences : undefined);
  const isAdmin = $derived(authManager.authenticated && authManager.user.isAdmin);

  const context = $derived({
    isAdmin,
    capabilities: {
      search: featureFlagsManager.value.search,
      map: featureFlagsManager.value.map,
      trash: featureFlagsManager.value.trash,
      people: !!preferences?.people.enabled,
      memories: !!preferences?.memories.enabled,
      tags: !!preferences?.tags.enabled,
      folders: !!preferences?.folders.enabled,
      sharedLinks: !!preferences?.sharedLinks.enabled,
    },
  });

  /**
   * Actions are real side effects on production managers, not navigation. They are kept short
   * on purpose: an action that needs a confirmation or a server write belongs to the surface
   * that owns it, and the palette links to that surface instead.
   */
  const actions = $derived([
    {
      id: 'toggle-theme',
      title: $t('theme'),
      subtitle: $t('toggle_theme_description'),
      icon: mdiThemeLightDark,
      shortcut: 'shift+t',
      run: () => themeManager.toggle(),
    },
    {
      id: 'system-theme',
      title: $t('system_theme'),
      icon: mdiThemeLightDark,
      run: () => themeManager.setPreference(ThemePreference.System),
    },
  ]);

  const commandIndex = $derived<CommandItem[]>(
    buildCommandIndex({
      actions,
      pages: buildPageCommands($t, context),
      settings: buildSettingsCommands($t, context),
      ...buildCatalogueCommands($t, catalogue),
    }),
  );

  const settingsCommandIndex = $derived(commandIndex.filter((item) => item.group === 'settings'));
  const paletteIndex = $derived(paletteScope === 'settings' ? settingsCommandIndex : commandIndex);

  /**
   * The query the palette opens on: the search the page already shows, or the scope it stands for,
   * together with its session's filters (FL-48). Nothing the page is narrowed by is reset.
   */
  const currentContext = $derived(searchContextFor(page.url));
  const currentQuery = $derived(currentContext.query);

  /**
   * The prototype's `screen === "admin"` branch (App.jsx): the top bar's one search entry hides
   * the library search palette and searches settings instead, on every settings/administration
   * page, not only server administration (`openSettings()` sets the same screen for account
   * preferences too).
   */
  const isSettings = $derived(isSettingsRoute(page.url.pathname));

  const refreshCatalogue = (term: string) => {
    catalogueController?.abort();
    const controller = new AbortController();
    catalogueController = controller;
    void loadCommandCatalogue(term, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          catalogue = result;
        }
      })
      .catch(() => {
        // Superseded by a newer request, or the palette closed.
      });
  };

  const openSearch = () => {
    if (showSearch) {
      return;
    }
    showSearch = true;
    paletteQuery = null;
    onOpen?.();
    refreshCatalogue('');
  };

  const openPalette = (text = '', scope: 'all' | 'settings' = 'all') => {
    showSearch = false;
    paletteScope = scope;
    paletteQuery = text;
    refreshCatalogue('');
  };

  /**
   * Settings/administration routes: focus the settings page's own inline search
   * (`#settings-search` in SettingsHost.svelte, the production match for the prototype's
   * `CommandCenter.jsx` search, which `screen === "admin"` always focuses in App.jsx) when the
   * current page has one. Not every admin page does yet, so where it is missing this opens the
   * command palette filtered to the settings-only entries `buildSettingsCommands` already
   * contributes to the index, rather than the library search palette.
   */
  const openSettingsSearch = () => {
    const input = document.querySelector('#settings-search');
    if (input instanceof HTMLInputElement) {
      input.focus();
      return;
    }
    openPalette('', 'settings');
  };

  const openEntry = () => (isSettings ? openSettingsSearch() : openSearch());

  const closeAll = () => {
    showSearch = false;
    requestedSection = undefined;
    paletteQuery = null;
    paletteScope = 'all';
    catalogueController?.abort();
  };

  const runCommand = (command: CommandItem) => {
    if (command.href) {
      handlePromiseError(goto(command.href));
      return;
    }
    void command.run?.();
  };

  onDestroy(() => catalogueController?.abort());

  // Ctrl/Cmd+K and "/" arrive through the root layout's capture listener (search-shortcuts.ts),
  // which keeps them from the upstream command palette.
  $effect(() => {
    const onShortcut = () => openEntry();
    addEventListener(SEARCH_SHORTCUT_EVENT, onShortcut);
    return () => removeEventListener(SEARCH_SHORTCUT_EVENT, onShortcut);
  });

  // The results toolbar's Filter control and its "Choose a filter" menu open the Advanced filters
  // at a section (prototype `openFilters`); the palette is the one filter panel.
  $effect(() => {
    const onFilters = (event: Event) => {
      const detail = (event as CustomEvent<FilterPanelRequest>).detail;
      if (isSettings || !detail?.section) {
        return;
      }
      requestedSection = detail.section;
      openSearch();
    };
    const onClose = () => {
      if (requestedSection) {
        closeAll();
      }
    };
    addEventListener(FILTER_PANEL_EVENT, onFilters);
    addEventListener(FILTER_PANEL_CLOSE_EVENT, onClose);
    return () => {
      removeEventListener(FILTER_PANEL_EVENT, onFilters);
      removeEventListener(FILTER_PANEL_CLOSE_EVENT, onClose);
    };
  });

  // The toolbar's Filter shows whether the panel it asked for is up, and closes it again.
  $effect(() => {
    announceFilterPanel(showSearch && !!requestedSection);
  });
</script>

<svelte:document
  use:shortcuts={[
    { shortcut: { ctrl: true, shift: true, key: 'p' }, onShortcut: () => openPalette() },
    { shortcut: { meta: true, shift: true, key: 'p' }, onShortcut: () => openPalette() },
  ]}
/>

<button type="button" class="search-entry" data-testid="search-entry" onclick={openEntry}>
  <Icon icon={mdiMagnify} size="1.25em" aria-hidden={true} />
  <span class="label">{isSettings ? $t('search_settings') : currentQuery.text || $t('frameleaf_search_title')}</span>
  <!-- S-25 / CC-7 (App.jsx:2374 "⌘ K"): the hint names the platform's own modifier. -->
  <kbd aria-hidden="true">{$t(searchShortcutHintKey())}</kbd>
</button>

{#if showSearch}
  <SearchPalette
    query={currentQuery}
    unsupported={currentContext.unsupported}
    {commandIndex}
    section={requestedSection ?? section}
    onClose={closeAll}
    onCommand={runCommand}
    onOpenPalette={(text) => openPalette(text)}
  />
{/if}

{#if paletteQuery !== null}
  <CommandPalette index={paletteIndex} initialQuery={paletteQuery} onRun={runCommand} onClose={closeAll} />
{/if}

<style>
  .search-entry {
    display: flex;
    width: 100%;
    min-width: 0;
    align-items: center;
    gap: 0.625rem;
    min-height: 40px;
    padding: 0.375rem 0.75rem;
    font-size: 0.875rem;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    /* The prototype's `.global-search` (styles.css) hardcodes 8px rather than one of the shared
       radius tokens (control is 6px, card is 10px; neither matches), so this matches the
       prototype's literal value instead of picking the nearest token. */
    border-radius: 8px;
    transition: border-color var(--fl-motion-fast) var(--fl-ease);
  }
  .search-entry:hover {
    border-color: var(--fl-muted);
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-align: start;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  kbd {
    flex-shrink: 0;
    padding: 0.0625rem 0.375rem;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
  @media (max-width: 48rem) {
    kbd {
      display: none;
    }
  }
</style>
