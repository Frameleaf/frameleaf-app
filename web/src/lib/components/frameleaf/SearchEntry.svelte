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
  import ShortcutsHelp from '$lib/components/frameleaf/ShortcutsHelp.svelte';
  import { buildCommandIndex, type CommandInput, type CommandItem } from '$lib/frameleaf/command-palette';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { isSettingsRoute } from '$lib/frameleaf/navigation';
  import { albumSearchContext, searchContextFor, workspaceHref } from '$lib/frameleaf/search-context';
  import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
  import { openAboutDialog, openSupportDialog } from '$lib/frameleaf/system-dialogs';
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
  import { Route } from '$lib/route';
  import { LibraryScope, LibraryViewScope, type AlbumResponseDto } from '@frameleaf/sdk';
  import { Icon, Theme, themeManager } from '@frameleaf/ui';
  import { handlePromiseError } from '$lib/utils';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import { isAlbumsRoute, isLockedFolderRoute } from '$lib/utils/navigation';
  import {
    mdiFolderPlusOutline,
    mdiInformationOutline,
    mdiKeyboardOutline,
    mdiLifebuoy,
    mdiLogoutVariant,
    mdiMagnify,
    mdiMoonWaningCrescent,
    mdiShieldLockOutline,
    mdiUpload,
    mdiWhiteBalanceSunny,
  } from '@mdi/js';
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
    /** The top bar's Locked toggle, offered as the palette's Unlock / Hide Locked content action. */
    onToggleLocked,
  }: { section?: DiscoveryFilterSection; onOpen?: () => void; onToggleLocked?: () => void } = $props();

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

  // Route metadata supplies the workspace on an album deep link.
  const currentContext = $derived.by(() => {
    const url = new URL(page.url.href);
    const album = (page.data as { album?: AlbumResponseDto } | undefined)?.album;
    return album ? { query: albumSearchContext(url, album), unsupported: [] } : searchContextFor(url);
  });
  const currentQuery = $derived(currentContext.query);

  const context = $derived({
    isAdmin,
    capabilities: {
      // The palette reaches every page; only the rail follows the "in navigation" choices.
      recentlyAdded: true,
      search: featureFlagsManager.value.search || currentQuery.filter.libraryScope === LibraryViewScope.Design,
      map: featureFlagsManager.value.map,
      trash: featureFlagsManager.value.trash,
      people: !!preferences?.people.enabled,
      memories: !!preferences?.memories.enabled,
      tags: !!preferences?.tags.enabled,
      folders: !!preferences?.folders.enabled,
      sharedLinks: !!preferences?.sharedLinks.enabled,
    },
  });

  // The Upload button's own defaults (TopBar.svelte): on an album page uploads join that album, and
  // uploads made from the Locked area stay locked.
  const uploadAlbumId = $derived(isAlbumsRoute(page.route?.id) ? page.params.albumId : undefined);
  const uploadIsLocked = $derived(isLockedFolderRoute(page.route?.id));
  const isDark = $derived(themeManager.value === Theme.Dark);
  let shortcutsOpen = $state(false);

  /**
   * The prototype's actions (App.jsx `buildCommandIndex` actions, SHELL-P3), in its order, so an
   * empty ">" suggests them before the pages. They are real side effects on production managers or
   * links to the surface that owns them; nothing here writes to the server or skips a confirmation.
   * Locked is the top bar's own control, so the action exists only where the bar hands it over.
   */
  const actions = $derived<CommandInput[]>([
    {
      id: 'upload',
      title: $t('frameleaf_search_command_upload_photos'),
      icon: mdiUpload,
      run: async () => {
        await openFileUploadDialog({
          albumId: uploadAlbumId,
          isLockedAssets: uploadIsLocked,
          libraryScope: currentQuery.filter.libraryScope === LibraryViewScope.Design ? LibraryScope.Design : undefined,
        });
      },
    },
    {
      id: 'new-album',
      title: $t('frameleaf_albums_create_album'),
      icon: mdiFolderPlusOutline,
      href: Route.newAlbum({ kind: 'album' }),
    },
    {
      id: 'shortcuts',
      title: $t('keyboard_shortcuts'),
      icon: mdiKeyboardOutline,
      shortcut: '?',
      run: () => {
        shortcutsOpen = true;
      },
    },
    {
      id: 'toggle-theme',
      title: isDark ? $t('light_theme') : $t('dark_theme'),
      icon: isDark ? mdiWhiteBalanceSunny : mdiMoonWaningCrescent,
      shortcut: 'shift+t',
      keywords: [$t('theme')],
      run: () => themeManager.toggle(),
    },
    ...(onToggleLocked
      ? [
          {
            id: 'locked',
            title: sessionAccess.isElevated
              ? $t('frameleaf_locked_hide_content')
              : $t('frameleaf_locked_unlock_content'),
            icon: mdiShieldLockOutline,
            run: onToggleLocked,
          },
        ]
      : []),
    { id: 'help', title: $t('support_and_feedback'), icon: mdiLifebuoy, run: openSupportDialog },
    { id: 'about', title: $t('frameleaf_about_menu_item'), icon: mdiInformationOutline, run: openAboutDialog },
    { id: 'sign-out', title: $t('sign_out'), icon: mdiLogoutVariant, href: Route.logout() },
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
      handlePromiseError(
        goto(
          command.href.startsWith('/albums')
            ? workspaceHref(command.href, currentQuery.filter.libraryScope, page.url.origin)
            : command.href,
        ),
      );
      return;
    }
    void command.run?.();
  };

  // People, albums and places were answered for the earlier access: none of them may outlive a
  // lock or an account change, and an open palette asks again under the new access.
  const stopAccess = onLibraryAccessChange(() => {
    catalogueController?.abort();
    catalogue = emptyCommandCatalogue();
    if (showSearch || paletteQuery !== null) {
      refreshCatalogue('');
    }
  });

  onDestroy(() => {
    stopAccess();
    catalogueController?.abort();
  });

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

<!--
  Settings pages carry their own search field, which Ctrl/Cmd+K focuses (`openSettingsSearch`), so
  the top bar does not draw a second one beside it. The listeners above stay mounted either way.
-->
{#if !isSettings}
  <button type="button" class="search-entry" data-testid="search-entry" onclick={openEntry}>
    <Icon icon={mdiMagnify} size="1.25em" aria-hidden={true} />
    <span class="label">{currentQuery.text || $t('frameleaf_search_title')}</span>
    <!-- S-25 / CC-7 (App.jsx:2374 "⌘ K"): the hint names the platform's own modifier. -->
    <kbd aria-hidden="true">{$t(searchShortcutHintKey())}</kbd>
  </button>
{/if}

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

{#if shortcutsOpen}
  <ShortcutsHelp onClose={() => (shortcutsOpen = false)} />
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
    border-radius: var(--fl-radius-control);
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
    border-radius: var(--fl-radius-xs);
  }
  @media (pointer: coarse) {
    .search-entry {
      min-height: var(--fl-control-height);
    }
  }
  @media (max-width: 48rem) {
    kbd {
      display: none;
    }
  }
</style>
