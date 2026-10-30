<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { goto } from '$app/navigation';
  import AlbumConfirmDialog from '$lib/components/frameleaf/AlbumConfirmDialog.svelte';
  import AlbumCoverDialog from '$lib/components/frameleaf/AlbumCoverDialog.svelte';
  import AlbumMark from '$lib/components/frameleaf/AlbumMark.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import AlbumInlineEdit from '$lib/components/frameleaf/AlbumInlineEdit.svelte';
  import AlbumOptionsDialog from '$lib/components/frameleaf/AlbumOptionsDialog.svelte';
  import AlbumShareDialog from '$lib/components/frameleaf/AlbumShareDialog.svelte';
  import AlbumAvatarStack from '$lib/components/frameleaf/AlbumAvatarStack.svelte';
  import MakeMovieSheet from '$lib/components/frameleaf/MakeMovieSheet.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import RuleChips from '$lib/components/frameleaf/RuleChips.svelte';
  import SmartAlbumReevaluateDialog from '$lib/components/frameleaf/SmartAlbumReevaluateDialog.svelte';
  import SmartAlbumReviewDialog from '$lib/components/frameleaf/SmartAlbumReviewDialog.svelte';
  import SmartAlbumRuleDialog from '$lib/components/frameleaf/SmartAlbumRuleDialog.svelte';
  import { fromResponse, timeAgo } from '$lib/frameleaf/classification-rules';
  import { loadRuleSources, type RuleSources } from '$lib/frameleaf/classification-sources';
  import { getAssetMediaUrl } from '$lib/utils';
  import {
    canEdit,
    isOwner,
    monthSpan,
    othersOf,
    ownerOf,
    roleOf,
    type AlbumDetailsDraft,
  } from '$lib/frameleaf/album-directory';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import {
    handleCreateAlbumEntry,
    handleDeleteAlbum,
    handleDownloadAlbum,
    handleEditAlbumDetails,
    handleLeaveAlbum,
    handleUpdateAlbumInfo,
  } from '$lib/services/album.service';
  import { handleError } from '$lib/utils/handle-error';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import {
    AlbumKind,
    AssetMediaSize,
    LibraryScope,
    LibraryViewScope,
    getWorkflowCapabilities,
    AlbumUserRole,
    getAlbumMapMarkers,
    createClassificationRule,
    getClassificationRule,
    type ClassificationRuleCreateDto,
    type ClassificationRuleResponseDto,
    type AlbumResponseDto,
    type CreateAlbumDto,
    type MapMarkerResponseDto,
  } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import {
    mdiAccountCircleOutline,
    mdiAccountMultipleOutline,
    mdiAccountPlusOutline,
    mdiAlertOutline,
    mdiCheck,
    mdiChevronDown,
    mdiChevronRight,
    mdiCommentTextOutline,
    mdiDeleteOutline,
    mdiDotsHorizontal,
    mdiDownloadOutline,
    mdiFolderMultipleOutline,
    mdiImageMultipleOutline,
    mdiImageOutline,
    mdiLinkVariant,
    mdiLogoutVariant,
    mdiMapOutline,
    mdiPencilOutline,
    mdiMovieOpenPlayOutline,
    mdiPlayCircleOutline,
    mdiPaletteOutline,
    mdiPlus,
    mdiRefresh,
    mdiTextBoxCheckOutline,
    mdiTuneVariant,
    mdiAutoFix,
    mdiUpload,
  } from '@mdi/js';
  import { locale, t } from 'svelte-i18n';

  /**
   * The album detail header (FL-53), ported from
   * `design/frameleaf/template/src/CollectionHeader.jsx`.
   *
   * It carries inline title and description, "Icon and colour…" (the icon chooser over the whole
   * Material catalogue and the eight album colours), members with roles, links, map, slideshow, download, cover, options, delete
   * keeping assets, and leave — and, on a collection, the strip of its albums above its
   * photos with a New album tile and a New album primary action in place of Add photos.
   *
   * Every control calls an existing endpoint: `PATCH /albums/{id}` for the details, the
   * album user endpoints for membership, the shared-link endpoints for links,
   * `GET /albums/{id}/map-marker` for the map and `GET /albums/tree` (loaded by the route)
   * for the album strip. What a viewer, an editor and the owner may do follows the roles the
   * server returned in `albumUsers`, so a revoked role removes the control on the next read.
   *
   * What an action did is said in a toast. The line under the toolbar is only for what stays
   * true: that this person's role on the album changed while the page was open. "Shared links"
   * opens the Share dialog at this album's links, where they are listed, edited and created.
   */
  interface Props {
    album: AlbumResponseDto;
    uploadScope?: LibraryScope;
    /** Albums inside this collection, from the tree endpoint. Empty for an album or space. */
    childAlbums?: AlbumResponseDto[];
    /** The collection this album sits in, for the breadcrumb. */
    parent?: AlbumResponseDto;
    ancestors?: AlbumResponseDto[];
    /** Collections the current user may create an album in. */
    collections?: AlbumResponseDto[];
    /**
     * Every album the viewer can see (the page's directory), for "N inside" on the collection cards.
     * Without it the cards count only the albums passed in `childAlbums`.
     */
    albums?: AlbumResponseDto[];
    likeCount?: number;
    commentCount?: number;
    activityOpen?: boolean;
    /** True when the album has editors, so owner badges can be shown on its items. */
    canShowOwnerBadges?: boolean;
    ownerBadges?: boolean;
    /** Items on the page; the slideshow and download are offered only when there are some. */
    assetCount?: number;
    /** Total authorized media and bookmarks; media actions still use assetCount. */
    itemCount?: number;
    onAlbumChange: (album: AlbumResponseDto) => void;
    /** Re-read the album and the tree after membership or structure changed. */
    onRefresh: () => Promise<void> | void;
    onAddPhotos?: () => void;
    onSlideshow?: () => void;
    onToggleActivity?: () => void;
    onToggleOwnerBadges?: () => void;
    /** Replaces the immediate download, for Boards' Download dialog (FL-660). */
    onDownload?: () => void;
  }

  let {
    album,
    uploadScope,
    childAlbums = [],
    parent,
    ancestors,
    collections = [],
    albums = [],
    likeCount = 0,
    commentCount = 0,
    activityOpen = false,
    canShowOwnerBadges = false,
    ownerBadges = false,
    assetCount = 0,
    itemCount,
    onAlbumChange,
    onRefresh,
    onAddPhotos,
    onSlideshow,
    onToggleActivity,
    onToggleOwnerBadges,
    onDownload,
  }: Props = $props();
  const download = () => (onDownload ? onDownload() : void handleDownloadAlbum(album));

  const currentUserId = $derived(authManager.user.id);
  let automationAvailable = $state(false);
  onMount(() => {
    void Promise.resolve(getWorkflowCapabilities())
      .then((value) => {
        automationAvailable = value?.sourceFilters ?? false;
      })
      .catch(() => {});
  });
  const owner = $derived(isOwner(album, currentUserId));
  const editor = $derived(canEdit(album, currentUserId));
  const breadcrumbAlbums = $derived(ancestors ?? (parent ? [parent] : []));
  const isCollection = $derived(album.kind === AlbumKind.Collection);
  const others = $derived(othersOf(album, currentUserId));
  const albumOwner = $derived(ownerOf(album));
  const viewOnly = $derived(roleOf(album, currentUserId) === AlbumUserRole.Viewer);
  const name = $derived(album.albumName || $t('unnamed_album'));
  const span = $derived(monthSpan(album.startDate, album.endDate, $locale ?? undefined));

  const kindLabel = $derived(
    isCollection
      ? $t('frameleaf_album_kind_collection')
      : album.kind === AlbumKind.Space
        ? $t('frameleaf_album_kind_space')
        : $t('frameleaf_album_kind_album'),
  );

  /** The albums a cover may be picked from: this album, or a collection's albums. */
  const coverSourceIds = $derived(isCollection ? childAlbums.map(({ id }) => id) : [album.id]);

  /** Phones (apple-style.css `max-width: 700px`): the secondary actions live in the "…" menu. */
  const phone = new MediaQuery('max-width: 700px');
  const compact = $derived(phone.current);
  /**
   * A Boards collection (prototype screen 02, FL-670): the path starts at Boards, the board's own Add
   * replaces Add photos, the secondary actions sit in "…", and the cards of collections inside show
   * only when there are any, so the items start near the top.
   */
  const boards = $derived(uploadScope === LibraryScope.Design);
  const folded = $derived(compact || boards);

  /** "Icon and colour…" (README point 22): the header's icon tile and the "…" menu open it. */
  let iconOpen = $state(false);
  /** How many albums sit directly inside `id`, from the directory when the page passed one. */
  const insideCount = (id: string) => albums.filter(({ parentId }) => parentId === id).length;
  const coverOf = (child: AlbumResponseDto) =>
    child.albumThumbnailAssetId
      ? getAssetMediaUrl({ id: child.albumThumbnailAssetId, size: AssetMediaSize.Thumbnail })
      : null;
  /** Where the albums inside move when this one is deleted: its parent, or the top level. */
  const deleteDestination = $derived(
    breadcrumbAlbums.at(-1)?.albumName || (breadcrumbAlbums.length > 0 ? $t('unnamed_album') : null),
  );
  const childNames = $derived(
    new Intl.ListFormat($locale ?? undefined, { style: 'long', type: 'conjunction' }).format(
      childAlbums.map((child) => child.albumName || $t('unnamed_album')),
    ),
  );
  const saveAppearance = async ({ icon, color }: { icon: string | null; color: string | null }) =>
    save({ icon, color }, $t('frameleaf_album_color_saved'));
  /** Make a movie (FL-561): beside Slideshow, in the "…" menu on phones. */
  let movieOpen = $state(false);
  let shareOpen = $state(false);
  let shareSection = $state<'people' | 'links'>('people');
  const openShare = (section: 'people' | 'links' = 'people') => {
    shareSection = section;
    shareOpen = true;
  };
  let coverOpen = $state(false);
  let optionsOpen = $state(false);
  let deleteOpen = $state(false);
  let leaveOpen = $state(false);
  let createOpen = $state(false);
  let editOpen = $state(false);
  /** The persistent line: this person's access to the album changed while the page was open. */
  let status = $state('');

  /** "Edit details" (`CollectionFormDialog`, CollectionHeader.jsx:1303-1308): name, description, icon, collection. */
  const saveDetails = async (draft: AlbumDetailsDraft) => {
    const saved = await handleEditAlbumDetails(album, draft);
    if (!saved) {
      return false;
    }
    onAlbumChange(saved);
    toastManager.primary($t('frameleaf_albums_saved', { values: { name: saved.albumName || $t('unnamed_album') } }));
    await onRefresh();
    return true;
  };

  /* ---- smart album rule (FL-60): only the owner's own rule is ever returned ---- */
  let rule = $state<ClassificationRuleResponseDto | undefined>();
  let ruleSources = $state<RuleSources>({ people: [], tags: [] });
  let reevaluateOpen = $state(false);
  let reviewOpen = $state(false);
  let ruleOpen = $state(false);
  /** Edit details, owner badges, rule, cover and options: the "…" menu's middle group. */
  const hasMiddleItems = $derived(editor || canShowOwnerBadges || !!rule);

  const loadRule = async (id: string) => {
    try {
      rule = await getClassificationRule({ id });
    } catch {
      rule = undefined;
    }
  };

  $effect(() => {
    const id = album.smartRuleId;
    if (!id) {
      rule = undefined;
      return;
    }
    void loadRule(id);
    void loadRuleSources().then((sources) => (ruleSources = sources));
  });

  const checkedLabel = $derived.by(() => {
    if (!rule) {
      return '';
    }
    if (!rule.lastAppliedAt) {
      return $t('frameleaf_rules_not_applied');
    }
    return $t('frameleaf_rules_checked', {
      values: { when: timeAgo(rule.lastAppliedAt, Date.now(), $locale ?? undefined) },
    });
  });

  const onRuleChanged = async (message: string) => {
    toastManager.primary(message);
    if (album.smartRuleId) {
      await loadRule(album.smartRuleId);
    }
    await onRefresh();
  };

  /**
   * A role can change while this page is open (FL-53): the server tells every open page at once
   * (`AlbumUserUpdateV1`), the page patches the album, and here every control and open dialog the
   * new role no longer allows closes, with a line saying why. The server refuses the same actions
   * again; this only keeps the page honest.
   */
  let lastAccess = $state<{ editor: boolean; owner: boolean } | undefined>();
  $effect(() => {
    const access = { editor, owner };
    const previous = untrack(() => lastAccess);
    lastAccess = access;
    if (!previous || (previous.editor === access.editor && previous.owner === access.owner)) {
      return;
    }
    if (!access.editor) {
      iconOpen = false;
      coverOpen = false;
      optionsOpen = false;
      editOpen = false;
      createOpen = false;
      reevaluateOpen = false;
      reviewOpen = false;
      ruleOpen = false;
    }
    if (!access.owner) {
      deleteOpen = false;
    }
    if (previous.editor && !access.editor) {
      status = $t('frameleaf_album_access_view_only');
    } else if (!previous.editor && access.editor) {
      status = $t('frameleaf_album_access_can_edit');
    }
  });

  let mapMarkers = $state<MapMarkerResponseDto[]>([]);
  let markerController: AbortController | undefined;

  const mapEnabled = $derived(featureFlagsManager.value.map);

  // The map button states honestly whether this album has anything to put on a map, so it is
  // disabled rather than opening an empty map.
  $effect(() => {
    const id = album.id;
    if (!mapEnabled) {
      mapMarkers = [];
      return;
    }
    markerController?.abort();
    const controller = new AbortController();
    markerController = controller;
    void getAlbumMapMarkers({ ...authManager.params, id }, { signal: controller.signal })
      .then((markers) => {
        if (!controller.signal.aborted) {
          mapMarkers = markers;
        }
      })
      .catch(() => {
        // A map that cannot be loaded simply stays unavailable; nothing else depends on it.
        if (!controller.signal.aborted) {
          mapMarkers = [];
        }
      });
    return () => controller.abort();
  });

  /** The prototype's cover status (FL-83): whether the cover now follows the newest item. */
  const onCoverChange = (updated: AlbumResponseDto) => {
    onAlbumChange(updated);
    toastManager.primary(
      updated.coverFollowsNewest ? $t('frameleaf_album_cover_follows_newest') : $t('frameleaf_album_cover_updated'),
    );
  };

  /** The service says `message` in a toast once the change is saved. */
  const save = async (dto: Parameters<typeof handleUpdateAlbumInfo>[1], message: string) => {
    const updated = await handleUpdateAlbumInfo(album.id, dto, { message });
    if (!updated) {
      return false;
    }
    onAlbumChange(updated);
    return true;
  };

  // The prototype opens the Map screen scoped to this album (App.jsx `setMapScope("collection")`),
  // not a dialog over the album.
  const openMap = () => goto(Route.mapAlbum({ id: album.id }));

  /** Creating inside a collection stays here and says so (CollectionHeader.jsx); the strip refreshes. */
  const createChildAlbum = async (dto: CreateAlbumDto) => {
    const created = await handleCreateAlbumEntry({
      ...dto,
      libraryScope: dto.libraryScope ?? uploadScope ?? album.libraryScope,
    });
    if (!created) {
      return false;
    }
    toastManager.primary(
      $t('frameleaf_albums_created', { values: { name: created.albumName || $t('unnamed_album') } }),
    );
    await onRefresh();
    return true;
  };

  /** A new smart album in this collection, created with its rule (FL-60). */
  const createChildSmartAlbum = async (dto: ClassificationRuleCreateDto) => {
    try {
      const scope = uploadScope ?? album.libraryScope;
      const libraryScope = scope === LibraryScope.Design ? LibraryViewScope.Design : LibraryViewScope.Personal;
      const created = await createClassificationRule({
        classificationRuleCreateDto: { ...dto, filter: { ...dto.filter, libraryScope } },
      });
      await goto(Route.viewAlbum({ id: created.albumId }));
      return true;
    } catch (error) {
      handleError(error, $t('frameleaf_rules_create_failed'));
      return false;
    }
  };

  const confirmDelete = async () => {
    const deleted = await handleDeleteAlbum(album);
    if (deleted) {
      await goto(Route.albums());
    }
  };
  let deleting = $state(false);
  const runDelete = async () => {
    deleting = true;
    try {
      await confirmDelete();
      deleteOpen = false;
    } finally {
      deleting = false;
    }
  };

  const confirmLeave = async () => {
    const left = await handleLeaveAlbum(album);
    if (left) {
      await goto(Route.albums());
    }
  };

  const upload = async () => {
    try {
      await openFileUploadDialog({
        albumId: album.id,
        libraryScope: uploadScope ?? (album.libraryScope === LibraryScope.Design ? LibraryScope.Design : undefined),
      });
    } catch (error) {
      handleError(error, $t('errors.unable_to_upload_file'));
    }
  };

  /** This album's links are listed, edited and created in the Share dialog. */
  const openLinks = () => openShare('links');
</script>

<header class="album-header" aria-label={kindLabel}>
  {#if compact && uploadScope === LibraryScope.Design}
    <!-- Boards on a phone: the rail is the "Collections and filters" sheet (prototype screen 22). -->
    <button
      type="button"
      class="sheet-trigger"
      aria-haspopup="dialog"
      aria-expanded={sidebarStore.isOpen}
      aria-controls="sidebar"
      onclick={() => sidebarStore.toggle()}
    >
      <Icon icon={mdiFolderMultipleOutline} size="18" aria-hidden={true} />
      {$t('frameleaf_boards_collections_and_filters')}
      <Icon icon={mdiChevronDown} size="16" aria-hidden={true} />
    </button>
  {/if}
  <nav class="crumbs" aria-label={$t('frameleaf_album_breadcrumb')}>
    {#if album.kind === AlbumKind.Space}
      <a href={Route.sharing()}>{$t('frameleaf_shared_spaces')}</a>
    {:else if boards}
      <a href="/pro">{$t('frameleaf_pro_title')}</a>
    {:else}
      <a href={Route.albums()}>{$t('albums')}</a>
    {/if}
    {#each breadcrumbAlbums as ancestor (ancestor.id)}
      <span aria-hidden="true"><Icon icon={mdiChevronRight} size="16" /></span>
      <a href={Route.viewAlbum({ id: ancestor.id })}>{ancestor.albumName || $t('unnamed_album')}</a>
    {/each}
    <span aria-hidden="true"><Icon icon={mdiChevronRight} size="16" /></span>
    <span aria-current="page">{name}</span>
  </nav>

  <div class="main">
    <div class="icon-wrap">
      {#if editor}
        <button
          type="button"
          class="icon-button"
          class:open={iconOpen}
          aria-haspopup="dialog"
          aria-expanded={iconOpen}
          aria-label={$t('frameleaf_album_color_change', { values: { name } })}
          title={$t('frameleaf_album_color_menu')}
          onclick={() => (iconOpen = true)}
        >
          <AlbumMark icon={album.icon} color={album.color} kind={album.kind} size="26" />
          <span class="badge" aria-hidden="true"><Icon icon={mdiPencilOutline} size="12" /></span>
        </button>
      {:else}
        <span class="icon-button static" aria-hidden="true">
          <AlbumMark icon={album.icon} color={album.color} kind={album.kind} size="26" />
        </span>
      {/if}
    </div>

    <div class="text">
      <div class="title-row">
        <AlbumInlineEdit
          as="h1"
          label={$t('frameleaf_album_edit_title')}
          value={album.albumName}
          editable={editor}
          placeholder={$t('unnamed_album')}
          onSave={(albumName) => save({ albumName }, $t('frameleaf_album_title_saved'))}
        />
        {#if album.kind === AlbumKind.Space}
          <span class="badge-pill">{$t('frameleaf_album_kind_space')}</span>
        {:else if isCollection}
          <span class="badge-pill">{$t('frameleaf_album_kind_collection')}</span>
        {/if}
        {#if album.isSmart}
          <span class="badge-pill"><Icon icon={mdiAutoFix} size="14" />{$t('frameleaf_album_smart_badge')}</span>
        {/if}
        {#if !owner && albumOwner}
          <!-- CollectionHeader.jsx:1164-1170: who shared it, and whether this member may only view. -->
          <span class="shared-by">
            <span class="owner-avatar" aria-hidden="true"><UserAvatar user={albumOwner} size="full" noTitle /></span>
            {$t('frameleaf_album_shared_by', { values: { name: albumOwner.name } })}{viewOnly
              ? ` · ${$t('frameleaf_album_view_only')}`
              : ''}
          </span>
        {/if}
      </div>

      {#if !boards || album.description}<AlbumInlineEdit
          as="p"
          label={$t('frameleaf_album_edit_description')}
          value={album.description}
          editable={editor}
          multiline
          placeholder={$t('frameleaf_album_add_description')}
          onSave={(description) => save({ description }, $t('frameleaf_album_description_saved'))}
        />{/if}

      {#if rule}
        <div class="rule-row">
          <RuleChips rule={fromResponse(rule)} people={ruleSources.people} tags={ruleSources.tags} />
          {#if !rule.enabled}
            <span class="badge-pill">{$t('frameleaf_rules_paused')}</span>
          {/if}
          <span class="muted">{checkedLabel}</span>
          {#if rule.counts.suggested > 0}
            <button type="button" class="link" onclick={() => (reviewOpen = true)}>
              {$t('frameleaf_rules_to_review', { values: { count: rule.counts.suggested } })}
            </button>
          {/if}
        </div>
      {/if}

      <div class="summary">
        <span>{$t('frameleaf_albums_items', { values: { count: itemCount ?? assetCount } })}</span>
        {#if span}
          <span>{span}</span>
        {/if}
        {#if others.length > 0}
          <button type="button" class="members" onclick={() => openShare()}>
            <AlbumAvatarStack users={others} />
            <span>{$t('frameleaf_album_shared_with_count', { values: { count: others.length } })}</span>
          </button>
        {:else if owner}
          <button type="button" class="members" onclick={() => openShare()}>
            <span aria-hidden="true"><Icon icon={mdiAccountPlusOutline} size="16" /></span>
            <span>{$t('frameleaf_album_private_share_it')}</span>
          </button>
        {:else}
          <span>{$t('frameleaf_album_private')}</span>
        {/if}
        {#if likeCount + commentCount > 0}
          <span>
            {$t('frameleaf_album_activity_summary', { values: { likes: likeCount, comments: commentCount } })}
          </span>
        {/if}
      </div>
    </div>
  </div>

  <div class="actions" role="toolbar" aria-label={$t('frameleaf_album_actions', { values: { kind: kindLabel } })}>
    {#if editor && isCollection}
      <button type="button" class="action primary" onclick={() => (createOpen = true)}>
        <Icon icon={mdiPlus} size="18" />
        <span>{$t('frameleaf_albums_create_album')}</span>
      </button>
    {:else if editor && !album.isSmart && !boards}
      <!-- CollectionHeader.jsx:1373: Add photos is the header's primary menu. -->
      <div class="primary-menu">
        <Menu label={$t('add_photos')} align="start">
          {#snippet trigger()}
            <span class="trigger-content"><Icon icon={mdiPlus} size="18" />{$t('add_photos')}</span>
          {/snippet}
          <MenuItem onSelect={() => onAddPhotos?.()}>
            <Icon icon={mdiImageMultipleOutline} size="18" />
            {$t('frameleaf_album_select_from_library')}
          </MenuItem>
          <MenuItem onSelect={() => void upload()}>
            <Icon icon={mdiUpload} size="18" />
            {$t('frameleaf_album_upload_from_computer')}
          </MenuItem>
        </Menu>
      </div>
    {/if}

    {#if rule}
      <button type="button" class="action primary" disabled={!rule.enabled} onclick={() => (reevaluateOpen = true)}>
        <Icon icon={mdiRefresh} size="18" />
        <span>{$t('frameleaf_rules_reevaluate')}</span>
      </button>
    {/if}

    <button type="button" class="action" onclick={() => openShare()}>
      <Icon icon={owner ? mdiAccountPlusOutline : mdiAccountMultipleOutline} size="18" />
      <span>{owner ? $t('share') : $t('frameleaf_albums_members')}</span>
    </button>

    <!--
      On phones the secondary actions move into the "…" menu instead of running off-screen
      (CollectionHeader.jsx:1142-1154, 1410-1510; apple-style.css:872-877): only Add photos (or New
      album), Re-evaluate and Share stay in the row.
    -->
    {#if !folded}
      {#if owner}
        <button type="button" class="action" onclick={openLinks}>
          <Icon icon={mdiLinkVariant} size="18" />
          <span>{$t('frameleaf_spaces_links')}</span>
        </button>
      {/if}

      {#if mapEnabled}
        <button type="button" class="action" disabled={mapMarkers.length === 0} onclick={() => void openMap()}>
          <Icon icon={mdiMapOutline} size="18" />
          <span>{$t('map')}</span>
        </button>
      {/if}

      <button type="button" class="action" disabled={assetCount === 0} onclick={() => onSlideshow?.()}>
        <Icon icon={mdiPlayCircleOutline} size="18" />
        <span>{$t('slideshow')}</span>
      </button>

      <button type="button" class="action" disabled={assetCount === 0} onclick={() => (movieOpen = true)}>
        <Icon icon={mdiMovieOpenPlayOutline} size="18" />
        <span>{$t('frameleaf_movie_make')}</span>
      </button>

      <button type="button" class="action" disabled={assetCount === 0} onclick={download}>
        <Icon icon={mdiDownloadOutline} size="18" />
        <span>{$t('download')}</span>
      </button>

      <!-- Always offered, as in the design (CollectionHeader.jsx:1290-1297), shared or not. -->
      {#if onToggleActivity}
        <!-- SHARING-P7: "Comments" on album and space headers alike; "Activity" is the app's own workspace. -->
        <button
          type="button"
          class="action"
          aria-pressed={activityOpen}
          aria-label={$t('frameleaf_album_activity_button', { values: { count: likeCount + commentCount } })}
          onclick={() => onToggleActivity?.()}
        >
          <Icon icon={mdiCommentTextOutline} size="18" />
          <span>{$t('frameleaf_album_comments_title')}</span>
          {#if likeCount + commentCount > 0}
            <span class="count" aria-hidden="true">{likeCount + commentCount}</span>
          {/if}
        </button>
      {/if}
    {/if}

    <span class="spacer"></span>

    <Menu label={$t('frameleaf_album_more_actions')} align="end">
      {#snippet trigger()}
        <span class="trigger-content"><Icon icon={mdiDotsHorizontal} size="18" /></span>
      {/snippet}
      {#if folded}
        {#if boards && editor}
          <MenuItem onSelect={() => (createOpen = true)}>
            <Icon icon={mdiPlus} size="18" />
            {$t('frameleaf_boards_new_collection')}
          </MenuItem>
        {/if}
        {#if owner}
          <MenuItem onSelect={openLinks}>
            <Icon icon={mdiLinkVariant} size="18" />
            {$t('frameleaf_spaces_links')}
          </MenuItem>
        {/if}
        {#if mapEnabled}
          <MenuItem disabled={mapMarkers.length === 0} onSelect={() => void openMap()}>
            <Icon icon={mdiMapOutline} size="18" />
            {$t('map')}
          </MenuItem>
        {/if}
        <MenuItem disabled={assetCount === 0} onSelect={() => onSlideshow?.()}>
          <Icon icon={mdiPlayCircleOutline} size="18" />
          {$t('slideshow')}
        </MenuItem>
        <MenuItem disabled={assetCount === 0} onSelect={() => (movieOpen = true)}>
          <Icon icon={mdiMovieOpenPlayOutline} size="18" />
          {$t('frameleaf_movie_make')}
        </MenuItem>
        <MenuItem disabled={assetCount === 0} onSelect={download}>
          <Icon icon={mdiDownloadOutline} size="18" />
          {$t('download')}
        </MenuItem>
        {#if onToggleActivity}
          <MenuItem checked={activityOpen} onSelect={() => onToggleActivity?.()}>
            <Icon icon={mdiCommentTextOutline} size="18" />
            {likeCount + commentCount > 0
              ? $t('frameleaf_album_activity_menu', { values: { count: likeCount + commentCount } })
              : $t('frameleaf_album_comments_title')}
          </MenuItem>
        {/if}
        <div class="menu-separator" role="separator"></div>
      {/if}
      {#if editor && !rule && !album.isSmart}
        {#if !isCollection && automationAvailable}
          <MenuItem
            onSelect={() =>
              void goto(`${Route.workflows()}&${new URLSearchParams({ workflowAlbum: album.id, workflowName: name })}`)}
          >
            <Icon icon={mdiAutoFix} size="18" />
            {$t('frameleaf_workflows.automate_album')}
          </MenuItem>
        {/if}
        <MenuItem onSelect={() => (editOpen = true)}>
          <Icon icon={mdiPencilOutline} size="18" />
          {$t('frameleaf_album_edit_details')}
        </MenuItem>
      {/if}
      {#if editor && album.kind !== AlbumKind.Space}
        <MenuItem onSelect={() => (iconOpen = true)}>
          <Icon icon={mdiPaletteOutline} size="18" />
          {$t('frameleaf_album_color_menu')}
        </MenuItem>
      {/if}
      {#if canShowOwnerBadges}
        <MenuItem checked={ownerBadges} onSelect={() => onToggleOwnerBadges?.()}>
          <Icon icon={mdiAccountCircleOutline} size="18" />
          {$t('frameleaf_album_owner_badges')}
        </MenuItem>
      {/if}
      {#if rule}
        <MenuItem onSelect={() => (ruleOpen = true)}>
          <Icon icon={mdiPencilOutline} size="18" />
          {$t('frameleaf_album_edit_details')}
        </MenuItem>
        <MenuItem disabled={rule.counts.suggested === 0} onSelect={() => (reviewOpen = true)}>
          <Icon icon={mdiTextBoxCheckOutline} size="18" />
          {$t('frameleaf_rules_review')}
        </MenuItem>
      {/if}
      {#if editor && !album.isSmart}
        <MenuItem disabled={coverSourceIds.length === 0} onSelect={() => (coverOpen = true)}>
          <Icon icon={mdiImageOutline} size="18" />
          {$t('frameleaf_album_cover_title')}
        </MenuItem>
      {/if}
      {#if editor}
        <MenuItem onSelect={() => (optionsOpen = true)}>
          <Icon icon={mdiTuneVariant} size="18" />
          {$t('options')}
        </MenuItem>
      {/if}
      <!-- A separator only between two groups: never doubled, never first. -->
      {#if hasMiddleItems}
        <div class="menu-separator" role="separator"></div>
      {/if}
      <!-- Delete and Leave are the danger items (CollectionHeader.jsx:1520-1536). -->
      {#if owner}
        <MenuItem onSelect={() => (deleteOpen = true)}>
          <span class="danger-item">
            <Icon icon={mdiDeleteOutline} size="18" />
            {$t('frameleaf_album_delete', { values: { kind: kindLabel } })}
          </span>
        </MenuItem>
      {:else}
        <MenuItem onSelect={() => (leaveOpen = true)}>
          <span class="danger-item">
            <Icon icon={mdiLogoutVariant} size="18" />
            {$t('frameleaf_album_leave', { values: { kind: kindLabel } })}
          </span>
        </MenuItem>
      {/if}
    </Menu>
  </div>

  <p class="status" role="status" aria-live="polite">{status}</p>

  {#if album.kind !== AlbumKind.Space && (childAlbums.length > 0 || (editor && !boards))}
    <section class="strip" class:boards aria-label={$t(boards ? 'frameleaf_boards_collections' : 'albums')}>
      {#if !boards}<div class="strip-head">
          <h2>{$t('albums')}</h2>
          <small>{$t('frameleaf_albums_count', { values: { count: childAlbums.length } })}</small>
        </div>{/if}
      <div class="strip-grid">
        {#each childAlbums as child (child.id)}
          {@const cover = coverOf(child)}
          {@const inside = insideCount(child.id)}
          {@const childName = child.albumName || $t('unnamed_album')}
          <!-- The collections inside, as cards (prototype `pro-subcollections`): cover, own mark, counts. -->
          <a class="sub-card" href={Route.viewAlbum({ id: child.id })} data-testid="sub-collection-card">
            <span class="sub-cover" aria-hidden="true">
              {#if cover}
                <img src={cover} alt="" loading="lazy" draggable="false" />
              {:else}
                <AlbumMark icon={child.icon} color={child.color} kind={child.kind} hasChildren={inside > 0} size="28" />
              {/if}
            </span>
            <strong class="sub-name">
              <AlbumMark icon={child.icon} color={child.color} kind={child.kind} hasChildren={inside > 0} size="15" />
              <span>{childName}</span>
            </strong>
            <small class="sub-meta">
              {$t('frameleaf_albums_items', { values: { count: child.assetCount } })}{inside > 0
                ? ` · ${$t('frameleaf_boards_inside_count', { values: { count: inside } })}`
                : ''}
            </small>
          </a>
        {/each}
        {#if editor && !boards}
          <button type="button" class="new-tile" onclick={() => (createOpen = true)}>
            <Icon icon={mdiPlus} size="22" />
            <span>{$t('frameleaf_albums_create_album')}</span>
          </button>
        {/if}
      </div>
      {#if childAlbums.length === 0 && !editor}
        <p class="empty">{$t('frameleaf_albums_shelf_empty')}</p>
      {/if}
    </section>
  {/if}
</header>

<MakeMovieSheet
  bind:open={movieOpen}
  source={{
    kind: 'album',
    albumId: album.id,
    name,
    itemCount: itemCount ?? assetCount,
    previewIds: album.albumThumbnailAssetId ? [album.albumThumbnailAssetId] : [],
  }}
/>

<AlbumShareDialog
  {album}
  section={shareSection}
  bind:open={shareOpen}
  onChanged={onRefresh}
  onLeave={() => (leaveOpen = true)}
/>
<AlbumCoverDialog {album} albumIds={coverSourceIds} bind:open={coverOpen} onUpdated={onCoverChange} />
<AlbumOptionsDialog {album} bind:open={optionsOpen} onUpdated={onAlbumChange} />

{#if editOpen}{#await import('$lib/components/frameleaf/AlbumCreateDialog.svelte') then { default: AlbumCreateDialog }}
    <AlbumCreateDialog
      kind={album.kind}
      {album}
      collections={collections.filter(({ id }) => id !== album.id)}
      canMove={album.kind !== AlbumKind.Space && owner}
      bind:open={editOpen}
      onCreate={createChildAlbum}
      onSave={saveDetails}
    />
  {/await}{/if}

{#if createOpen}{#await import('$lib/components/frameleaf/AlbumCreateDialog.svelte') then { default: AlbumCreateDialog }}
    <AlbumCreateDialog
      kind={AlbumKind.Album}
      collections={collections.length > 0 ? collections : [album]}
      defaultParentId={album.id}
      bind:open={createOpen}
      onCreate={createChildAlbum}
      onCreateSmart={createChildSmartAlbum}
    />
  {/await}{/if}

{#if rule}
  <SmartAlbumReevaluateDialog {rule} sources={ruleSources} bind:open={reevaluateOpen} onApplied={onRuleChanged} />
  <SmartAlbumReviewDialog {rule} bind:open={reviewOpen} onDecided={onRuleChanged} />
  <SmartAlbumRuleDialog
    {rule}
    sources={ruleSources}
    bind:open={ruleOpen}
    {album}
    onSaved={(saved, message, updatedAlbum) => {
      rule = saved ?? undefined;
      if (updatedAlbum) {
        onAlbumChange(updatedAlbum);
      }
      void onRuleChanged(message);
    }}
  />
{/if}

{#if editor && album.kind !== AlbumKind.Space}
  {#if iconOpen}{#await import('$lib/components/frameleaf/AlbumAppearanceDialog.svelte') then { default: AlbumAppearanceDialog }}
      <AlbumAppearanceDialog
        {album}
        hasChildren={childAlbums.length > 0}
        bind:open={iconOpen}
        onSave={saveAppearance}
      />
    {/await}{/if}
{/if}

<!--
  Delete spells out what happens (prototype `DeleteCollectionDialog`, README point 8): the items stay
  in the library, the albums inside move up a level, and people it was shared with lose access.
-->
<Dialog
  title={$t('frameleaf_album_delete_title', { values: { name } })}
  closeLabel={$t('close')}
  bind:open={deleteOpen}
>
  <ul class="consequences" data-testid="delete-consequences">
    <li>
      <Icon icon={mdiCheck} size="16" aria-hidden={true} />
      <span>
        {album.isSmart
          ? $t('frameleaf_album_delete_smart_keep')
          : $t('frameleaf_boards_delete_items_stay', { values: { count: itemCount ?? assetCount } })}
      </span>
    </li>
    {#if childAlbums.length > 0}
      <li>
        <Icon icon={mdiCheck} size="16" aria-hidden={true} />
        <span>
          {deleteDestination
            ? $t('frameleaf_boards_delete_children_move', {
                values: { children: childNames, count: childAlbums.length, parent: deleteDestination },
              })
            : $t('frameleaf_boards_delete_children_top', {
                values: { children: childNames, count: childAlbums.length },
              })}
        </span>
      </li>
    {/if}
    {#if others.length > 0}
      <li class="warn">
        <Icon icon={mdiAlertOutline} size="16" aria-hidden={true} />
        <span>
          {$t('frameleaf_boards_delete_people_lose_access', {
            values: {
              count: others.length,
              names: new Intl.ListFormat($locale ?? undefined, { style: 'long', type: 'conjunction' }).format(
                others.map((user) => user.name),
              ),
              kind: kindLabel,
            },
          })}
        </span>
      </li>
    {/if}
    {#if album.hasSharedLink}
      <li class="warn">
        <Icon icon={mdiAlertOutline} size="16" aria-hidden={true} />
        <span>{$t('frameleaf_boards_delete_links_stop')}</span>
      </li>
    {/if}
  </ul>
  {#snippet actions()}
    <button type="button" class="button" data-initial-focus disabled={deleting} onclick={() => (deleteOpen = false)}
      >{$t('cancel')}</button
    >
    <button type="button" class="button fl-danger" disabled={deleting} onclick={() => void runDelete()}
      >{$t('frameleaf_album_delete', { values: { kind: kindLabel } })}</button
    >
  {/snippet}
</Dialog>

<AlbumConfirmDialog
  title={$t('frameleaf_album_leave_title', { values: { name } })}
  body={$t('frameleaf_album_leave_body')}
  confirmLabel={$t('frameleaf_album_leave', { values: { kind: kindLabel } })}
  bind:open={leaveOpen}
  onConfirm={confirmLeave}
/>

<style>
  .sheet-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    align-self: flex-start;
    min-height: 44px;
    padding: 0 0.25rem;
    border: 0;
    background: none;
    color: var(--fl-text);
    font: inherit;
    font-weight: 600;
  }
  .sheet-trigger:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .consequences {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    width: min(28rem, 100%);
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 0.875rem;
  }
  .consequences li {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    color: var(--fl-text);
  }
  .consequences li > :global(svg) {
    flex-shrink: 0;
    margin-block-start: 2px;
    color: var(--fl-teal, var(--fl-accent));
  }
  .consequences li.warn > :global(svg) {
    color: var(--fl-warning, var(--fl-danger));
  }
  /* The collections inside (prototype .pro-subcollections): a cover, the own mark and name, counts. */
  .sub-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    color: var(--fl-text);
    text-decoration: none;
    border-radius: var(--fl-radius-card);
  }
  .sub-card:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 3px;
  }
  .sub-cover {
    display: flex;
    align-items: center;
    justify-content: center;
    aspect-ratio: 1;
    overflow: hidden;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fl-text), transparent 91%);
  }
  .sub-cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .sub-card:hover .sub-cover {
    box-shadow:
      inset 0 0 0 1px var(--fl-border),
      var(--fl-shadow-1, none);
  }
  .sub-name {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 0.8125rem;
  }
  .sub-name span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub-meta {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .rule-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-block: 0.25rem;
  }
  .rule-row .muted {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .rule-row .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--fl-accent);
    font-size: var(--fl-font-small);
    text-decoration: underline;
    cursor: pointer;
  }
  .album-header {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    /* The layout switch follows the actions closely (`.collection-header.compact`), with no band between. */
    padding-block: 1rem 0.25rem;
    color: var(--fl-text);
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    /* A link's hover box hangs outside, so its text starts on the content edge. */
    margin-inline-start: calc(-1 * var(--fl-space-2));
    font-size: 0.75rem;
    color: var(--fl-muted);
    flex-wrap: wrap;
  }
  .crumbs a,
  .crumbs span[aria-current='page'] {
    padding: var(--fl-space-1) var(--fl-space-2);
  }
  .crumbs a {
    color: var(--fl-muted);
    text-decoration: none;
    border-radius: var(--fl-radius);
  }
  .crumbs a:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .crumbs span[aria-current='page'] {
    color: var(--fl-text);
  }
  .main {
    display: flex;
    /* The title's edit button hangs 8px outside the text column and stays 12px clear of the icon. */
    gap: var(--fl-space-5);
    align-items: flex-start;
  }
  .icon-wrap {
    position: relative;
    flex-shrink: 0;
  }
  .icon-button {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: 3rem;
    block-size: 3rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .icon-button.static {
    cursor: default;
  }
  .badge {
    position: absolute;
    inset-block-end: -0.25rem;
    inset-inline-end: -0.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: 1.25rem;
    block-size: 1.25rem;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-radius: 50%;
    opacity: 0;
    transition: opacity var(--fl-motion-fast) var(--fl-ease);
  }
  .icon-button:hover .badge,
  .icon-button:focus-visible .badge,
  .icon-button.open .badge {
    opacity: 1;
  }
  .text {
    flex: 1;
    min-inline-size: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .badge-pill {
    padding: 0.125rem 0.5rem;
    font-size: 0.75rem;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
  }
  .shared-by {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  .owner-avatar {
    display: inline-flex;
    width: 18px;
    height: 18px;
  }
  .summary {
    --summary-gap: calc(2 * var(--fl-space-2) + 3px);
    display: flex;
    align-items: center;
    gap: var(--fl-space-1) var(--summary-gap);
    flex-wrap: wrap;
    /*
     * Room for a focus ring at either end, and the edge that hides a separator: the dot before the
     * first thing on a wrapped line falls outside this box, so no line starts or ends with one.
     */
    margin-inline: calc(-1 * var(--fl-space-1));
    padding-inline: var(--fl-space-1);
    overflow-x: clip;
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  .summary > * {
    position: relative;
  }
  .summary > * + *::before {
    content: '';
    position: absolute;
    inset-block-start: calc(50% - 1.5px);
    inset-inline-start: calc(-0.5 * var(--summary-gap) - 1.5px);
    inline-size: 3px;
    block-size: 3px;
    border-radius: 50%;
    background: var(--fl-muted);
  }
  .members {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.125rem var(--fl-space-2);
    font: inherit;
    color: var(--fl-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--fl-radius);
  }
  .members:hover {
    background: var(--fl-raised);
    border-color: var(--fl-border);
    color: var(--fl-text);
  }
  /*
   * SHARING-P3: the title, description and summary rows sit at the prototype's 4px rhythm
   * (collections.css .ch-text). Each control there keeps its 44px target (48px on touch) as an
   * invisible box centred on it, so the rows no longer grow to the target's height.
   */
  .text :global(.trigger),
  .members {
    position: relative;
    min-height: 0;
  }
  .text :global(.trigger)::after,
  .members::after {
    content: '';
    position: absolute;
    inset-inline: 0;
    inset-block: min(0px, calc((100% - 44px) / 2));
  }
  @media (pointer: coarse) {
    .text :global(.trigger),
    .members {
      min-height: 0;
    }
    .text :global(.trigger)::after,
    .members::after {
      inset-block: min(0px, calc((100% - 48px) / 2));
    }
  }
  .actions {
    display: flex;
    align-items: center;
    /* 8px between buttons, 12px between the rows they wrap into. */
    gap: var(--fl-space-3) var(--fl-space-2);
    flex-wrap: wrap;
  }
  .action,
  .trigger-content {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    white-space: nowrap;
  }
  .action {
    padding: 0 var(--fl-space-3);
    min-height: 44px;
    font: inherit;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .action:hover:not(:disabled) {
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 8%);
  }
  .action.primary {
    font-weight: 600;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .action[aria-pressed='true']:not(.primary) {
    color: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .action:disabled {
    color: var(--fl-muted);
    background: var(--fl-canvas);
  }
  .count {
    font-variant-numeric: var(--fl-numeric);
    padding: 0 0.375rem;
    font-size: 0.75rem;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-radius: var(--fl-radius-pill);
  }
  .spacer {
    flex: 1;
  }
  .status {
    margin: 0;
    min-block-size: 1rem;
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  /* With nothing to say the line keeps no row (or gap) of its own; it stays in the page to be announced. */
  .status:empty {
    min-block-size: 0;
    margin-block-start: -0.75rem;
  }
  .strip {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
    margin-block-start: var(--fl-space-2);
    padding-block-start: var(--fl-space-4);
    border-block-start: 1px solid var(--fl-border);
  }
  /* Boards (prototype screen 02): small cards in a row, cover beside the name, no rule above. */
  .strip.boards {
    padding-block-start: 0;
    border-block-start: 0;
  }
  .strip.boards .strip-grid {
    grid-template-columns: repeat(auto-fill, minmax(13.5rem, 1fr));
    gap: var(--fl-space-3);
  }
  .strip.boards .sub-card {
    display: grid;
    grid-template-columns: 3.5rem minmax(0, 1fr);
    grid-template-rows: auto auto;
    align-content: center;
    column-gap: var(--fl-space-3);
    row-gap: 2px;
    padding: var(--fl-space-2);
    border: 1px solid var(--fl-border);
  }
  .strip.boards .sub-cover {
    grid-row: span 2;
    border-radius: var(--fl-radius-control);
  }
  .strip.boards .sub-name,
  .strip.boards .sub-meta {
    align-self: end;
  }
  .strip.boards .sub-meta {
    align-self: start;
  }
  .strip-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .strip-head h2 {
    margin: 0;
    font-size: 0.875rem;
  }
  .strip-head small {
    color: var(--fl-muted);
  }
  /* The collection's albums: the compact Albums grid (apple-style.css:973-983 .al-grid.compact). */
  .strip-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
    gap: var(--fl-space-5) var(--fl-space-3);
    align-items: start;
  }
  @media (max-width: 700px) {
    .strip-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    /* collections.css:1800: phones drop the icon tile so the title and description use the full width. */
    .icon-wrap {
      display: none;
    }
  }
  /* The prototype's primary Add photos menu (CollectionHeader.jsx:1373, Menu primary). */
  .primary-menu {
    display: contents;
  }
  .primary-menu :global(.menu-root > button) {
    font-weight: 600;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .new-tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    aspect-ratio: 1;
    font: inherit;
    color: var(--fl-muted);
    background: transparent;
    border: 1px dashed var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .new-tile:hover {
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  .empty {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .menu-separator {
    height: 1px;
    margin: 0.25rem 0.375rem;
    background: var(--fl-border);
  }
  .danger-item {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--fl-danger);
  }
  /*
   * The large title that shrinks as you scroll (apple-style.css:219-244), on album, collection and
   * shared-space headers alike: it follows whichever scroller holds the header (the timeline, the
   * collection's results or the page), and only fades under Reduce Motion.
   */
  .main .title-row :global(h1) {
    font-size: 30px;
    font-weight: 700;
    letter-spacing: -0.02em;
    transform-origin: left bottom;
  }
  /* D9: the phone title is the prototype's 19px (collections.css:1803). */
  @media (max-width: 700px) {
    .main .title-row :global(h1) {
      font-size: 19px;
    }
  }
  @supports (animation-timeline: scroll()) {
    .main .title-row :global(h1) {
      animation: fl-album-title-shrink linear both;
      animation-timeline: scroll(nearest block);
      animation-range: 0 90px;
    }
    @media (prefers-reduced-motion: reduce) {
      .main .title-row :global(h1) {
        animation-name: fl-album-title-fade;
      }
    }
  }
  @keyframes fl-album-title-shrink {
    to {
      scale: 0.62;
      opacity: 0.2;
    }
  }
  @keyframes fl-album-title-fade {
    to {
      opacity: 0.2;
    }
  }
</style>
