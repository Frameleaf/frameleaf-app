<script lang="ts">
  import { page } from '$app/state';
  import Sidebar from '$lib/components/sidebar/Sidebar.svelte';
  import { buildAlbumTree, emptyAlbumTree, type FrameleafAlbumNode, type FrameleafAlbumTree } from '$lib/frameleaf/album-tree';
  import { buildRailSections, isDestinationCurrent, type RailDestination } from '$lib/frameleaf/navigation';
  import '$lib/frameleaf/tokens.css';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { albumTreeDropdown, sidebarCollapsed } from '$lib/stores/preferences.store';
  import { handlePromiseError } from '$lib/utils';
  import { albumIconPath } from '$lib/utils/album-icons';
  import { createAlbumAndRedirect } from '$lib/utils/album-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { getAlbumTree } from '@immich/sdk';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import { mdiChevronDown, mdiChevronRight, mdiPlus } from '@mdi/js';
  import { onMount, type Snippet } from 'svelte';
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
   */

  interface Props {
    /** Extra content from the hosting route, rendered below the navigation. */
    children?: Snippet;
  }

  let { children }: Props = $props();

  let tree = $state<FrameleafAlbumTree>(emptyAlbumTree());
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

  onMount(() => {
    void refreshAlbums();

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

  const isAlbumCurrent = (node: FrameleafAlbumNode) => pathname.startsWith(Route.viewAlbum({ id: node.id }));
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
    isDestinationCurrent(pathname, destination),
    false,
  )}
{/snippet}

{#snippet albumLink(node: FrameleafAlbumNode)}
  {@render railLink(node.name, albumIconPath(node.icon), Route.viewAlbum({ id: node.id }), isAlbumCurrent(node), true)}
{/snippet}

<Sidebar ariaLabel={$t('primary')}>
  <div class="frameleaf fl-rail" class:fl-icon-only={iconOnly} data-theme={appTheme}>
    {#each sections as section (section.id)}
      {#if section.id === 'footer'}
        <hr class="fl-separator" />
      {/if}

      {#if section.labelKey && !iconOnly}
        <div class="fl-heading">
          <h2>{$t(section.labelKey)}</h2>
          {#if section.id === 'albums'}
            <button
              type="button"
              class="fl-action"
              title={$t('new_album')}
              aria-label={$t('new_album')}
              onclick={() => handlePromiseError(createAlbumAndRedirect())}
            >
              <Icon icon={mdiPlus} size="1em" aria-hidden={true} />
            </button>
          {/if}
        </div>
      {/if}

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
      {/each}

      {#if section.id === 'spaces' && !iconOnly}
        {#each tree.spaces as space (space.id)}
          {@render albumLink(space)}
        {/each}
      {/if}
    {/each}

    {@render children?.()}
  </div>
</Sidebar>

<style>
  .fl-rail {
    display: flex;
    flex: 1 1 auto;
    min-height: 100%;
    flex-direction: column;
    gap: 0.125rem;
    background: var(--fl-panel);
    padding: 0.5rem 0.5rem 1rem;
    font-size: 0.875rem;
  }
  .fl-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    /* Section titles keep clear of the divider, with consistent padding above and
       below, as the interaction requirements ask. */
    padding: 0.75rem 0.5rem 0.25rem;
  }
  .fl-heading h2 {
    color: var(--fl-muted);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin: 0;
  }
  .fl-separator {
    /* Library Care, Settings and Support sit at the bottom of the rail. */
    margin-top: auto;
    margin-bottom: 0.5rem;
    border: 0;
    border-top: 1px solid var(--fl-border);
  }
  .fl-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 32px;
    min-height: 32px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .fl-link {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    min-height: 40px;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border: 0;
    border-radius: var(--fl-radius);
    background: transparent;
    color: var(--fl-text);
    text-align: start;
    text-decoration: none;
  }
  .fl-icon-only .fl-link {
    justify-content: center;
  }
  .fl-link:hover {
    background: var(--fl-raised);
  }
  .fl-current {
    background: var(--fl-raised);
    color: var(--fl-accent);
    font-weight: 600;
  }
  .fl-nested {
    padding-inline-start: 1.75rem;
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
  @media (pointer: coarse) {
    .fl-link {
      min-height: 48px;
    }
  }
</style>
