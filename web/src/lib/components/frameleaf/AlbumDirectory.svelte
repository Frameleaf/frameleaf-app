<script lang="ts" module>
  /** Stable id for the page heading so the layout's skip link can target it. */
  export const albumDirectoryHeadingId = 'frameleaf-albums-heading';
</script>

<script lang="ts">
  import { goto } from '$app/navigation';
  import AlbumCreateDialog from '$lib/components/frameleaf/AlbumCreateDialog.svelte';
  import AlbumMoveDialog from '$lib/components/frameleaf/AlbumMoveDialog.svelte';
  import AlbumTile from '$lib/components/frameleaf/AlbumTile.svelte';
  import CollectionShelf from '$lib/components/frameleaf/CollectionShelf.svelte';
  import SmartAlbumReevaluateDialog from '$lib/components/frameleaf/SmartAlbumReevaluateDialog.svelte';
  import SmartAlbumRuleDialog from '$lib/components/frameleaf/SmartAlbumRuleDialog.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import Dropdown from '$lib/elements/Dropdown.svelte';
  import {
    albumDirectoryFilters,
    albumDirectorySorts,
    arrangeAlbumDirectory,
    canDropOnCollection,
    canEdit,
    canTakeOut,
    isOwner,
    moveTargets,
    normalizeAlbumDirectoryView,
    type AlbumDirectoryFilter,
    type AlbumDirectorySort,
    type AlbumDirectoryViewMode,
  } from '$lib/frameleaf/album-directory';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import AlbumEditModal from '$lib/modals/AlbumEditModal.svelte';
  import AlbumOptionsModal from '$lib/modals/AlbumOptionsModal.svelte';
  import SmartAlbumReevaluateModal from '$lib/modals/SmartAlbumReevaluateModal.svelte';
  import { Route } from '$lib/route';
  import {
    handleCreateAlbumEntry,
    handleDeleteAlbum,
    handleDownloadAlbum,
    handleMoveAlbumToCollection,
    handleRemoveUserFromAlbum,
  } from '$lib/services/album.service';
  import { albumDirectoryView } from '$lib/stores/preferences.store';
  import { loadRuleSources, type RuleSources } from '$lib/frameleaf/classification-sources';
  import { handleError } from '$lib/utils/handle-error';
  import { getAlbumDragData, isAlbumDrag } from '$lib/utils/album-drag';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import {
    AlbumKind,
    createClassificationRule,
    getClassificationRule,
    type AlbumResponseDto,
    type AlbumTreeResponseDto,
    type ClassificationRuleCreateDto,
    type ClassificationRuleResponseDto,
    type CreateAlbumDto,
  } from '@immich/sdk';
  import { Icon, modalManager } from '@immich/ui';
  import {
    mdiAccountMultipleOutline,
    mdiAccountPlusOutline,
    mdiAutoFix,
    mdiDeleteOutline,
    mdiDotsHorizontal,
    mdiDownloadOutline,
    mdiFolderMoveOutline,
    mdiFolderMultipleOutline,
    mdiFolderOpenOutline,
    mdiImageAlbum,
    mdiLogoutVariant,
    mdiMagnify,
    mdiPencilOutline,
    mdiPlus,
    mdiRefresh,
    mdiSortVariant,
    mdiUpload,
    mdiViewGridOutline,
    mdiViewListOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The Albums page (FL-52). Collections are shelves with their albums beneath;
   * albums that stand on their own follow under "Other albums", then shared
   * spaces. Filters All, My albums, Shared, Smart; one sort menu; grid and list
   * (the list keeps the shelves); a New menu for album, smart album, collection
   * or shared space. Albums drag onto a collection shelf (mouse, pen) or move
   * through the dialog (keyboard, touch). Everything comes from GET /albums/tree
   * and goes back through the album service; the server owns the access rules.
   *
   * Shared spaces are the last shelf (FL-55). They stay top level — never inside
   * a collection, never offered a move — and open on their own page, where the
   * space's photos, viewer and members live. The shelf links to Sharing, where
   * spaces are created and invitations answered, and says when invitations are
   * waiting.
   */
  interface Props {
    tree: AlbumTreeResponseDto;
    /** Shared space invitations waiting for this person's answer. */
    spaceInvitations?: number;
    /** Re-fetch the tree after a change; the page owns the loader. */
    onRefresh: () => Promise<void> | void;
  }

  let { tree, spaceInvitations = 0, onRefresh }: Props = $props();

  const currentUserId = $derived(authManager.user.id);
  const view = $derived(normalizeAlbumDirectoryView($albumDirectoryView));

  let search = $state('');
  let status = $state('');
  let dragged = $state<AlbumResponseDto | undefined>();
  let overRoot = $state(false);
  let busy = $state(false);
  let createDialog = $state<{ open: boolean; kind: AlbumKind; parentId: string | null; smart: boolean }>({
    open: false,
    kind: AlbumKind.Album,
    parentId: null,
    smart: false,
  });
  let moveDialog = $state<{ open: boolean; album?: AlbumResponseDto }>({ open: false });
  let reevaluate = $state<{ open: boolean; rule?: ClassificationRuleResponseDto; sources: RuleSources }>({
    open: false,
    sources: { people: [], tags: [] },
  });
  const headingId = albumDirectoryHeadingId;

  const arrangement = $derived(
    arrangeAlbumDirectory(tree, { filter: view.filter, sort: view.sort, search, userId: currentUserId }),
  );
  const everything = $derived([
    ...tree.collections.flatMap((node) => [node.collection, ...node.albums]),
    ...tree.albums,
    ...tree.spaces,
  ]);
  const editableCollections = $derived(
    tree.collections.map(({ collection }) => collection).filter((collection) => canEdit(collection, currentUserId)),
  );
  const find = (id: string) => everything.find((album) => album.id === id);

  /**
   * The spaces shelf shows whenever it has spaces to show, and — so there is always a way to one
   * from here — as an invitation to make the first when the page has other things on it and the
   * filter could include a space.
   */
  const showSpaces = $derived(
    arrangement.spaces.length > 0 ||
      (!arrangement.searching && !arrangement.empty && (view.filter === 'all' || view.filter === 'shared')),
  );
  const isSpace = (album: AlbumResponseDto) => album.kind === AlbumKind.Space;
  const openRoute = (album: AlbumResponseDto) =>
    isSpace(album) ? Route.viewSharedSpace({ id: album.id }) : Route.viewAlbum({ id: album.id });
  const nameOf = (album: AlbumResponseDto | undefined) => album?.albumName || $t('unnamed_album');

  const filterLabels: Record<AlbumDirectoryFilter, () => string> = {
    all: () => $t('all'),
    owned: () => $t('frameleaf_albums_filter_owned'),
    shared: () => $t('shared'),
    smart: () => $t('frameleaf_albums_filter_smart'),
  };
  const sortLabels: Record<AlbumDirectorySort, () => string> = {
    modified: () => $t('frameleaf_albums_sort_modified'),
    created: () => $t('frameleaf_albums_sort_created'),
    title: () => $t('frameleaf_albums_sort_title'),
    items: () => $t('frameleaf_albums_sort_items'),
    'recent-photo': () => $t('frameleaf_albums_sort_recent'),
    'oldest-photo': () => $t('frameleaf_albums_sort_oldest'),
  };

  const summary = $derived(
    [
      $t('frameleaf_albums_count', { values: { count: arrangement.totals.albums } }),
      arrangement.totals.collections > 0
        ? $t('frameleaf_albums_collection_count', { values: { count: arrangement.totals.collections } })
        : null,
      arrangement.totals.shared > 0
        ? $t('frameleaf_albums_shared_count', { values: { count: arrangement.totals.shared } })
        : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );

  const setView = (patch: Partial<typeof view>) => {
    $albumDirectoryView = { ...view, ...patch };
  };
  const setFilter = (filter: AlbumDirectoryFilter) => setView({ filter });
  const setSort = (sort: AlbumDirectorySort) => setView({ sort });
  const setViewMode = (mode: AlbumDirectoryViewMode) => setView({ view: mode });
  const isCollapsed = (id: string) => view.collapsed.includes(id);
  const toggleCollapsed = (id: string) =>
    setView({ collapsed: isCollapsed(id) ? view.collapsed.filter((item) => item !== id) : [...view.collapsed, id] });

  const onFilterKeydown = (event: KeyboardEvent, index: number) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) {
      return;
    }
    event.preventDefault();
    const next = (index + step + albumDirectoryFilters.length) % albumDirectoryFilters.length;
    setFilter(albumDirectoryFilters[next]);
    (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLElement>('[role=tab]')[next]?.focus();
  };

  const refresh = async () => {
    await onRefresh();
  };

  onMount(() =>
    eventManager.on({
      AlbumCreate: () => void refresh(),
      AlbumUpdate: () => void refresh(),
      AlbumDelete: () => void refresh(),
      AlbumUserDelete: () => void refresh(),
      AlbumShare: () => void refresh(),
    }),
  );

  /* ---- actions ---- */
  const openCreate = (kind: AlbumKind, parentId: string | null = null, smart = false) => {
    createDialog = { open: true, kind, parentId, smart };
  };

  /** A smart album and its rule are created together (FL-60); nothing is matched until it is applied. */
  const createSmart = async (dto: ClassificationRuleCreateDto) => {
    busy = true;
    try {
      const rule = await createClassificationRule({ classificationRuleCreateDto: dto });
      status = $t('frameleaf_albums_created', { values: { name: rule.albumName } });
      await goto(Route.viewAlbum({ id: rule.albumId }));
      return true;
    } catch (error) {
      handleError(error, $t('frameleaf_rules_create_failed'));
      return false;
    } finally {
      busy = false;
    }
  };

  /** Re-evaluate a rule-backed smart album in place; the built-in ones keep the server-wide check. */
  const openReevaluate = async (album: AlbumResponseDto) => {
    if (!album.smartRuleId) {
      void modalManager.show(SmartAlbumReevaluateModal, {});
      return;
    }
    try {
      const [rule, sources] = await Promise.all([getClassificationRule({ id: album.smartRuleId }), loadRuleSources()]);
      reevaluate = { open: true, rule, sources };
    } catch (error) {
      handleError(error, $t('frameleaf_rules_plan_failed'));
    }
  };

  const create = async (dto: CreateAlbumDto) => {
    busy = true;
    try {
      const album = await handleCreateAlbumEntry(dto);
      if (!album) {
        return false;
      }
      status = $t('frameleaf_albums_created', { values: { name: nameOf(album) } });
      if (album.kind === AlbumKind.Album) {
        await goto(Route.viewAlbum({ id: album.id }));
      } else {
        await refresh();
      }
      return true;
    } finally {
      busy = false;
    }
  };

  const move = async (album: AlbumResponseDto, collectionId: string | null) => {
    if (album.parentId === collectionId) {
      return;
    }
    busy = true;
    try {
      const moved = await handleMoveAlbumToCollection(album, collectionId);
      if (!moved) {
        return;
      }
      const destination = collectionId ? find(collectionId) : undefined;
      status = destination
        ? $t('frameleaf_albums_moved_into', { values: { name: nameOf(album), collection: nameOf(destination) } })
        : $t('frameleaf_albums_moved_out', { values: { name: nameOf(album) } });
      moveDialog = { open: false };
      await refresh();
    } finally {
      busy = false;
    }
  };

  const remove = async (album: AlbumResponseDto) => {
    if (album.kind === AlbumKind.Collection) {
      const count = tree.collections.find(({ collection }) => collection.id === album.id)?.albumCount ?? 0;
      const confirmed = await modalManager.showDialog({
        prompt: $t('frameleaf_albums_delete_collection_confirm', { values: { name: nameOf(album), count } }),
      });
      if (!confirmed) {
        return;
      }
      const ok = await handleDeleteAlbum(album, { prompt: false, notify: false });
      if (ok) {
        status = $t('frameleaf_albums_deleted_collection', { values: { name: nameOf(album) } });
      }
    } else {
      await handleDeleteAlbum(album);
    }
    await refresh();
  };

  const leave = async (album: AlbumResponseDto) => {
    await handleRemoveUserFromAlbum(album, authManager.user);
    await refresh();
  };

  let ruleEdit = $state<{
    open: boolean;
    album?: AlbumResponseDto;
    rule?: ClassificationRuleResponseDto;
    sources: RuleSources;
  }>({ open: false, sources: { people: [], tags: [] } });

  const edit = async (album: AlbumResponseDto) => {
    // A smart album is edited with its rule, as the design's edit dialog does (FL-60).
    if (album.smartRuleId) {
      try {
        const [rule, sources] = await Promise.all([
          getClassificationRule({ id: album.smartRuleId }),
          loadRuleSources(),
        ]);
        ruleEdit = { open: true, album, rule, sources };
      } catch (error) {
        handleError(error, $t('frameleaf_rules_save_failed'));
      }
      return;
    }
    await modalManager.show(AlbumEditModal, { album });
    await refresh();
  };

  const share = async (album: AlbumResponseDto) => {
    await modalManager.show(AlbumOptionsModal, { album, readOnly: !isOwner(album, currentUserId) });
    await refresh();
  };

  /* ---- drag an album onto a collection shelf; touch uses Move to… ---- */
  const startDrag = (album: AlbumResponseDto) => {
    dragged = album;
    status = $t('frameleaf_albums_drag_hint');
  };
  const endDrag = () => {
    dragged = undefined;
    overRoot = false;
  };
  const dropOnCollection = async (albumId: string, collection: AlbumResponseDto) => {
    const album = find(albumId);
    endDrag();
    if (canDropOnCollection(album, collection, currentUserId) && album) {
      await move(album, collection.id);
    }
  };
  const onRootDragOver = (event: DragEvent) => {
    if (!(canTakeOut(dragged, currentUserId) && isAlbumDrag(event))) {
      return;
    }

    event.preventDefault();
    overRoot = true;
  };
  const onRootDrop = async (event: DragEvent) => {
    const albumId = getAlbumDragData(event);
    const album = albumId ? find(albumId) : undefined;
    endDrag();
    if (album && canTakeOut(album, currentUserId)) {
      event.preventDefault();
      await move(album, null);
    }
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (!(event.key === 'Escape' && dragged)) {
      return;
    }

    endDrag();
    status = $t('frameleaf_albums_move_cancelled');
  };

  const draggedParent = $derived(dragged?.parentId ? find(dragged.parentId) : undefined);
</script>

{#snippet menu(album: AlbumResponseDto)}
  {@const owner = isOwner(album, currentUserId)}
  {@const editor = canEdit(album, currentUserId)}
  {@const isAlbum = album.kind === AlbumKind.Album}
  {@const isCollection = album.kind === AlbumKind.Collection}
  <ButtonContextMenu
    icon={mdiDotsHorizontal}
    title={$t('frameleaf_albums_actions_for', { values: { name: nameOf(album) } })}
    align="top-right"
    direction="left"
    size="small"
  >
    <MenuOption icon={mdiFolderOpenOutline} text={$t('open')} onClick={() => goto(openRoute(album))} />
    {#if editor}
      <MenuOption icon={mdiPencilOutline} text={$t('edit')} onClick={() => edit(album)} />
    {/if}
    {#if editor && isCollection}
      <MenuOption
        icon={mdiPlus}
        text={$t('frameleaf_albums_new_album')}
        onClick={() => openCreate(AlbumKind.Album, album.id)}
      />
    {/if}
    {#if owner && isAlbum}
      <MenuOption
        icon={mdiFolderMoveOutline}
        text={$t('frameleaf_albums_move_to')}
        onClick={() => (moveDialog = { open: true, album })}
      />
    {/if}
    {#if editor && isAlbum && !album.isSmart}
      <MenuOption
        icon={mdiUpload}
        text={$t('frameleaf_albums_upload')}
        onClick={() => void openFileUploadDialog({ albumId: album.id })}
      />
    {/if}
    {#if album.isSmart && (album.smartRuleId || authManager.user.isAdmin)}
      <MenuOption
        icon={mdiRefresh}
        text={$t('frameleaf_albums_smart_reevaluate')}
        onClick={() => void openReevaluate(album)}
      />
    {/if}
    {#if isSpace(album)}
      <!-- A space's people are invitations and roles, managed on the space's own Members panel. -->
      <MenuOption
        icon={mdiAccountMultipleOutline}
        text={$t('frameleaf_albums_members')}
        onClick={() => goto(`${Route.viewSharedSpace({ id: album.id })}?panel=members`)}
      />
    {:else}
      <MenuOption
        icon={owner ? mdiAccountPlusOutline : mdiAccountMultipleOutline}
        text={owner ? $t('share') : $t('frameleaf_albums_members')}
        onClick={() => share(album)}
      />
    {/if}
    {#if album.assetCount > 0}
      <MenuOption icon={mdiDownloadOutline} text={$t('download')} onClick={() => handleDownloadAlbum(album)} />
    {/if}
    {#if owner}
      <MenuOption icon={mdiDeleteOutline} text={$t('delete')} onClick={() => remove(album)} />
    {:else}
      <MenuOption icon={mdiLogoutVariant} text={$t('leave')} onClick={() => leave(album)} />
    {/if}
  </ButtonContextMenu>
{/snippet}

{#snippet albums(list: AlbumResponseDto[], emptyText: string)}
  {#if view.view === 'grid'}
    <div class="grid">
      {#each list as album (album.id)}
        <AlbumTile
          {album}
          {currentUserId}
          draggable={album.kind === AlbumKind.Album && isOwner(album, currentUserId)}
          dragging={dragged?.id === album.id}
          onDragStart={startDrag}
          onDragEnd={endDrag}
        >
          {#snippet actions()}{@render menu(album)}{/snippet}
        </AlbumTile>
      {/each}
      {#if list.length === 0 && emptyText}
        <p class="shelf-empty">{emptyText}</p>
      {/if}
    </div>
  {:else}
    <div class="list" role="list">
      {#each list as album (album.id)}
        <div role="listitem">
          <AlbumTile
            {album}
            {currentUserId}
            layout="list"
            draggable={album.kind === AlbumKind.Album && isOwner(album, currentUserId)}
            dragging={dragged?.id === album.id}
            onDragStart={startDrag}
            onDragEnd={endDrag}
          >
            {#snippet actions()}{@render menu(album)}{/snippet}
          </AlbumTile>
        </div>
      {/each}
      {#if list.length === 0 && emptyText}
        <p class="shelf-empty">{emptyText}</p>
      {/if}
    </div>
  {/if}
{/snippet}

<svelte:document onkeydown={onKeydown} />

<section class="albums" aria-labelledby={headingId}>
  <header class="head">
    <div class="heading">
      <h1 id={headingId}>{$t('albums')}</h1>
      <p>{summary}</p>
    </div>
    <div class="tools">
      <label class="search">
        <Icon icon={mdiMagnify} size="17" />
        <input type="search" bind:value={search} placeholder={$t('search_albums')} aria-label={$t('search_albums')} />
      </label>
      <Dropdown
        title={$t('frameleaf_albums_sort')}
        options={[...albumDirectorySorts]}
        selectedOption={view.sort}
        onSelect={(sort) => setSort(sort)}
        render={(sort) => ({ title: sortLabels[sort](), icon: mdiSortVariant })}
      />
      <div class="view" role="group" aria-label={$t('view')}>
        <button
          type="button"
          aria-pressed={view.view === 'grid'}
          aria-label={$t('frameleaf_albums_view_grid')}
          title={$t('frameleaf_albums_view_grid')}
          onclick={() => setViewMode('grid')}
        >
          <Icon icon={mdiViewGridOutline} size="18" />
        </button>
        <button
          type="button"
          aria-pressed={view.view === 'list'}
          aria-label={$t('frameleaf_albums_view_list')}
          title={$t('frameleaf_albums_view_list')}
          onclick={() => setViewMode('list')}
        >
          <Icon icon={mdiViewListOutline} size="18" />
        </button>
      </div>
      <ButtonContextMenu
        icon={mdiPlus}
        title={$t('frameleaf_albums_new')}
        align="top-right"
        direction="left"
        color="primary"
        variant="filled"
        hideContent={false}
      >
        <MenuOption
          icon={mdiImageAlbum}
          text={$t('frameleaf_albums_new_album')}
          onClick={() => openCreate(AlbumKind.Album)}
        />
        <MenuOption
          icon={mdiAutoFix}
          text={$t('frameleaf_albums_new_smart')}
          onClick={() => openCreate(AlbumKind.Album, null, true)}
        />
        <MenuOption
          icon={mdiFolderMultipleOutline}
          text={$t('frameleaf_albums_new_collection')}
          onClick={() => openCreate(AlbumKind.Collection)}
        />
        <MenuOption
          icon={mdiAccountMultipleOutline}
          text={$t('frameleaf_albums_new_space')}
          onClick={() => openCreate(AlbumKind.Space)}
        />
      </ButtonContextMenu>
    </div>
  </header>

  <div class="filters" role="tablist" aria-label={$t('frameleaf_albums_show')}>
    {#each albumDirectoryFilters as filter, index (filter)}
      <button
        type="button"
        role="tab"
        aria-selected={view.filter === filter}
        tabindex={view.filter === filter ? 0 : -1}
        onclick={() => setFilter(filter)}
        onkeydown={(event) => onFilterKeydown(event, index)}
      >
        {filterLabels[filter]()}
      </button>
    {/each}
  </div>

  <Status message={status} {busy} />

  {#each arrangement.shelves as shelf (shelf.collection.id)}
    {@const editor = canEdit(shelf.collection, currentUserId)}
    <CollectionShelf
      {shelf}
      {currentUserId}
      collapsed={isCollapsed(shelf.collection.id)}
      canEdit={editor}
      acceptsDrop={canDropOnCollection(dragged, shelf.collection, currentUserId)}
      onToggle={() => toggleCollapsed(shelf.collection.id)}
      onNewAlbum={() => openCreate(AlbumKind.Album, shelf.collection.id)}
      onDrop={(albumId) => void dropOnCollection(albumId, shelf.collection)}
    >
      {#snippet actions()}{@render menu(shelf.collection)}{/snippet}
      {@render albums(
        shelf.albums,
        editor ? $t('frameleaf_albums_shelf_empty_editor') : $t('frameleaf_albums_shelf_empty'),
      )}
    </CollectionShelf>
  {/each}

  {#if arrangement.albums.length > 0}
    <section class="plain" aria-label={$t('frameleaf_albums_other')}>
      {#if arrangement.shelves.length > 0 || showSpaces}
        <h2>
          {$t('frameleaf_albums_other')}
          <small>{$t('frameleaf_albums_count', { values: { count: arrangement.albums.length } })}</small>
        </h2>
      {/if}
      {@render albums(arrangement.albums, '')}
    </section>
  {/if}

  {#if showSpaces}
    <section class="plain spaces" aria-label={$t('frameleaf_albums_spaces')}>
      <div class="spaces-head">
        <h2>
          {$t('frameleaf_albums_spaces')}
          <small>{$t('frameleaf_albums_space_count', { values: { count: arrangement.spaces.length } })}</small>
        </h2>
        <div class="spaces-links">
          {#if spaceInvitations > 0}
            <a class="invitations" href={Route.sharing()}>
              {$t('frameleaf_albums_spaces_invitations', { values: { count: spaceInvitations } })}
            </a>
          {/if}
          <a href={Route.sharing()}>{$t('frameleaf_albums_spaces_open_sharing')}</a>
        </div>
      </div>
      <p class="spaces-hint">{$t('frameleaf_spaces_intro')}</p>
      {#if arrangement.spaces.length > 0}
        {@render albums(arrangement.spaces, '')}
      {:else}
        <div class="shelf-empty spaces-empty">
          <p>{$t('frameleaf_spaces_empty_title')}</p>
          <button type="button" class="primary" onclick={() => openCreate(AlbumKind.Space)}>
            {$t('frameleaf_spaces_new')}
          </button>
        </div>
      {/if}
    </section>
  {/if}

  {#if arrangement.empty}
    <div class="empty">
      <Icon icon={mdiImageAlbum} size="36" />
      {#if arrangement.searching}
        <h2>{$t('frameleaf_albums_empty_search_title')}</h2>
        <p>{$t('frameleaf_albums_empty_search_text')}</p>
      {:else if view.filter === 'shared'}
        <h2>{$t('frameleaf_albums_empty_shared_title')}</h2>
        <p>{$t('frameleaf_albums_empty_shared_text')}</p>
      {:else if view.filter === 'smart'}
        <h2>{$t('frameleaf_albums_empty_smart_title')}</h2>
        <p>{$t('frameleaf_albums_empty_smart_text')}</p>
      {:else}
        <h2>{$t('frameleaf_albums_empty_title')}</h2>
        <p>{$t('frameleaf_albums_empty_text')}</p>
        <button type="button" class="primary" onclick={() => openCreate(AlbumKind.Album)}>{$t('create_album')}</button>
      {/if}
    </div>
  {/if}

  <div
    class="root-drop"
    class:visible={!!draggedParent}
    class:over={overRoot}
    aria-hidden="true"
    ondragover={onRootDragOver}
    ondragenter={onRootDragOver}
    ondragleave={() => (overRoot = false)}
    ondrop={onRootDrop}
  >
    {#if dragged && draggedParent}
      {$t('frameleaf_albums_drop_take_out', { values: { name: nameOf(dragged), collection: nameOf(draggedParent) } })}
    {/if}
  </div>
</section>

<AlbumCreateDialog
  bind:open={createDialog.open}
  kind={createDialog.kind}
  collections={editableCollections}
  defaultParentId={createDialog.parentId}
  smart={createDialog.smart}
  onCreate={create}
  onCreateSmart={createSmart}
/>

{#if moveDialog.album}
  <AlbumMoveDialog
    bind:open={moveDialog.open}
    album={moveDialog.album}
    targets={moveTargets(tree, moveDialog.album, currentUserId)}
    {busy}
    onMove={(collectionId) => moveDialog.album && void move(moveDialog.album, collectionId)}
  />
{/if}

{#if ruleEdit.rule && ruleEdit.album}
  <SmartAlbumRuleDialog
    album={ruleEdit.album}
    rule={ruleEdit.rule}
    sources={ruleEdit.sources}
    bind:open={ruleEdit.open}
    onSaved={(_saved, message) => {
      status = message;
      void refresh();
    }}
  />
{/if}

{#if reevaluate.rule}
  <SmartAlbumReevaluateDialog
    rule={reevaluate.rule}
    sources={reevaluate.sources}
    bind:open={reevaluate.open}
    onApplied={(message) => {
      status = message;
      void refresh();
    }}
  />
{/if}

<style>
  .albums {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1rem;
    color: var(--fl-text);
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .heading h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 700;
  }
  .heading p {
    margin: 0.125rem 0 0;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-inline-start: 0.625rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-panel);
    color: var(--fl-muted);
    min-width: 14rem;
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--fl-text);
    font: inherit;
  }
  .search input:focus-visible {
    outline: none;
  }
  .search:focus-within {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .view {
    display: inline-flex;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    overflow: hidden;
  }
  .view button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.625rem;
    border: 0;
    background: var(--fl-panel);
    color: var(--fl-muted);
  }
  .view button[aria-pressed='true'] {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .filters button {
    padding: 0 0.875rem;
    border: 1px solid var(--fl-border);
    border-radius: 999px;
    background: var(--fl-panel);
    color: var(--fl-text);
    font-size: 0.875rem;
  }
  .filters button[aria-selected='true'] {
    background: var(--fl-accent);
    border-color: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
    gap: 1rem;
  }
  .list {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--fl-border);
  }
  .shelf-empty {
    grid-column: 1 / -1;
    margin: 0;
    padding: 1rem;
    border: 1px dashed var(--fl-border);
    border-radius: var(--fl-radius);
    color: var(--fl-muted);
    font-size: 0.875rem;
    text-align: center;
  }
  .plain h2 {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin: 0 0 0.75rem;
    font-size: 1rem;
    font-weight: 600;
  }
  .spaces-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.25rem 1rem;
  }
  .spaces-head h2 {
    margin-block-end: 0.25rem;
  }
  .spaces-links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    font-size: 0.8125rem;
  }
  .spaces-links a {
    color: var(--fl-accent);
    font-weight: 600;
    text-decoration: none;
  }
  .spaces-links .invitations {
    color: var(--fl-text);
  }
  .spaces-hint {
    margin: 0 0 0.75rem;
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
  .spaces-empty {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
  }
  .spaces-empty p {
    margin: 0;
  }
  .spaces-empty .primary {
    min-height: 36px;
  }
  .plain h2 small {
    color: var(--fl-muted);
    font-size: 0.75rem;
    font-weight: 400;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 3rem 1rem;
    color: var(--fl-muted);
    text-align: center;
  }
  .empty h2 {
    margin: 0;
    color: var(--fl-text);
    font-size: 1.125rem;
  }
  .empty p {
    margin: 0;
    font-size: 0.875rem;
  }
  .primary {
    padding: 0 1rem;
    border: 1px solid var(--fl-accent);
    border-radius: var(--fl-radius);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  .root-drop {
    display: none;
    padding: 1rem;
    border: 2px dashed var(--fl-border);
    border-radius: 10px;
    color: var(--fl-muted);
    text-align: center;
    font-size: 0.875rem;
  }
  .root-drop.visible {
    display: block;
  }
  .root-drop.over {
    border-color: var(--fl-accent);
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  @media (max-width: 640px) {
    .albums {
      padding: 0.75rem;
    }
    .search {
      min-width: 0;
      flex: 1 1 100%;
    }
    .grid {
      grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
      gap: 0.75rem;
    }
  }
</style>
