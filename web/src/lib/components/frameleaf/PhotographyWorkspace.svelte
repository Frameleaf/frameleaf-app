<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Icon } from '@immich/ui';
  import {
    AssetMediaSize,
    getAllAlbums,
    getAssetDevelop,
    type AlbumResponseDto,
    type AssetDevelopResponseDto,
  } from '@immich/sdk';
  import {
    mdiArrowLeft,
    mdiCameraIris,
    mdiCameraOutline,
    mdiChevronRight,
    mdiCloudUploadOutline,
    mdiImageMultipleOutline,
    mdiMagnify,
    mdiPaletteOutline,
    mdiPlus,
    mdiShieldCheckOutline,
    mdiStar,
    mdiStarOutline,
    mdiWeb,
  } from '@mdi/js';
  import PhotographyBranding from '$lib/components/frameleaf/PhotographyBranding.svelte';
  import PhotographyWorkflow from '$lib/components/frameleaf/PhotographyWorkflow.svelte';
  import PhotographyWatermarks from '$lib/components/frameleaf/PhotographyWatermarks.svelte';
  import PhotographyWebsite from '$lib/components/frameleaf/PhotographyWebsite.svelte';
  import PhotographyNativeSync from '$lib/components/frameleaf/PhotographyNativeSync.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    loadPhotos,
    loadWorkspace,
    ratePhoto,
    saveWorkspace,
    shootStages,
    shootTypes,
    type Photo,
    type Shoot,
    type Workspace,
  } from '$lib/frameleaf/photography/api';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { loadWorkflowSummaries, type WorkflowSummary } from '$lib/frameleaf/photography/workflow-api';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl } from '$lib/utils';
  import { locale } from '$lib/stores/preferences.store';
  import '$lib/frameleaf/photography/workspace.css';

  let section = $state<
    'shoots' | 'branding' | 'watermarks' | 'intake' | 'workflow' | 'orders' | 'presentation' | 'publishing' | 'website'
  >('shoots');
  let projectFilter = $state('All projects');
  let workspace = $state<Workspace>({ revision: null, shoots: [] });
  let workflowSummaries = $state<WorkflowSummary[]>([]);
  let summaryError = $state('');
  let albums = $state<AlbumResponseDto[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let message = $state('');
  let search = $state('');
  let sort = $state('date');
  let activeId = $state<string | null>(null);
  let photos = $state<Photo[]>([]);
  let photoLoading = $state(false);
  let photoError = $state('');
  let nextCursor = $state<string | null>(null);
  let tab = $state('All');
  let selected = $state<string[]>([]);
  let compareOpen = $state(false);
  let batchOpen = $state(false);
  let newOpen = $state(false);
  let draft = $state({
    name: '',
    client: '',
    type: shootTypes[0] as Shoot['type'],
    date: new Date().toISOString().slice(0, 10),
    albumId: '',
  });
  let details = $state({ name: '', client: '', stage: shootStages[0] as Shoot['stage'] });
  let inspecting = $state<Photo | null>(null);
  let versions = $state<AssetDevelopResponseDto | null>(null);
  let versionError = $state('');
  let versionsLoading = $state(false);
  let generation = 0;
  let detailGeneration = 0;
  let versionGeneration = 0;
  let disposed = false;
  const active = $derived(workspace.shoots.find(({ id }) => id === activeId));
  const listing = $derived(
    workspace.shoots
      .filter(
        (shoot) =>
          projectFilter === 'All projects' ||
          (projectFilter === 'Active' ? shoot.stage !== 'Delivered' : shoot.stage === projectFilter),
      )
      .filter((shoot) => `${shoot.name} ${shoot.client} ${shoot.type}`.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : b.date.localeCompare(a.date))),
  );
  const matches = (photo: Photo, filter: string) =>
    filter === 'All' ||
    (filter === 'Selected' && (photo.rating ?? 0) >= 4) ||
    (filter === 'Edited' && photo.rating !== -1 && !!photo.currentRevisionId);
  const visible = $derived(photos.filter((photo) => matches(photo, tab)));
  const availableAlbums = $derived(
    albums.filter(
      (album) =>
        album.albumUsers[0]?.user.id === authManager.user.id &&
        album.kind === 'album' &&
        !album.isSmart &&
        workspace.shoots.every((shoot) => shoot.albumId !== album.id),
    ),
  );
  const cover = (id: string) => getAssetMediaUrl({ id, size: AssetMediaSize.Thumbnail });
  const dateLabel = (date: string) =>
    new Date(`${date}T12:00:00`).toLocaleDateString($locale, { month: 'short', day: 'numeric', year: 'numeric' });
  const failure = (cause: unknown) =>
    cause instanceof Error ? cause.message : 'The request could not be completed. Try again.';

  async function reload() {
    const current = ++generation;
    loading = true;
    error = '';
    try {
      const [stored, sourceAlbums, summaries] = await Promise.all([
        loadWorkspace(),
        getAllAlbums({}),
        loadWorkflowSummaries().catch(() => null),
      ]);
      if (disposed || current !== generation) {
        return;
      }
      workspace = stored;
      albums = sourceAlbums;
      workflowSummaries = summaries?.galleries ?? [];
      summaryError = summaries ? '' : 'Collection progress could not be loaded.';
      if (activeId) {
        await openShoot(activeId);
      }
    } catch (error_) {
      if (current === generation) {
        error = failure(error_);
      }
    } finally {
      if (current === generation) {
        loading = false;
      }
    }
  }

  async function persist(shoots: Shoot[]) {
    if (busy) {
      return false;
    }
    const current = generation;
    busy = true;
    error = '';
    message = '';
    try {
      const saved = await saveWorkspace({ revision: workspace.revision, shoots });
      if (disposed || current !== generation) {
        return false;
      }
      workspace = saved;
      message = 'Saved on your server';
      return true;
    } catch (error_) {
      if (current === generation) {
        error = failure(error_);
      }
      return false;
    } finally {
      if (current === generation) {
        busy = false;
      }
    }
  }

  async function openShoot(id: string) {
    activeId = id;
    const shoot = workspace.shoots.find((shoot) => shoot.id === id);
    if (!shoot) {
      activeId = null;
      return;
    }
    details = { name: shoot.name, client: shoot.client, stage: shoot.stage };
    photos = [];
    nextCursor = null;
    selected = [];
    compareOpen = false;
    batchOpen = false;
    tab = 'All';
    inspecting = null;
    versions = null;
    versionGeneration++;
    const current = ++detailGeneration;
    photoError = '';
    if (shoot.unavailable) {
      photoLoading = false;
      return;
    }
    photoLoading = true;
    try {
      const page = await loadPhotos(id);
      if (disposed || current !== detailGeneration) {
        return;
      }
      photos = page.photos;
      nextCursor = page.nextCursor;
    } catch (error_) {
      if (current === detailGeneration) {
        photoError = failure(error_);
      }
    } finally {
      if (current === detailGeneration) {
        photoLoading = false;
      }
    }
  }

  async function more() {
    if (!activeId || !nextCursor || photoLoading) {
      return;
    }
    const id = activeId;
    const current = detailGeneration;
    photoLoading = true;
    photoError = '';
    try {
      const page = await loadPhotos(id, nextCursor);
      if (disposed || current !== detailGeneration) {
        return;
      }
      photos = [...photos, ...page.photos.filter((photo) => photos.every(({ id }) => id !== photo.id))];
      nextCursor = page.nextCursor;
    } catch (error_) {
      if (current === detailGeneration) {
        photoError = failure(error_);
      }
    } finally {
      if (current === detailGeneration) {
        photoLoading = false;
      }
    }
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    const shoot: Shoot = {
      ...draft,
      id: crypto.randomUUID(),
      stage: 'Imported',
      unavailable: false,
      coverAssetId: null,
      assetCount: 0,
    };
    if (await persist([...workspace.shoots, shoot])) {
      newOpen = false;
      await openShoot(shoot.id);
    }
  }

  async function saveDetails(event: SubmitEvent) {
    event.preventDefault();
    if (active) {
      await persist(workspace.shoots.map((shoot) => (shoot.id === activeId ? { ...shoot, ...details } : shoot)));
    }
  }

  async function rate(ids: string[], rating: number | null) {
    if (!activeId || busy) {
      return;
    }
    const id = activeId;
    const current = generation;
    busy = true;
    error = '';
    message = '';
    try {
      // ponytail: selection is limited to loaded photos; each request reports its actual persisted result.
      for (const assetId of ids) {
        await ratePhoto(id, assetId, rating);
        if (disposed || current !== generation) {
          return;
        }
        photos = photos.map((photo) => (photo.id === assetId ? { ...photo, rating } : photo));
      }
      message = 'Ratings saved on your server';
    } catch (error_) {
      if (current === generation) {
        error = failure(error_);
      }
    } finally {
      if (current === generation) {
        busy = false;
      }
    }
  }

  async function inspect(photo: Photo) {
    inspecting = photo;
    versions = null;
    versionError = '';
    const current = ++versionGeneration;
    versionsLoading = true;
    try {
      const saved = await getAssetDevelop({ id: photo.id });
      if (!disposed && current === versionGeneration) {
        versions = saved;
      }
    } catch (error_) {
      if (current === versionGeneration) {
        versionError = failure(error_);
      }
    } finally {
      if (current === versionGeneration) {
        versionsLoading = false;
      }
    }
  }

  onMount(() => {
    void reload();
    return onLibraryAccessChange(() => {
      generation++;
      detailGeneration++;
      versionGeneration++;
      section = 'shoots';
      workspace = { revision: null, shoots: [] };
      workflowSummaries = [];
      summaryError = '';
      albums = [];
      activeId = null;
      photos = [];
      inspecting = null;
      versions = null;
      selected = [];
      compareOpen = false;
      batchOpen = false;
      busy = false;
      newOpen = false;
      draft = {
        name: '',
        client: '',
        type: 'Family portrait',
        date: new Date().toISOString().slice(0, 10),
        albumId: '',
      };
      details = { name: '', client: '', stage: 'Imported' };
      message = '';
      error = '';
      if (authManager.authenticated) {
        void reload();
      }
    }, authManager.user.id);
  });
  onDestroy(() => {
    disposed = true;
    generation++;
    detailGeneration++;
    versionGeneration++;
  });
</script>

<svelte:window
  onkeydown={(event) => {
    if (
      section !== 'shoots' ||
      !active ||
      busy ||
      newOpen ||
      compareOpen ||
      batchOpen ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      (event.target instanceof HTMLElement &&
        (event.target.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(event.target.tagName)))
    ) {
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const candidates = visible.filter((photo) => photo.canRate);
      const index = candidates.findIndex((photo) => photo.id === selected.at(-1));
      const next =
        candidates[Math.max(0, Math.min(candidates.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)))];
      if (next) {
        event.preventDefault();
        selected = [next.id];
        void inspect(next);
      }
    } else if (selected.length > 0 && /^[0-5xX]$/.test(event.key)) {
      event.preventDefault();
      void rate(selected, event.key.toLowerCase() === 'x' ? -1 : event.key === '0' ? null : Number(event.key));
    }
  }}
/>

<div class="phw">
  <aside class="phw-rail">
    <a class="phw-return" href={Route.photos()}><Icon icon={mdiArrowLeft} size="1rem" />Back to library</a>
    <div class="phw-studio-brand">
      <span class="phw-brand-mark"><Icon icon={mdiCameraIris} size="1.2rem" /></span>
      <div><strong>{authManager.user.name}</strong><small>Photography workspace</small></div>
    </div>
    <nav aria-label="Photography workspace">
      <button
        type="button"
        aria-current={section === 'shoots' ? 'page' : undefined}
        disabled={busy}
        onclick={() => {
          const returning = section !== 'shoots';
          section = 'shoots';
          activeId = null;
          detailGeneration++;
          if (returning) {
            void reload();
          }
        }}><Icon icon={mdiCameraOutline} size="1.2rem" />Projects</button
      >
      {#each [['intake', 'Intake & assembly', mdiCameraOutline], ['workflow', 'Client workflow', mdiImageMultipleOutline], ['orders', 'Selections & orders', mdiStarOutline], ['presentation', 'Gallery templates', mdiWeb], ['watermarks', 'Watermarks', mdiPaletteOutline]] as [id, label, icon] (id)}
        <button
          type="button"
          aria-current={section === id ? 'page' : undefined}
          disabled={busy}
          onclick={() => {
            section = id as typeof section;
            detailGeneration++;
          }}><Icon {icon} size="1.2rem" />{label}</button
        >
      {/each}
      <button
        type="button"
        aria-current={section === 'branding' ? 'page' : undefined}
        disabled={busy}
        onclick={() => {
          section = 'branding';
          detailGeneration++;
        }}><Icon icon={mdiPaletteOutline} size="1.2rem" />Branding</button
      >
      <button
        type="button"
        aria-current={section === 'publishing' ? 'page' : undefined}
        disabled={busy}
        onclick={() => {
          section = 'publishing';
          detailGeneration++;
        }}><Icon icon={mdiCloudUploadOutline} size="1.2rem" />Publishing</button
      >
      <button
        type="button"
        aria-current={section === 'website' ? 'page' : undefined}
        disabled={busy}
        onclick={() => {
          section = 'website';
          detailGeneration++;
        }}><Icon icon={mdiWeb} size="1.2rem" />Studio website</button
      >
    </nav>
    <div class="phw-rail-bottom">
      <Icon icon={mdiShieldCheckOutline} size="1.3rem" />
      <p>Your originals stay local.<small>Shoots and local editing are yours on every plan.</small></p>
      <a href={Route.libraryCare()}>Library care <Icon icon={mdiChevronRight} size="1rem" /></a>
    </div>
  </aside>
  <div class="phw-workspace">
    <header class="phw-header">
      <div>
        <span class="phw-breadcrumb">Photography</span>
        <h1>
          {section === 'branding'
            ? 'Branding'
            : section === 'watermarks'
              ? 'Watermarks'
              : section === 'website'
                ? 'Studio website'
                : (active?.name ?? 'Projects')}
        </h1>
        <p>
          {section === 'branding'
            ? 'Your studio, carried through every detail.'
            : active
              ? `${active.client} · ${active.type} · ${dateLabel(active.date)}`
              : 'From the first frame to the final delivery.'}
        </p>
      </div>
      <div class="phw-header-actions">
        <span class="phw-save" aria-live="polite">{busy ? 'Saving…' : message}</span>{#if section === 'shoots'}<Button
            variant="primary"
            disabled={loading || busy || !!error}
            onclick={() => {
              draft = {
                name: '',
                client: '',
                type: 'Family portrait',
                date: new Date().toISOString().slice(0, 10),
                albumId: availableAlbums[0]?.id ?? '',
              };
              newOpen = true;
            }}><Icon icon={mdiPlus} size="1rem" />New project</Button
          >{/if}
      </div>
    </header>
    {#if error}<div class="phw-notice" role="alert">
        <span>{error}</span><Button disabled={busy} onclick={reload}>Reload shoots</Button>
      </div>{/if}
    <main class="phw-scroll" aria-busy={loading}>
      {#if section === 'branding'}<PhotographyBranding
          onSaved={() => {
            void reload();
          }}
        />
      {:else if section === 'watermarks'}<PhotographyWatermarks />
      {:else if section === 'website'}<PhotographyWebsite shoots={workspace.shoots} />
      {:else if !['shoots', 'website'].includes(section)}
        <div class="phd-project-picker">
          <label
            >Project<select
              value={activeId ?? ''}
              onchange={(event) => {
                activeId = event.currentTarget.value || null;
              }}
              ><option value="">Choose a project</option>{#each workspace.shoots as shoot (shoot.id)}<option
                  value={shoot.id}>{shoot.name} · {shoot.client}</option
                >{/each}</select
            ></label
          >
        </div>
        {#if active}{#key `${active.id}:${section}`}<PhotographyWorkflow
              shoot={active}
              panel={section as 'intake' | 'workflow' | 'orders' | 'presentation' | 'publishing'}
            />{/key}{:else}<div class="phw-empty">
            <h2>Choose a project</h2>
            <p>Open an existing project or create one from Projects.</p>
          </div>{/if}
      {:else if loading}<div class="phw-empty" role="status">Loading your shoots…</div>
      {:else if active}
        <div class="phw-shoot-top">
          <Button
            disabled={busy}
            onclick={() => {
              activeId = null;
              detailGeneration++;
            }}>All shoots</Button
          >
          <div class="phw-stages" aria-label="Shoot workflow">
            {#each shootStages as stage, index (stage)}<span class:done={index <= shootStages.indexOf(active.stage)}
                ><i>{index + 1}</i>{stage}</span
              >{/each}
          </div>
        </div>
        <div class="phd-project-actions">
          {#each [['intake', 'Intake & assembly'], ['workflow', 'Client workflow'], ['orders', 'Selections & delivery'], ['presentation', 'Presentation'], ['publishing', 'Publish & invite']] as [id, label] (id)}<Button
              onclick={() => (section = id as typeof section)}>{label}</Button
            >{/each}
        </div>
        {#if active.unavailable}<div class="phw-empty">
            <h2>Source album is unavailable</h2>
            <p>
              Your private shoot details are retained. The source album may have been deleted or its ownership changed.
            </p>
            <Button
              disabled={busy}
              onclick={() =>
                persist(workspace.shoots.filter(({ id }) => id !== activeId)).then((saved) => {
                  if (saved) {
                    activeId = null;
                  }
                })}>Remove shoot reference</Button
            >
          </div>
        {:else}<div class="phw-detail-layout">
            <section class="phw-contact-sheet">
              <div class="phw-contact-toolbar">
                <div class="phw-tabs" aria-label="Photo filter">
                  {#each ['All', 'Selected', 'Edited'] as name (name)}<button
                      type="button"
                      aria-pressed={tab === name}
                      onclick={() => {
                        tab = name;
                        selected = [];
                      }}>{name}<small>{photos.filter((photo) => matches(photo, name)).length}</small></button
                    >{/each}<button type="button" onclick={() => (section = 'orders')}>Deliverables</button>
                </div>
                {#if active.albumId}<a href={Route.viewAlbum({ id: active.albumId })}>Add photos in album</a>{/if}
              </div>
              <div class="phw-selection-tools">
                <label
                  ><input
                    type="checkbox"
                    aria-label="Select all editable visible photos"
                    disabled={busy || visible.every((photo) => !photo.canRate)}
                    checked={visible.some((photo) => photo.canRate) &&
                      visible.filter((photo) => photo.canRate).every(({ id }) => selected.includes(id))}
                    onchange={(event) =>
                      (selected = event.currentTarget.checked
                        ? visible.filter((photo) => photo.canRate).map(({ id }) => id)
                        : [])}
                  />{selected.length > 0 ? `${selected.length} selected` : 'Select photos'}</label
                >{#if selected.length}<Button disabled={busy} onclick={() => rate(selected, 4)}>Keep</Button><Button
                    disabled={busy}
                    onclick={() => rate(selected, -1)}>Reject</Button
                  ><Button disabled={busy} onclick={() => rate(selected, null)}>Clear rating</Button>{/if}
                {#if selected.length === 2}<Button disabled={busy} onclick={() => (compareOpen = true)}>Compare</Button
                  >{/if}
                {#if selected.length > 1}<Button disabled={busy} onclick={() => (batchOpen = !batchOpen)}
                    >Batch RAW editing</Button
                  >{/if}
              </div>
              <p class="phw-small">
                Use ← and → to move between photos, 1–5 to rate, X to reject and 0 to clear a rating.
              </p>
              {#if batchOpen && selected.length > 1}<PhotographyNativeSync {photos} assetIds={selected} />{/if}
              {#if photoError}<div class="phw-notice" role="alert">
                  {photoError}<Button
                    disabled={photoLoading}
                    onclick={() => (photos.length > 0 ? more() : openShoot(active.id))}>Retry</Button
                  >
                </div>{/if}
              <div class="phw-photo-grid">
                {#each visible as photo (photo.id)}<article
                    class="phw-photo"
                    class:is-selected={selected.includes(photo.id)}
                    class:is-rejected={photo.rating === -1}
                  >
                    <div class="phw-photo-image">
                      <button
                        type="button"
                        class="phw-open-photo"
                        aria-label={`Inspect ${photo.fileName}`}
                        onclick={() => inspect(photo)}
                        ><img src={cover(photo.id)} alt={photo.fileName} loading="lazy" /></button
                      ><input
                        class="phw-photo-select"
                        type="checkbox"
                        aria-label={`Select ${photo.fileName}`}
                        disabled={busy || !photo.canRate}
                        checked={selected.includes(photo.id)}
                        onchange={(event) =>
                          (selected = event.currentTarget.checked
                            ? [...selected, photo.id]
                            : selected.filter((id) => id !== photo.id))}
                      /><span class="phw-raw"
                        >{photo.fileName.split('.').at(-1)?.toUpperCase()}{#if photo.stackCount > 1}
                          · {photo.stackCount} in stack{/if}</span
                      >{#if photo.currentRevisionId}<span class="phw-edited">Edited</span>{/if}
                    </div>
                    <div class="phw-photo-meta">
                      <span title={photo.fileName}>{photo.fileName}</span>
                      <div class="phw-stars" aria-label={`Rating for ${photo.fileName}`}>
                        {#each [1, 2, 3, 4, 5] as rating (rating)}<button
                            type="button"
                            aria-label={`${rating} star rating for ${photo.fileName}`}
                            aria-pressed={photo.rating === rating}
                            disabled={busy || !photo.canRate}
                            onclick={() => rate([photo.id], photo.rating === rating ? null : rating)}
                            ><Icon
                              icon={(photo.rating ?? 0) >= rating ? mdiStar : mdiStarOutline}
                              size="0.875rem"
                            /></button
                          >{/each}<button
                          type="button"
                          aria-label={`${photo.rating === -1 ? 'Restore' : 'Reject'} ${photo.fileName}`}
                          aria-pressed={photo.rating === -1}
                          disabled={busy || !photo.canRate}
                          onclick={() => rate([photo.id], photo.rating === -1 ? null : -1)}
                          >{photo.rating === -1 ? '↶' : '×'}</button
                        >
                      </div>
                    </div>
                  </article>{/each}
              </div>
              {#if photoLoading}<div class="phw-empty" role="status">
                  Loading photos…
                </div>{:else if visible.length === 0 && !photoError}<div class="phw-empty">
                  <Icon icon={mdiCameraOutline} size="2rem" />
                  <h2>{photos.length > 0 ? `No ${tab.toLowerCase()} photos yet` : 'Your new shoot is ready'}</h2>
                  <p>
                    {photos.length > 0
                      ? 'Star your favourites, then continue into the editor.'
                      : 'Add your photographs to the linked album to begin.'}
                  </p>
                  {#if active.albumId}<a href={Route.viewAlbum({ id: active.albumId })}>Open album</a>{/if}
                </div>{/if}
              {#if nextCursor}<Button disabled={photoLoading || busy} onclick={more}>Load more photos</Button>{/if}
            </section>
            <aside class="phw-inspector">
              <div class="phw-inspector-cover">
                {#if inspecting || active.coverAssetId}<img
                    src={cover(inspecting?.id ?? active.coverAssetId!)}
                    alt={inspecting?.fileName ?? active.name}
                  />{/if}
              </div>
              <div class="phw-inspector-body">
                <h2>Shoot details</h2>
                <form onsubmit={saveDetails}>
                  <label class="phw-field"
                    ><span>Shoot name</span><input
                      required
                      maxlength="200"
                      bind:value={details.name}
                      disabled={busy}
                    /></label
                  ><label class="phw-field"
                    ><span>Client</span><input
                      required
                      maxlength="200"
                      bind:value={details.client}
                      disabled={busy}
                    /></label
                  ><label class="phw-field"
                    ><span>Stage</span><select bind:value={details.stage} disabled={busy}
                      >{#each shootStages as stage (stage)}<option>{stage}</option>{/each}</select
                    ></label
                  ><Button type="submit" disabled={busy || !!error}>Save details</Button>
                </form>
                <dl class="phw-stats">
                  <div>
                    <dt>Photos loaded</dt>
                    <dd>{photos.length}</dd>
                  </div>
                  <div>
                    <dt>Kept for proofing</dt>
                    <dd>{photos.filter((photo) => (photo.rating ?? 0) >= 4).length}</dd>
                  </div>
                  <div>
                    <dt>Edited</dt>
                    <dd>{photos.filter((photo) => photo.currentRevisionId && photo.rating !== -1).length}</dd>
                  </div>
                  <div>
                    <dt>Rejected</dt>
                    <dd>{photos.filter((photo) => photo.rating === -1).length}</dd>
                  </div>
                </dl>
                {#if inspecting}<h3>{inspecting.fileName}</h3>
                  {#if active.albumId}<a
                      href={Route.viewAlbumAsset({ albumId: active.albumId, assetId: inspecting.id })}
                      >Open photo and editor</a
                    >{/if}{#if versionsLoading}<p role="status">Loading saved versions…</p>{:else if versionError}<p
                      role="alert"
                    >
                      {versionError}
                    </p>
                    <Button onclick={() => inspect(inspecting!)}>Retry versions</Button>{:else if versions}<h3>
                      Saved versions
                    </h3>
                    {#if versions.revisions.length === 0}<p>
                        No saved develop versions yet.
                      </p>{/if}{#each versions.revisions as version (version.revision)}<p>
                        {version.label ?? `Version ${version.revision}`} · {version.status}{version.isCurrent
                          ? ' · Current'
                          : ''}
                      </p>{/each}{/if}{/if}
                <p class="phw-small">
                  Star your favourites, reject the rest, then open the editor. Approve a saved version in Selections &
                  delivery before publishing it.
                </p>
              </div>
            </aside>
          </div>{/if}
      {:else if !error}
        <div class="phd-metrics">
          <div>
            <strong>{workspace.shoots.filter((shoot) => shoot.stage !== 'Delivered').length}</strong><span
              >Active projects</span
            >
          </div>
          <div>
            <strong>{workspace.shoots.filter((shoot) => shoot.stage === 'Proofing').length}</strong><span
              >In proofing</span
            >
          </div>
          <div>
            <strong>{workspace.shoots.filter((shoot) => shoot.stage === 'Edited').length}</strong><span
              >Edited projects</span
            >
          </div>
          <div>
            <strong>{workspace.shoots.filter((shoot) => shoot.stage === 'Delivered').length}</strong><span
              >Delivered</span
            >
          </div>
        </div>
        {#if summaryError}<p class="phw-small" role="status">
            {summaryError}
            <Button disabled={loading} onclick={reload}>Refresh</Button>
          </p>{:else if workflowSummaries.length}
          <div class="phd-metrics">
            <div>
              <strong>{workflowSummaries.reduce((total, row) => total + row.submittedRounds, 0)}</strong><span
                >Selection rounds received</span
              >
            </div>
            <div>
              <strong>{workflowSummaries.reduce((total, row) => total + row.unpaidOrders, 0)}</strong><span
                >Orders awaiting payment</span
              >
            </div>
            <div>
              <strong>{workflowSummaries.reduce((total, row) => total + (row.pendingEdits ?? 0), 0)}</strong><span
                >Photographs awaiting editing</span
              >
            </div>
            <div>
              <strong>{workflowSummaries.reduce((total, row) => total + row.readyCount, 0)}</strong><span
                >Prepared deliveries</span
              >
            </div>
            <div>
              <strong>{workflowSummaries.filter((row) => row.published).length}</strong><span
                >Published collections</span
              >
            </div>
          </div>
        {/if}
        <div class="phw-tabs phd-project-filters" aria-label="Project status">
          {#each ['All projects', 'Active', 'Proofing', 'Delivered'] as label (label)}<button
              type="button"
              aria-pressed={projectFilter === label}
              onclick={() => (projectFilter = label)}>{label}</button
            >{/each}
        </div>
        <div class="phw-list-tools">
          <label class="phw-search"
            ><Icon icon={mdiMagnify} size="1.2rem" /><input
              aria-label="Search projects"
              placeholder="Search projects or clients"
              bind:value={search}
            /></label
          ><select aria-label="Sort shoots" bind:value={sort}
            ><option value="date">Newest first</option><option value="name">Shoot name</option></select
          ><span>{listing.length} projects</span>
        </div>
        <div class="phw-shoot-grid">
          {#each listing as shoot (shoot.id)}{@const summary = workflowSummaries.find(
              (row) => row.shootId === shoot.id,
            )}<button type="button" class="phw-shoot-card" onclick={() => openShoot(shoot.id)}
              ><div class="phw-shoot-image">
                {#if shoot.coverAssetId}<img
                    src={cover(shoot.coverAssetId)}
                    alt={shoot.name}
                    loading="lazy"
                  />{:else}<Icon icon={mdiCameraOutline} size="3rem" />{/if}<span class="phw-status"
                  >{shoot.unavailable ? 'Unavailable' : shoot.stage}</span
                >
              </div>
              <div class="phw-shoot-text">
                <strong>{shoot.name}</strong><span>{shoot.client}</span>
                {#if summary}<small class="phw-small"
                    >{summary.submittedRounds} selection {summary.submittedRounds === 1 ? 'round' : 'rounds'} · {summary.unpaidOrders}
                    unpaid {summary.unpaidOrders === 1 ? 'order' : 'orders'} · {summary.pendingEdits ?? 0} awaiting editing{#if summary.selectionDeadline}
                      · Selections due {new Date(summary.selectionDeadline).toLocaleDateString($locale)}{/if}</small
                  >{/if}
                <footer>
                  <time datetime={shoot.date}>{dateLabel(shoot.date)}</time><span
                    >{shoot.assetCount ?? '—'} photos <Icon icon={mdiChevronRight} size="0.875rem" /></span
                  >
                </footer>
              </div></button
            >{/each}
        </div>
        {#if listing.length === 0}<div class="phw-empty">
            <Icon icon={mdiCameraOutline} size="2rem" />
            <h2>{workspace.shoots.length > 0 ? 'No shoots match that search' : 'Your shoots start here'}</h2>
            <p>
              {workspace.shoots.length > 0
                ? 'Try a client name, or start a new shoot.'
                : 'Link an album you own to keep the shoot and its client details together.'}
            </p>
            {#if search}<Button onclick={() => (search = '')}>Clear search</Button>{/if}
          </div>{/if}
        <div class="phw-list-footer">One place to cull, edit, proof and deliver.</div>
      {/if}
    </main>
  </div>
  <Dialog title="Compare photographs" closeLabel="Close comparison" bind:open={compareOpen} wide>
    <div class="phd-owner-compare">
      {#each photos.filter((photo) => selected.includes(photo.id)).slice(0, 2) as photo (photo.id)}
        <figure>
          <img src={getAssetMediaUrl({ id: photo.id, size: AssetMediaSize.Preview })} alt={photo.fileName} />
          <figcaption>
            {photo.fileName}{#if active?.albumId}<a
                href={Route.viewAlbumAsset({ albumId: active.albumId, assetId: photo.id })}>Open photo and editor</a
              >{/if}
          </figcaption>
        </figure>
      {/each}
    </div>
  </Dialog>

  <Dialog
    title="New shoot"
    closeLabel="Close new shoot"
    bind:open={newOpen}
    onRequestClose={() => {
      if (!busy) {
        newOpen = false;
      }
    }}
  >
    <form class="phw-new-shoot" onsubmit={create}>
      <label class="phw-field"
        ><span>Shoot name</span><input
          required
          data-initial-focus
          maxlength="200"
          bind:value={draft.name}
          disabled={busy}
        /></label
      >
      <label class="phw-field"
        ><span>Client</span><input required maxlength="200" bind:value={draft.client} disabled={busy} /></label
      >
      <label class="phw-field"
        ><span>Shoot type</span><select bind:value={draft.type} disabled={busy}
          >{#each shootTypes as type (type)}<option>{type}</option>{/each}</select
        ></label
      >
      <label class="phw-field"
        ><span>Shoot date</span><input required type="date" bind:value={draft.date} disabled={busy} /></label
      >
      <label class="phw-field"
        ><span>Source album</span><select required bind:value={draft.albumId} disabled={busy}
          ><option value="" disabled>Choose an album you own</option>{#each availableAlbums as album (album.id)}<option
              value={album.id}>{album.albumName}</option
            >{/each}</select
        ></label
      >
      <p class="phw-small">
        Photographs, ratings, stacks and saved edits stay in this album. Client and shoot details are private to you.
      </p>
      {#if availableAlbums.length === 0}<p>Create an album or choose one not already linked to a shoot.</p>
        <a href={Route.newAlbum({ kind: 'album' })}>Create album</a>{/if}
      {#if error}<p role="alert">{error}</p>{/if}
      <div class="phw-dialog-actions">
        <Button disabled={busy} onclick={() => (newOpen = false)}>Cancel</Button><Button
          type="submit"
          variant="primary"
          disabled={busy || !draft.albumId}>Create shoot</Button
        >
      </div>
    </form>
  </Dialog>
</div>
