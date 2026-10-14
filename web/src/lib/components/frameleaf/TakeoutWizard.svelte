<script lang="ts" module>
  /**
   * Files chosen on the start screen, handed to the wizard that opens on the new import: creating the
   * import moves the hosting dialog to it, which mounts a fresh wizard.
   */
  let handoff: { id: string; files: File[] } | undefined;
</script>

<script lang="ts">
  import { goto } from '$app/navigation';
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { formatBytes } from '$lib/frameleaf/physical-dedup';
  import {
    collectPages,
    findStagedArchive,
    isTakeoutMoving,
    resumeTakeoutArchive,
    takeoutImportOptions,
    takeoutProgress,
    takeoutReportCsv,
    takeoutReportFileName,
    takeoutSourcesStaged,
    takeoutStateKey,
    takeoutStep,
    TakeoutUploadError,
    takeoutView,
    type TakeoutArchiveProgress,
  } from '$lib/frameleaf/takeout';
  import '$lib/frameleaf/tokens.css';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { downloadBlob } from '$lib/utils';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    controlTakeoutImport,
    createTakeoutArchive,
    createTakeoutImport,
    deleteTakeoutImport,
    getTakeoutImport,
    getBaseUrl,
    getTakeoutItems,
    getTakeoutPairs,
    getTakeoutRoots,
    resolveTakeoutItem,
    scanTakeoutImport,
    startTakeoutImport,
    TakeoutControlAction,
    TakeoutItemState,
    TakeoutPairState,
    TakeoutSourceKind,
    TakeoutState,
    uploadTakeoutArchiveChunk,
    verifyTakeoutArchiveChunk,
    type TakeoutItemResponseDto,
    type TakeoutResponseDto,
    type TakeoutRootDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiCheck, mdiImageOffOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * One Google Photos import (FL-65), approved as the prototype's Google Photos import flow
   * (frameleaf-prototype `settings-v2/library/google-import.jsx`): Upload → Check → Import, moving on
   * by itself so the owner chooses the ZIP files and presses Import once. It is the body of a wide
   * Command Center dialog (FL-83, `TakeoutSettingsSection`), which carries the title.
   *
   * Only the upload needs this page open; it resumes by checking every byte already on the server.
   * Checking and importing are background jobs on the server, so every later screen says a large
   * library can be left and come back to. Items going into Locked are never listed here unless Locked
   * is unlocked; the server only gives their number.
   */

  let {
    imports = [],
    current: initial,
    onClose,
  }: {
    imports?: TakeoutResponseDto[];
    current?: TakeoutResponseDto;
    /** Closes the Command Center dialog that hosts the wizard. */
    onClose?: () => void;
  } = $props();

  /**
   * Moves the hosting dialog to another import, or to the start. The host reads the import from the
   * address and loads it from the server, so the page's own data is never reloaded.
   */
  const openImport = (id?: string) => goto(Route.takeout(id ? { import: id } : undefined), { reset: false });
  const close = () => (onClose ? onClose() : history.back());

  const SHOWN = 50;

  let current = $state<TakeoutResponseDto | undefined>(initial);
  let busy = $state(false);
  let error = $state('');
  let announcement = $state('');
  let fileInput = $state<HTMLInputElement>();

  // Start
  let roots = $state<TakeoutRootDto[]>([]);
  let rootId = $state('');
  let folder = $state('');

  // Upload
  let upload = $state<TakeoutArchiveProgress>();
  let uploadStarted = $state<{ at: number; bytes: number }>();
  let uploadController: AbortController | undefined;

  // Ready
  let options = $state<TakeoutResponseDto['options']>();
  let selectedAlbums = $state<Record<string, boolean>>({});
  let livePhotos = $state(0);
  let trashed = $state(0);

  // Photos to check, and what did not make it
  let unclear = $state<TakeoutItemResponseDto[]>([]);
  let choices = $state<Record<string, string>>({});
  let noPreview = $state<Record<string, boolean>>({});
  let failed = $state<TakeoutItemResponseDto[]>([]);
  let cancelOpen = $state(false);

  const isAdmin = $derived(authManager.user.isAdmin);
  const view = $derived(takeoutView(current, !!upload));
  const step = $derived(takeoutStep(view));
  const fromFolder = $derived(current?.sources.some((source) => source.kind === TakeoutSourceKind.Directory) ?? false);
  const zips = $derived(current?.sources.filter((source) => source.kind === TakeoutSourceKind.Zip) ?? []);
  const progress = $derived(current ? takeoutProgress(current) : undefined);
  const albumCount = $derived(current?.albums.filter((album) => selectedAlbums[album.folder]).length ?? 0);
  const toImport = $derived(current ? current.counts.newAssets + (options?.includeTrashed ? trashed : 0) : 0);

  /** Bytes on the server, counting the archive this page is sending right now as it goes. */
  const uploaded = $derived(
    zips.reduce(
      (total, zip) => total + (upload?.phase === 'uploading' && upload.name === zip.name ? upload.bytes : zip.received),
      0,
    ),
  );
  const uploadSize = $derived(zips.reduce((total, zip) => total + zip.size, 0));
  const zipsDone = $derived(zips.filter((zip) => zip.received === zip.size).length);
  const minutesLeft = $derived.by(() => {
    if (!uploadStarted || upload?.phase !== 'uploading') {
      return;
    }
    const seconds = (Date.now() - uploadStarted.at) / 1000;
    const rate = (uploaded - uploadStarted.bytes) / seconds;
    return seconds > 5 && rate > 0 ? Math.max(1, Math.round((uploadSize - uploaded) / rate / 60)) : undefined;
  });

  const stepLabels = $derived([
    fromFolder ? $t('frameleaf_takeout_step_folder') : $t('frameleaf_takeout_step_upload'),
    $t('frameleaf_takeout_step_check'),
    $t('frameleaf_takeout_step_import'),
  ]);

  const counts = (value: number) => value.toLocaleString($locale);
  const bytes = (value: number) => formatBytes(value);
  const say = (message: string) => (announcement = message);

  const messageOf = (failure: unknown) =>
    failure instanceof TakeoutUploadError
      ? $t(failure.key)
      : (getServerErrorMessage(failure) ?? $t('frameleaf_takeout_error_generic'));

  /** Run a request; any failure is shown on the page. */
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

  const adopt = (next: TakeoutResponseDto) => {
    const moved = !current || next.state !== current.state || next.phase !== current.phase;
    current = next;
    if (moved || !options) {
      options = { ...next.options };
      selectedAlbums = Object.fromEntries(next.albums.map((album) => [album.folder, album.selected]));
    }
    if (moved) {
      say($t(takeoutStateKey(next.state)));
    }
  };

  const refresh = async () => {
    if (!current) {
      return;
    }

    const id = current.id;
    const next = await getTakeoutImport({ id });
    if (current?.id === id) {
      adopt(next);
    }
  };

  /** What each screen needs beyond the import itself. */
  const loadDetails = async () => {
    if (!current) {
      return;
    }
    const id = current.id;
    switch (view) {
      case 'ready': {
        const [pairs, skipped] = await Promise.all([
          getTakeoutPairs({ id, state: TakeoutPairState.Approved, limit: 1 }),
          getTakeoutItems({ id, state: TakeoutItemState.Skipped, limit: 1 }),
        ]);
        livePhotos = pairs.total;
        trashed = skipped.total;

        break;
      }
      case 'unclear': {
        const page = await getTakeoutItems({ id, state: TakeoutItemState.Review, limit: SHOWN });
        unclear = page.items;
        choices = Object.fromEntries(page.items.map((item) => [item.id, item.sidecarId ?? '']));

        break;
      }
      case 'done': {
        const [pairs, page] = await Promise.all([
          getTakeoutPairs({ id, state: TakeoutPairState.Linked, limit: 1 }),
          getTakeoutItems({ id, state: TakeoutItemState.Failed, limit: SHOWN }),
        ]);
        livePhotos = pairs.total;
        failed = page.items;

        break;
      }
      // No default
    }
  };

  $effect(() => {
    void view;
    void current?.updatedAt;
    void loadDetails().catch(() => {});
  });

  if (initial) {
    adopt(initial);
  }

  onMount(() => {
    if (isAdmin) {
      void getTakeoutRoots()
        .then((result) => {
          roots = result.roots;
          rootId = result.roots[0]?.id ?? '';
        })
        .catch(() => {});
    }
    if (current && handoff?.id === current.id) {
      const { files } = handoff;
      handoff = undefined;
      void uploadFiles(files);
    } else if (current && view === 'upload' && takeoutSourcesStaged(current.sources)) {
      // Everything arrived but the check never started (the page closed in between).
      void check();
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

  const defaultName = () =>
    $t('frameleaf_takeout_default_name', {
      values: { date: new Date().toLocaleDateString($locale, { day: 'numeric', month: 'long' }) },
    });

  /* Start ------------------------------------------------------------- */

  const chooseFiles = () => fileInput?.click();

  const filesChosen = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (files.length === 0) {
      return;
    }
    if (current) {
      void uploadFiles(files);
      return;
    }
    void run(async () => {
      const created = await createTakeoutImport({ takeoutCreateDto: { name: defaultName() } });
      handoff = { id: created.id, files };
      // The host is keyed by the import, so this opens a fresh wizard on the new one.
      await openImport(created.id);
    });
  };

  const importFolder = () =>
    run(async () => {
      const created = await createTakeoutImport({
        takeoutCreateDto: { name: defaultName(), rootId, directory: folder.trim() },
      });
      await scanTakeoutImport({ id: created.id });
      await openImport(created.id);
    });

  /* Upload, then check ------------------------------------------------ */

  const check = () =>
    run(async () => {
      if (current) {
        adopt(await scanTakeoutImport({ id: current.id }));
      }
    });

  const uploadFiles = (files: File[]) =>
    run(async () => {
      if (!current) {
        return;
      }
      uploadController = new AbortController();
      const signal = uploadController.signal;
      const importId = current.id;
      try {
        for (const file of files) {
          signal.throwIfAborted();
          if (!file.name.toLowerCase().endsWith('.zip')) {
            throw new TakeoutUploadError('frameleaf_takeout_error_not_zip');
          }
          await refresh();
          uploadStarted ??= { at: Date.now(), bytes: uploaded };
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
              upload: (chunkOffset, chunk) =>
                uploadTakeoutArchiveChunk(
                  { id: importId, archiveId: archive.id, offset: chunkOffset, body: chunk },
                  { headers: { 'Content-Type': 'application/octet-stream' }, signal },
                ),
            },
            signal,
            (value) => (upload = value),
          );
          await refresh();
        }
      } finally {
        uploadController = undefined;
        upload = undefined;
        uploadStarted = undefined;
        await refresh().catch(() => {});
      }
      // Every file is in: the check starts by itself.
      if (current && takeoutSourcesStaged(current.sources)) {
        say($t('frameleaf_takeout_upload_done'));
        adopt(await scanTakeoutImport({ id: current.id }));
      }
    });

  /* Import ------------------------------------------------------------ */

  const startImport = (overrides: Partial<TakeoutResponseDto['options']> = {}) =>
    run(async () => {
      if (!current || !options) {
        return;
      }
      adopt(
        await startTakeoutImport({
          id: current.id,
          takeoutOptionsDto: takeoutImportOptions(
            { ...options, ...overrides },
            current.albums.map((album) => ({ folder: album.folder, selected: selectedAlbums[album.folder] ?? false })),
          ),
        }),
      );
    });

  const control = (action: TakeoutControlAction) =>
    run(async () => {
      if (current) {
        adopt(await controlTakeoutImport({ id: current.id, takeoutControlDto: { action } }));
      }
    });

  /** The photos the owner chose details for; the rest import with the most likely ones. */
  const addUnclear = () =>
    run(async () => {
      if (!current) {
        return;
      }
      for (const item of unclear) {
        const choice = choices[item.id];
        if (choice && choice !== item.sidecarId) {
          await resolveTakeoutItem({ id: current.id, itemId: item.id, takeoutResolveDto: { sidecarId: choice } });
        }
      }
      await startImport({ sidecarReview: false });
    });

  const download = () =>
    run(async () => {
      if (!current) {
        return;
      }
      const id = current.id;
      const items = await collectPages(async (from, limit) => {
        const result = await getTakeoutItems({ id, offset: from, limit });
        return { entries: result.items, total: result.total };
      });
      downloadBlob(new Blob([takeoutReportCsv(items)], { type: 'text/csv' }), takeoutReportFileName(current, 'csv'));
    });

  const cancelImport = () =>
    run(async () => {
      if (!current) {
        return;
      }
      uploadController?.abort();
      await deleteTakeoutImport({ id: current.id });
      cancelOpen = false;
      await openImport();
    });

  /* Words ------------------------------------------------------------- */

  const takenAt = (value?: string | null) =>
    value
      ? $t('frameleaf_takeout_candidate_taken', {
          values: { date: new Date(value).toLocaleString($locale, { dateStyle: 'long', timeStyle: 'short' }) },
        })
      : $t('frameleaf_takeout_candidate_no_date');

  const candidateDetail = (metadata: TakeoutItemResponseDto['metadata']) =>
    [
      metadata.description
        ? $t('frameleaf_takeout_candidate_description', { values: { text: metadata.description.slice(0, 80) } })
        : $t('frameleaf_takeout_candidate_no_description'),
      metadata.latitude === undefined || metadata.latitude === null
        ? $t('frameleaf_takeout_candidate_no_place')
        : $t('frameleaf_takeout_candidate_place'),
    ].join(' · ');

  /** The staged photo, made small by the server; the browser's sign-in cookie authorises it. */
  const previewUrl = (item: TakeoutItemResponseDto) =>
    `${getBaseUrl()}/takeout/${current?.id}/items/${item.id}/preview`;

  const importTone = (state: TakeoutState) => {
    if (state === TakeoutState.Failed) {
      return 'danger';
    }
    return state === TakeoutState.Completed ? 'teal' : 'neutral';
  };
</script>

{#snippet leaveNote(uploading: boolean)}
  <div class="note-box" role="note">
    <strong>
      {uploading ? $t('frameleaf_takeout_keep_open_title') : $t('frameleaf_takeout_leave_title')}
    </strong>
    <p>{uploading ? $t('frameleaf_takeout_keep_open_body') : $t('frameleaf_takeout_leave_body')}</p>
  </div>
{/snippet}

{#snippet bar(label: string, done: number, total: number, text: string, note?: string)}
  <div class="bar">
    <p>
      <strong>{text}</strong>{#if note}<span> · {note}</span>{/if}
    </p>
    <progress aria-label={label} max={Math.max(total, 1)} value={done}></progress>
  </div>
{/snippet}

<div class="fl-takeout">
  <!-- The hosting dialog carries the title. -->
  <ol class="stepper" aria-label={$t('frameleaf_takeout_steps_label')}>
    {#each stepLabels as label, index (index)}
      <li aria-current={index === step ? 'step' : undefined} class:done={index < step}>
        <span aria-hidden="true">
          {#if index < step}<Icon icon={mdiCheck} size="14" />{:else}{index + 1}{/if}
        </span>{label}
      </li>
    {/each}
  </ol>

  <input
    bind:this={fileInput}
    class="sr-only"
    type="file"
    accept=".zip,application/zip"
    multiple
    tabindex="-1"
    aria-hidden="true"
    onchange={(event) => {
      filesChosen(event.currentTarget.files);
      event.currentTarget.value = '';
    }}
  />

  {#if error}
    <p class="alert" role="alert">{error}</p>
  {/if}
  <p class="sr-only" role="status" aria-live="polite">{announcement}</p>

  {#if view === 'start'}
    <ol class="intro">
      <li>
        <strong>{$t('frameleaf_takeout_step_upload')}</strong>{$t('frameleaf_takeout_start_step_upload')}
      </li>
      <li><strong>{$t('frameleaf_takeout_step_check')}</strong>{$t('frameleaf_takeout_start_step_check')}</li>
      <li>
        <strong>{$t('frameleaf_takeout_step_import')}</strong>{$t('frameleaf_takeout_start_step_import')}
      </li>
    </ol>
    <div class="note-box warn" role="note">
      <strong>{$t('frameleaf_takeout_all_files_title')}</strong>
      <p>{$t('frameleaf_takeout_all_files_body')}</p>
    </div>

    {#if isAdmin}
      <details class="more">
        <summary>{$t('frameleaf_takeout_folder_summary')}</summary>
        {#if roots.length === 0}
          <p class="muted">{$t('frameleaf_takeout_no_roots')}</p>
        {:else}
          <p class="muted">{$t('frameleaf_takeout_folder_help')}</p>
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
          <div>
            <Button disabled={busy || !rootId} onclick={importFolder}>{$t('frameleaf_takeout_import_folder')}</Button>
          </div>
        {/if}
      </details>
    {/if}

    <section class="imports">
      <h2>{$t('frameleaf_takeout_previous_heading')}</h2>
      {#if imports.length === 0}
        <p class="muted">{$t('frameleaf_takeout_previous_empty')}</p>
      {:else}
        <ul>
          {#each imports as entry (entry.id)}
            <li>
              <a href={Route.takeout({ import: entry.id })}>
                <strong>{entry.name}</strong>
                <span class="muted">
                  {$t('frameleaf_takeout_import_summary', {
                    values: { imported: entry.counts.imported, matched: entry.counts.matched },
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
  {:else if current && (view === 'upload' || view === 'stopped')}
    {#if view === 'stopped'}
      <div class="note-box warn" role="status">
        <strong>
          {$t('frameleaf_takeout_stopped_title', { values: { done: zipsDone, total: zips.length } })}
        </strong>
        <p>{$t('frameleaf_takeout_stopped_body')}</p>
      </div>
    {/if}
    {#if zips.length > 0}
      {@render bar(
        $t('frameleaf_takeout_upload_label'),
        uploaded,
        uploadSize,
        $t('frameleaf_takeout_uploaded', { values: { done: bytes(uploaded), total: bytes(uploadSize) } }),
        upload?.phase === 'verifying'
          ? $t('frameleaf_takeout_verifying', { values: { name: upload.name } })
          : minutesLeft === undefined
            ? undefined
            : $t('frameleaf_takeout_minutes_left', { values: { count: minutesLeft } }),
      )}
    {:else}
      <p>{$t('frameleaf_takeout_archives_help')}</p>
    {/if}
    {@render leaveNote(true)}
    {#if zips.length > 0}
      <details class="more">
        <summary>{$t('frameleaf_takeout_files_count', { values: { count: zips.length } })}</summary>
        <ul class="files">
          {#each zips as zip (zip.id)}
            <li>
              <span class="name">{zip.name}</span>
              <span class="muted">
                {zip.received === zip.size
                  ? $t('frameleaf_takeout_file_uploaded')
                  : $t('frameleaf_takeout_archive_progress', {
                      values: { received: bytes(zip.received), size: bytes(zip.size) },
                    })}
              </span>
            </li>
          {/each}
        </ul>
      </details>
    {/if}
  {:else if current && view === 'checking'}
    {@render bar(
      $t('frameleaf_takeout_check_label'),
      progress?.done ?? 0,
      progress?.total ?? 0,
      progress?.total
        ? $t('frameleaf_takeout_scan_progress', {
            values: { done: counts(progress.done), total: counts(progress.total) },
          })
        : $t('frameleaf_takeout_waiting'),
      $t('frameleaf_takeout_check_note'),
    )}
    {@render leaveNote(false)}
  {:else if current && view === 'check-failed'}
    <div class="note-box warn" role="status">
      <strong>{$t('frameleaf_takeout_check_failed_title')}</strong>
      <p>{current.error ?? $t('frameleaf_takeout_error_generic')}</p>
    </div>
  {:else if current && view === 'ready' && options}
    <dl class="facts">
      <div>
        <dt>{$t('frameleaf_takeout_fact_new')}</dt>
        <dd>{counts(toImport)}<small>{$t('frameleaf_takeout_fact_new_detail')}</small></dd>
      </div>
      <div>
        <dt>{$t('frameleaf_takeout_fact_already')}</dt>
        <dd>
          {counts(current.counts.matchedOriginals)}<small>
            {options.albums
              ? $t('frameleaf_takeout_fact_already_detail')
              : $t('frameleaf_takeout_fact_already_skipped')}
          </small>
        </dd>
      </div>
      <div>
        <dt>{$t('frameleaf_takeout_fact_albums')}</dt>
        <dd>
          {options.albums ? counts(albumCount) : $t('frameleaf_takeout_fact_albums_none')}<small>
            {$t('frameleaf_takeout_fact_albums_detail')}
          </small>
        </dd>
      </div>
      <div>
        <dt>{$t('frameleaf_takeout_fact_live')}</dt>
        <dd>{counts(livePhotos)}<small>{$t('frameleaf_takeout_fact_live_detail')}</small></dd>
      </div>
    </dl>

    <div class="choices">
      <SettingToggle
        title={$t('frameleaf_takeout_option_albums')}
        subtitle={options.albums ? $t('frameleaf_takeout_option_albums_on') : $t('frameleaf_takeout_option_albums_off')}
        bind:checked={options.albums}
      />
      {#if options.albums && current.albums.length > 0}
        <details class="more">
          <summary>
            {$t('frameleaf_takeout_choose_albums', { values: { selected: albumCount, total: current.albums.length } })}
          </summary>
          <ul class="albums">
            {#each current.albums as album (album.folder)}
              <li>
                <label>
                  <input type="checkbox" bind:checked={selectedAlbums[album.folder]} />
                  <span class="name">{album.name}</span>
                  <span class="muted">{$t('frameleaf_takeout_album_count', { values: { count: album.count } })}</span>
                </label>
              </li>
            {/each}
          </ul>
          <p class="muted">{$t('frameleaf_takeout_year_folders')}</p>
        </details>
      {/if}
      <SettingToggle
        title={$t('frameleaf_takeout_option_matched')}
        subtitle={$t('frameleaf_takeout_option_matched_help')}
        bind:checked={options.updateMatchedMetadata}
      />
      {#if current.counts.review > 0}
        <SettingToggle
          title={$t('frameleaf_takeout_unclear_title', { values: { count: current.counts.review } })}
          subtitle={options.sidecarReview
            ? $t('frameleaf_takeout_option_unclear_on')
            : $t('frameleaf_takeout_option_unclear_off')}
          bind:checked={options.sidecarReview}
        />
      {/if}
      {#if trashed > 0}
        <label class="tick">
          <input type="checkbox" bind:checked={options.includeTrashed} />
          <span>
            <strong>{$t('frameleaf_takeout_option_trash', { values: { count: trashed } })}</strong>
            <small>{$t('frameleaf_takeout_option_trash_help')}</small>
          </span>
        </label>
      {/if}
    </div>

    {#if current.counts.hiddenLocked > 0}
      <p class="muted">{$t('frameleaf_takeout_locked_count', { values: { count: current.counts.hiddenLocked } })}</p>
    {/if}
    {@render leaveNote(false)}
  {:else if current && view === 'importing'}
    {@render bar(
      $t('frameleaf_takeout_import_label'),
      progress?.done ?? 0,
      progress?.total ?? 0,
      progress?.total
        ? $t('frameleaf_takeout_import_progress', {
            values: { done: counts(progress.done), total: counts(progress.total) },
          })
        : $t('frameleaf_takeout_waiting'),
      current.state === TakeoutState.Paused ? $t('frameleaf_takeout_state_paused') : undefined,
    )}
    {@render leaveNote(false)}
  {:else if current && view === 'unclear'}
    <div class="note-box warn" role="status">
      <strong>
        {$t('frameleaf_takeout_unclear_heading', {
          values: { done: current.counts.imported + current.counts.matched, count: current.counts.review },
        })}
      </strong>
      <p>{$t('frameleaf_takeout_unclear_body')}</p>
    </div>
    {#each unclear as item (item.id)}
      <fieldset class="unclear">
        <legend>
          {#if noPreview[item.id]}
            <span class="preview none" aria-hidden="true"><Icon icon={mdiImageOffOutline} size="24" /></span>
          {:else}
            <img class="preview" src={previewUrl(item)} alt="" onerror={() => (noPreview[item.id] = true)} />
          {/if}
          <span class="name">{item.path}</span>
        </legend>
        {#each item.candidates as candidate (candidate.id)}
          <label class="candidate" class:on={choices[item.id] === candidate.id}>
            <input type="radio" name={item.id} value={candidate.id} bind:group={choices[item.id]} />
            <span>
              <strong>{takenAt(candidate.metadata.takenAt)}</strong>
              <small>{candidateDetail(candidate.metadata)}</small>
            </span>
          </label>
        {/each}
      </fieldset>
    {/each}
    {#if current.counts.review > unclear.length}
      <p class="muted">
        {$t('frameleaf_takeout_unclear_more', { values: { count: current.counts.review - unclear.length } })}
      </p>
    {/if}
    {#if current.counts.hiddenLocked > 0}
      <p class="muted">{$t('frameleaf_takeout_locked_count', { values: { count: current.counts.hiddenLocked } })}</p>
    {/if}
  {:else if current && view === 'done'}
    {#if current.state === TakeoutState.Completed}
      <div class="note-box good" role="status">
        <strong>{$t('frameleaf_takeout_done_title', { values: { count: current.counts.imported } })}</strong>
        <p>
          {$t('frameleaf_takeout_done_body', {
            values: { matched: current.counts.matched, albums: albumCount, live: livePhotos },
          })}
        </p>
      </div>
    {:else}
      <div class="note-box warn" role="status">
        <strong>{$t('frameleaf_takeout_stopped_import_title')}</strong>
        <p>{current.error ?? $t('frameleaf_takeout_stopped_import_body')}</p>
        {#if current.counts.failed === 0}
          <div>
            <Button disabled={busy} onclick={() => startImport()}>{$t('frameleaf_takeout_try_again')}</Button>
          </div>
        {/if}
      </div>
    {/if}
    {#if current.counts.failed > 0}
      <section class="failed">
        <div class="failed-head">
          <h2>{$t('frameleaf_takeout_failed_heading', { values: { count: current.counts.failed } })}</h2>
          <Button disabled={busy} onclick={() => startImport()}>{$t('frameleaf_takeout_try_again')}</Button>
        </div>
        <ul class="files">
          {#each failed as item (item.id)}
            <li>
              <span class="name">{item.path}</span>
              <span class="muted">{item.error ?? $t('frameleaf_takeout_error_generic')}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}

  <footer class="footer">
    {#if view === 'start'}
      <Button onclick={close}>{$t('frameleaf_takeout_cancel')}</Button>
      <Button variant="primary" disabled={busy} onclick={chooseFiles}>{$t('frameleaf_takeout_choose_zips')}</Button>
    {:else if view === 'upload' && upload}
      <Button onclick={() => (cancelOpen = true)}>{$t('frameleaf_takeout_cancel_import')}</Button>
      <Button onclick={() => uploadController?.abort()}>{$t('frameleaf_takeout_pause_upload')}</Button>
    {:else if view === 'upload' || view === 'stopped'}
      <Button disabled={busy} onclick={() => (cancelOpen = true)}>{$t('frameleaf_takeout_cancel_import')}</Button>
      {#if !fromFolder}
        <Button variant="primary" disabled={busy} onclick={chooseFiles}>{$t('frameleaf_takeout_choose_zips')}</Button>
      {/if}
    {:else if view === 'checking'}
      <Button variant="primary" onclick={close}>{$t('frameleaf_takeout_close')}</Button>
    {:else if view === 'check-failed'}
      <Button disabled={busy} onclick={() => (cancelOpen = true)}>{$t('frameleaf_takeout_cancel_import')}</Button>
      <Button variant="primary" disabled={busy} onclick={check}>{$t('frameleaf_takeout_check_again')}</Button>
    {:else if view === 'ready'}
      <Button disabled={busy} onclick={() => (cancelOpen = true)}>{$t('frameleaf_takeout_cancel_import')}</Button>
      <Button variant="primary" disabled={busy} onclick={() => startImport()}>
        {$t('frameleaf_takeout_import_count', { values: { count: toImport } })}
      </Button>
    {:else if view === 'importing'}
      {#if current?.state === TakeoutState.Paused}
        <Button disabled={busy} onclick={() => control(TakeoutControlAction.Resume)}>
          {$t('frameleaf_takeout_resume')}
        </Button>
      {:else}
        <Button
          disabled={busy || current?.state === TakeoutState.Cancelling}
          onclick={() => control(TakeoutControlAction.Pause)}
        >
          {$t('frameleaf_takeout_pause')}
        </Button>
      {/if}
      <Button variant="primary" onclick={close}>{$t('frameleaf_takeout_close')}</Button>
    {:else if view === 'unclear'}
      <Button onclick={close}>{$t('frameleaf_takeout_later')}</Button>
      <Button variant="primary" disabled={busy} onclick={addUnclear}>
        {$t('frameleaf_takeout_add_count', { values: { count: current?.counts.review ?? 0 } })}
      </Button>
    {:else}
      <Button disabled={busy} onclick={download}>{$t('frameleaf_takeout_download_report')}</Button>
      <Button variant="primary" onclick={close}>{$t('frameleaf_takeout_done')}</Button>
    {/if}
  </footer>
</div>

<Dialog title={$t('frameleaf_takeout_cancel_confirm_title')} closeLabel={$t('cancel')} bind:open={cancelOpen}>
  <p>{$t('frameleaf_takeout_cancel_confirm_body')}</p>
  <div class="dialog-actions">
    <Button onclick={() => (cancelOpen = false)}>{$t('frameleaf_takeout_keep_going')}</Button>
    <Button variant="danger" disabled={busy} onclick={cancelImport}>{$t('frameleaf_takeout_cancel_import')}</Button>
  </div>
</Dialog>

<style>
  .fl-takeout {
    display: grid;
    gap: 1.5rem;
    color: var(--fl-text);
    font-size: var(--fl-font-size);
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  p {
    margin: 0;
  }
  .muted,
  small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
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
    color: var(--fl-teal);
    border-color: var(--fl-teal);
  }
  .intro {
    display: grid;
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .intro li {
    display: grid;
    gap: 0.25rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
  }
  .bar {
    display: grid;
    gap: 0.5rem;
  }
  .bar span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  progress {
    width: 100%;
    height: 0.375rem;
    accent-color: var(--fl-accent);
  }
  .note-box {
    display: grid;
    gap: 0.375rem;
    padding: 1rem 1.25rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
  }
  .note-box p {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .note-box.warn {
    border-color: var(--fl-warning);
  }
  .note-box.good {
    border-color: var(--fl-teal);
  }
  .alert {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--fl-danger);
    border-radius: var(--fl-radius-control);
    font-size: var(--fl-font-small);
  }
  .more {
    display: grid;
    gap: 0.75rem;
  }
  .more summary {
    cursor: pointer;
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .more[open] > :not(summary) {
    margin-top: 0.75rem;
  }
  label {
    display: grid;
    gap: 0.5rem;
    font-size: var(--fl-font-small);
  }
  input:not([type='checkbox'], [type='radio'], [type='file']),
  select {
    min-width: 0;
    padding: 0.4375rem 0.75rem;
    color: var(--fl-text);
    background: var(--fl-canvas);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .imports {
    display: grid;
    gap: 0.75rem;
  }
  .imports ul,
  .files,
  .albums {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .imports li {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .imports a {
    display: grid;
    gap: 0.25rem;
    color: inherit;
    text-decoration: none;
  }
  .files li {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.5rem 1rem;
    font-size: var(--fl-font-small);
  }
  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .albums label {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 1rem 1.5rem;
    margin: 0;
  }
  .facts dt {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .facts dd {
    display: grid;
    gap: 0.25rem;
    margin: 0.25rem 0 0;
    font-size: 1.125rem;
    font-weight: 600;
  }
  .facts small {
    font-weight: 400;
  }
  .choices {
    display: grid;
    gap: 0.75rem;
  }
  .tick {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }
  .tick span {
    display: grid;
    gap: 0.25rem;
  }
  .unclear {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    border: 0;
  }
  .unclear legend {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
  }
  .preview {
    flex: none;
    width: 4.5rem;
    height: 4.5rem;
    border-radius: var(--fl-radius-control);
    object-fit: cover;
    background: var(--fl-raised);
  }
  .preview.none {
    display: grid;
    place-items: center;
    color: var(--fl-muted);
  }
  .candidate {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    cursor: pointer;
  }
  .candidate.on {
    border-color: var(--fl-accent);
  }
  .candidate span {
    display: grid;
    gap: 0.25rem;
  }
  .failed {
    display: grid;
    gap: 0.75rem;
  }
  .failed-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .footer {
    position: sticky;
    bottom: 0;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.75rem 0 0;
    background: var(--fl-panel);
    border-top: 1px solid var(--fl-border);
  }
  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
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
