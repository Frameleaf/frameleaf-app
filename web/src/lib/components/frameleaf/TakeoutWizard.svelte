<script lang="ts">
  import { goto } from '$app/navigation';
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { formatBytes } from '$lib/frameleaf/physical-dedup';
  import {
    canRetryScan,
    canReviewTakeout,
    collectPages,
    findStagedArchive,
    isTakeoutBusy,
    isTakeoutMoving,
    resumeTakeoutArchive,
    TAKEOUT_STAGES,
    takeoutImportOptions,
    takeoutItemStateKey,
    takeoutNeedsReview,
    takeoutPairStateKey,
    takeoutProgress,
    takeoutReportCsv,
    takeoutReportFileName,
    takeoutReportJson,
    takeoutSourcesStaged,
    takeoutStage,
    takeoutStateKey,
    TakeoutUploadError,
    takeoutWarningKey,
    type TakeoutArchiveProgress,
    type TakeoutStage,
  } from '$lib/frameleaf/takeout';
  import '$lib/frameleaf/tokens.css';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { downloadBlob } from '$lib/utils';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    controlTakeoutImport,
    createTakeoutArchive,
    createTakeoutImport,
    decideTakeoutPair,
    deleteTakeoutArchive,
    deleteTakeoutImport,
    getTakeoutImport,
    getTakeoutItems,
    getTakeoutPairs,
    getTakeoutRoots,
    resolveTakeoutItem,
    scanTakeoutImport,
    startTakeoutImport,
    TakeoutAction,
    TakeoutControlAction,
    TakeoutItemState,
    TakeoutPairState,
    TakeoutPhase,
    TakeoutSourceKind,
    TakeoutState,
    uploadTakeoutArchiveChunk,
    verifyTakeoutArchiveChunk,
    type TakeoutItemResponseDto,
    type TakeoutItemsResponseDto,
    type TakeoutPairResponseDto,
    type TakeoutResponseDto,
    type TakeoutRootDto,
  } from '@immich/sdk';
  import { onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The Google Photos import wizard (FL-65), ported from the prototype's `Import Google Photos`
   * workflow: the same title, the same three stages — Stage, Scan, Reconcile — the same facts
   * (Source, New assets, Matched originals, Needs review), and the same closing notice when flagged
   * items remain. Everything the prototype simulated is a server request here.
   *
   * Staging archives needs this page open; it resumes by checking every byte already on the server.
   * Scanning and importing are background jobs on the server, shown in Activity and the running-jobs
   * panel as well, and this page only watches them. Items going into Locked are never listed here
   * unless Locked is unlocked; the server only gives their number.
   */

  let {
    imports = [],
    current: initial,
  }: {
    imports?: TakeoutResponseDto[];
    current?: TakeoutResponseDto;
  } = $props();

  type ReconcileTab = 'review' | 'live-photos' | 'albums' | 'options' | 'report';
  const PAGE = 50;

  let current = $state<TakeoutResponseDto | undefined>(initial);
  let busy = $state(false);
  let error = $state('');
  let announcement = $state('');

  // Start
  let name = $state($t('frameleaf_takeout_default_name'));
  let source = $state('archives');
  let roots = $state<TakeoutRootDto[]>([]);
  let rootId = $state('');
  let folder = $state('');

  // Stage
  let upload = $state<TakeoutArchiveProgress>();
  let uploadController: AbortController | undefined;

  // Reconcile
  let viewing = $state<TakeoutStage | undefined>();
  let tab = $state<ReconcileTab>('review');
  let itemFilter = $state<string>(initial && initial.counts.review > 0 ? TakeoutItemState.Review : '');
  let offset = $state(0);
  let page = $state<TakeoutItemsResponseDto>({ items: [], total: 0, hiddenLocked: 0 });
  let sidecarChoice = $state<Record<string, string>>({});
  let pairs = $state<TakeoutPairResponseDto[]>([]);
  let pairOffset = $state(0);
  let pairTotal = $state(0);
  let options = $state<TakeoutResponseDto['options']>();
  let selectedAlbums = $state<Record<string, boolean>>({});
  let deleteOpen = $state(false);
  let loadGeneration = 0;

  const isAdmin = $derived(authManager.user.isAdmin);
  const serverStage = $derived(takeoutStage(current));
  const stage = $derived(viewing ?? serverStage);
  const stageIndex = $derived(TAKEOUT_STAGES.indexOf(stage));
  const busyJob = $derived(!!current && isTakeoutBusy(current.state));
  const reviewable = $derived(!!current && canReviewTakeout(current));
  const progress = $derived(current ? takeoutProgress(current) : undefined);
  const needsReview = $derived(current ? takeoutNeedsReview(current) : 0);
  const blocked = $derived(!!current && !!options?.sidecarReview && current.counts.review > 0);
  const pendingImport = $derived(
    !!current && current.counts.ready + current.counts.failed + current.counts.importing + current.counts.review > 0,
  );
  const zipSources = $derived(current?.sources.filter((item) => item.kind === TakeoutSourceKind.Zip) ?? []);
  const folderSource = $derived(current?.sources.find((item) => item.kind === TakeoutSourceKind.Directory));
  const staged = $derived(!!current && takeoutSourcesStaged(current.sources));

  const stageLabel: Record<TakeoutStage, string> = $derived({
    stage: $t('frameleaf_takeout_stage_stage'),
    scan: $t('frameleaf_takeout_stage_scan'),
    reconcile: $t('frameleaf_takeout_stage_reconcile'),
  });

  const sourceFact = $derived.by(() => {
    if (!current) {
      return '';
    }
    if (folderSource) {
      return $t('frameleaf_takeout_source_folder_value', { values: { name: folderSource.name } });
    }
    return $t('frameleaf_takeout_source_archives_count', { values: { count: zipSources.length } });
  });

  const counted = $derived(
    !!current && current.phase !== TakeoutPhase.Sources && current.phase !== TakeoutPhase.Scanning,
  );

  $effect(() => {
    if (!current || options) {
      return;
    }

    options = { ...current.options };
    selectedAlbums = Object.fromEntries(current.albums.map((album) => [album.folder, album.selected]));
  });

  const say = (message: string) => {
    announcement = message;
  };

  const messageOf = (failure: unknown) => {
    if (failure instanceof TakeoutUploadError) {
      return $t(failure.key);
    }
    return getServerErrorMessage(failure) ?? $t('frameleaf_takeout_error_generic');
  };

  /** Run a request; any failure is shown on the page, and the import is re-read from the server. */
  const run = async (action: () => Promise<unknown>) => {
    busy = true;
    error = '';
    try {
      await action();
    } catch (error_) {
      if (!(error_ instanceof DOMException && error_.name === 'AbortError')) {
        error = messageOf(error_);
      }
    } finally {
      busy = false;
    }
  };

  const refresh = async () => {
    if (!current) {
      return;
    }
    const id = current.id;
    const next = await getTakeoutImport({ id });
    if (current?.id === id) {
      const moved = next.phase !== current.phase;
      current = next;
      if (moved) {
        viewing = undefined;
        options = { ...next.options };
        selectedAlbums = Object.fromEntries(next.albums.map((album) => [album.folder, album.selected]));
        say($t(takeoutStateKey(next.state)));
      }
    }
  };

  const loadItems = async () => {
    if (!current) {
      return;
    }
    const request = ++loadGeneration;
    const result = await getTakeoutItems({
      id: current.id,
      offset,
      limit: PAGE,
      state: (itemFilter as TakeoutItemState) || undefined,
    });
    if (request === loadGeneration) {
      page = result;
      sidecarChoice = Object.fromEntries(result.items.map((item) => [item.id, item.sidecarId ?? '']));
    }
  };

  const loadPairs = async () => {
    if (!current) {
      return;
    }
    const id = current.id;
    const result = await getTakeoutPairs({ id, offset: pairOffset, limit: PAGE });
    if (current?.id === id) {
      pairs = result.pairs;
      pairTotal = result.total;
    }
  };

  $effect(() => {
    if (!current || stage !== 'reconcile' || busyJob) {
      return;
    }
    // Read again whenever the import itself changes on the server; paging and filters load on demand.
    void current.updatedAt;
    untrack(() => {
      void loadItems().catch(() => {});
      void loadPairs().catch(() => {});
    });
  });

  onMount(() => {
    if (isAdmin) {
      void getTakeoutRoots()
        .then((result) => {
          roots = result.roots;
          rootId = result.roots[0]?.id ?? '';
        })
        .catch(() => {});
    }
    const timer = setInterval(() => {
      if (!document.hidden && current && isTakeoutMoving(current.state)) {
        void refresh().catch(() => {});
      }
    }, 2500);
    const focus = () => void refresh().catch(() => {});
    window.addEventListener('focus', focus);
    return () => {
      clearInterval(timer);
      uploadController?.abort();
      window.removeEventListener('focus', focus);
    };
  });

  /* Start ------------------------------------------------------------- */

  const create = () =>
    run(async () => {
      const created = await createTakeoutImport({
        takeoutCreateDto: source === 'folder' ? { name, rootId, directory: folder.trim() } : { name },
      });
      // The page is keyed by the import, so this opens a fresh wizard on the new one.
      await goto(Route.takeout({ import: created.id }), { invalidateAll: true });
    });

  /* Stage ------------------------------------------------------------- */

  const uploadFiles = (files: FileList | null) =>
    run(async () => {
      if (!files?.length || !current) {
        return;
      }
      uploadController = new AbortController();
      const signal = uploadController.signal;
      const importId = current.id;
      try {
        for (const file of Array.from(files)) {
          signal.throwIfAborted();
          if (!file.name.toLowerCase().endsWith('.zip')) {
            throw new TakeoutUploadError('frameleaf_takeout_error_not_zip');
          }
          await refresh();
          const archive =
            findStagedArchive(current?.sources ?? [], file) ??
            (await createTakeoutArchive({
              id: importId,
              takeoutArchiveCreateDto: { name: file.name, size: file.size },
            }));
          await resumeTakeoutArchive(
            file,
            archive,
            {
              verify: (takeoutVerifyChunkDto) =>
                verifyTakeoutArchiveChunk({ id: importId, archiveId: archive.id, takeoutVerifyChunkDto }),
              upload: (chunkOffset, bytes) =>
                uploadTakeoutArchiveChunk(
                  { id: importId, archiveId: archive.id, offset: chunkOffset, body: bytes },
                  { headers: { 'Content-Type': 'application/octet-stream' }, signal },
                ),
            },
            signal,
            (value) => (upload = value),
          );
          await refresh();
        }
        say($t('frameleaf_takeout_upload_done'));
      } finally {
        uploadController = undefined;
        upload = undefined;
        await refresh().catch(() => {});
      }
    });

  const removeArchive = (archiveId: string) =>
    run(async () => {
      if (!current) {
        return;
      }
      await deleteTakeoutArchive({ id: current.id, archiveId });
      await refresh();
    });

  const scan = () =>
    run(async () => {
      if (!current) {
        return;
      }
      current = await scanTakeoutImport({ id: current.id });
      viewing = undefined;
      say($t(takeoutStateKey(current.state)));
    });

  /* Jobs -------------------------------------------------------------- */

  const control = (action: TakeoutControlAction) =>
    run(async () => {
      if (!current) {
        return;
      }
      current = await controlTakeoutImport({ id: current.id, takeoutControlDto: { action } });
      say($t(takeoutStateKey(current.state)));
    });

  /* Reconcile --------------------------------------------------------- */

  const resolve = (item: TakeoutItemResponseDto, decision: { skip?: boolean; useChoice?: boolean }) =>
    run(async () => {
      if (!current) {
        return;
      }
      const choice = sidecarChoice[item.id];
      current = await resolveTakeoutItem({
        id: current.id,
        itemId: item.id,
        takeoutResolveDto: decision.skip === undefined ? { sidecarId: choice || null } : { skip: decision.skip },
      });
      await loadItems();
    });

  const decidePair = (pair: TakeoutPairResponseDto, approve: boolean) =>
    run(async () => {
      if (!current) {
        return;
      }
      await decideTakeoutPair({
        id: current.id,
        takeoutPairDecisionDto: { photoItemId: pair.photoItemId, videoItemId: pair.videoItemId, approve },
      });
      await loadPairs();
      await refresh();
    });

  const startImport = () =>
    run(async () => {
      if (!current || !options) {
        return;
      }
      current = await startTakeoutImport({
        id: current.id,
        takeoutOptionsDto: takeoutImportOptions(
          options,
          current.albums.map((album) => ({ folder: album.folder, selected: selectedAlbums[album.folder] ?? false })),
        ),
      });
      viewing = undefined;
      say($t(takeoutStateKey(current.state)));
    });

  const download = (format: 'json' | 'csv') =>
    run(async () => {
      if (!current) {
        return;
      }
      const id = current.id;
      const items = await collectPages(async (from, limit) => {
        const result = await getTakeoutItems({ id, offset: from, limit });
        return { entries: result.items, total: result.total };
      });
      if (format === 'csv') {
        downloadBlob(new Blob([takeoutReportCsv(items)], { type: 'text/csv' }), takeoutReportFileName(current, 'csv'));
        return;
      }
      const livePhotos = await collectPages(async (from, limit) => {
        const result = await getTakeoutPairs({ id, offset: from, limit });
        return { entries: result.pairs, total: result.total };
      });
      downloadBlob(
        new Blob([takeoutReportJson(current, items, livePhotos, page.hiddenLocked)], { type: 'application/json' }),
        takeoutReportFileName(current, 'json'),
      );
    });

  const remove = () =>
    run(async () => {
      if (!current) {
        return;
      }
      await deleteTakeoutImport({ id: current.id });
      deleteOpen = false;
      await goto(Route.takeout(), { invalidateAll: true });
    });

  /* Footer ------------------------------------------------------------ */

  const primary = $derived.by((): { label: string; disabled: boolean; action: () => void } => {
    if (!current) {
      return { label: $t('frameleaf_takeout_continue'), disabled: busy || !name.trim(), action: () => void create() };
    }
    if (viewing && TAKEOUT_STAGES.indexOf(viewing) < TAKEOUT_STAGES.indexOf(serverStage)) {
      const next = TAKEOUT_STAGES[TAKEOUT_STAGES.indexOf(viewing) + 1];
      return {
        label: $t('frameleaf_takeout_continue'),
        disabled: false,
        action: () => (viewing = next === serverStage ? undefined : next),
      };
    }
    if (serverStage === 'stage') {
      return {
        label: $t('frameleaf_takeout_continue'),
        disabled: busy || !!upload || !staged,
        action: () => void scan(),
      };
    }
    if (serverStage === 'scan') {
      return canRetryScan(current)
        ? { label: $t('frameleaf_takeout_scan_again'), disabled: busy || !staged, action: () => void scan() }
        : { label: $t('frameleaf_takeout_continue'), disabled: true, action: () => {} };
    }
    if (current.state === TakeoutState.Completed && !pendingImport) {
      return { label: $t('frameleaf_takeout_done'), disabled: false, action: () => void goto(Route.takeout()) };
    }
    const label =
      current.state === TakeoutState.Failed || current.state === TakeoutState.Cancelled
        ? $t('frameleaf_takeout_import_again')
        : current.state === TakeoutState.Completed
          ? $t('frameleaf_takeout_import_remaining')
          : $t('frameleaf_takeout_import');
    return { label, disabled: busy || !reviewable || blocked, action: () => void startImport() };
  });

  const secondary = () => {
    if (!current) {
      history.back();
      return;
    }
    if (stageIndex === 0) {
      void goto(Route.takeout());
      return;
    }
    viewing = TAKEOUT_STAGES[stageIndex - 1];
  };

  const bytes = (value: number) => formatBytes(value);
  const counts = (value: number) => value.toLocaleString();
  const stepDone = (index: number) => !!current && index < TAKEOUT_STAGES.indexOf(serverStage);

  const importTone = (state: TakeoutState) => {
    if (state === TakeoutState.Failed) {
      return 'danger';
    }
    return state === TakeoutState.Completed ? 'teal' : 'neutral';
  };

  const itemTone = (state: TakeoutItemState) => {
    switch (state) {
      case TakeoutItemState.Failed: {
        return 'danger';
      }
      case TakeoutItemState.Review: {
        return 'warning';
      }
      case TakeoutItemState.Imported:
      case TakeoutItemState.Matched: {
        return 'teal';
      }
      default: {
        return 'neutral';
      }
    }
  };

  const PAUSABLE: readonly TakeoutState[] = [TakeoutState.Queued, TakeoutState.Scanning, TakeoutState.Importing];
  const canPause = $derived(!!current && PAUSABLE.includes(current.state));
  const canSkip = (item: TakeoutItemResponseDto) =>
    item.state === TakeoutItemState.Ready || item.state === TakeoutItemState.Failed;

  const progressText = $derived.by(() => {
    if (!current || !progress || progress.total === null) {
      return $t('frameleaf_takeout_waiting');
    }
    const key =
      current.action === TakeoutAction.Scan ? 'frameleaf_takeout_scan_progress' : 'frameleaf_takeout_import_progress';
    return $t(key, { values: { done: counts(progress.done), total: counts(progress.total) } });
  });

  const newAssetsFact = $derived(
    current && counted
      ? counts(current.counts.newAssets + current.counts.imported)
      : $t('frameleaf_takeout_not_counted'),
  );
</script>

<div class="fl-takeout">
  <header class="head">
    <div>
      <p class="eyebrow">{$t('frameleaf_settings_area_backup')}</p>
      <h1>{$t('frameleaf_takeout_title')}</h1>
      <p class="intro">{$t('frameleaf_takeout_intro')}</p>
    </div>
    {#if current}
      <a class="all" href={Route.takeout()}>{$t('frameleaf_takeout_all_imports')}</a>
    {/if}
  </header>

  <ol class="stepper" aria-label={$t('frameleaf_takeout_steps_label')}>
    {#each TAKEOUT_STAGES as item, index (item)}
      <li aria-current={stage === item ? 'step' : undefined} class:done={stepDone(index)}>
        <span>{index + 1}</span>{stageLabel[item]}
      </li>
    {/each}
  </ol>

  {#if error}
    <p class="alert" role="alert">{error}</p>
  {/if}
  <p class="sr-only" role="status" aria-live="polite">{announcement}</p>

  {#if !current}
    <section class="panel">
      <h2>{$t('frameleaf_takeout_start_heading')}</h2>
      <form
        class="form"
        onsubmit={(event) => {
          event.preventDefault();
          primary.action();
        }}
      >
        <label>
          {$t('frameleaf_takeout_name_label')}
          <input bind:value={name} required maxlength="200" />
        </label>
        {#if isAdmin}
          <SegmentedControl
            label={$t('frameleaf_takeout_source_label')}
            options={[
              { value: 'archives', label: $t('frameleaf_takeout_source_archives') },
              { value: 'folder', label: $t('frameleaf_takeout_source_folder') },
            ]}
            bind:value={source}
          />
        {/if}
        {#if source === 'folder'}
          {#if roots.length === 0}
            <p class="note">{$t('frameleaf_takeout_no_roots')}</p>
          {:else}
            <label>
              {$t('frameleaf_takeout_root_label')}
              <select bind:value={rootId}>
                {#each roots as root (root.id)}
                  <option value={root.id}>{root.path}</option>
                {/each}
              </select>
            </label>
            <label>
              {$t('frameleaf_takeout_folder_label')}
              <input bind:value={folder} maxlength="4096" placeholder="Takeout" />
            </label>
            <p class="note">{$t('frameleaf_takeout_folder_help')}</p>
          {/if}
        {:else}
          <p class="note">{$t('frameleaf_takeout_archives_help')}</p>
        {/if}
      </form>
    </section>

    <section class="panel">
      <h2>{$t('frameleaf_takeout_previous_heading')}</h2>
      {#if imports.length === 0}
        <p class="note">{$t('frameleaf_takeout_previous_empty')}</p>
      {:else}
        <ul class="imports">
          {#each imports as entry (entry.id)}
            <li>
              <a href={Route.takeout({ import: entry.id })}>
                <span class="import-name">{entry.name}</span>
                <span class="meta">
                  {$t('frameleaf_takeout_import_summary', {
                    values: {
                      imported: entry.counts.imported,
                      matched: entry.counts.matched,
                      items: entry.counts.items,
                    },
                  })}
                </span>
              </a>
              <Badge
                value={$t(takeoutStateKey(entry.state))}
                label={$t(takeoutStateKey(entry.state))}
                tone={importTone(entry.state)}
              />
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {:else}
    <dl class="facts">
      <dt>{$t('frameleaf_takeout_fact_source')}</dt>
      <dd>{sourceFact}</dd>
      <dt>{$t('frameleaf_takeout_fact_new')}</dt>
      <dd>{newAssetsFact}</dd>
      <dt>{$t('frameleaf_takeout_fact_matched')}</dt>
      <dd>
        {counted
          ? $t('frameleaf_takeout_matched_value', { values: { count: counts(current.counts.matchedOriginals) } })
          : $t('frameleaf_takeout_not_counted')}
      </dd>
      <dt>{$t('frameleaf_takeout_fact_review')}</dt>
      <dd>
        {#if !counted}
          {$t('frameleaf_takeout_not_counted')}
        {:else if needsReview === 0}
          {$t('frameleaf_takeout_review_none')}
        {:else}
          {$t('frameleaf_takeout_review_value', {
            values: { sidecars: current.counts.review, pairs: current.counts.suggestedPairs },
          })}
        {/if}
      </dd>
    </dl>

    {#if current.counts.hiddenLocked > 0}
      <p class="note locked">
        {$t('frameleaf_takeout_hidden_locked', { values: { count: current.counts.hiddenLocked } })}
      </p>
    {/if}
    {#if current.counts.rejected > 0}
      <p class="note">{$t('frameleaf_takeout_rejected_entries', { values: { count: current.counts.rejected } })}</p>
    {/if}

    {#if busyJob || current.state === TakeoutState.Failed || current.state === TakeoutState.Cancelled}
      <section class="panel job" aria-live="polite">
        <div class="job-head">
          <h2>{$t(takeoutStateKey(current.state))}</h2>
          <div class="actions">
            {#if current.state === TakeoutState.Paused}
              <Button disabled={busy} onclick={() => control(TakeoutControlAction.Resume)}>
                {$t('frameleaf_takeout_resume')}
              </Button>
            {:else if canPause}
              <Button disabled={busy} onclick={() => control(TakeoutControlAction.Pause)}>
                {$t('frameleaf_takeout_pause')}
              </Button>
            {/if}
            {#if busyJob && current.state !== TakeoutState.Cancelling}
              <Button variant="quiet" disabled={busy} onclick={() => control(TakeoutControlAction.Cancel)}>
                {$t('frameleaf_takeout_stop')}
              </Button>
            {/if}
            <a class="link" href={Route.activity({ filter: 'running' })}>{$t('frameleaf_takeout_open_activity')}</a>
          </div>
        </div>
        {#if busyJob && progress}
          <progress max="100" value={progress.percent ?? undefined} aria-label={$t('frameleaf_takeout_progress_label')}
          ></progress>
          <p class="meta">{progressText}</p>
          <p class="note">{$t('frameleaf_takeout_background_note')}</p>
        {/if}
        {#if current.error && (current.state === TakeoutState.Failed || current.state === TakeoutState.Cancelled)}
          <p class="alert">{current.error}</p>
        {/if}
      </section>
    {/if}

    {#if stage === 'stage'}
      <section class="panel">
        <h2>{$t('frameleaf_takeout_stage_heading')}</h2>
        {#if folderSource}
          <p>{$t('frameleaf_takeout_source_folder_value', { values: { name: folderSource.name } })}</p>
        {/if}
        {#if zipSources.length > 0}
          <ul class="archives">
            {#each zipSources as archive (archive.id)}
              <li>
                <div class="archive-head">
                  <span class="import-name">{archive.name}</span>
                  <span class="meta">
                    {$t('frameleaf_takeout_archive_progress', {
                      values: { received: bytes(archive.received), size: bytes(archive.size) },
                    })}
                  </span>
                  {#if (serverStage === 'stage' || canRetryScan(current)) && !upload}
                    <Button
                      variant="quiet"
                      disabled={busy}
                      label={$t('frameleaf_takeout_archive_remove', { values: { name: archive.name } })}
                      onclick={() => removeArchive(archive.id)}
                    >
                      {$t('frameleaf_takeout_remove')}
                    </Button>
                  {/if}
                </div>
                <progress
                  max={Math.max(archive.size, 1)}
                  value={archive.received}
                  aria-label={$t('frameleaf_takeout_archive_progress_label', { values: { name: archive.name } })}
                ></progress>
              </li>
            {/each}
          </ul>
        {/if}
        {#if serverStage === 'stage' || canRetryScan(current)}
          {#if !folderSource}
            <label class="file">
              <span>{$t('frameleaf_takeout_choose_archives')}</span>
              <input
                type="file"
                accept=".zip,application/zip"
                multiple
                disabled={busy}
                onchange={(event) => {
                  void uploadFiles(event.currentTarget.files);
                  event.currentTarget.value = '';
                }}
              />
            </label>
          {/if}
          {#if upload}
            <div class="upload" role="status">
              <p>
                {$t(upload.phase === 'verifying' ? 'frameleaf_takeout_verifying' : 'frameleaf_takeout_uploading', {
                  values: { name: upload.name },
                })}
              </p>
              <progress max={Math.max(upload.total, 1)} value={upload.bytes}></progress>
              <Button onclick={() => uploadController?.abort()}>{$t('frameleaf_takeout_pause_upload')}</Button>
            </div>
          {/if}
          <p class="note">{$t('frameleaf_takeout_keep_open')}</p>
        {/if}
      </section>
    {:else if stage === 'scan'}
      <section class="panel">
        <h2>{$t('frameleaf_takeout_scan_heading')}</h2>
        <p>{$t('frameleaf_takeout_scan_help')}</p>
        {#if serverStage !== 'scan'}
          <p class="meta">
            {$t('frameleaf_takeout_scan_summary', {
              values: { files: counts(current.counts.files), items: counts(current.counts.items) },
            })}
          </p>
        {/if}
      </section>
    {:else}
      <section class="panel">
        <SegmentedControl
          label={$t('frameleaf_takeout_tabs_label')}
          options={[
            { value: 'review', label: $t('frameleaf_takeout_tab_review'), hint: String(current.counts.review) },
            {
              value: 'live-photos',
              label: $t('frameleaf_takeout_tab_live_photos'),
              hint: String(current.counts.suggestedPairs),
            },
            { value: 'albums', label: $t('frameleaf_takeout_tab_albums') },
            { value: 'options', label: $t('frameleaf_takeout_tab_options') },
            { value: 'report', label: $t('frameleaf_takeout_tab_report') },
          ]}
          value={tab}
          onChange={(value) => (tab = value as ReconcileTab)}
        />

        {#if tab === 'review'}
          <div class="toolbar">
            <label>
              {$t('frameleaf_takeout_filter_label')}
              <select
                bind:value={itemFilter}
                onchange={() => {
                  offset = 0;
                  void run(loadItems);
                }}
              >
                <option value="">{$t('frameleaf_takeout_filter_all')}</option>
                {#each Object.values(TakeoutItemState) as state (state)}
                  <option value={state}>{$t(takeoutItemStateKey(state))}</option>
                {/each}
              </select>
            </label>
          </div>
          {#if page.hiddenLocked > 0}
            <p class="note locked">{$t('frameleaf_takeout_hidden_locked', { values: { count: page.hiddenLocked } })}</p>
          {/if}
          {#if page.items.length === 0}
            <p class="note">{$t('frameleaf_takeout_items_empty')}</p>
          {:else}
            <ul class="items">
              {#each page.items as item (item.id)}
                <li>
                  <div class="item-head">
                    <span class="import-name">{item.path}</span>
                    <Badge
                      value={$t(takeoutItemStateKey(item.state))}
                      label={$t(takeoutItemStateKey(item.state))}
                      tone={itemTone(item.state)}
                    />
                  </div>
                  <p class="meta">
                    {item.source}{#if item.metadata.takenAt}
                      · {new Date(item.metadata.takenAt).toLocaleString()}{/if}{#if item.albums.length > 0}
                      · {item.albums.join(', ')}{/if}
                  </p>
                  {#if item.metadata.description}
                    <p class="description">{item.metadata.description}</p>
                  {/if}
                  {#each item.warnings as warning (warning)}
                    <p class="warning">{$t(takeoutWarningKey(warning))}</p>
                  {/each}
                  {#if item.error}
                    <p class="alert">{item.error}</p>
                  {/if}
                  {#if reviewable && item.state === TakeoutItemState.Review}
                    <div class="decision">
                      <label>
                        {$t('frameleaf_takeout_sidecar_label')}
                        <select bind:value={sidecarChoice[item.id]}>
                          <option value="">{$t('frameleaf_takeout_sidecar_none')}</option>
                          {#each item.candidates as candidate (candidate.id)}
                            <option value={candidate.id}>
                              {candidate.path}{candidate.metadata.takenAt
                                ? ` · ${new Date(candidate.metadata.takenAt).toLocaleString()}`
                                : ''}{candidate.metadata.description
                                ? ` · ${candidate.metadata.description.slice(0, 80)}`
                                : ''}
                            </option>
                          {/each}
                        </select>
                      </label>
                      <Button variant="primary" disabled={busy} onclick={() => resolve(item, { useChoice: true })}>
                        {$t('frameleaf_takeout_use_choice')}
                      </Button>
                      <Button disabled={busy} onclick={() => resolve(item, { skip: true })}>
                        {$t('frameleaf_takeout_skip')}
                      </Button>
                    </div>
                  {:else if reviewable && canSkip(item)}
                    <div class="decision">
                      <Button variant="quiet" disabled={busy} onclick={() => resolve(item, { skip: true })}>
                        {$t('frameleaf_takeout_skip')}
                      </Button>
                    </div>
                  {:else if reviewable && item.state === TakeoutItemState.Skipped}
                    <div class="decision">
                      <Button disabled={busy} onclick={() => resolve(item, { skip: false })}>
                        {$t('frameleaf_takeout_include')}
                      </Button>
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
          <div class="pager">
            <Button
              disabled={busy || offset === 0}
              onclick={() => {
                offset = Math.max(0, offset - PAGE);
                void run(loadItems);
              }}
            >
              {$t('frameleaf_takeout_previous')}
            </Button>
            <span class="meta">
              {$t('frameleaf_takeout_page_range', {
                values: {
                  from: page.total === 0 ? 0 : offset + 1,
                  to: Math.min(offset + PAGE, page.total),
                  total: page.total,
                },
              })}
            </span>
            <Button
              disabled={busy || offset + PAGE >= page.total}
              onclick={() => {
                offset += PAGE;
                void run(loadItems);
              }}
            >
              {$t('frameleaf_takeout_next')}
            </Button>
          </div>
        {:else if tab === 'live-photos'}
          <p class="note">{$t('frameleaf_takeout_pair_reason')}</p>
          {#if pairs.length === 0}
            <p class="note">{$t('frameleaf_takeout_pairs_empty')}</p>
          {:else}
            <ul class="items">
              {#each pairs as pair (`${pair.photoItemId}:${pair.videoItemId}`)}
                <li>
                  <div class="item-head">
                    <span class="import-name">{pair.photoPath}</span>
                    <Badge
                      value={$t(takeoutPairStateKey(pair.state))}
                      label={$t(takeoutPairStateKey(pair.state))}
                      tone="neutral"
                    />
                  </div>
                  <p class="meta">{pair.videoPath}</p>
                  {#if pair.error}
                    <p class="alert">{pair.error}</p>
                  {/if}
                  {#if reviewable && pair.state !== TakeoutPairState.Linked}
                    <div class="decision">
                      <Button
                        variant={pair.state === TakeoutPairState.Approved ? 'default' : 'primary'}
                        pressed={pair.state === TakeoutPairState.Approved}
                        disabled={busy}
                        onclick={() => decidePair(pair, true)}
                      >
                        {$t('frameleaf_takeout_pair_link')}
                      </Button>
                      <Button
                        pressed={pair.state === TakeoutPairState.Skipped}
                        disabled={busy}
                        onclick={() => decidePair(pair, false)}
                      >
                        {$t('frameleaf_takeout_pair_separate')}
                      </Button>
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
          <div class="pager">
            <Button
              disabled={busy || pairOffset === 0}
              onclick={() => {
                pairOffset = Math.max(0, pairOffset - PAGE);
                void run(loadPairs);
              }}
            >
              {$t('frameleaf_takeout_previous')}
            </Button>
            <span class="meta">
              {$t('frameleaf_takeout_page_range', {
                values: {
                  from: pairTotal === 0 ? 0 : pairOffset + 1,
                  to: Math.min(pairOffset + PAGE, pairTotal),
                  total: pairTotal,
                },
              })}
            </span>
            <Button
              disabled={busy || pairOffset + PAGE >= pairTotal}
              onclick={() => {
                pairOffset += PAGE;
                void run(loadPairs);
              }}
            >
              {$t('frameleaf_takeout_next')}
            </Button>
          </div>
        {:else if tab === 'albums'}
          <p class="note">{$t('frameleaf_takeout_albums_help')}</p>
          {#if current.albums.length === 0}
            <p class="note">{$t('frameleaf_takeout_albums_empty')}</p>
          {:else}
            <ul class="albums">
              {#each current.albums as album (album.folder)}
                <li>
                  <label>
                    <input
                      type="checkbox"
                      bind:checked={selectedAlbums[album.folder]}
                      disabled={!reviewable || !options?.albums}
                    />
                    <span class="import-name">{album.name}</span>
                    <span class="meta">
                      {$t('frameleaf_takeout_album_count', { values: { count: album.count } })}{#if album.year}
                        · {$t('frameleaf_takeout_album_year')}{/if}
                    </span>
                  </label>
                </li>
              {/each}
            </ul>
          {/if}
        {:else if tab === 'options' && options}
          <SettingToggle
            title={$t('frameleaf_takeout_option_albums')}
            subtitle={$t('frameleaf_takeout_option_albums_help')}
            bind:checked={options.albums}
            disabled={!reviewable}
          />
          <SettingToggle
            title={$t('frameleaf_takeout_option_sidecar_review')}
            subtitle={$t('frameleaf_takeout_option_sidecar_review_help')}
            bind:checked={options.sidecarReview}
            disabled={!reviewable}
          />
          <SettingToggle
            title={$t('frameleaf_takeout_option_dates')}
            bind:checked={options.dates}
            disabled={!reviewable}
          />
          <SettingToggle
            title={$t('frameleaf_takeout_option_locations')}
            bind:checked={options.locations}
            disabled={!reviewable}
          />
          <SettingToggle
            title={$t('frameleaf_takeout_option_descriptions')}
            bind:checked={options.descriptions}
            disabled={!reviewable}
          />
          <SettingToggle
            title={$t('frameleaf_takeout_option_favorites')}
            bind:checked={options.favorites}
            disabled={!reviewable}
          />
          <SettingToggle
            title={$t('frameleaf_takeout_option_archive')}
            bind:checked={options.archive}
            disabled={!reviewable}
          />
          <SettingToggle
            title={$t('frameleaf_takeout_option_matched')}
            subtitle={$t('frameleaf_takeout_option_matched_help')}
            bind:checked={options.updateMatchedMetadata}
            disabled={!reviewable}
          />
          <p class="note">{$t('frameleaf_takeout_locked_note')}</p>
        {:else if tab === 'report'}
          <dl class="report">
            <dt>{$t('frameleaf_takeout_item_imported')}</dt>
            <dd>{counts(current.counts.imported)}</dd>
            <dt>{$t('frameleaf_takeout_item_matched')}</dt>
            <dd>{counts(current.counts.matched)}</dd>
            <dt>{$t('frameleaf_takeout_item_skipped')}</dt>
            <dd>{counts(current.counts.skipped)}</dd>
            <dt>{$t('frameleaf_takeout_report_unresolved')}</dt>
            <dd>{counts(current.counts.review + current.counts.unresolvedPairs)}</dd>
            <dt>{$t('frameleaf_takeout_item_failed')}</dt>
            <dd>{counts(current.counts.failed)}</dd>
          </dl>
          <div class="actions">
            <Button disabled={busy} onclick={() => download('json')}>{$t('frameleaf_takeout_download_json')}</Button>
            <Button disabled={busy} onclick={() => download('csv')}>{$t('frameleaf_takeout_download_csv')}</Button>
          </div>
        {/if}
      </section>

      {#if reviewable && blocked}
        <p class="notice">{$t('frameleaf_takeout_flagged_notice')}</p>
      {:else if current.state === TakeoutState.Completed && !pendingImport}
        <p class="notice done">{$t('frameleaf_takeout_completed_notice')}</p>
      {/if}
    {/if}
  {/if}

  <footer class="footer">
    {#if current && !busyJob}
      <Button variant="quiet" disabled={busy} onclick={() => (deleteOpen = true)}>
        {$t('frameleaf_takeout_delete')}
      </Button>
    {/if}
    <span class="spacer"></span>
    <Button onclick={secondary}>
      {stageIndex === 0 || !current ? $t('frameleaf_takeout_cancel') : $t('frameleaf_takeout_back')}
    </Button>
    <Button variant="primary" disabled={primary.disabled} onclick={primary.action}>{primary.label}</Button>
  </footer>
</div>

<Dialog title={$t('frameleaf_takeout_delete_confirm_title')} closeLabel={$t('cancel')} bind:open={deleteOpen}>
  <p>{$t('frameleaf_takeout_delete_confirm_body')}</p>
  <div class="dialog-actions">
    <Button onclick={() => (deleteOpen = false)}>{$t('cancel')}</Button>
    <Button variant="primary" disabled={busy} onclick={remove}>{$t('frameleaf_takeout_delete_confirm')}</Button>
  </div>
</Dialog>

<style>
  .fl-takeout {
    display: grid;
    gap: 1rem;
    max-width: 60rem;
    margin-inline: auto;
    padding: 1.5rem 1rem 5rem;
    color: var(--fl-text);
    font-size: var(--fl-font-size);
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 1rem;
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
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  .intro,
  .meta,
  .note {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .intro {
    margin-top: 0.25rem;
    font-size: var(--fl-font-size);
  }
  .all,
  .link {
    color: var(--fl-text);
    font-size: var(--fl-font-small);
    text-decoration: underline;
  }
  .stepper {
    display: flex;
    flex-wrap: wrap;
    gap: 1.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .stepper li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .stepper li > span {
    display: grid;
    place-items: center;
    width: 1.375rem;
    height: 1.375rem;
    border: 1px solid var(--fl-border);
    border-radius: 50%;
    background: var(--fl-raised);
    font-size: 0.6875rem;
  }
  .stepper li[aria-current] {
    color: var(--fl-text);
  }
  .stepper li[aria-current] > span {
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .stepper li.done > span {
    border-color: var(--fl-teal, var(--fl-border));
  }
  .facts,
  .report {
    display: grid;
    grid-template-columns: 8.125rem 1fr;
    gap: 0.75rem 1rem;
    margin: 0.5rem 0;
  }
  .facts dt,
  .report dt {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .facts dd,
  .report dd {
    margin: 0;
    font-size: var(--fl-font-small);
    line-height: 1.7;
  }
  .panel {
    display: grid;
    gap: 0.875rem;
    padding: 1rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-panel-radius);
    background: var(--fl-surface, var(--fl-raised));
  }
  .form {
    display: grid;
    gap: 0.875rem;
  }
  label {
    display: grid;
    gap: 0.375rem;
    font-size: var(--fl-font-small);
  }
  input:not([type='checkbox'], [type='file']),
  select {
    min-width: 0;
    padding: 0.4375rem 0.625rem;
    color: var(--fl-text);
    background: var(--fl-canvas);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .file input {
    color: var(--fl-muted);
  }
  .alert {
    margin: 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--fl-danger, var(--fl-border));
    border-radius: var(--fl-radius-control);
    color: var(--fl-text);
    font-size: var(--fl-font-small);
  }
  .warning {
    margin: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-warning, var(--fl-muted));
  }
  .notice {
    margin: 0;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    font-size: var(--fl-font-small);
  }
  .locked {
    padding-left: 0.5rem;
    border-left: 2px solid var(--fl-border);
  }
  .job-head,
  .item-head,
  .archive-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .actions,
  .decision,
  .pager,
  .dialog-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .decision label {
    flex: 1 1 16rem;
  }
  .pager {
    justify-content: space-between;
  }
  .dialog-actions {
    justify-content: flex-end;
    margin-top: 1rem;
  }
  progress {
    width: 100%;
    height: 0.375rem;
    accent-color: var(--fl-accent);
  }
  .imports,
  .archives,
  .items,
  .albums {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .imports li,
  .archives li,
  .items li {
    display: grid;
    gap: 0.375rem;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .imports li {
    grid-template-columns: 1fr auto;
    align-items: center;
  }
  .imports a {
    display: grid;
    gap: 0.125rem;
    color: inherit;
    text-decoration: none;
  }
  .import-name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .description {
    margin: 0;
    font-size: var(--fl-font-small);
  }
  .albums label {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .toolbar {
    display: flex;
    justify-content: flex-end;
  }
  .footer {
    position: sticky;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 0;
    background: var(--fl-canvas);
    border-top: 1px solid var(--fl-border);
  }
  .spacer {
    flex: 1;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  @media (max-width: 40rem) {
    .facts,
    .report {
      grid-template-columns: 1fr;
      gap: 0.25rem;
    }
    .facts dd,
    .report dd {
      margin-bottom: 0.5rem;
    }
  }
</style>
