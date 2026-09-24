<script lang="ts">
  import { page } from '$app/state';
  import { currentTab, showsTabBar, type TabBarId } from '$lib/frameleaf/navigation';
  import { SEARCH_SHORTCUT_EVENT } from '$lib/frameleaf/search-shortcuts';
  import '$lib/frameleaf/tokens.css';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { Icon } from '@immich/ui';
  import { mdiFolderMultipleOutline, mdiHistory, mdiImageMultipleOutline, mdiMagnify } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  /**
   * The phone tab bar (FL-30), ported from `.fl-tabbar` in `design/frameleaf/template/src/App.jsx`
   * and apple-style.css "#7 phone tab bar": a frosted capsule at the foot of the screen with
   * Library, Memories, Albums and Search (owner decision, FL-146). It only shows at phone width;
   * the ☰ drawer stays, because Favorites, Archive, People, Map, Folders, Trash, Shared links and
   * Library Care are reachable only from there. Studio and the settings screens have no tab bar.
   *
   * Search opens the one search entry in the top bar (the same event ⌘K sends), so there is still
   * exactly one search surface. Memories and Search follow the same switches as the rail (the
   * account's Memories preference, the server's search feature). The ☰ drawer ends above the tab bar
   * (the template's `.sidebar.mobile-open { bottom: 64px }`), so its footer — Library Care,
   * Settings, Support — stays reachable while the tab bar stays in place.
   */

  let { theme }: { theme: 'dark' | 'light' } = $props();

  type Tab = { id: TabBarId; labelKey: Translations; icon: string; href?: string };

  const ALL_TABS: Tab[] = [
    { id: 'library', labelKey: 'library', icon: mdiImageMultipleOutline, href: Route.photos() },
    { id: 'memories', labelKey: 'memories', icon: mdiHistory, href: Route.memories() },
    // The prototype's "collections" screen: every album and shared space.
    { id: 'albums', labelKey: 'albums', icon: mdiFolderMultipleOutline, href: Route.albums() },
    { id: 'search', labelKey: 'search', icon: mdiMagnify },
  ];

  const memories = $derived(
    authManager.authenticated &&
      authManager.preferences.memories.enabled &&
      authManager.preferences.memories.sidebarWeb,
  );
  const TABS = $derived(
    ALL_TABS.filter(
      (tab) => (tab.id !== 'memories' || memories) && (tab.id !== 'search' || featureFlagsManager.value.search),
    ),
  );
  const visible = $derived(showsTabBar(page.url.pathname));
  const current = $derived(currentTab(page.url.pathname));

  const openSearch = () => dispatchEvent(new CustomEvent(SEARCH_SHORTCUT_EVENT));
</script>

{#if visible}
  <nav
    class="frameleaf fl-tabbar fl-material"
    data-theme={theme}
    aria-label={$t('frameleaf_tabbar_label')}
    data-testid="frameleaf-tabbar"
  >
    {#each TABS as tab (tab.id)}
      {#if tab.href}
        <a href={tab.href} aria-current={current === tab.id ? 'page' : undefined} data-sveltekit-preload-data="hover">
          <Icon icon={tab.icon} size="24" aria-hidden={true} />
          {$t(tab.labelKey)}
        </a>
      {:else}
        <button type="button" aria-current={current === tab.id ? 'page' : undefined} onclick={openSearch}>
          <Icon icon={tab.icon} size="24" aria-hidden={true} />
          {$t(tab.labelKey)}
        </button>
      {/if}
    {/each}
  </nav>
{/if}

<style>
  /* apple-style.css "#7 phone tab bar": hidden above phone width. */
  .fl-tabbar {
    display: none;
  }
  @media (max-width: 700px) {
    .fl-tabbar {
      position: fixed;
      left: max(12px, var(--fl-safe-left));
      right: max(12px, var(--fl-safe-right));
      bottom: max(10px, var(--fl-safe-bottom));
      /* apple-style.css "#7 phone tab bar": over the page, under dialogs and the drawer. */
      z-index: 8;
      display: grid;
      grid-auto-columns: 1fr;
      grid-auto-flow: column;
      padding: 6px;
      border: 1px solid var(--fl-material-edge);
      border-radius: 26px;
      background: var(--fl-material);
      box-shadow: 0 10px 40px rgb(0 0 0 / 44%);
    }
    .fl-tabbar a,
    .fl-tabbar button {
      display: grid;
      justify-items: center;
      gap: 2px;
      min-height: 52px;
      padding: 6px 0 4px;
      border: 0;
      border-radius: 20px;
      background: transparent;
      /* Text on material uses the on-material colours only (tokens.css). */
      color: var(--fl-on-material-muted);
      font: inherit;
      font-size: 10px;
      font-weight: 600;
      text-decoration: none;
    }
    .fl-tabbar [aria-current='page'] {
      color: var(--fl-on-material-accent);
      background: color-mix(in srgb, var(--fl-text) 8%, transparent);
    }
    /* Room for the tab bar under the scrolling content (apple-style.css: `padding-bottom: 96px`). */
    :global(:root:has(.fl-tabbar)) {
      --fl-tabbar-space: calc(96px + env(safe-area-inset-bottom, 0px));
      /* What the bar covers from the bottom edge: its inset, 66px of bar and an 8px gap. */
      --fl-tabbar-height: calc(max(10px, env(safe-area-inset-bottom, 0px)) + 74px);
    }
  }
</style>
