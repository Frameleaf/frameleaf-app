<script lang="ts">
  /**
   * Frameleaf Folders: storage folders as a visual browser (FL-46, redesigned after the approved
   * mock `design/frameleaf/template/src/FoldersV2.jsx` and `discovery-v2.css`).
   *
   * One layout for the top and every folder: the folder's name as the title, its path as pills, its
   * folders as piles of their own photos, then the photos directly in it. Columns is the fast way
   * down a deep tree on a wide screen.
   *
   * - The tree, counts, sizes, covers and dates come from `GET /view/folder/summary`
   *   (`$lib/frameleaf/folder-tree`), the open folder's files from `GET /view/folder`; both list only
   *   the owner's Timeline items the session may see, so nothing archived, trashed, Locked or hidden
   *   is listed or counted. No card asks the server for anything.
   * - The open folder is the page address (`?path=`), so a link opens it and browser Back returns to
   *   the previous one. The top is the first folder that holds files or branches, never "/".
   * - A folder named after an account's id reads as that person's uploads; its real path stays
   *   visible ("On disk: ...") and is what Copy path copies.
   * - The files are the Frameleaf results grid (`ResultsView`), so they open in the viewer and carry
   *   the library's selection and bulk actions, with an offline badge for an external library file
   *   that went missing.
   *
   * A storage folder is where originals live on disk, not an album: nothing here moves, renames or
   * deletes a folder.
   */
  import { afterNavigate, beforeNavigate, goto, invalidateAll } from '$app/navigation';
  import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import FolderCardGrid from '$lib/components/frameleaf/folders/FolderCardGrid.svelte';
  import FolderColumns from '$lib/components/frameleaf/folders/FolderColumns.svelte';
  import FolderPath from '$lib/components/frameleaf/folders/FolderPath.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import ResultsAssetViewer from '$lib/components/frameleaf/ResultsAssetViewer.svelte';
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { monthSpan } from '$lib/frameleaf/album-directory';
  import {
    FOLDER_ROOT_PATH,
    findFolders,
    firstUsefulFolder,
    folderAccountName,
    folderSorts,
    folderTrail,
    formatBytes,
    normalizeFoldersView,
    resolveFolder,
    sortFolderFiles,
    sortFolders,
    type FolderAccounts,
    type FolderLabel,
    type FolderNode,
    type FolderSort,
    type FoldersViewMode,
    type FolderTree,
  } from '$lib/frameleaf/folder-tree';
  import type { CellGridOptions } from '$lib/frameleaf/library-grid';
  import { libraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
  import { viewInLibraryHref } from '$lib/frameleaf/library-query-options';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { Route } from '$lib/route';
  import { foldersColumnsFit, foldersStore, foldersView } from '$lib/stores/folders.svelte';
  import { navigateToAsset } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import type { AssetResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiChevronLeft,
    mdiContentCopy,
    mdiFolderOutline,
    mdiFormatText,
    mdiMagnify,
    mdiSortVariant,
    mdiTimelineClockOutline,
    mdiViewColumnOutline,
    mdiViewGridOutline,
  } from '@mdi/js';
  import { tick, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { locale, t } from 'svelte-i18n';

  interface Props {
    tree: FolderTree;
    /** The open folder's path. */
    path: string;
    /** The open folder's own files. */
    assets: AssetResponseDto[];
    /** The open folder's files could not be loaded; everything else still shows. */
    assetsFailed?: boolean;
    /** The files were not asked for, because the page opened in columns, which show none. */
    assetsDeferred?: boolean;
    /** Account id to name, for friendly upload folders. Defaults to the signed-in account. */
    accounts?: FolderAccounts;
  }

  let { tree, path, assets, assetsFailed = false, assetsDeferred = false, accounts }: Props = $props();

  const headingId = $props.id();

  const top = $derived(firstUsefulFolder(tree));
  const folder = $derived(resolveFolder(tree, path));
  const isTop = $derived(folder === top);
  const trail = $derived(folderTrail(folder, top));
  const parent = $derived(isTop ? null : folder.parent);
  const hasFolders = $derived(tree.root.count > 0 || tree.root.children.length > 0);

  // The accounts the session already holds: the signed-in one. Nothing is requested to name more.
  const knownAccounts = $derived<FolderAccounts>(
    accounts ?? (authManager.authenticated ? { [authManager.user.id]: authManager.user.name } : {}),
  );
  const accountName = (node: FolderNode) => folderAccountName(node, knownAccounts);
  /** A folder's name: an account's uploads by the person's name, anything else as it is on disk. */
  const label = $derived.by<FolderLabel>(() => {
    const translate = $t;
    const known = knownAccounts;
    return (node) => {
      const account = folderAccountName(node, known);
      return account ? translate('frameleaf_folders_uploads_of', { values: { name: account } }) : node.name;
    };
  });
  /** The same, with the top of the browser as "All folders". */
  const nameOf = $derived.by<FolderLabel>(() => {
    const allFolders = $t('frameleaf_folders_all');
    const named = label;
    const first = top;
    return (node) => (node === first ? allFolders : named(node));
  });
  // A friendly name hides where the folder is, and so does a top that sits below "/": say it.
  const showsDisk = $derived(
    trail.some((node) => accountName(node) !== null) || (isTop && top.path !== FOLDER_ROOT_PATH),
  );
  const diskTitle = (node: FolderNode) =>
    accountName(node) ? $t('frameleaf_folders_on_disk', { values: { path: node.name } }) : undefined;
  // "On disk: " and whatever a language puts after the path, so the path alone is clipped when long.
  // The object replacement character stands in for the path while the sentence is translated.
  const PATH_SLOT = '\u{FFFC}';
  const diskWords = $derived($t('frameleaf_folders_on_disk', { values: { path: PATH_SLOT } }).split(PATH_SLOT));

  const itemCount = (count: number) => $t('frameleaf_folders_item_count', { values: { count } });
  const dateRange = (node: FolderNode) =>
    monthSpan(node.startDate ?? undefined, node.endDate ?? undefined, $locale ?? undefined);
  /** "108 items · 2.6 GB · Aug 2026" */
  const summary = $derived([itemCount(folder.count), formatBytes(folder.size), dateRange(folder)].filter(Boolean));
  /** "108 items · 4 folders · 2.6 GB" */
  const cardNote = (node: FolderNode) =>
    [
      itemCount(node.count),
      node.children.length > 0
        ? $t('frameleaf_folders_folder_count', { values: { count: node.children.length } })
        : null,
      formatBytes(node.size),
    ]
      .filter(Boolean)
      .join(' · ');
  /** "19 items · in uploads": where a found folder is. */
  const foundNote = (node: FolderNode) =>
    `${itemCount(node.count)} · ${$t('frameleaf_folders_found_in', {
      values: {
        place:
          folderTrail(node, top)
            .slice(1, -1)
            .map((crumb) => label(crumb))
            .join(' › ') || $t('frameleaf_folders_all'),
      },
    })}`;

  // The viewer's choices, remembered on this device like the Albums page's view.
  const stored = $derived(normalizeFoldersView($foldersView));
  const columnsFit = $derived(foldersColumnsFit());
  const view = $derived<FoldersViewMode>(stored.view === 'columns' && columnsFit ? 'columns' : 'grid');
  const fileNames = $derived(stored.fileNames);
  const setView = (mode: FoldersViewMode) => {
    $foldersView = { ...stored, view: mode };
  };
  const phone = $derived(libraryGridPreferences.phone);

  const sortLabels: Record<FolderSort, () => string> = {
    name: () => $t('frameleaf_folders_sort_name'),
    newest: () => $t('frameleaf_folders_sort_newest'),
    largest: () => $t('frameleaf_folders_sort_largest'),
    items: () => $t('frameleaf_folders_sort_items'),
  };
  let sort = $state<FolderSort>('name');
  let search = $state('');
  let status = $state('');
  const query = $derived(search.trim());
  const found = $derived(query ? sortFolders(findFolders(top, query, label), sort, label) : []);
  const folders = $derived(sortFolders(folder.children, sort, label));

  const hrefOf = (node: FolderNode) => Route.folders({ path: node.path });
  /** A step inside the page (a neighbouring folder, a row in the columns): focus stays where it is. */
  const go = (node: FolderNode, { replace = false }: { replace?: boolean } = {}) =>
    goto(hrefOf(node), { keepFocus: true, noScroll: true, replaceState: replace });
  /** Open a folder in the grid from the columns (Enter, a double click, Open). */
  const openInGrid = async (node: FolderNode) => {
    setView('grid');
    if (node !== folder) {
      await goto(hrefOf(node), { keepFocus: true });
    }
    // The row or button that was pressed went with the columns; reading starts at the folder's name.
    await tick();
    scrollerOf()?.scrollTo({ top: 0, behavior: 'instant' });
    heading?.focus({ preventScroll: true });
  };
  /** A found folder's card is a link; it opens in the grid, whichever view the search began in. */
  const onFoundOpen = (node: FolderNode) => {
    if (stored.view !== 'grid') {
      setView('grid');
    }
    // Already the open folder: the link goes nowhere new, so only the search is in the way.
    if (node === folder) {
      search = '';
    }
  };

  // Another folder starts clean: its own selection, no search and no message about the last one.
  $effect(() => {
    void folder.path;
    untrack(() => {
      librarySession.clearSelection();
      search = '';
      status = '';
    });
  });

  let section = $state<HTMLElement>();
  let heading = $state<HTMLElement>();
  const scrollerOf = (): HTMLElement | null => {
    for (let node = section?.parentElement; node; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') {
        return node;
      }
    }
    return null;
  };
  // Where each folder was scrolled to, so Back from a subfolder lands on the card that opened it.
  const scrolledTo = new Map<string, number>();
  let arrivedAt = untrack(() => folder.path);
  beforeNavigate(() => {
    const scroller = scrollerOf();
    if (scroller) {
      scrolledTo.set(folder.path, scroller.scrollTop);
    }
  });
  afterNavigate(({ type }) => {
    const from = arrivedAt;
    arrivedAt = folder.path;
    // The same folder: the viewer opening or closing over it.
    if (from === folder.path) {
      return;
    }
    const scroller = scrollerOf();
    if (type === 'popstate') {
      const offset = scrolledTo.get(folder.path) ?? 0;
      void tick().then(() => scroller?.scrollTo({ top: offset, behavior: 'instant' }));
      return;
    }
    // A followed link dropped focus on the page; the folder's name is where reading starts.
    if (type === 'link') {
      heading?.focus({ preventScroll: true });
    }
    // A step in the columns leaves the page where it is.
    if (view !== 'columns') {
      scroller?.scrollTo({ top: 0, behavior: 'instant' });
    }
  });

  // The page opened in columns without the folder's files; the grid asks for them once.
  let askedForFiles = false;
  $effect(() => {
    if (!assetsDeferred) {
      askedForFiles = false;
      return;
    }
    if (view === 'grid' && !askedForFiles) {
      askedForFiles = true;
      void invalidateAll();
    }
  });

  let retrying = $state(false);
  const retryFiles = async () => {
    retrying = true;
    try {
      await invalidateAll();
    } finally {
      retrying = false;
    }
  };

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

  /**
   * Mock `.dv2-files`: square tiles 150px and up with a hair of space between them (three across on
   * phones); with File names on, room under each for its name and size (two across on phones).
   */
  const cellOptions = $derived<CellGridOptions>(
    fileNames
      ? { minCellWidth: 150, aspect: 1, gap: phone ? 10 : 12, captionHeight: 44, columns: phone ? 2 : undefined }
      : { minCellWidth: 150, aspect: 1, gap: phone ? 3 : 4, captionHeight: 0, columns: phone ? 3 : undefined },
  );

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
    // The tree's counts, sizes and covers, and every cached folder, change with what left this folder.
    void refresh();
  };

  const showInTimeline = (node: FolderNode) => {
    status = $t('frameleaf_folders_show_in_timeline_status', { values: { name: nameOf(node) } });
    // The search results for the folder path (M3): the timeline buckets cannot apply a path.
    void goto(
      viewInLibraryHref(
        { ...emptyDiscoveryQuery(), filter: { originalPath: { startsWith: node.path } } },
        location.origin,
      ),
    );
  };

  const copyPath = async (node: FolderNode) => {
    try {
      await navigator.clipboard.writeText(node.path);
      status = $t('frameleaf_folders_copy_path_done', { values: { path: node.path } });
    } catch {
      // No clipboard on a plain http address: the path is shown, to be selected by hand.
      status = $t('frameleaf_folders_copy_path_failed', { values: { path: node.path } });
    }
  };
</script>

<!-- The page layout already provides the main landmark. -->
<section class="folders" aria-labelledby={headingId} bind:this={section}>
  <header class="head">
    <div class="heading" class:has-back={phone && !!parent}>
      {#if phone && parent}
        <a
          class="back"
          href={hrefOf(parent)}
          aria-label={$t('frameleaf_folders_back_to', { values: { name: nameOf(parent) } })}
        >
          <Icon icon={mdiChevronLeft} size="26" aria-hidden />
        </a>
      {/if}
      <h1 id={headingId} tabindex="-1" bind:this={heading}>{isTop ? $t('folders') : label(folder)}</h1>
      <p>{isTop ? $t('frameleaf_folders_subtitle') : summary.join(' · ')}</p>
      {#if phone && showsDisk}
        <p class="disk">
          {diskWords.at(0)}<span class="disk-path" title={folder.path}><bdi>{folder.path}</bdi></span>{diskWords.at(1)}
        </p>
      {/if}
    </div>
    <div class="tools">
      {#if hasFolders}
        <label class="search">
          <Icon icon={mdiMagnify} size="17" aria-hidden />
          <input
            type="search"
            placeholder={$t('frameleaf_folders_find')}
            aria-label={$t('frameleaf_folders_find')}
            bind:value={search}
            oninput={() => (status = '')}
          />
        </label>
        <div class="sort">
          <Menu label={$t('frameleaf_folders_sort')} align={phone ? 'start' : 'end'}>
            {#snippet trigger()}
              <Icon icon={mdiSortVariant} size="17" aria-hidden />
              <span aria-hidden="true">{sortLabels[sort]()}</span>
            {/snippet}
            {#each folderSorts as option (option)}
              <MenuItem checked={sort === option} onSelect={() => (sort = option)}>{sortLabels[option]()}</MenuItem>
            {/each}
          </Menu>
        </div>
        {#if columnsFit}
          <div class="view" role="group" aria-label={$t('view')}>
            <button
              type="button"
              aria-pressed={view === 'grid'}
              aria-label={$t('frameleaf_folders_view_grid')}
              title={$t('frameleaf_folders_view_grid')}
              onclick={() => setView('grid')}
            >
              <Icon icon={mdiViewGridOutline} size="18" aria-hidden />
            </button>
            <button
              type="button"
              aria-pressed={view === 'columns'}
              aria-label={$t('frameleaf_folders_view_columns')}
              title={$t('frameleaf_folders_view_columns')}
              onclick={() => setView('columns')}
            >
              <Icon icon={mdiViewColumnOutline} size="18" aria-hidden />
            </button>
          </div>
        {/if}
      {/if}
      <div class="push">
        <Button onclick={() => showInTimeline(folder)} disabled={folder.count === 0}>
          <Icon icon={mdiTimelineClockOutline} size="18" aria-hidden />
          {$t('frameleaf_folders_show_in_timeline')}
        </Button>
      </div>
    </div>
  </header>

  <!-- Phones have no path row; the back button and the path on disk stand in for it there. -->
  {#if !phone && hasFolders && (!isTop || showsDisk)}
    <div class="path-row">
      {#if !isTop}
        <FolderPath {trail} label={nameOf} href={hrefOf} title={diskTitle} onGo={(node) => void go(node)} />
      {/if}
      {#if view === 'grid'}
        <span class="disk-line">
          {#if showsDisk}
            <span class="disk">
              {diskWords.at(0)}<span class="disk-path" title={folder.path}><bdi>{folder.path}</bdi></span>{diskWords.at(
                1,
              )}
            </span>
          {/if}
          <button type="button" class="copy" title={folder.path} onclick={() => void copyPath(folder)}>
            <Icon icon={mdiContentCopy} size="16" aria-hidden />
            {$t('frameleaf_folders_copy_path')}
          </button>
        </span>
      {/if}
    </div>
  {/if}

  <div class="status"><Status message={status} /></div>

  {#if !hasFolders}
    <div class="empty" role="status">
      <Icon icon={mdiFolderOutline} size="36" aria-hidden />
      <h2>{$t('frameleaf_folders_empty_title')}</h2>
      <p>{$t('frameleaf_folders_empty_description')}</p>
    </div>
  {:else if query}
    {#if found.length > 0}
      <section class="group" aria-label={$t('frameleaf_folders_matching', { values: { query } })}>
        <div class="group-head">
          <h2>
            {$t('frameleaf_folders_matching', { values: { query } })}
            <small role="status">{$t('frameleaf_folders_folder_count', { values: { count: found.length } })}</small>
          </h2>
        </div>
        <FolderCardGrid folders={found} {label} note={foundNote} href={hrefOf} title={diskTitle} onOpen={onFoundOpen} />
      </section>
    {:else}
      <div class="empty" role="status">
        <Icon icon={mdiFolderOutline} size="36" aria-hidden />
        <h2>{$t('frameleaf_folders_find_none_title', { values: { query } })}</h2>
        <p>{$t('frameleaf_discovery_find_none_help')}</p>
        <Button onclick={() => (search = '')}>{$t('frameleaf_discovery_find_clear')}</Button>
      </div>
    {/if}
  {:else if view === 'columns'}
    <FolderColumns
      {top}
      {folder}
      {sort}
      label={nameOf}
      {accountName}
      {dateRange}
      onGo={(node, options) => void go(node, { replace: options?.keyboard })}
      onOpen={(node) => void openInGrid(node)}
      onCopy={(node) => void copyPath(node)}
      onTimeline={showInTimeline}
    />
  {:else}
    {#if folders.length > 0}
      <section class="group" aria-label={$t('folders')}>
        <div class="group-head">
          <h2>
            {$t('folders')}
            <small>{$t('frameleaf_folders_folder_count', { values: { count: folders.length } })}</small>
          </h2>
        </div>
        <FolderCardGrid {folders} {label} note={cardNote} href={hrefOf} title={diskTitle} />
      </section>
    {/if}
    {#if folder.directCount > 0}
      <section class="group" aria-label={$t('frameleaf_folders_in_this_folder')}>
        <div class="group-head">
          <h2>
            {$t('frameleaf_folders_in_this_folder')}
            <small>{itemCount(assetsFailed || assetsDeferred ? folder.directCount : files.length)}</small>
          </h2>
          {#if !assetsFailed && files.length > 0}
            <button
              type="button"
              class="names"
              aria-pressed={fileNames}
              onclick={() => ($foldersView = { ...stored, fileNames: !fileNames })}
            >
              <Icon icon={mdiFormatText} size="16" aria-hidden />
              {$t('frameleaf_folders_file_names')}
            </button>
          {/if}
        </div>
        {#if assetsFailed}
          <InlineError compact message={$t('frameleaf_folders_files_failed')} onRetry={retryFiles} {retrying} />
        {:else if files.length > 0}
          <div class="files" class:named={fileNames}>
            <ResultsView
              assets={timelineAssets}
              {cellOptions}
              offlineFor={(asset) => byId.get(asset.id)?.isOffline ?? false}
              onOpen={(asset) => void navigateToAsset(asset)}
              {onRemoved}
              onSelectAll={() => librarySession.selectAll(files.map((asset) => asset.id))}
              caption={fileNames ? fileCaption : undefined}
            />
          </div>
        {/if}
      </section>
    {/if}
  {/if}
</section>

{#snippet fileCaption(asset: TimelineAsset)}
  {@const file = byId.get(asset.id)}
  <span class="file-name" title={file?.originalFileName}>{file?.originalFileName}</span>
  <small class="file-size">{formatBytes(file?.fileSizeInByte)}</small>
{/snippet}

<ResultsAssetViewer
  assets={files}
  onAssetChange={(asset) => (changed = { ...changed, [asset.id]: asset })}
  onRemove={(id) => onRemoved([id])}
  emptyRoute={hrefOf(folder)}
/>

<style>
  /* The Albums page's shell (AlbumDirectory.svelte), which the mock is built from. */
  .folders {
    padding: 18px 24px 64px;
    color: var(--fl-text);
  }
  .folders > :global(*) {
    max-width: 1400px;
    margin-inline: auto;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--fl-space-4) var(--fl-space-5);
    margin-bottom: var(--fl-space-2);
  }
  .heading {
    min-width: 0;
  }
  .heading h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 700;
    overflow-wrap: anywhere;
  }
  /* Focused by script when a folder opens, so reading starts at its name; it is not a control. */
  .heading h1:focus {
    outline: none;
  }
  .heading p {
    margin: var(--fl-space-2) 0 0;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-3) var(--fl-space-2);
  }
  .search {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 15rem;
    padding-inline-start: 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-panel);
    color: var(--fl-muted);
  }
  .search input {
    flex: 1;
    min-width: 0;
    padding-inline: 0 0.75rem;
    border: 0;
    border-radius: var(--fl-radius-pill);
    background: transparent;
    color: var(--fl-text);
    font: inherit;
  }
  /* The field is the whole capsule, so the capsule wears the one focus ring in the input's place. */
  .search input:focus-visible {
    outline: none;
  }
  .search:has(input:focus-visible) {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .view {
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
  }
  .view button {
    display: grid;
    place-items: center;
    width: 36px;
    min-width: 0;
    min-height: 38px;
    padding: 0;
    border-radius: var(--fl-radius-pill);
    color: var(--fl-muted);
  }
  .view button[aria-pressed='true'] {
    background: var(--fl-panel);
    color: var(--fl-text);
    box-shadow: var(--fl-shadow-1);
  }

  .path-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    margin-block: 4px 8px;
  }
  .disk-line {
    display: inline-flex;
    flex: 0 1 auto;
    align-items: center;
    gap: 8px;
    min-width: 0;
    /* Alone on its line (the top of the browser, or wrapped under a long path) it keeps to the end. */
    margin-inline-start: auto;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .path-row > .disk-line:first-child {
    margin-inline-start: 0;
  }
  /* "On disk: " and the path. The end of a path says the most, so a long one loses its start. */
  .disk {
    display: inline-flex;
    min-width: 0;
    white-space: pre;
  }
  .disk-path {
    min-width: 0;
    max-width: 52ch;
    overflow: hidden;
    /* Clipped at its start: the ellipsis goes where a right-to-left line would put it. */
    direction: rtl;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .copy {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 4px 10px 4px 8px;
    border-radius: var(--fl-radius-pill);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    white-space: nowrap;
  }
  .copy:hover {
    color: var(--fl-text);
  }

  .status {
    min-height: 18px;
    margin-bottom: 8px;
    font-size: var(--fl-font-small);
    overflow-wrap: anywhere;
  }

  .group {
    margin-bottom: 30px;
  }
  .group-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 34px;
    margin-bottom: 10px;
  }
  .group-head h2 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 8px;
    min-width: 0;
    margin: 0;
    padding-inline-start: 2px;
    font-size: 17px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .group-head h2 small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 400;
  }
  .names {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 4px 12px 4px 10px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    font-size: var(--fl-font-callout);
    white-space: nowrap;
  }
  .names:hover {
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 8%);
  }
  .names[aria-pressed='true'] {
    border-color: color-mix(in srgb, var(--fl-text) 28%, var(--fl-border));
    background: color-mix(in srgb, var(--fl-text) 12%, var(--fl-raised));
  }

  /* The file tiles are the library's; here they are rounded like the mock's (`.dv2-files .at-open`). */
  .files :global(.fl-grid-cell .fl-tile) {
    border-radius: var(--fl-radius-control);
  }
  .files :global(.fl-grid-caption) {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 6px 2px 0;
  }
  .file-name {
    overflow: hidden;
    font-size: var(--fl-font-small);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-size {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    font-variant-numeric: tabular-nums;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 64px 20px;
    color: var(--fl-muted);
    text-align: center;
  }
  .empty h2 {
    margin: 4px 0 0;
    color: var(--fl-text);
    font-size: 16px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .empty p {
    max-width: 360px;
    margin: 0;
    font-size: var(--fl-font-callout);
  }

  @media (pointer: coarse) {
    .copy,
    .names {
      min-height: 44px;
    }
  }
  /* Phones: a back button and the name instead of pills, search on its own row, then sort and Show in timeline. */
  @media (max-width: 700px) {
    .folders {
      padding: 14px 16px 64px;
    }
    .head {
      flex-direction: column;
      /* One column: with wrapping on, a long path on disk would set the width of the whole header. */
      flex-wrap: nowrap;
      align-items: stretch;
    }
    .heading.has-back {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      column-gap: 4px;
    }
    .heading.has-back > p {
      grid-column: 1 / -1;
    }
    .back {
      display: inline-grid;
      place-items: center;
      width: 44px;
      height: 44px;
      margin-inline-start: -12px;
      border-radius: var(--fl-radius-control);
      color: inherit;
    }
    .back:dir(rtl) {
      scale: -1 1;
    }
    .heading .disk {
      display: flex;
      font-size: var(--fl-font-small);
    }
    .heading .disk-path {
      max-width: none;
    }
    .search {
      flex: 1 1 100%;
      width: auto;
    }
    .push {
      margin-inline-start: auto;
    }
    .names {
      min-height: 44px;
    }
  }
</style>
