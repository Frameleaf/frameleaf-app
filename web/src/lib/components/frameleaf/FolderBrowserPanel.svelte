<script lang="ts">
  /**
   * Frameleaf Folders browser (FL-46): a port of the prototype's `Folders` screen
   * (`design/frameleaf/template/src/Folders.jsx`, `discovery.css`) over the real folder views:
   *
   * - the tree, counts and sizes come from `GET /view/folder/summary` (`$lib/frameleaf/folder-tree`),
   *   the open folder's files from `GET /view/folder`; both list only the owner's Timeline items the
   *   session may see, so nothing archived, trashed, Locked or hidden is listed or counted;
   * - the open folder is the page address (`?path=`), so a deep link opens it and browser Back
   *   returns to the previous one; the keyboard tree is `DiscoveryTree`;
   * - the files are the Frameleaf results grid (`ResultsView`), so they open in the viewer and carry
   *   the library's selection and bulk actions, with an offline badge for an external library file
   *   that went missing.
   *
   * A storage folder is where originals live on disk, not an album: nothing here moves, renames or
   * deletes a folder.
   */
  import '$lib/frameleaf/discovery.css';
  import { goto, invalidateAll } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import DiscoveryTree from '$lib/components/frameleaf/DiscoveryTree.svelte';
  import ResultsAssetViewer from '$lib/components/frameleaf/ResultsAssetViewer.svelte';
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
  import {
    FOLDER_ROOT_PATH,
    captureDay,
    folderAt,
    folderBreadcrumbs,
    formatBytes,
    sortFolderFiles,
    type FolderNode,
    type FolderSort,
    type FolderTree,
  } from '$lib/frameleaf/folder-tree';
  import type { CellGridOptions } from '$lib/frameleaf/library-grid';
  import { libraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
  import { viewInLibraryHref } from '$lib/frameleaf/library-query-options';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { Route } from '$lib/route';
  import { foldersStore } from '$lib/stores/folders.svelte';
  import { navigateToAsset } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import type { AssetResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiChevronRight,
    mdiFileDocumentOutline,
    mdiFolderMultipleOutline,
    mdiFolderOpenOutline,
    mdiFolderOutline,
    mdiHarddisk,
    mdiTimelineClockOutline,
  } from '@mdi/js';
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { t } from 'svelte-i18n';

  interface Props {
    tree: FolderTree;
    /** The open folder's path. */
    path: string;
    /** The open folder's own files. */
    assets: AssetResponseDto[];
  }

  let { tree, path, assets }: Props = $props();

  interface FolderView {
    id: string;
    name: string;
    children: FolderView[];
    node: FolderNode;
  }

  const allFolders = $derived($t('frameleaf_folders_all'));
  const folder = $derived(folderAt(tree, path) ?? tree.root);
  const folderName = (node: FolderNode) => (node.path === FOLDER_ROOT_PATH ? allFolders : node.name);
  const toView = (node: FolderNode): FolderView => ({
    id: node.path,
    name: folderName(node),
    children: node.children.map((child) => toView(child)),
    node,
  });
  const roots = $derived([toView(tree.root)]);
  const crumbs = $derived(folderBreadcrumbs(folder));
  const hasFolders = $derived(tree.root.count > 0 || tree.root.children.length > 0);

  // Prototype `open`: the open folder's branch is always expanded, so its row is in view.
  const expanded = new SvelteSet<string>();
  let focusedId = $state<string | null>(null);
  let status = $state('');
  $effect(() => {
    for (const crumb of folderBreadcrumbs(folder)) {
      expanded.add(crumb.path);
    }
  });
  // A folder's selection belongs to its own files: opening another folder starts fresh.
  $effect(() => {
    void folder.path;
    untrack(() => librarySession.clearSelection());
  });

  const toggle = (view: FolderView) => {
    if (expanded.has(view.id)) {
      expanded.delete(view.id);
    } else {
      expanded.add(view.id);
    }
  };
  const open = (target: FolderNode) => {
    focusedId = target.path;
    return goto(Route.folders({ path: target.path }), { keepFocus: true, noScroll: true });
  };

  let sort = $state<FolderSort>('name');
  const removed = new SvelteSet<string>();
  let changed = $state<Record<string, AssetResponseDto>>({});
  const files = $derived(
    sortFolderFiles(
      assets
        .filter((asset) => !removed.has(asset.id))
        .map((asset) => ({
          ...(changed[asset.id] ?? asset),
          fileSizeInByte: (changed[asset.id] ?? asset).exifInfo?.fileSizeInByte ?? null,
        })),
      sort,
    ) as (AssetResponseDto & { fileSizeInByte: number | null })[],
  );
  const byId = $derived(new Map(files.map((asset) => [asset.id, asset])));
  const timelineAssets = $derived(files.map((asset) => toTimelineAsset(asset)));

  /** Template `.dv-file-grid`: 132px square tiles (three columns on phones) with a two-line caption. */
  const cellOptions = $derived<CellGridOptions>({
    minCellWidth: 132,
    aspect: 1,
    gap: libraryGridPreferences.phone ? 8 : 12,
    captionHeight: 40,
    columns: libraryGridPreferences.phone ? 3 : undefined,
  });

  const refresh = async () => {
    foldersStore.bustAssetCache();
    try {
      await foldersStore.fetchTree({ refresh: true });
      await invalidateAll();
    } catch (error) {
      handleError(error, $t('errors.frameleaf_folders_unable_to_load'));
    }
  };
  const onRemoved = (ids: string[]) => {
    for (const id of ids) {
      removed.add(id);
    }
    // The tree's counts and sizes, and every cached folder, change with what left this folder.
    void refresh();
  };

  const showInTimeline = () => {
    status = $t('frameleaf_folders_show_in_timeline_status', { values: { name: folderName(folder) } });
    // The search results for the folder path (M3): the timeline buckets cannot apply a path.
    void goto(
      viewInLibraryHref(
        { ...emptyDiscoveryQuery(), filter: { originalPath: { startsWith: folder.path } } },
        location.origin,
      ),
    );
  };
</script>

<!-- Prototype `<main className="discovery dv-folders">`; the page layout already provides the main landmark. -->
<section class="fl-discovery dv-folders" aria-label={$t('folders')}>
  <header class="dv-header">
    <div>
      <h1>{$t('folders')}</h1>
      <p>{$t('frameleaf_folders_subtitle')}</p>
    </div>
    <div class="dv-header-actions">
      <label class="dv-select">
        {$t('frameleaf_folders_sort')}
        <select bind:value={sort} aria-label={$t('frameleaf_folders_sort_label')}>
          <option value="name">{$t('frameleaf_folders_sort_name')}</option>
          <option value="date">{$t('frameleaf_folders_sort_date')}</option>
          <option value="size">{$t('frameleaf_folders_sort_size')}</option>
        </select>
      </label>
      <Button onclick={showInTimeline} disabled={!folder.count}>
        <Icon icon={mdiTimelineClockOutline} size="16" aria-hidden="true" />
        {$t('frameleaf_folders_show_in_timeline')}
      </Button>
    </div>
  </header>

  <Status message={status} />

  <nav class="dv-breadcrumb dv-breadcrumb-bar" aria-label={$t('frameleaf_folders_path')}>
    {#each crumbs as crumb, index (crumb.path)}
      {#if index > 0}
        <Icon icon={mdiChevronRight} size="14" aria-hidden="true" />
      {/if}
      {#if index === crumbs.length - 1}
        <span aria-current="page">
          {#if index === 0}<Icon icon={mdiHarddisk} size="15" aria-hidden="true" />{/if}
          {folderName(crumb)}
        </span>
      {:else}
        <button type="button" onclick={() => void open(crumb)}>
          {#if index === 0}<Icon icon={mdiHarddisk} size="15" aria-hidden="true" />{/if}
          {folderName(crumb)}
        </button>
      {/if}
    {/each}
  </nav>

  {#if !hasFolders}
    <div class="dv-empty" role="status">
      <span class="dv-empty-icon"><Icon icon={mdiFolderOutline} size="30" aria-hidden="true" /></span>
      <strong>{$t('frameleaf_folders_empty_title')}</strong>
      <p>{$t('frameleaf_folders_empty_description')}</p>
    </div>
  {:else}
    <div class="dv-split">
      <nav class="dv-pane dv-tree-pane" aria-label={$t('frameleaf_folders_tree_label')}>
        <DiscoveryTree
          {roots}
          label={$t('folders')}
          {expanded}
          selectedId={folder.path}
          bind:focusedId
          count={(view) => view.node.count}
          expandLabel={(view) => $t('frameleaf_folders_expand_node', { values: { name: view.name } })}
          collapseLabel={(view) => $t('frameleaf_folders_collapse_node', { values: { name: view.name } })}
          onChoose={(view) => void open(view.node)}
          onToggle={toggle}
        >
          {#snippet lead(_, selected)}
            <Icon icon={selected ? mdiFolderOpenOutline : mdiFolderOutline} size="16" aria-hidden="true" />
          {/snippet}
        </DiscoveryTree>
      </nav>

      <section
        class="dv-pane dv-detail dv-folder-detail"
        aria-label={$t('frameleaf_folders_contents_of', { values: { name: folderName(folder) } })}
      >
        {#if folder.children.length > 0}
          <ul class="dv-folder-rows" aria-label={$t('frameleaf_folders_subfolders')}>
            {#each folder.children as child (child.path)}
              <li>
                <button type="button" onclick={() => void open(child)}>
                  <Icon icon={mdiFolderOutline} size="20" aria-hidden="true" />
                  <span>
                    <strong>{child.name}</strong>
                    <small>
                      {$t('frameleaf_folders_file_count', { values: { count: child.count } })}{child.children.length > 0
                        ? ` · ${$t('frameleaf_folders_folder_count', { values: { count: child.children.length } })}`
                        : ''}
                    </small>
                  </span>
                  <small class="dv-folder-size">{formatBytes(child.size)}</small>
                  <Icon icon={mdiChevronRight} size="16" aria-hidden="true" />
                </button>
              </li>
            {/each}
          </ul>
        {/if}

        {#if files.length > 0}
          <div
            class="dv-file-grid-host"
            role="region"
            aria-label={$t('frameleaf_folders_files_in', { values: { name: folderName(folder) } })}
          >
            <ResultsView
              assets={timelineAssets}
              {cellOptions}
              offlineFor={(asset) => byId.get(asset.id)?.isOffline ?? false}
              onOpen={(asset) => void navigateToAsset(asset)}
              {onRemoved}
              onSelectAll={() => librarySession.selectAll(files.map((asset) => asset.id))}
            >
              {#snippet caption(asset: TimelineAsset)}
                {@const file = byId.get(asset.id)}
                {@const day = captureDay(file?.localDateTime)}
                <span class="dv-file-name" title={file?.originalFileName}>{file?.originalFileName}</span>
                <small class="dv-file-detail">{formatBytes(file?.fileSizeInByte)}{day ? ` · ${day}` : ''}</small>
              {/snippet}
            </ResultsView>
          </div>
        {:else}
          <div class="dv-empty compact" role="status">
            <span class="dv-empty-icon"><Icon icon={mdiFolderOpenOutline} size="26" aria-hidden="true" /></span>
            <strong>{$t('frameleaf_folders_no_files_title')}</strong>
            <p>{$t('frameleaf_folders_no_files_description')}</p>
          </div>
        {/if}

        <footer class="dv-details-bar">
          <span>
            <Icon icon={mdiFileDocumentOutline} size="15" aria-hidden="true" />
            {$t('frameleaf_folders_file_count', { values: { count: folder.count } })}{folder.directCount ===
            folder.count
              ? ''
              : ` · ${$t('frameleaf_folders_files_here', { values: { count: folder.directCount } })}`}
          </span>
          <span>
            <Icon icon={mdiHarddisk} size="15" aria-hidden="true" />
            {formatBytes(folder.size)}
          </span>
          {#if folder.children.length > 0}
            <span>
              <Icon icon={mdiFolderMultipleOutline} size="15" aria-hidden="true" />
              {$t('frameleaf_folders_folder_count', { values: { count: folder.children.length } })}
            </span>
          {/if}
          <span class="dv-details-path" title={folder.path}>{folder.path}</span>
        </footer>
      </section>
    </div>
  {/if}
</section>

<ResultsAssetViewer
  assets={files}
  onAssetChange={(asset) => (changed = { ...changed, [asset.id]: asset })}
  onRemove={(id) => onRemoved([id])}
  emptyRoute={Route.folders({ path: folder.path })}
/>
