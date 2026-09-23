<script lang="ts">
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import BulkConfirmDialog from '$lib/components/frameleaf/BulkConfirmDialog.svelte';
  import { studioBundleDownloadPath } from '$lib/frameleaf/studio/bundles';
  import {
    isStudioBundleSettled,
    recentStudioProjects,
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
  } from '@immich/sdk';
  import { Icon, toastManager } from '@immich/ui';
  import { mdiFilmstrip, mdiImport, mdiPlus } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { locale, t, type Translations } from 'svelte-i18n';

  /**
   * The Studio project library (FL-91, `STU-204`).
   *
   * Beyond the prototype, which kept a single project in local storage. Three shelves: the
   * projects a person owns or reviews, their archive, and their trash. Opening, renaming,
   * duplicating, archiving, trashing, restoring and deleting for good all go to the server, and
   * the list is re-read afterwards rather than patched, so what is shown is what the server holds.
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
  let recent = $state<StudioProjectDto[]>([]);
  let loading = $state(true);
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
  const dateFormat = $derived(new Intl.DateTimeFormat($locale ?? undefined, { dateStyle: 'medium' }));

  const load = async () => {
    loading = true;
    try {
      const term = query.trim();
      const [list, recents] = await Promise.all([
        searchStudioProjects({
          shelf: shelfEnum[shelf],
          sort: sortEnum[sort],
          query: term || undefined,
          take: 60,
        }),
        shelf === 'active' && !term
          ? searchStudioProjects({ shelf: StudioProjectShelf.Active, sort: StudioProjectSort.Recent, take: 12 })
          : Promise.resolve(null),
      ]);
      if (disposed) {
        return;
      }
      items = list.items;
      total = list.total;
      recent = recents ? recentStudioProjects(recents.items) : [];
    } catch (error) {
      handleError(error, $t('frameleaf_studio_library_load_failed'));
    } finally {
      loading = false;
    }
  };

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
    shelf = next;
    void goto(Route.studioProjects({ shelf: next }), { replaceState: true, keepFocus: true, noScroll: true });
  };

  const run = async (project: StudioProjectDto, action: () => Promise<unknown>, doneKey: Translations) => {
    busyId = project.id;
    try {
      await action();
      announcement = $t(doneKey, { values: { name: project.name } });
      toastManager.primary(announcement);
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
        // Reversible for the whole retention period, so no confirmation: Restore is one click away.
        void run(project, () => deleteStudioProject({ id: project.id }), 'frameleaf_studio_library_trashed');
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
      project.revision > 0
        ? $t('frameleaf_studio_history_version', { values: { revision: project.revision } })
        : $t('frameleaf_studio_library_unsaved'),
      $t('frameleaf_studio_library_changed', { values: { date: dateFormat.format(new Date(project.updatedAt)) } }),
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
      <p class="eyebrow">{$t('frameleaf_studio_title')}</p>
      <h1 id="fl-studio-library-title">{$t('frameleaf_studio_library_title')}</h1>
      <p class="summary">{$t('frameleaf_studio_library_summary', { values: { count: total } })}</p>
    </div>
    <div class="head-actions">
      <Button onclick={chooseBundle} disabled={uploading}>
        <Icon icon={mdiImport} size="16" />
        {uploading ? $t('frameleaf_studio_bundle_uploading') : $t('frameleaf_studio_bundle_import')}
      </Button>
      <Button variant="primary" onclick={() => void goto(Route.studio())}>
        <Icon icon={mdiPlus} size="16" />
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

  <nav class="toolbar" aria-label={$t('frameleaf_studio_library_shelves')}>
    <div class="shelves">
      {#each STUDIO_LIBRARY_SHELVES as option (option.id)}
        <Button variant="quiet" pressed={shelf === option.id} onclick={() => setShelf(option.id)}>
          {$t(option.labelKey)}
        </Button>
      {/each}
    </div>
    <div class="filters">
      <input
        class="search"
        type="search"
        placeholder={$t('frameleaf_studio_library_search')}
        aria-label={$t('frameleaf_studio_library_search')}
        bind:value={query}
      />
      <select aria-label={$t('frameleaf_studio_library_sort')} bind:value={sort}>
        {#each STUDIO_LIBRARY_SORTS as option (option.id)}
          <option value={option.id}>{$t(option.labelKey)}</option>
        {/each}
      </select>
      {#if shelf === 'trashed' && items.length > 0}
        <Button onclick={() => (confirmEmptyOpen = true)}>{$t('frameleaf_studio_library_empty_trash')}</Button>
      {/if}
    </div>
  </nav>

  {#if shelf === 'trashed'}
    <p class="note">{$t('frameleaf_studio_library_trash_note')}</p>
  {:else if shelf === 'archived'}
    <p class="note">{$t('frameleaf_studio_library_archive_note')}</p>
  {/if}

  {#if recent.length > 0}
    <section aria-labelledby="fl-studio-recent">
      <h2 id="fl-studio-recent">{$t('frameleaf_studio_library_recent')}</h2>
      <ul class="recent">
        {#each recent as project (project.id)}
          <li>
            <a href={Route.studio({ projectId: project.id })}>
              <Icon icon={mdiFilmstrip} size="16" />
              <span>{project.name}</span>
            </a>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if loading && items.length === 0}
    <p class="note" aria-busy="true">{$t('frameleaf_studio_library_loading')}</p>
  {:else if items.length === 0}
    <p class="note">
      {query.trim() ? $t('frameleaf_studio_library_no_match') : $t(`frameleaf_studio_library_empty_${shelf}`)}
    </p>
  {:else}
    <ul class="grid">
      {#each items as project (project.id)}
        {@const poster = posterUrl(project)}
        {@const days = studioDaysUntilPurge(project)}
        <li class="card" aria-busy={busyId === project.id}>
          <div class="poster">
            {#if poster}
              <img src={poster} alt="" loading="lazy" />
            {:else}
              <Icon icon={mdiFilmstrip} size="32" />
            {/if}
          </div>
          <div class="body">
            {#if renamingId === project.id}
              <input
                class="rename"
                aria-label={$t('frameleaf_studio_library_rename_label')}
                bind:value={renameValue}
                maxlength={200}
                onblur={() => commitRename(project)}
                onkeydown={(event) => {
                  if (event.key === 'Enter') {
                    commitRename(project);
                  } else if (event.key === 'Escape') {
                    renamingId = null;
                  }
                }}
              />
            {:else if project.shelf === StudioProjectShelf.Trashed}
              <h3>{project.name}</h3>
            {:else}
              <h3><a href={Route.studio({ projectId: project.id })}>{project.name}</a></h3>
            {/if}
            <p class="meta">{metaLine(project)}</p>
            {#if days !== null}
              <p class="meta warning">{$t('frameleaf_studio_library_purge_in', { values: { count: days } })}</p>
            {/if}
          </div>
          <div class="actions">
            {#each studioProjectActions(project).filter((action) => action !== 'open') as action (action)}
              <Button
                variant={action === 'delete-permanently' ? 'default' : 'quiet'}
                disabled={busyId === project.id}
                label={`${$t(actionLabelKey[action])}: ${project.name}`}
                onclick={() => act(project, action)}
              >
                {$t(actionLabelKey[action])}
              </Button>
            {/each}
          </div>
        </li>
      {/each}
    </ul>
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

<BulkConfirmDialog
  bind:open={confirmEmptyOpen}
  count={items.length}
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
      <p role="status">{$t(studioBundleJobStatusKey(exportJob))}</p>
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
        <p role="status">{$t(studioBundleJobStatusKey(importJob))}</p>
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
    gap: 1rem;
    padding: 1.5rem 1rem;
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
    gap: 0.75rem;
  }
  .eyebrow {
    margin: 0;
    font-size: var(--fl-font-small);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fl-muted);
  }
  h1 {
    margin: 0.125rem 0 0;
    font-size: 1.375rem;
    font-weight: 600;
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  h3 {
    margin: 0;
    font-size: var(--fl-font-size);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  h3 a {
    color: inherit;
    text-decoration: none;
  }
  h3 a:hover,
  h3 a:focus-visible {
    text-decoration: underline;
  }
  .summary,
  .meta,
  .note {
    margin: 0.25rem 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .warning {
    color: var(--fl-warning, var(--fl-muted));
  }
  .error {
    margin: 0;
    color: var(--fl-danger, var(--fl-text));
  }
  .head-actions,
  .shelves,
  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .search,
  select,
  .rename,
  .field input {
    min-height: 2.25rem;
    padding: 0 0.625rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font: inherit;
  }
  .search {
    width: min(16rem, 100%);
  }
  .recent {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .recent a {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.625rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    text-decoration: none;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    display: grid;
    grid-template-rows: auto 1fr auto;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-panel-radius);
    overflow: hidden;
  }
  .poster {
    display: grid;
    place-items: center;
    aspect-ratio: 16 / 9;
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .body {
    padding: 0.625rem 0.75rem 0;
    min-width: 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    padding: 0.5rem 0.5rem 0.625rem;
  }
  .dialog-body {
    display: grid;
    gap: 0.75rem;
    margin-top: 0.75rem;
    min-width: min(28rem, 100%);
  }
  .dialog-body p {
    margin: 0;
  }
  .check,
  .field {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .field {
    flex-direction: column;
    align-items: stretch;
  }
  .sources {
    display: grid;
    gap: 0.375rem;
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
    gap: 0.5rem;
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
    gap: 0.5rem;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
