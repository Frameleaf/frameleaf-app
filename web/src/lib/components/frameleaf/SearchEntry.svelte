<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { shortcuts } from '$lib/actions/shortcut';
  import CommandPalette from '$lib/components/frameleaf/CommandPalette.svelte';
  import SearchDialog from '$lib/components/frameleaf/SearchDialog.svelte';
  import { contextDiscoveryQuery, type DiscoveryFilterSection } from '$lib/components/discovery/query';
  import {
    buildCatalogueCommands,
    buildPageCommands,
    buildSettingsCommands,
    emptyCommandCatalogue,
    loadCommandCatalogue,
    type CommandCatalogue,
  } from '$lib/frameleaf/command-index';
  import { buildCommandIndex, type CommandItem } from '$lib/frameleaf/command-palette';
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
   * the top bar. It opens the Frameleaf search dialog, and a ">" prefix — or the palette
   * shortcut — opens the command palette over the same index. The legacy search bar with its
   * inline suggestion dropdown and the separate search-options modal are gone.
   *
   * The command index is assembled here because this is where the account context lives: the
   * server's feature flags and the account's own feature preferences decide which rail
   * destinations exist, and administrator status decides whether the admin pages and system
   * settings areas are offered at all.
   */

  let {
    /** Deep-links the dialog's filter panel into a section, for the results toolbar's Filter control. */
    section,
    onOpen,
  }: { section?: DiscoveryFilterSection; onOpen?: () => void } = $props();

  let showSearch = $state(false);
  let paletteQuery = $state<string | null>(null);
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

  /** The query the dialog opens on: whatever the current route already implies. */
  const currentQuery = $derived(contextDiscoveryQuery(page.url));

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

  const openPalette = (text = '') => {
    showSearch = false;
    paletteQuery = text;
    refreshCatalogue('');
  };

  const closeAll = () => {
    showSearch = false;
    paletteQuery = null;
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
</script>

<svelte:document
  use:shortcuts={[
    { shortcut: { ctrl: true, key: 'k' }, onShortcut: openSearch },
    { shortcut: { meta: true, key: 'k' }, onShortcut: openSearch },
    { shortcut: { ctrl: true, shift: true, key: 'p' }, onShortcut: () => openPalette() },
    { shortcut: { meta: true, shift: true, key: 'p' }, onShortcut: () => openPalette() },
  ]}
/>

<button type="button" class="search-entry" data-testid="search-entry" onclick={openSearch}>
  <Icon icon={mdiMagnify} size="1.25em" aria-hidden={true} />
  <span class="label">{currentQuery.text || $t('search_your_photos')}</span>
  <kbd aria-hidden="true">{$t('frameleaf_search_shortcut_hint')}</kbd>
</button>

{#if showSearch}
  <SearchDialog
    query={currentQuery}
    {commandIndex}
    {section}
    onClose={closeAll}
    onCommand={runCommand}
    onOpenPalette={(text) => openPalette(text)}
  />
{/if}

{#if paletteQuery !== null}
  <CommandPalette index={commandIndex} initialQuery={paletteQuery} onRun={runCommand} onClose={closeAll} />
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
    border-radius: var(--fl-radius-pill);
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
