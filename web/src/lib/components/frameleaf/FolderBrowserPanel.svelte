<script lang="ts">
  /**
   * Frameleaf Folders browser (FL-46).
   *
   * Ported from the approved prototype (`design/frameleaf/template/src/Folders.jsx`), built on
   * the existing `foldersStore` (`GET /view/folder/unique-paths`, `GET /view/folder`) that the
   * legacy folders page already uses — the store, its tree and its asset cache are shared, not
   * duplicated. The tree and breadcrumb reuse the existing `Tree` / `TreeItems` / `Breadcrumbs`
   * components from `shared-components/tree`.
   *
   * A storage folder is distinct from an album: it is a read-only view of where originals live
   * on disk, so this panel offers no move/rename/delete-folder actions, matching the source
   * folder endpoint's read-only surface.
   *
   * The full asset grid is deliberately not rendered inline: "View in library" hands the folder
   * off to the shared library session (`$lib/frameleaf/library-session`, an `originalPath`
   * prefix filter) so browsing shares one selection/bulk-action surface with the rest of the
   * library instead of this panel re-implementing it.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Pane from '$lib/components/frameleaf/Pane.svelte';
  import Breadcrumbs from '$lib/components/shared-components/tree/Breadcrumbs.svelte';
  import TreeItemThumbnails from '$lib/components/shared-components/tree/TreeItemThumbnails.svelte';
  import TreeItems from '$lib/components/shared-components/tree/TreeItems.svelte';
  import { createLibrarySession, writeLibraryView } from '$lib/frameleaf/library-session';
  import { Route } from '$lib/route';
  import { foldersStore } from '$lib/stores/folders.svelte';
  import { getAssetUrls } from '$lib/utils';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { joinPaths, type TreeNode } from '$lib/utils/tree-utils';
  import type { AssetResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiFolder, mdiFolderHome, mdiFolderOutline, mdiImageMultipleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    tree: TreeNode;
    pathAssets: AssetResponseDto[] | null;
  }

  let { tree, pathAssets }: Props = $props();

  const getLink = (path: string) => Route.folders({ path });
  const handleNavigateToFolder = (name: string) => goto(getLink(joinPaths(tree.path, name)));

  const files = $derived(pathAssets ?? []);
  const totalBytes = $derived(files.reduce((sum, asset) => sum + (asset.exifInfo?.fileSizeInByte ?? 0), 0));

  const viewInLibrary = () => {
    const session = createLibrarySession();
    session.state.query.filter = { originalPath: { startsWith: tree.path } };
    const url = writeLibraryView(new URL(Route.photos(), window.location.origin), session.state);
    void goto(`${url.pathname}${url.search}`);
  };
</script>

<div class="folder-browser">
  <header class="folder-browser-header">
    <div>
      <h1>{$t('folders')}</h1>
      <p>{$t('frameleaf_folders_subtitle')}</p>
    </div>
  </header>

  <div class="folder-browser-split">
    <Pane label={$t('frameleaf_folders_tree_label')}>
      {#if foldersStore.folders}
        <TreeItems
          tree={foldersStore.folders}
          icons={{ default: mdiFolderOutline, active: mdiFolder }}
          active={tree.path}
          {getLink}
        />
      {/if}
    </Pane>

    <Pane label={$t('frameleaf_folders_contents_of', { values: { name: tree.value || $t('folders') } })}>
      <Breadcrumbs node={tree} icon={mdiFolderHome} title={$t('folders')} {getLink} />

      {#if tree.children.length > 0}
        <h3 class="folder-browser-subheading">{$t('frameleaf_folders_subfolders')}</h3>
        <TreeItemThumbnails items={tree.children} icon={mdiFolder} onClick={handleNavigateToFolder} />
      {/if}

      {#if files.length > 0}
        <div
          class="folder-browser-strip"
          aria-label={$t('frameleaf_folders_contents_of', { values: { name: tree.value } })}
        >
          {#each files.slice(0, 8) as asset (asset.id)}
            <img src={getAssetUrls(asset).thumbnail} alt="" loading="lazy" />
          {/each}
        </div>
        <p class="folder-browser-summary">
          {$t('frameleaf_folders_file_count', { values: { count: files.length } })}
          {#if totalBytes > 0}
            · {getByteUnitString(totalBytes)}
          {/if}
        </p>
        <div class="folder-browser-cta">
          <Button variant="primary" onclick={viewInLibrary}>
            <Icon icon={mdiImageMultipleOutline} size={16} aria-hidden="true" />
            {$t('frameleaf_folders_show_in_timeline')}
          </Button>
        </div>
      {:else if tree.children.length === 0}
        <p class="folder-browser-empty" role="status">
          <Icon icon={mdiFolderOutline} size={28} aria-hidden="true" />
          <strong>{$t('frameleaf_folders_no_files_title')}</strong>
          <span>{$t('frameleaf_folders_no_files_description')}</span>
        </p>
      {/if}
    </Pane>
  </div>
</div>

<style>
  .folder-browser {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    color: var(--fl-text);
  }
  .folder-browser-header h1 {
    font-size: 1.25rem;
  }
  .folder-browser-header p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .folder-browser-split {
    display: grid;
    grid-template-columns: minmax(14rem, 20rem) 1fr;
    gap: 0.75rem;
    align-items: start;
  }
  @media (max-width: 62rem) {
    .folder-browser-split {
      grid-template-columns: 1fr;
    }
  }
  .folder-browser-subheading {
    margin-block-start: 0.75rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .folder-browser-strip {
    display: flex;
    gap: 0.375rem;
    margin-block-start: 0.75rem;
    overflow-x: auto;
  }
  .folder-browser-strip img {
    width: 4.5rem;
    height: 4.5rem;
    object-fit: cover;
    border-radius: var(--fl-radius);
  }
  .folder-browser-summary {
    margin-block-start: 0.375rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .folder-browser-cta {
    margin-block-start: 0.75rem;
  }
  .folder-browser-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    padding: 2rem 1rem;
    color: var(--fl-muted);
    text-align: center;
  }
</style>
