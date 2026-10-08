<script lang="ts" module>
  /** Poster-shaped placeholders for the first read of a shelf. */
  const SKELETON_CARDS = [0, 1, 2, 3, 4, 5];
  /** How many projects one request reads; Show more asks for the next page. */
  const PAGE = 60;

  const focusOnMount = (node: HTMLInputElement) => {
    node.focus();
    node.select();
  };
</script>

<script lang="ts">
  import { goto, onNavigate } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import BulkConfirmDialog from '$lib/components/frameleaf/BulkConfirmDialog.svelte';
  import EmptyState from '$lib/components/frameleaf/EmptyState.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import Spinner from '$lib/components/frameleaf/Spinner.svelte';
  import { armHero } from '$lib/frameleaf/motion';
  import {
    rememberStudioOpening,
    studioExportPercent,
    studioProjectSharedKey,
    studioRelativeTime,
  } from '$lib/frameleaf/studio/chrome';
  import { toastUndo } from '$lib/frameleaf/toast';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { studioBundleDownloadPath } from '$lib/frameleaf/studio/bundles';
  import {
    isStudioBundleSettled,
    reviewStudioBundle,
    STUDIO_LIBRARY_SHELVES,
    STUDIO_LIBRARY_SORTS,
    studioBundleErrorCode,
    studioBundleErrorKey,
    studioBundleJobStatusKey,
    studioBundleMapping,
    studioBundlePollMs,
    studioDaysUntilPurge,
    studioProjectActions,
    type StudioLibraryShelf,
    type StudioLibrarySort,
    type StudioProjectAction,
  } from '$lib/frameleaf/studio/project-library';
  import '$lib/frameleaf/tokens.css';
  import { Route } from '$lib/route';
  import { downloadUrl, getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    deleteStudioBundleUpload,
    deleteStudioProject,
    duplicateStudioProject,
    emptyStudioProjectTrash,
    exportStudioProjectBundle,
    getBaseUrl,
    getStudioBundleOperation,
    importStudioBundle,
    MediaOperationStatus,
    restoreStudioProjectFromTrash,
    searchStudioProjects,
    StudioBundleSourceResolution,
    StudioProjectAccess,
    StudioProjectShelf,
    StudioProjectSort,
    updateStudioProject,
    uploadStudioBundle,
    type StudioBundleOperationDto,
    type StudioBundleUploadDto,
    type StudioProjectDto,
  } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import {
    mdiArchiveOutline,
    mdiDotsHorizontal,
    mdiFilmstrip,
    mdiImport,
    mdiMagnify,
    mdiPlus,
    mdiTrashCanOutline,
  } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { locale, t, type Translations } from 'svelte-i18n';

  /**
   * The Studio project library (FL-91, `STU-204`).
   *
   * Beyond the prototype, which kept a single project in local storage. Three shelves: the
   * projects a person owns or reviews, their archive, and their trash. Opening, renaming,
   * duplicating, archiving, trashing, recovering and deleting for good all go to the server, and
   * the list is re-read afterwards rather than patched, so what is shown is what the server holds.
   *
   * A project is a card: its poster, its name and when it was last edited. The whole card opens it,
   * and everything else a person may do with it is in the card's one menu. A shelf that is still
   * being read shows poster-shaped placeholders, one that could not be read says so with Try again,
   * and an empty one says what to do next; the three are never mistaken for each other.
   *
   * Bundles are durable jobs. Export and import both start here and can be followed either here or
   * in Activity; closing this page does not stop them. Deleting a project, even for good, never
   * touches a photo or a video, and the copy says so where it matters.
   */
  let { shelf: initialShelf = 'active' }: { shelf?: StudioLibraryShelf } = $props();

  let shelf = $state<StudioLibraryShelf>(initialShelf);
  let query = $state('');
  let sort = $state<StudioLibrarySort>('updated');
  let items = $state<StudioProjectDto[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let loadingMore = $state(false);
  let failed = $state(false);
  let busyId = $state<string | null>(null);
  let renamingId = $state<string | null>(null);
  let renameValue = $state('');
  let announcement = $state('');

  let confirmDelete = $state<StudioProjectDto | null>(null);
  let confirmDeleteOpen = $state(false);
  let confirmEmptyOpen = $state(false);

  let exportTarget = $state<StudioProjectDto | null>(null);
  let exportOpen = $state(false);
  let exportIncludeMedia = $state(false);
  let exportJob = $state<StudioBundleOperationDto | null>(null);

  let fileInput = $state<HTMLInputElement>();
  let upload = $state<StudioBundleUploadDto | null>(null);
  let importOpen = $state(false);
  let importName = $state('');
  let declined = $state<Set<string>>(new Set());
  let importJob = $state<StudioBundleOperationDto | null>(null);
  let uploading = $state(false);

  let disposed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const shelfEnum: Record<StudioLibraryShelf, StudioProjectShelf> = {
    active: StudioProjectShelf.Active,
    archived: StudioProjectShelf.Archived,
    trashed: StudioProjectShelf.Trashed,
  };
  const sortEnum: Record<StudioLibrarySort, StudioProjectSort> = {
    updated: StudioProjectSort.Updated,
    recent: StudioProjectSort.Recent,
    name: StudioProjectSort.Name,
  };

  const review = $derived(upload ? reviewStudioBundle(upload) : null);

  /** Answers from before the newest request are dropped, so a slow shelf never lands on another. */
  let generation = 0;

  const read = (skip: number) =>
    searchStudioProjects({
      shelf: shelfEnum[shelf],
      sort: sortEnum[sort],
      query: query.trim() || undefined,
      skip: skip || undefined,
      take: PAGE,
    });

  const load = async () => {
    const gen = ++generation;
    loading = true;
    try {
      const list = await read(0);
      if (disposed || gen !== generation) {
        return;
      }
      items = list.items;
      total = list.total;
      failed = false;
    } catch (error) {
      if (disposed || gen !== generation) {
        return;
      }
      failed = true;
      // With cards on screen the page keeps them and says so in a toast; an empty page says it inline.
      if (items.length > 0) {
        handleError(error, $t('frameleaf_studio_library_load_failed'));
      }
    } finally {
      if (gen === generation) {
        loading = false;
      }
    }
  };

  const loadMore = async () => {
    const gen = generation;
    loadingMore = true;
    try {
      const list = await read(items.length);
      if (!disposed && gen === generation) {
        const seen = new Set(items.map((item) => item.id));
        items = [...items, ...list.items.filter((item) => !seen.has(item.id))];
        total = list.total;
      }
    } catch (error) {
      handleError(error, $t('frameleaf_studio_library_load_failed'));
    } finally {
      loadingMore = false;
    }
  };

  /*
   * Opening a project (finding 58): the card's poster and name go with the person to the editor's
   * opening screen. Where the browser can, the poster travels there: the card and the opening screen
   * mark it with the same `data-fl-shared` key and the root layout pairs the two (the card-to-page
   * Hero in `$lib/frameleaf/motion`). Under Reduce Motion, or without view transitions, it simply opens.
   */
  onNavigate((navigation) => {
    const to = navigation.to;
    const id = to?.route.id === '/(user)/studio' ? to.url.searchParams.get('project') : null;
    const project = id ? items.find((item) => item.id === id) : undefined;
    if (project) {
      rememberStudioOpening({ projectId: project.id, name: project.name, posterUrl: posterUrl(project) });
    }
  });

  // FL-195 follow-up: a poster whose item is Locked shows only to the unlocked session, so a lock or an
  // unlock reads the shelf again (the server then sends the placeholder, or the poster, as it should)
  onMount(() =>
    onLibraryAccessChange((change) => {
      if (change === 'restricted' || change === 'expanded') {
        void load();
      }
    }),
  );

  $effect(() => {
    // Re-read whenever the shelf, the order or the search changes; typing waits for a pause.
    void shelf;
    void sort;
    const typing = query.trim().length > 0;
    const timer = setTimeout(() => void load(), typing ? 250 : 0);
    return () => clearTimeout(timer);
  });

  onDestroy(() => {
    disposed = true;
    for (const timer of timers) {
      clearTimeout(timer);
    }
  });

  const setShelf = (next: StudioLibraryShelf) => {
    if (next === shelf) {
      return;
    }
    // Another shelf's cards must not sit under this shelf's heading while it is read.
    items = [];
    total = 0;
    failed = false;
    loading = true;
    shelf = next;
    void goto(Route.studioProjects({ shelf: next }), { replaceState: true, keepFocus: true, noScroll: true });
  };

  const run = async (
    project: StudioProjectDto,
    action: () => Promise<unknown>,
    doneKey: Translations,
    undo?: () => Promise<unknown>,
  ) => {
    busyId = project.id;
    try {
      await action();
      announcement = $t(doneKey, { values: { name: project.name } });
      if (undo) {
        toastUndo(announcement, async () => {
          try {
            await undo();
            await load();
          } catch (error) {
            handleError(error, $t('frameleaf_studio_library_action_failed'));
          }
        });
      } else {
        toastManager.primary(announcement);
      }
      await load();
    } catch (error) {
      handleError(error, $t('frameleaf_studio_library_action_failed'));
    } finally {
      busyId = null;
    }
  };

  const startRename = (project: StudioProjectDto) => {
    renamingId = project.id;
    renameValue = project.name;
  };

  const commitRename = (project: StudioProjectDto) => {
    const name = renameValue.trim();
    renamingId = null;
    if (!name || name === project.name) {
      return;
    }
    void run(
      project,
      () => updateStudioProject({ id: project.id, studioProjectUpdateDto: { name } }),
      'frameleaf_studio_library_renamed',
    );
  };

  const act = (project: StudioProjectDto, action: StudioProjectAction) => {
    switch (action) {
      case 'open': {
        armHero(studioProjectSharedKey(project.id));
        void goto(Route.studio({ projectId: project.id }));
        break;
      }
      case 'rename': {
        startRename(project);
        break;
      }
      case 'duplicate': {
        const name = $t('frameleaf_studio_copy_name', { values: { name: project.name } });
        void run(
          project,
          () => duplicateStudioProject({ id: project.id, studioProjectDuplicateDto: { name } }),
          'frameleaf_studio_library_duplicated',
        );
        break;
      }
      case 'export': {
        exportTarget = project;
        exportIncludeMedia = false;
        exportJob = null;
        exportOpen = true;
        break;
      }
      case 'archive':
      case 'unarchive': {
        const archived = action === 'archive';
        void run(
          project,
          () => updateStudioProject({ id: project.id, studioProjectUpdateDto: { archived } }),
          archived ? 'frameleaf_studio_library_archived' : 'frameleaf_studio_library_unarchived',
        );
        break;
      }
      case 'trash': {
        // Reversible for the whole retention period, so no confirmation: Undo is on the toast, and
        // Recover stays in the trash afterwards.
        void run(
          project,
          () => deleteStudioProject({ id: project.id }),
          'frameleaf_studio_library_trashed',
          () => restoreStudioProjectFromTrash({ id: project.id }),
        );
        break;
      }
      case 'restore': {
        void run(project, () => restoreStudioProjectFromTrash({ id: project.id }), 'frameleaf_studio_library_restored');
        break;
      }
      case 'delete-permanently': {
        confirmDelete = project;
        confirmDeleteOpen = true;
        break;
      }
    }
  };

  const actionLabelKey: Record<StudioProjectAction, Translations> = {
    open: 'frameleaf_studio_library_open',
    rename: 'rename',
    duplicate: 'frameleaf_studio_library_duplicate',
    export: 'frameleaf_studio_library_export',
    archive: 'frameleaf_studio_library_archive',
    unarchive: 'frameleaf_studio_library_unarchive',
    trash: 'frameleaf_studio_library_trash',
    restore: 'frameleaf_studio_library_restore',
    'delete-permanently': 'frameleaf_studio_library_delete_permanently',
  };

  /* ---------------------------------------------------------------- */
  /* Bundle jobs                                                        */
  /* ---------------------------------------------------------------- */

  /** Follow one bundle job until it settles, backing off while it runs. */
  const follow = (operationId: string, onUpdate: (operation: StudioBundleOperationDto) => void, attempt = 0) => {
    const timer = setTimeout(
      () =>
        void (async () => {
          timers.delete(timer);
          if (disposed) {
            return;
          }
          try {
            const operation = await getStudioBundleOperation({ id: operationId });
            onUpdate(operation);
            if (!isStudioBundleSettled(operation)) {
              follow(operationId, onUpdate, attempt + 1);
            }
          } catch {
            // A lost poll is retried; the job itself carries on regardless on the server.
            follow(operationId, onUpdate, attempt + 1);
          }
        })(),
      studioBundlePollMs(attempt),
    );
    timers.add(timer);
  };

  const startExport = async () => {
    const target = exportTarget;
    if (!target) {
      return;
    }
    try {
      const operation = await exportStudioProjectBundle({
        id: target.id,
        studioBundleExportCreateDto: { includeMedia: exportIncludeMedia },
      });
      exportJob = {
        operationId: operation.id,
        kind: operation.kind,
        status: operation.status,
        progress: operation.progress,
        attempt: operation.attempt,
        maxAttempts: operation.maxAttempts,
        autoRetries: operation.autoRetries,
        retryAt: operation.retryAt,
        error: null,
        errorCode: null,
        projectId: target.id,
        export: null,
        import: null,
      };
      follow(operation.id, (next) => {
        exportJob = next;
      });
    } catch (error) {
      handleError(error, $t('frameleaf_studio_bundle_export_failed'));
    }
  };

  const downloadExport = () => {
    if (exportJob?.export?.downloadable) {
      downloadUrl(getBaseUrl() + studioBundleDownloadPath(exportJob.operationId), exportJob.export.fileName);
    }
  };

  const chooseBundle = () => fileInput?.click();

  const onBundleChosen = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    uploading = true;
    try {
      upload = await uploadStudioBundle({ studioBundleUploadCreateDto: { file } });
      importName = upload.projectName;
      declined = new Set();
      importJob = null;
      importOpen = true;
    } catch (error) {
      toastManager.danger($t(studioBundleErrorKey(studioBundleErrorCode(error))));
    } finally {
      uploading = false;
    }
  };

  const toggleSuggestion = (key: string) => {
    const next = new Set(declined);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    declined = next;
  };

  const startImport = async () => {
    if (!upload) {
      return;
    }
    try {
      const operation = await importStudioBundle({
        studioBundleImportCreateDto: {
          uploadId: upload.id,
          name: importName.trim() || undefined,
          mapping: studioBundleMapping(upload.sources, declined),
        },
      });
      importJob = {
        operationId: operation.id,
        kind: operation.kind,
        status: operation.status,
        progress: operation.progress,
        attempt: operation.attempt,
        maxAttempts: operation.maxAttempts,
        autoRetries: operation.autoRetries,
        retryAt: operation.retryAt,
        error: null,
        errorCode: null,
        projectId: null,
        export: null,
        import: null,
      };
      follow(operation.id, (next) => {
        importJob = next;
        if (next.status === MediaOperationStatus.Completed) {
          void load();
        }
      });
    } catch (error) {
      handleError(error, $t('frameleaf_studio_bundle_import_failed'));
    }
  };

  const discardUpload = async () => {
    const current = upload;
    importOpen = false;
    upload = null;
    if (current && !importJob) {
      await deleteStudioBundleUpload({ id: current.id }).catch(() => {});
    }
  };

  const posterUrl = (project: StudioProjectDto) =>
    project.thumbnailAssetId
      ? getAssetMediaUrl({ id: project.thumbnailAssetId, size: AssetMediaSize.Thumbnail })
      : null;

  const metaLine = (project: StudioProjectDto) =>
    [
      $t('frameleaf_studio_library_changed', {
        values: { date: studioRelativeTime(project.updatedAt, $locale ?? undefined) },
      }),
      project.revision > 0 ? null : $t('frameleaf_studio_library_unsaved'),
      project.access === StudioProjectAccess.Reviewer ? $t('frameleaf_studio_read_only') : null,
      project.importedFromBundle ? $t('frameleaf_studio_library_imported') : null,
    ]
      .filter(Boolean)
      .join(' · ');
</script>

<main class="frameleaf fl-studio-library" aria-labelledby="fl-studio-library-title">
  <p class="sr-only" role="status" aria-live="polite">{announcement}</p>

  <header class="head">
    <div>
      <p class="fl-type-overline kicker">{$t('frameleaf_studio_title')}</p>
      <h1 id="fl-studio-library-title">{$t('frameleaf_studio_library_title')}</h1>
      {#if !failed && !(loading && items.length === 0)}
        <p class="summary">{$t('frameleaf_studio_library_summary', { values: { count: total } })}</p>
      {/if}
    </div>
    <div class="head-actions">
      <Button onclick={chooseBundle} disabled={uploading}>
        <Icon icon={mdiImport} size={ICON_SIZE.md} />
        {uploading ? $t('frameleaf_studio_bundle_uploading') : $t('frameleaf_studio_bundle_import')}
      </Button>
      <Button variant="primary" onclick={() => void goto(Route.studio())}>
        <Icon icon={mdiPlus} size={ICON_SIZE.md} />
        {$t('frameleaf_studio_library_new')}
      </Button>
      <input
        bind:this={fileInput}
        class="sr-only"
        type="file"
        accept=".zip,application/zip"
        tabindex="-1"
        aria-hidden="true"
        onchange={onBundleChosen}
      />
    </div>
  </header>

  <div class="toolbar">
    <!-- The three shelves and the order are the app's own segmented control, not a browser menu. -->
    <SegmentedControl
      label={$t('frameleaf_studio_library_shelves')}
      options={STUDIO_LIBRARY_SHELVES.map((option) => ({ value: option.id, label: $t(option.labelKey) }))}
      value={shelf}
      onChange={(next) => setShelf(next as StudioLibraryShelf)}
    />
    <div class="filters">
      <input
        class="search"
        type="search"
        placeholder={$t('frameleaf_studio_library_search')}
        aria-label={$t('frameleaf_studio_library_search')}
        bind:value={query}
      />
      <SegmentedControl
        label={$t('frameleaf_studio_library_sort')}
        options={STUDIO_LIBRARY_SORTS.map((option) => ({ value: option.id, label: $t(option.labelKey) }))}
        value={sort}
        onChange={(next) => (sort = next as StudioLibrarySort)}
      />
      {#if shelf === 'trashed' && items.length > 0}
        <Button onclick={() => (confirmEmptyOpen = true)}>{$t('frameleaf_studio_library_empty_trash')}</Button>
      {/if}
    </div>
  </div>

  {#if shelf === 'trashed'}
    <p class="note">{$t('frameleaf_studio_library_trash_note')}</p>
  {:else if shelf === 'archived'}
    <p class="note">{$t('frameleaf_studio_library_archive_note')}</p>
  {/if}

  {#if failed && items.length === 0}
    <!-- A list that could not be read is not an empty one: say so, and offer the way to ask again. -->
    <InlineError message={$t('frameleaf_studio_library_load_failed')} onRetry={() => void load()} retrying={loading} />
  {:else if loading && items.length === 0}
    <ul class="grid" aria-busy="true" aria-label={$t('frameleaf_studio_library_loading')}>
      {#each SKELETON_CARDS as index (index)}
        <li class="placeholder">
          <Skeleton variant="block" aspect="16 / 9" />
          <div class="body"><Skeleton variant="text" lines={2} /></div>
        </li>
      {/each}
    </ul>
  {:else if items.length === 0}
    {#if query.trim()}
      <EmptyState compact icon={mdiMagnify} message={$t('frameleaf_studio_library_no_match')} />
    {:else if shelf === 'active'}
      <EmptyState
        icon={mdiFilmstrip}
        title={$t('frameleaf_studio_library_empty_title')}
        message={$t('frameleaf_studio_library_empty_active')}
        action={{ label: $t('frameleaf_studio_library_new'), href: Route.studio(), icon: mdiPlus }}
        secondaryAction={{ label: $t('frameleaf_studio_library_pick_photos'), href: Route.photos() }}
      />
    {:else}
      <EmptyState
        compact
        icon={shelf === 'trashed' ? mdiTrashCanOutline : mdiArchiveOutline}
        message={$t(`frameleaf_studio_library_empty_${shelf}`)}
      />
    {/if}
  {:else}
    <!-- While a new order or search is on its way the cards dim rather than vanish. -->
    <ul class="grid" class:stale={loading} aria-busy={loading}>
      {#each items as project, index (project.id)}
        {@const poster = posterUrl(project)}
        {@const days = studioDaysUntilPurge(project)}
        {@const openable = project.shelf !== StudioProjectShelf.Trashed}
        {@const actions = studioProjectActions(project).filter((action) => action !== 'open')}
        <li class="card fl-reveal" class:openable style="--i: {index}" aria-busy={busyId === project.id}>
          <div class="poster" data-fl-shared={poster && openable ? studioProjectSharedKey(project.id) : undefined}>
            {#if poster}
              <img src={poster} alt="" loading="lazy" />
            {:else}
              <Icon icon={mdiFilmstrip} size={ICON_SIZE.hero} />
            {/if}
          </div>
          <div class="body">
            <div class="text">
              {#if renamingId === project.id}
                <input
                  class="rename"
                  aria-label={$t('frameleaf_studio_library_rename_label')}
                  bind:value={renameValue}
                  maxlength={200}
                  use:focusOnMount
                  onblur={() => commitRename(project)}
                  onkeydown={(event) => {
                    if (event.key === 'Enter') {
                      commitRename(project);
                    } else if (event.key === 'Escape') {
                      renamingId = null;
                    }
                  }}
                />
              {:else if openable}
                <!-- The whole card opens the project: the link's hit area is stretched over it. -->
                <h3>
                  <!-- The link is beside the poster, not around it, so it names the poster that travels. -->
                  <a
                    class="open"
                    href={Route.studio({ projectId: project.id })}
                    onclick={() => armHero(studioProjectSharedKey(project.id))}>{project.name}</a
                  >
                </h3>
              {:else}
                <h3>{project.name}</h3>
              {/if}
              <p class="meta">{metaLine(project)}</p>
              {#if days !== null}
                <p class="meta warning">{$t('frameleaf_studio_library_purge_in', { values: { count: days } })}</p>
              {/if}
            </div>
            {#if actions.length > 0}
              <div class="more">
                <Menu label={$t('frameleaf_studio_library_actions', { values: { name: project.name } })} align="end">
                  {#snippet trigger()}
                    <Icon icon={mdiDotsHorizontal} size={ICON_SIZE.lg} />
                  {/snippet}
                  {#each actions as action (action)}
                    {#if action === 'trash' || action === 'delete-permanently'}
                      <div class="separator" role="separator"></div>
                    {/if}
                    <MenuItem disabled={busyId === project.id} onSelect={() => act(project, action)}>
                      <span class:danger={action === 'trash' || action === 'delete-permanently'}>
                        {$t(actionLabelKey[action])}
                      </span>
                    </MenuItem>
                  {/each}
                </Menu>
              </div>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
    {#if items.length < total}
      <div class="more-row">
        <Button onclick={() => void loadMore()} disabled={loadingMore}>
          {#if loadingMore}<Spinner size="md" decorative />{/if}
          {$t('frameleaf_studio_library_show_more')}
        </Button>
      </div>
    {/if}
  {/if}
</main>

{#if confirmDelete}
  <BulkConfirmDialog
    bind:open={confirmDeleteOpen}
    count={1}
    labelKey="frameleaf_studio_library_delete_permanently"
    messageKey="frameleaf_studio_library_delete_permanently_confirm"
    onConfirm={() => {
      const project = confirmDelete;
      if (project) {
        void run(
          project,
          () => deleteStudioProject({ id: project.id, permanent: true }),
          'frameleaf_studio_library_deleted',
        );
      }
    }}
  />
{/if}

<!-- The count is the whole trash, not only the cards on screen: that is what the server empties. -->
<BulkConfirmDialog
  bind:open={confirmEmptyOpen}
  count={total}
  labelKey="frameleaf_studio_library_empty_trash"
  messageKey="frameleaf_studio_library_empty_trash_confirm"
  onConfirm={async () => {
    try {
      const { count } = await emptyStudioProjectTrash();
      toastManager.primary($t('frameleaf_studio_library_trash_emptied', { values: { count } }));
      await load();
    } catch (error) {
      handleError(error, $t('frameleaf_studio_library_action_failed'));
    }
  }}
/>

{#snippet jobProgress(job: StudioBundleOperationDto)}
  <p role="status">{$t(studioBundleJobStatusKey(job))}</p>
  {#if !isStudioBundleSettled(job)}
    <!-- The job reports counted work, so the bar is real progress, not a spinner in disguise. -->
    <div
      class="progress"
      role="progressbar"
      aria-label={$t(studioBundleJobStatusKey(job))}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={studioExportPercent(job)}
    >
      <span style:transform="scaleX({studioExportPercent(job) / 100})"></span>
    </div>
  {/if}
{/snippet}

<Dialog bind:open={exportOpen} title={$t('frameleaf_studio_bundle_export_title')} closeLabel={$t('close')}>
  <div class="dialog-body">
    {#if !exportJob}
      <p>{$t('frameleaf_studio_bundle_export_body', { values: { name: exportTarget?.name ?? '' } })}</p>
      <label class="check">
        <input type="checkbox" bind:checked={exportIncludeMedia} />
        <span>{$t('frameleaf_studio_bundle_include_media')}</span>
      </label>
      <p class="note">{$t('frameleaf_studio_bundle_include_media_note')}</p>
      <footer>
        <Button onclick={() => (exportOpen = false)}>{$t('cancel')}</Button>
        <Button variant="primary" onclick={() => void startExport()}>
          {$t('frameleaf_studio_bundle_export_start')}
        </Button>
      </footer>
    {:else}
      {@render jobProgress(exportJob)}
      {#if exportJob.status === MediaOperationStatus.Failed}
        <p class="error">{$t(studioBundleErrorKey(exportJob.errorCode))}</p>
      {/if}
      {#if exportJob.export}
        <p class="note">
          {$t('frameleaf_studio_bundle_export_done', {
            values: { embedded: exportJob.export.embedded, referenced: exportJob.export.referenced },
          })}
        </p>
      {/if}
      <footer>
        <Button onclick={() => void goto(Route.activity())}>{$t('frameleaf_studio_bundle_open_activity')}</Button>
        {#if exportJob.export?.downloadable}
          <Button variant="primary" onclick={downloadExport}>{$t('frameleaf_studio_bundle_download')}</Button>
        {/if}
      </footer>
    {/if}
  </div>
</Dialog>

<Dialog bind:open={importOpen} title={$t('frameleaf_studio_bundle_import_title')} closeLabel={$t('close')}>
  <div class="dialog-body">
    {#if upload && review}
      {#if !importJob}
        <label class="field">
          <span>{$t('frameleaf_studio_bundle_import_name')}</span>
          <input bind:value={importName} maxlength={200} />
        </label>
        <p class="note">
          {$t('frameleaf_studio_bundle_review_summary', {
            values: { kept: review.kept, suggested: review.suggested, missing: review.missing },
          })}
        </p>
        {#if review.missingWithCopy > 0}
          <p class="note">
            {$t('frameleaf_studio_bundle_review_copies', { values: { count: review.missingWithCopy } })}
          </p>
        {/if}
        {#if upload.sources.length > 0}
          <ul class="sources">
            {#each upload.sources as source (source.key)}
              <li>
                <span class="source-name">{source.fileName ?? $t('frameleaf_studio_bundle_unnamed_source')}</span>
                {#if source.resolution === StudioBundleSourceResolution.Suggested}
                  <label class="check">
                    <input
                      type="checkbox"
                      checked={!declined.has(source.key)}
                      onchange={() => toggleSuggestion(source.key)}
                    />
                    <span>{$t('frameleaf_studio_bundle_use_match')}</span>
                  </label>
                {:else}
                  <span class="chip">{$t(`frameleaf_studio_bundle_source_${source.resolution}`)}</span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        <p class="note">{$t('frameleaf_studio_bundle_import_note')}</p>
        <footer>
          <Button onclick={() => void discardUpload()}>{$t('cancel')}</Button>
          <Button variant="primary" disabled={!importName.trim()} onclick={() => void startImport()}>
            {$t('frameleaf_studio_bundle_import_start')}
          </Button>
        </footer>
      {:else}
        {@render jobProgress(importJob)}
        {#if importJob.status === MediaOperationStatus.Failed}
          <p class="error">{$t(studioBundleErrorKey(importJob.errorCode))}</p>
        {/if}
        {#if importJob.import}
          <p class="note">
            {$t('frameleaf_studio_bundle_import_done', {
              values: {
                relinked: importJob.import.relinked,
                kept: importJob.import.kept,
                missing: importJob.import.missing.length,
              },
            })}
          </p>
        {/if}
        <footer>
          <Button onclick={() => void goto(Route.activity())}>{$t('frameleaf_studio_bundle_open_activity')}</Button>
          {#if importJob.import?.projectId}
            <Button
              variant="primary"
              onclick={() => void goto(Route.studio({ projectId: importJob?.import?.projectId ?? null }))}
            >
              {$t('frameleaf_studio_library_open')}
            </Button>
          {/if}
        </footer>
      {/if}
    {/if}
  </div>
</Dialog>

<style>
  .fl-studio-library {
    display: grid;
    align-content: start;
    gap: var(--fl-space-4);
    padding: var(--fl-space-6) var(--fl-space-4);
    max-width: 72rem;
    margin-inline: auto;
    color: var(--fl-text);
    font-size: var(--fl-font-size);
  }
  .head,
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--fl-space-3);
  }
  .toolbar {
    align-items: center;
  }
  /* Not `overline`: that is a Tailwind utility, and draws a line over the text. */
  .kicker {
    margin: 0;
  }
  h1 {
    margin: var(--fl-space-half) 0 0;
    font: var(--fl-type-title);
    letter-spacing: var(--fl-tracking-title);
  }
  h3 {
    margin: 0;
    font-size: var(--fl-font-size);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .open {
    color: inherit;
    text-decoration: none;
  }
  /* The stretched link: one target the size of the card, named by the project. */
  .open::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: var(--fl-radius-card);
  }
  .open:focus-visible {
    outline: none;
  }
  .card:has(.open:focus-visible) {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .summary,
  .meta,
  .note {
    margin: var(--fl-space-1) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .note {
    margin: 0;
  }
  .warning {
    color: var(--fl-warning);
  }
  .error {
    margin: 0;
    color: var(--fl-danger);
  }
  .danger {
    color: var(--fl-danger);
  }
  .head-actions,
  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
  }
  .filters {
    justify-content: flex-end;
  }
  @media (max-width: 640px) {
    .filters {
      justify-content: flex-start;
      width: 100%;
    }
    .search {
      flex: 1 1 100%;
    }
  }
  .search,
  .rename,
  .field input {
    min-height: var(--fl-control-height-compact);
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font: inherit;
  }
  /* A definite width: a percentage here made the row measure itself narrow and wrap early. */
  .search {
    width: 16rem;
    max-width: 100%;
  }
  .rename {
    position: relative;
    z-index: 1;
    width: 100%;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
    gap: var(--fl-space-4);
    margin: 0;
    padding: 0;
    list-style: none;
    transition: opacity var(--fl-motion) var(--fl-ease);
  }
  .grid.stale {
    opacity: 0.5;
  }
  .card {
    position: relative;
    display: grid;
    grid-template-rows: auto 1fr;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-1);
    transition:
      box-shadow var(--fl-motion) var(--fl-ease),
      transform var(--fl-duration) var(--fl-spring);
  }
  /* Not a `.card`: a placeholder is the shape of one, with nothing to open or act on. */
  .placeholder {
    overflow: hidden;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .card.openable:hover {
    box-shadow: var(--fl-shadow-2);
  }
  .card:has(.open:active) {
    transform: scale(0.98);
    transition-duration: var(--fl-motion), var(--fl-duration-press);
  }
  /* The card whose menu is open sits above its neighbours, so the menu is never cut off by them. */
  .card:focus-within {
    z-index: 2;
  }
  .poster {
    display: grid;
    place-items: center;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    background: var(--fl-raised);
    color: var(--fl-muted);
    border-radius: calc(var(--fl-radius-card) - 1px) calc(var(--fl-radius-card) - 1px) 0 0;
  }
  .poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform var(--fl-motion-slow) var(--fl-ease);
  }
  .card.openable:hover .poster img {
    transform: scale(1.02);
  }
  .body {
    display: flex;
    align-items: flex-start;
    gap: var(--fl-space-2);
    min-width: 0;
    padding: var(--fl-space-3) var(--fl-space-2) var(--fl-space-3) var(--fl-space-3);
  }
  .text {
    flex: 1 1 auto;
    min-width: 0;
  }
  /* Above the stretched link. Quiet until the card is pointed at or focused; always there on touch. */
  .more {
    position: relative;
    z-index: 1;
    flex: 0 0 auto;
    opacity: 0;
    transition: opacity var(--fl-motion-fast) var(--fl-ease);
  }
  .card:hover .more,
  .card:focus-within .more {
    opacity: 1;
  }
  @media (hover: none) {
    .more {
      opacity: 1;
    }
  }
  .separator {
    height: 1px;
    margin: var(--fl-space-1) 0;
    background: var(--fl-border);
  }
  .more-row {
    display: flex;
    justify-content: center;
  }
  .progress {
    height: var(--fl-space-1);
    overflow: hidden;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
  }
  .progress span {
    display: block;
    height: 100%;
    background: var(--fl-accent);
    transform-origin: left center;
    transition: transform var(--fl-motion-slow) linear;
  }
  :global([dir='rtl']) .progress span {
    transform-origin: right center;
  }
  .dialog-body {
    display: grid;
    gap: var(--fl-space-3);
    margin-top: var(--fl-space-3);
    min-width: min(28rem, 100%);
  }
  .dialog-body p {
    margin: 0;
  }
  .check,
  .field {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
  }
  .field {
    flex-direction: column;
    align-items: stretch;
  }
  .sources {
    display: grid;
    gap: var(--fl-space-2);
    max-height: 16rem;
    overflow: auto;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .sources li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-2);
    font-size: var(--fl-font-small);
  }
  .source-name {
    overflow-wrap: anywhere;
  }
  .chip {
    color: var(--fl-muted);
    white-space: nowrap;
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--fl-space-2);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  @media (prefers-reduced-motion: reduce) {
    .card:has(.open:active),
    .card.openable:hover .poster img {
      transform: none;
    }
  }
</style>
