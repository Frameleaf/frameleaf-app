<script lang="ts">
  import { browser } from '$app/environment';
  import { page } from '$app/state';
  import RailSavedSearches from '$lib/components/frameleaf/RailSavedSearches.svelte';
  import Sidebar from '$lib/components/sidebar/Sidebar.svelte';
  import {
    buildAlbumTree,
    emptyAlbumTree,
    type FrameleafAlbumNode,
    type FrameleafAlbumTree,
  } from '$lib/frameleaf/album-tree';
  import {
    buildRailSections,
    FOLDABLE_RAIL_SECTIONS,
    isDestinationCurrent,
    readClosedRailSections,
    toggleRailSection,
    type RailDestination,
    type RailSectionId,
  } from '$lib/frameleaf/navigation';
  import '$lib/frameleaf/tokens.css';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { albumTreeDropdown, sidebarCollapsed } from '$lib/stores/preferences.store';
  import { albumIconPath } from '$lib/utils/album-icons';
  import { handleError } from '$lib/utils/handle-error';
  import { getAlbumTree, getPartners, PartnerDirection, type PartnerResponseDto } from '@immich/sdk';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import {
    mdiAccountOutline,
    mdiChevronDoubleLeft,
    mdiChevronDoubleRight,
    mdiChevronDown,
    mdiChevronRight,
    mdiPlus,
  } from '@mdi/js';
  import { onMount, type Snippet } from 'svelte';
  import type { Translations } from 'svelte-i18n';
  import { t } from 'svelte-i18n';
  import { SvelteSet } from 'svelte/reactivity';

  /**
   * Frameleaf library rail (FL-30).
   *
   * The navigation `UserSidebar` renders. It reuses the production sidebar container, so
   * the mobile overlay, the focus
   * trap, the resize handle and the remembered collapse preference keep working; only
   * the contents are the Frameleaf ones. Destinations come from
   * `$lib/frameleaf/navigation`, the album and collection shape from
   * `$lib/frameleaf/album-tree`.
   *
   * September 24 polish pass (`LibraryRail.jsx`): each labelled section folds away from its
   * heading, remembered per device, and the icon-only rail — which has no headings to reopen a
   * section — always shows everything. Albums and Shared spaces each carry a "+" that opens the
   * Albums page with that create dialog, a request the page consumes so All albums never replays it.
   */

  interface Props {
    /** Extra content from the hosting route, rendered below the navigation. */
    children?: Snippet;
  }

  let { children }: Props = $props();

  let tree = $state<FrameleafAlbumTree>(emptyAlbumTree());
  /** Sections folded on this device (`frameleaf.rail.closedSections`, as in the prototype). */
  let closedSections = $state<RailSectionId[]>(readClosedRailSections(browser ? localStorage : undefined));
  const foldSection = (id: RailSectionId) => {
    closedSections = toggleRailSection(closedSections, id, browser ? localStorage : undefined);
  };
  /** The "+" beside a heading: New album, New shared space (`addButton` in LibraryRail.jsx). */
  const SECTION_CREATE: Partial<Record<RailSectionId, { labelKey: Translations; href: string }>> = {
    albums: { labelKey: 'frameleaf_albums_create_album', href: Route.newAlbum({ kind: 'album' }) },
    spaces: { labelKey: 'frameleaf_spaces_new', href: Route.newAlbum({ kind: 'space' }) },
  };

  /** Collections whose open state the user has flipped away from the saved default. */
  const flipped = new SvelteSet<string>();

  const refreshAlbums = async () => {
    try {
      // The real album directory (FL-52): collections with their albums, standalone
      // albums and top-level shared spaces, already scoped to the account's own albums
      // plus the ones shared with it.
      tree = buildAlbumTree(await getAlbumTree());
    } catch (error) {
      handleError(error, $t('errors.frameleaf_unable_to_load_albums'));
    }
  };

  /** People who share their library with this account (the prototype's partner library entry). */
  let partners = $state<PartnerResponseDto[]>([]);
  const refreshPartners = async () => {
    try {
      partners = await getPartners({ direction: PartnerDirection.SharedWith });
    } catch {
      // The rail still works without the entry; the Sharing page reports partner errors.
      partners = [];
    }
  };

  onMount(() => {
    void refreshAlbums();
    void refreshPartners();

    return eventManager.on({
      AlbumCreate: () => void refreshAlbums(),
      AlbumUpdate: () => void refreshAlbums(),
      AlbumDelete: () => void refreshAlbums(),
      AlbumShare: () => void refreshAlbums(),
      AlbumUserUpdate: () => void refreshAlbums(),
      AlbumUserDelete: () => void refreshAlbums(),
    });
  });

  const preferences = $derived(authManager.authenticated ? authManager.preferences : undefined);

  const sections = $derived(
    buildRailSections({
      search: featureFlagsManager.value.search,
      map: featureFlagsManager.value.map,
      trash: featureFlagsManager.value.trash,
      // Feature preferences are the account's own display choices, never permissions:
      // hiding a destination here does not revoke data or API access.
      people: !!preferences?.people.enabled && preferences.people.sidebarWeb,
      memories: !!preferences?.memories.enabled && preferences.memories.sidebarWeb,
      tags: !!preferences?.tags.enabled && preferences.tags.sidebarWeb,
      folders: !!preferences?.folders.enabled && preferences.folders.sidebarWeb,
      sharedLinks: !!preferences?.sharedLinks.enabled && preferences.sharedLinks.sidebarWeb,
    }),
  );

  const pathname = $derived(page.url.pathname);
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  // The icon-only rail applies on desktop only; the mobile sidebar is a full overlay.
  const iconOnly = $derived($sidebarCollapsed && mediaQueryManager.isFullSidebar);
  const isSectionOpen = (id: RailSectionId) =>
    iconOnly || !FOLDABLE_RAIL_SECTIONS.includes(id) || !closedSections.includes(id);

  const isAlbumCurrent = (node: FrameleafAlbumNode) => pathname.startsWith(Route.viewAlbum({ id: node.id }));
  // A shared space has its own page and is still browsed through the album view, so either is "here".
  const isSpaceCurrent = (node: FrameleafAlbumNode) =>
    isAlbumCurrent(node) || pathname.startsWith(Route.viewSharedSpace({ id: node.id }));
  const isCollectionCurrent = (collection: FrameleafAlbumNode) =>
    isAlbumCurrent(collection) || collection.children.some((child) => isAlbumCurrent(child));

  // The saved album-tree preference is the default for every collection; a collection
  // the user opens or closes keeps its own state for this session.
  const isCollectionOpen = (id: string) => (flipped.has(id) ? !$albumTreeDropdown : $albumTreeDropdown);
  const toggleCollection = (id: string) => {
    if (flipped.has(id)) {
      flipped.delete(id);
    } else {
      flipped.add(id);
    }
  };
</script>

{#snippet railLink(label: string, icon: string, href: string, current: boolean, nested: boolean)}
  <a
    {href}
    class="fl-link"
    class:fl-nested={nested && !iconOnly}
    class:fl-current={current}
    aria-current={current ? 'page' : undefined}
    title={iconOnly ? label : undefined}
    aria-label={iconOnly ? label : undefined}
    data-sveltekit-preload-data="hover"
  >
    <Icon {icon} size="1.25em" aria-hidden={true} class="fl-icon" />
    {#if !iconOnly}<span class="fl-label">{label}</span>{/if}
  </a>
{/snippet}

{#snippet destinationLink(destination: RailDestination)}
  {@render railLink(
    $t(destination.labelKey),
    destination.icon,
    destination.href,
    isDestinationCurrent(page.url, destination),
    false,
  )}
{/snippet}

{#snippet albumLink(node: FrameleafAlbumNode)}
  {@render railLink(node.name, albumIconPath(node.icon), Route.viewAlbum({ id: node.id }), isAlbumCurrent(node), true)}
{/snippet}

{#snippet spaceLink(node: FrameleafAlbumNode)}
  {@render railLink(
    node.name,
    albumIconPath(node.icon),
    Route.viewSharedSpace({ id: node.id }),
    isSpaceCurrent(node),
    true,
  )}
{/snippet}

{#snippet railHeader({ collapsed, toggle }: { collapsed: boolean; toggle: () => void })}
  <!-- LibraryRail.jsx `rail-header`: the "Library" label and the double-chevron toggle (desktop). -->
  <div class="frameleaf fl-rail-header" class:fl-icon-only={collapsed} data-theme={appTheme}>
    {#if !collapsed}<span>{$t('library')}</span>{/if}
    <button
      type="button"
      class="fl-rail-toggle"
      aria-expanded={!collapsed}
      aria-label={collapsed ? $t('frameleaf_rail_expand') : $t('frameleaf_rail_collapse')}
      title={collapsed ? $t('frameleaf_rail_expand') : $t('frameleaf_rail_collapse')}
      onclick={toggle}
    >
      <Icon icon={collapsed ? mdiChevronDoubleRight : mdiChevronDoubleLeft} size="18" aria-hidden={true} />
    </button>
  </div>
{/snippet}

<Sidebar ariaLabel={$t('primary')} header={railHeader}>
  <div class="frameleaf fl-rail" class:fl-icon-only={iconOnly} data-theme={appTheme}>
    {#each sections as section (section.id)}
      {#if section.id === 'footer'}
        <hr class="fl-separator" />
      {/if}

      {#if section.labelKey && iconOnly}
        <!-- `.sidebar.rail-collapsed .nav-heading`: the icon-only rail keeps a hairline per section. -->
        <div class="fl-heading fl-heading-rule" aria-hidden="true"></div>
      {:else if section.labelKey}
        {@const create = SECTION_CREATE[section.id]}
        <div class="fl-heading">
          <!-- The heading folds its section away (LibraryRail.jsx `heading`). -->
          <h2>
            <button
              type="button"
              class="fl-heading-toggle"
              aria-expanded={isSectionOpen(section.id)}
              aria-controls="fl-rail-section-{section.id}"
              onclick={() => foldSection(section.id)}
            >
              {$t(section.labelKey)}
              <Icon icon={mdiChevronDown} size="14" aria-hidden={true} class="fl-heading-chevron" />
            </button>
          </h2>
          {#if create}
            <a
              class="fl-action"
              href={create.href}
              title={$t(create.labelKey)}
              aria-label={$t(create.labelKey)}
              data-sveltekit-preload-data="hover"
            >
              <Icon icon={mdiPlus} size="1em" aria-hidden={true} />
            </a>
          {/if}
        </div>
      {/if}

      <div class="fl-section" id="fl-rail-section-{section.id}" hidden={!isSectionOpen(section.id)}>
        {#each section.destinations as destination (destination.id)}
          {@render destinationLink(destination)}

          {#if destination.id === 'allAlbums' && !iconOnly}
            <!-- Collections, each with the albums inside it. One level deep: in this
               product an album never contains another album, and there is no
               subcollection. -->
            {#each tree.collections as collection (collection.id)}
              <div class="fl-branch" class:fl-current={isCollectionCurrent(collection)}>
                <!-- The twisty only opens the branch; the collection keeps its own page,
                   so every album and collection stays reachable from the rail. -->
                <button
                  type="button"
                  class="fl-twisty"
                  aria-label={isCollectionOpen(collection.id) ? $t('collapse') : $t('expand')}
                  aria-expanded={isCollectionOpen(collection.id)}
                  onclick={() => toggleCollection(collection.id)}
                >
                  <Icon
                    icon={isCollectionOpen(collection.id) ? mdiChevronDown : mdiChevronRight}
                    size="1em"
                    aria-hidden={true}
                    class="fl-chevron"
                  />
                </button>
                <a
                  href={Route.viewAlbum({ id: collection.id })}
                  class="fl-link"
                  aria-current={isAlbumCurrent(collection) ? 'page' : undefined}
                  data-sveltekit-preload-data="hover"
                >
                  <Icon icon={albumIconPath(collection.icon)} size="1.25em" aria-hidden={true} class="fl-icon" />
                  <span class="fl-label">{collection.name}</span>
                </a>
              </div>
              {#if isCollectionOpen(collection.id)}
                {#each collection.children as album (album.id)}
                  {@render albumLink(album)}
                {/each}
              {/if}
            {/each}

            {#each tree.albums as album (album.id)}
              {@render albumLink(album)}
            {/each}
          {/if}
          {#if destination.id === 'allAlbums'}
            <!-- LibraryRail.jsx: saved searches follow the album tree, before Shared links. -->
            <RailSavedSearches {iconOnly} />
          {/if}
        {/each}

        {#if section.id === 'spaces'}
          {#if !iconOnly}
            {#each tree.spaces as space (space.id)}
              {@render spaceLink(space)}
            {/each}
          {/if}
          <!-- LibraryRail.jsx: each partner's library follows the spaces ("Jamie's library"). -->
          {#each partners as partner (partner.id)}
            {@render railLink(
              $t('frameleaf_rail_partner_library', { values: { name: partner.name } }),
              mdiAccountOutline,
              Route.viewPartner({ id: partner.id }),
              pathname.startsWith(Route.viewPartner({ id: partner.id })),
              false,
            )}
          {/each}
        {/if}
      </div>
    {/each}

    {@render children?.()}
  </div>
</Sidebar>

<style>
  /* S-28: the rail follows styles.css:291-357 and 1674-1729 (flat full-width rows, 34px, 22px
     inset, 11px uppercase headings over a hairline, the accent tint with an inset bar). */
  .fl-rail {
    display: flex;
    flex: 1 1 auto;
    min-height: 100%;
    flex-direction: column;
    background: var(--fl-panel);
    font-size: 13px;
  }
  .fl-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin: 8px 0 0;
    padding: 10px 22px 6px 21px;
    border-top: 1px solid var(--fl-border);
    color: var(--fl-muted);
  }
  .fl-heading-rule {
    height: 1px;
    margin: 10px 12px;
    padding: 0;
  }
  .fl-heading h2 {
    color: var(--fl-muted);
    font-size: 11px;
    font-weight: 400;
    letter-spacing: 0.7px;
    text-transform: uppercase;
    margin: 0;
  }
  .fl-rail-header {
    display: none;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    height: 44px;
    padding: 0 12px 0 22px;
    color: var(--fl-muted);
    background: var(--fl-panel);
  }
  .fl-rail-header.fl-icon-only {
    justify-content: center;
    padding-inline: 0;
  }
  /* Narrower screens open and close the drawer from the top bar's menu button. */
  @media (min-width: 850px) {
    .fl-rail-header {
      display: flex;
    }
  }
  .fl-rail-toggle {
    display: inline-grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: var(--fl-radius);
    background: transparent;
    color: var(--fl-muted);
  }
  .fl-rail-toggle:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .fl-heading-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    min-height: 28px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--fl-muted);
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    cursor: pointer;
  }
  .fl-heading-toggle:hover {
    color: var(--fl-text);
  }
  .fl-heading-toggle :global(.fl-heading-chevron) {
    transition: rotate 320ms var(--fl-spring, ease);
  }
  .fl-heading-toggle[aria-expanded='false'] :global(.fl-heading-chevron) {
    rotate: -90deg;
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-heading-toggle :global(.fl-heading-chevron) {
      transition: none;
    }
  }
  .fl-section {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .fl-section[hidden] {
    display: none;
  }
  .fl-separator {
    /* `.sidebar-bottom`: Library Care, Settings and Support sit at the bottom of the rail. */
    margin-top: auto;
    margin-bottom: 10px;
    border: 0;
    border-top: 1px solid var(--fl-border);
  }
  /* `.nav-heading .button`: a bare 24px "+" beside the heading. */
  .fl-action {
    display: inline-flex;
    text-decoration: none;
    align-items: center;
    justify-content: center;
    width: 24px;
    min-height: 24px;
    border: 0;
    border-radius: var(--fl-radius);
    background: none;
    color: var(--fl-muted);
  }
  .fl-action:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .fl-link {
    display: flex;
    align-items: center;
    gap: 11px;
    min-height: 34px;
    width: 100%;
    padding: 7px 22px;
    border: 0;
    border-radius: var(--fl-radius);
    background: transparent;
    color: var(--fl-text);
    text-align: start;
    text-decoration: none;
    transition: background var(--fl-motion-fast) var(--fl-ease);
  }
  .fl-icon-only .fl-link {
    justify-content: center;
    min-height: 36px;
    padding: 8px 0;
  }
  .fl-link:hover {
    background: var(--fl-raised);
  }
  .fl-current,
  .fl-current:hover {
    background: color-mix(in srgb, var(--fl-accent), var(--fl-panel) 86%);
    box-shadow: inset 3px 0 var(--fl-accent);
  }
  :global([dir='rtl']) .fl-current {
    box-shadow: inset -3px 0 var(--fl-accent);
  }
  .fl-nested {
    padding-inline-start: 42px;
  }
  .fl-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fl-branch {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    padding-inline-start: 14px;
    border-radius: var(--fl-radius);
  }
  .fl-branch .fl-link {
    padding-inline-start: 0.25rem;
  }
  .fl-twisty {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    min-height: 28px;
    flex-shrink: 0;
    border: 0;
    border-radius: var(--fl-radius);
    background: transparent;
    color: var(--fl-muted);
  }
  .fl-twisty:hover {
    background: var(--fl-raised);
  }
  .fl-rail :global(.fl-icon) {
    flex-shrink: 0;
  }
  .fl-rail :global(.fl-chevron) {
    flex-shrink: 0;
    color: var(--fl-muted);
  }
  /* Phones: the ☰ drawer ends above the frosted tab bar (template `.sidebar.mobile-open`,
     bottom inset = tab bar height + safe area), so its footer stays reachable. */
  @media (max-width: 700px) {
    :global(#sidebar) {
      margin-bottom: var(--fl-tabbar-height, 0px);
    }
  }
  @media (pointer: coarse) {
    .fl-link {
      min-height: 48px;
    }
  }
</style>
