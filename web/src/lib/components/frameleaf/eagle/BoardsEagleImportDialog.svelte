<script module lang="ts">
  import type { EaglePlan, EagleLibrary } from '$lib/frameleaf/eagle/eagle-import';
  import type { EagleImportRun } from '$lib/frameleaf/eagle/eagle-import-run.svelte';

  /**
   * The import in this tab. It lives outside the component, so Hide closes the dialog and the
   * import carries on; opening the dialog again shows where it is.
   */
  interface ImportSession {
    /** The account that started it: another account never sees or carries on this import. */
    ownerId: string;
    library: EagleLibrary;
    plan: EaglePlan;
    supported: ReadonlySet<string>;
    run: EagleImportRun;
    /** When this run started and how many items were already done then, for the time left. */
    startedAt: number;
    startDone: number;
  }
  let session: ImportSession | undefined;
</script>

<script lang="ts">
  import { goto } from '$app/navigation';
  import AlbumDestinationPicker from '$lib/components/frameleaf/AlbumDestinationPicker.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import EagleNamedList from '$lib/components/frameleaf/eagle/EagleNamedList.svelte';
  import { EAGLE_ANNOTATIONS_AVAILABLE } from '$lib/frameleaf/eagle/eagle-annotations';
  import {
    EAGLE_DEFAULT_COLLECTION,
    eagleImportKey,
    importResult,
    isComing,
    planEagleImport,
    previewTarget,
    reconciles,
    repeatedContents,
    supportedExtensions,
    type EagleTarget,
  } from '$lib/frameleaf/eagle/eagle-import';
  import { frameleafEagleImportApi } from '$lib/frameleaf/eagle/eagle-import-api';
  import { eagleImportStore, type EagleImportSaved } from '$lib/frameleaf/eagle/eagle-import-record';
  import { EagleImportRun as Run, isSameLibrary } from '$lib/frameleaf/eagle/eagle-import-run.svelte';
  import { eagleImportUi, eaglePercent } from '$lib/frameleaf/eagle/eagle-import-status.svelte';
  import {
    EagleLibraryError,
    directoryPicker,
    entriesFromDirectory,
    entriesFromFileList,
    readEagleLibrary,
    type LibraryEntry,
  } from '$lib/frameleaf/eagle/eagle-library-reader';
  import { workspaceHref } from '$lib/frameleaf/search-context';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { uploadManager } from '$lib/managers/upload-manager.svelte';
  import { Route } from '$lib/route';
  import { hashUploadFile, type UploadChecksums } from '$lib/utils/file-uploader';
  import {
    AssetUploadAction,
    LibraryViewScope,
    checkBulkUpload,
    getAllAlbums,
    type AlbumResponseDto,
  } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import {
    mdiAlertOutline,
    mdiCheck,
    mdiCheckCircleOutline,
    mdiCheckDecagramOutline,
    mdiDrawPen,
    mdiFileTreeOutline,
    mdiFolderArrowDownOutline,
    mdiFolderHomeOutline,
    mdiFolderMultipleOutline,
    mdiFolderOpenOutline,
    mdiFolderPlusOutline,
    mdiFolderZipOutline,
    mdiImageMultipleOutline,
    mdiInboxOutline,
    mdiLaptop,
    mdiNoteTextOutline,
    mdiPaletteOutline,
    mdiServerNetwork,
    mdiStarOutline,
    mdiTabRemove,
    mdiTagOutline,
    mdiTrayArrowUp,
  } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  /**
   * Import from Eagle (FL-653; approved prototype `BoardsEagleImport.jsx`, README points 35-41):
   * Choose, Check, Where, Import, with Stop, the finish report and the stopped report. The library
   * is read in this browser and its files are sent through the ordinary upload path, so files
   * already in the library are recognised and not stored twice. The Eagle library is only read.
   *
   * A library in a folder the server can open is not offered yet: the server has no way to read an
   * Eagle library, so that choice is shown and disabled.
   */
  type Step = 'pick' | 'summary' | 'target' | 'progress' | 'stop' | 'report' | 'stopped';

  const store = eagleImportStore();
  const ownerId = authManager.authenticated ? authManager.user.id : '';
  // An import started by another account (signed out, then someone else signed in) is stopped and
  // forgotten here: its library, plan and record are never shown to, or continued by, this account.
  if (session && session.ownerId !== ownerId) {
    session.run.stop();
    session = undefined;
    eagleImportUi.run = undefined;
  }
  const number = (value: number) => value.toLocaleString($locale ?? undefined);

  /** Opening the dialog again shows the import where it is. */
  const initialStep = (): Step => {
    const state = session?.run.state;
    return state === 'finished' ? 'report' : state === 'stopped' ? 'stopped' : state ? 'progress' : 'pick';
  };

  let step = $state<Step>(initialStep());
  let library = $state<EagleLibrary | undefined>(session?.library);
  let plan = $state<EaglePlan | undefined>(session?.plan);
  let run = $state<EagleImportRun | undefined>(session?.run);
  let saved = $state<EagleImportSaved | undefined>();
  let paused = $state<EagleImportSaved | undefined>();
  let reading = $state(false);
  let readError = $state<'not-library' | 'unreadable' | undefined>();
  let checking = $state<{ done: number; total: number } | undefined>();
  let checkFailed = $state(false);
  let albums = $state<AlbumResponseDto[]>([]);
  let albumsFailed = $state(false);
  let target = $state<{ mode: 'inside' | 'top'; inside: string }>({ mode: 'inside', inside: 'new' });
  let picker: HTMLInputElement | undefined = $state();
  let checksums = new Map<string, UploadChecksums>();
  let controller: AbortController | undefined;
  let now = $state(Date.now());

  const supported = supportedExtensions(uploadManager.getExtensions());

  // An import the tab left part-way, so the first step can say to choose that library again.
  if (!run && ownerId) {
    void store
      .unfinished(ownerId)
      .then((records) => (paused = records.find(({ record }) => record.status === 'running')))
      .catch(() => undefined);
  }

  const clock = setInterval(() => (now = Date.now()), 5000);
  onDestroy(() => {
    clearInterval(clock);
    controller?.abort();
  });

  const close = () => {
    // Closing once the import has finished or stopped ends it here; while it runs, closing hides it.
    if (run && (run.state === 'finished' || run.state === 'stopped')) {
      session = undefined;
      eagleImportUi.run = undefined;
    }
    eagleImportUi.open = false;
  };

  /* Choose ------------------------------------------------------------ */

  const load = async (name: string, entries: LibraryEntry[]) => {
    reading = true;
    readError = undefined;
    library = undefined;
    plan = undefined;
    try {
      library = await readEagleLibrary(name, entries);
    } catch (error) {
      readError = error instanceof EagleLibraryError ? error.reason : 'unreadable';
    } finally {
      reading = false;
    }
  };

  const choose = async () => {
    const pick = directoryPicker();
    if (!pick) {
      picker?.click();
      return;
    }
    try {
      const handle = await pick({ id: 'frameleaf-eagle', mode: 'read' });
      reading = true;
      const { name, entries } = await entriesFromDirectory(handle);
      await load(name, entries);
    } catch (error) {
      reading = false;
      if ((error as DOMException)?.name !== 'AbortError') {
        readError = 'unreadable';
      }
    }
  };

  const onPicked = (event: Event & { currentTarget: HTMLInputElement }) => {
    const files = event.currentTarget.files;
    if (files && files.length > 0) {
      const { name, entries } = entriesFromFileList(files);
      void load(name, entries);
    }
    event.currentTarget.value = '';
  };

  const changed = $derived(
    library?.changed
      ? new Date(library.changed).toLocaleDateString($locale ?? undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : undefined,
  );

  /* Check ------------------------------------------------------------- */

  const CHECK_BATCH = 500;
  const HASH_CONCURRENCY = 2;

  /** Reads each file that comes over once and asks the library which it already has. */
  const check = async () => {
    if (!library) {
      return;
    }
    step = 'summary';
    checkFailed = false;
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    const current = library;
    try {
      const earlier = await store.get(eagleImportKey(ownerId, current.name)).catch(() => undefined);
      // Carry on only into the same library: another one with the same folder name starts afresh.
      saved =
        earlier &&
        earlier.record.status !== 'finished' &&
        earlier.record.ownerId === ownerId &&
        isSameLibrary(earlier, current)
          ? earlier
          : undefined;
      const toCheck = current.items.filter(
        (item) => isComing(item, supported) && !(saved && Object.hasOwn(saved.outcomes, item.id)),
      );
      checking = { done: 0, total: toCheck.length };
      checksums = new Map();
      let next = 0;
      await Promise.all(
        Array.from({ length: HASH_CONCURRENCY }, async () => {
          while (next < toCheck.length) {
            const item = toCheck[next++];
            checksums.set(item.id, await hashUploadFile(item.file!, signal));
            checking = { done: checksums.size, total: toCheck.length };
          }
        }),
      );
      // A file that appears twice in the library is stored once, so its later copies count as already here.
      const existing = repeatedContents(toCheck, checksums);
      for (let index = 0; index < toCheck.length; index += CHECK_BATCH) {
        const assets = toCheck.slice(index, index + CHECK_BATCH).flatMap(({ id }) => {
          const { sha256, sha1 } = checksums.get(id)!;
          return [
            { id, checksum: sha256 },
            { id, checksum: sha1 },
          ];
        });
        const { results } = await checkBulkUpload({ assetBulkUploadCheckDto: { assets } }, { signal });
        for (const result of results) {
          if (result.action === AssetUploadAction.Reject && result.assetId) {
            existing.add(result.id);
          }
        }
      }
      plan = planEagleImport(current, {
        supported,
        existing,
        outcomes: saved?.outcomes,
        annotations: EAGLE_ANNOTATIONS_AVAILABLE,
      });
    } catch {
      if (!signal.aborted) {
        checkFailed = true;
      }
    } finally {
      checking = undefined;
    }
  };

  /* Where ------------------------------------------------------------- */

  const loadAlbums = async () => {
    albumsFailed = false;
    try {
      albums = await getAllAlbums({ libraryScope: LibraryViewScope.Design });
    } catch {
      albumsFailed = true;
    }
  };
  const existingTop = $derived(albums.filter(({ parentId }) => !parentId).map(({ albumName }) => albumName));
  const chosenTarget = $derived<EagleTarget>(
    target.mode === 'top' ? { mode: 'top' } : { mode: 'inside', inside: target.inside },
  );
  const insideName = $derived(
    target.inside === 'new'
      ? EAGLE_DEFAULT_COLLECTION
      : (albums.find(({ id }) => id === target.inside)?.albumName ?? EAGLE_DEFAULT_COLLECTION),
  );
  const preview = $derived(library ? previewTarget(library, chosenTarget, insideName, existingTop) : undefined);

  /* Import ------------------------------------------------------------ */

  const begin = (from?: EagleImportSaved) => {
    if (!library || !plan) {
      return;
    }
    const next = new Run({
      library,
      ownerId,
      target: chosenTarget,
      existingTop,
      insideName,
      supported,
      api: frameleafEagleImportApi,
      store,
      checksums,
      saved: from && from.record.ownerId === ownerId ? from : undefined,
      annotations: EAGLE_ANNOTATIONS_AVAILABLE,
      isCurrent: authManager.captureSession(),
    });
    session = { ownerId, library, plan, supported, run: next, startedAt: Date.now(), startDone: next.done };
    run = next;
    eagleImportUi.run = next;
    eagleImportUi.revision++;
    step = 'progress';
    void next.start().then(() => {
      eagleImportUi.revision++;
      if (step === 'progress' || step === 'stop') {
        step = next.state === 'stopped' ? 'stopped' : 'report';
      }
    });
  };

  const carryOnAfterStop = async () => {
    if (!run) {
      return;
    }
    // Without the record (storage unavailable) the files already sent are still recognised by the upload.
    const from = await store.get(run.key).catch(() => undefined);
    toastManager.info($t('frameleaf_eagle_carrying_on'));
    begin(from);
  };

  const percent = $derived(run ? eaglePercent(run) : 0);
  const minutesLeft = $derived.by(() => {
    if (!run || !session || run.done <= session.startDone) {
      return;
    }
    const perItem = (now - session.startedAt) / (run.done - session.startDone);
    return Math.max(0, Math.round(((run.total - run.done) * perItem) / 60_000));
  });
  const doneAlready = $derived(run ? Object.values(run.outcomes).filter(({ duplicate }) => duplicate).length : 0);

  const result = $derived(
    run && plan && library
      ? importResult(plan, library, {
          outcomes: run.outcomes,
          failed: run.failed,
          collections: run.collections,
          stopped: run.state === 'stopped',
          supported,
          annotations: EAGLE_ANNOTATIONS_AVAILABLE,
        })
      : undefined,
  );
  const accounted = $derived(!!plan && !!result && reconciles(plan, result));

  const showInBoards = () => {
    const rootAlbumId = run?.rootAlbumId;
    close();
    void goto(
      rootAlbumId
        ? workspaceHref(Route.viewAlbum({ id: rootAlbumId }), LibraryViewScope.Design, location.origin)
        : '/pro',
    );
  };

  /* Wording ----------------------------------------------------------- */

  const STEPPER: [
    Step,
    (
      | 'frameleaf_eagle_step_choose'
      | 'frameleaf_eagle_step_check'
      | 'frameleaf_eagle_step_where'
      | 'frameleaf_eagle_step_import'
    ),
  ][] = [
    ['pick', 'frameleaf_eagle_step_choose'],
    ['summary', 'frameleaf_eagle_step_check'],
    ['target', 'frameleaf_eagle_step_where'],
    ['progress', 'frameleaf_eagle_step_import'],
  ];
  const stepIndex = $derived(
    ['stop', 'report', 'stopped'].includes(step) ? 3 : STEPPER.findIndex(([id]) => id === step),
  );
  const TITLES = {
    pick: 'frameleaf_eagle_title_pick',
    summary: 'frameleaf_eagle_title_summary',
    target: 'frameleaf_eagle_title_target',
    progress: 'frameleaf_eagle_title_progress',
    stop: 'frameleaf_eagle_title_stop',
    report: 'frameleaf_eagle_title_report',
    stopped: 'frameleaf_eagle_title_stopped',
  } as const;
  const WIDE_STEPS: Step[] = ['summary', 'report', 'stopped'];
  const wide = $derived(WIDE_STEPS.includes(step));

  const fonts = $derived(plan?.unsupported.filter(({ reason }) => reason === 'font').map(({ name }) => name) ?? []);
  const soundAnd3d = $derived(
    plan?.unsupported
      .filter(({ reason }) => reason === 'sound' || reason === 'model')
      .map(({ name, reason }) => $t('frameleaf_eagle_unsupported_name', { values: { name, reason } })) ?? [],
  );
  const otherTypes = $derived(
    plan?.unsupported.filter(({ reason }) => reason === 'other').map(({ name }) => name) ?? [],
  );
  const fieldMap = $derived([
    [$t('frameleaf_eagle_map_folders'), $t('frameleaf_eagle_map_folders_to')],
    [$t('frameleaf_eagle_map_colours'), $t('frameleaf_eagle_map_colours_to')],
    [$t('frameleaf_eagle_map_descriptions'), $t('frameleaf_eagle_map_descriptions_to')],
    [$t('tags'), $t('frameleaf_eagle_map_tags_to')],
    [$t('frameleaf_eagle_map_rating'), $t('frameleaf_eagle_map_rating_to')],
    [$t('frameleaf_boards_note'), $t('frameleaf_eagle_map_note_to')],
    [$t('frameleaf_eagle_map_web'), $t('frameleaf_eagle_map_web_to')],
    [$t('frameleaf_eagle_map_name'), $t('frameleaf_eagle_map_name_to')],
    [$t('frameleaf_eagle_dates'), $t('frameleaf_eagle_map_date_to')],
    [
      $t('frameleaf_eagle_area_comments'),
      EAGLE_ANNOTATIONS_AVAILABLE ? $t('frameleaf_eagle_map_comments_to') : $t('frameleaf_eagle_map_comments_later'),
    ],
  ]);
  const recentDetail = (duplicate: boolean, collections: string[]) => {
    const names = collections.join(', ');
    if (duplicate) {
      return names
        ? $t('frameleaf_eagle_recent_already', { values: { names } })
        : $t('frameleaf_eagle_recent_already_unfiled');
    }
    return names
      ? $t('frameleaf_eagle_recent_added', { values: { names } })
      : $t('frameleaf_eagle_recent_added_unfiled');
  };
</script>

{#snippet count(icon: string, value: number, label: string, detail?: string)}
  <li>
    <Icon {icon} size="18" aria-hidden />
    <span>
      <span><strong>{number(value)}</strong> {label}</span>
      {#if detail}<small>{detail}</small>{/if}
    </span>
  </li>
{/snippet}

{#snippet leftOut()}
  {#if plan}
    <ul class="named-lists">
      {#if fonts.length > 0}<EagleNamedList
          title={$t('frameleaf_eagle_fonts')}
          names={fonts}
          reason={$t('frameleaf_eagle_fonts_reason')}
        />{/if}
      {#if soundAnd3d.length > 0}<EagleNamedList
          title={$t('frameleaf_eagle_sound_3d')}
          names={soundAnd3d}
          reason={$t('frameleaf_eagle_sound_3d_reason')}
        />{/if}
      {#if otherTypes.length > 0}<EagleNamedList
          title={$t('frameleaf_eagle_other_types')}
          names={otherTypes}
          reason={$t('frameleaf_eagle_other_types_reason')}
        />{/if}
      {#if plan.trash.length > 0}<EagleNamedList
          title={$t('frameleaf_eagle_trash')}
          names={plan.trash}
          reason={$t('frameleaf_eagle_trash_reason')}
          first={3}
        />{/if}
      {#if plan.missing.length > 0}<EagleNamedList
          title={$t('frameleaf_eagle_missing')}
          names={plan.missing}
          reason={$t('frameleaf_eagle_missing_reason')}
        />{/if}
      {#if result && result.failed.length > 0 && (step === 'report' || step === 'stopped')}<EagleNamedList
          title={$t('frameleaf_eagle_not_sent')}
          names={result.failed}
          reason={$t('frameleaf_eagle_not_sent_reason')}
        />{/if}
    </ul>
  {/if}
{/snippet}

{#snippet differently()}
  {#if plan}
    {@const { smartFolders, tagGroups, folderIcons, videoComments } = plan.notMapped}
    <ul class="named-lists">
      {#if smartFolders.length > 0}<EagleNamedList
          title={$t('frameleaf_eagle_smart_folders')}
          names={smartFolders}
          reason={$t('frameleaf_eagle_smart_folders_reason')}
        />{/if}
      {#if tagGroups.length > 0}<EagleNamedList
          title={$t('frameleaf_eagle_tag_groups')}
          names={tagGroups}
          reason={$t('frameleaf_eagle_tag_groups_reason')}
        />{/if}
      {#if folderIcons.length > 0}<EagleNamedList
          title={$t('frameleaf_eagle_folder_icons')}
          names={folderIcons}
          reason={$t('frameleaf_eagle_folder_icons_reason')}
          first={3}
        />{/if}
      {#if videoComments.length > 0}<EagleNamedList
          title={$t('frameleaf_eagle_video_comments')}
          names={videoComments}
          reason={$t('frameleaf_eagle_video_comments_reason')}
        />{/if}
      {#if plan.areaCommentsWaiting > 0}<EagleNamedList
          title={$t('frameleaf_eagle_area_comments')}
          count={plan.areaCommentsWaiting}
          reason={$t('frameleaf_eagle_area_comments_reason')}
        />{/if}
      {#if plan.sources > 0}<EagleNamedList
          title={$t('frameleaf_eagle_sources')}
          count={plan.sources}
          reason={$t('frameleaf_eagle_sources_reason')}
        />{/if}
      <EagleNamedList title={$t('frameleaf_eagle_dates')} reason={$t('frameleaf_eagle_dates_reason')} />
      <EagleNamedList title={$t('frameleaf_eagle_palettes')} reason={$t('frameleaf_eagle_palettes_reason')} />
    </ul>
  {/if}
{/snippet}

<input
  bind:this={picker}
  class="hidden-input"
  type="file"
  webkitdirectory
  multiple
  tabindex="-1"
  aria-hidden="true"
  onchange={onPicked}
/>

<Dialog
  title={$t(TITLES[step])}
  closeLabel={$t('close')}
  size={wide ? 'medium' : 'default'}
  bind:open={
    () => eagleImportUi.open,
    (open) => {
      if (!open) {
        close();
      }
    }
  }
>
  <div class="eagle" class:wide>
    {#if step !== 'stop'}
      <ol class="stepper" aria-label={$t('frameleaf_eagle_steps')}>
        {#each STEPPER as [id, label], index (id)}
          <li
            class:done={index < stepIndex}
            class:now={index === stepIndex}
            aria-current={index === stepIndex ? 'step' : undefined}
          >
            <span aria-hidden="true"
              >{#if index < stepIndex}<Icon icon={mdiCheck} size="12" />{:else}{index + 1}{/if}</span
            >
            {$t(label)}
          </li>
        {/each}
      </ol>
    {/if}

    {#if step === 'pick'}
      <p>{$t('frameleaf_eagle_pick_intro')}</p>
      <fieldset class="choices">
        <legend class="sr-only">{$t('frameleaf_eagle_source_label')}</legend>
        <label class="choice on">
          <input type="radio" name="eagle-source" checked />
          <Icon icon={mdiLaptop} size="20" aria-hidden />
          <span>
            <strong>{$t('frameleaf_eagle_source_computer')}</strong>
            <small>{$t('frameleaf_eagle_source_computer_hint')}</small>
          </span>
        </label>
        <label class="choice is-disabled">
          <input type="radio" name="eagle-source" disabled />
          <Icon icon={mdiServerNetwork} size="20" aria-hidden />
          <span>
            <strong>{$t('frameleaf_eagle_source_server')}</strong>
            <small>{$t('frameleaf_eagle_source_server_unavailable')}</small>
          </span>
        </label>
      </fieldset>
      {#if paused && !library}
        <p class="note-line" role="status">
          {$t('frameleaf_eagle_carry_on_choose', { values: { name: paused.record.libraryName } })}
        </p>
      {/if}
      {#if library}
        <div class="library-card">
          <span class="library-icon" aria-hidden="true"><Icon icon={mdiFolderZipOutline} size="26" /></span>
          <span>
            <strong>{library.name}</strong>
            <small>
              {[
                $t('frameleaf_eagle_library_items', { values: { count: library.items.length } }),
                ...(changed ? [$t('frameleaf_eagle_library_changed', { values: { date: changed } })] : []),
              ].join(' · ')}
            </small>
          </span>
          <Button onclick={() => void choose()}>{$t('frameleaf_eagle_choose_another')}</Button>
        </div>
      {:else}
        <div class="library-empty">
          <Button disabled={reading} onclick={() => void choose()} initialFocus>
            <Icon icon={mdiFolderOpenOutline} size="16" aria-hidden />{reading
              ? $t('frameleaf_eagle_reading')
              : $t('frameleaf_eagle_choose_folder')}
          </Button>
          <small>{$t('frameleaf_eagle_choose_hint')}</small>
        </div>
      {/if}
      {#if readError}<InlineError
          compact
          message={$t(readError === 'not-library' ? 'frameleaf_eagle_not_library' : 'frameleaf_eagle_unreadable')}
        />{/if}
      <p class="muted small">{$t('frameleaf_eagle_pick_next')}</p>
    {:else if step === 'summary'}
      {#if checking}
        <p role="status">{$t('frameleaf_eagle_checking', { values: checking })}</p>
        <span
          class="bar"
          role="progressbar"
          aria-label={$t('frameleaf_eagle_progress_label')}
          aria-valuenow={eaglePercent(checking)}
          aria-valuemin={0}
          aria-valuemax={100}><span style:width="{eaglePercent(checking)}%"></span></span
        >
      {:else if checkFailed || !plan}
        <InlineError message={$t('frameleaf_eagle_check_failed')} onRetry={() => void check()} />
      {:else}
        <p>{$t('frameleaf_eagle_read_just_now', { values: { name: plan.library } })}</p>
        {#if saved && plan.done > 0}
          <p class="note-line" role="status">
            {$t('frameleaf_eagle_resume_note', { values: { done: plan.done, total: plan.coming } })}
          </p>
        {/if}
        <div class="columns">
          <section aria-labelledby="eagle-comes">
            <h3 id="eagle-comes">{$t('frameleaf_eagle_comes_over')}</h3>
            <ul class="counts">
              {@render count(
                mdiImageMultipleOutline,
                plan.coming,
                $t('frameleaf_eagle_label_items', { values: { count: plan.coming } }),
                $t('frameleaf_eagle_items_detail', { values: { new: plan.newFiles, already: plan.already } }),
              )}
              {@render count(
                mdiFolderMultipleOutline,
                plan.collections,
                $t('frameleaf_eagle_label_collections', { values: { count: plan.collections } }),
                plan.collections > 0
                  ? $t('frameleaf_eagle_collections_detail', {
                      values: { depth: plan.depth, several: plan.inSeveral },
                    })
                  : undefined,
              )}
              {@render count(
                mdiTagOutline,
                plan.tags,
                $t('frameleaf_eagle_label_tags', { values: { count: plan.tags } }),
              )}
              {@render count(
                mdiStarOutline,
                plan.rated,
                $t('frameleaf_eagle_label_ratings', { values: { count: plan.rated } }),
              )}
              {@render count(
                mdiNoteTextOutline,
                plan.notes,
                $t('frameleaf_eagle_label_notes', { values: { count: plan.notes } }),
              )}
              {#if EAGLE_ANNOTATIONS_AVAILABLE}
                {@render count(
                  mdiDrawPen,
                  plan.annotations,
                  $t('frameleaf_eagle_label_annotations', { values: { count: plan.annotations } }),
                  $t('frameleaf_eagle_annotations_detail'),
                )}
              {/if}
              {@render count(
                mdiInboxOutline,
                plan.unfiled,
                $t('frameleaf_eagle_label_unfiled', { values: { count: plan.unfiled } }),
                $t('frameleaf_eagle_unfiled_detail'),
              )}
            </ul>
            <h3>{$t('frameleaf_eagle_differently')}</h3>
            {@render differently()}
          </section>
          <section aria-labelledby="eagle-cant">
            <h3 id="eagle-cant">
              {$t('frameleaf_eagle_cant')}
              <small>· {$t('frameleaf_eagle_cant_count', { values: { count: plan.leftOut } })}</small>
            </h3>
            {@render leftOut()}
          </section>
        </div>
        <p class="total" role="note">
          {$t('frameleaf_eagle_total', { values: { found: plan.found, coming: plan.coming, leftOut: plan.leftOut } })}
        </p>
        <details class="map">
          <summary>{$t('frameleaf_eagle_field_map')}</summary>
          <dl>
            {#each fieldMap as [from, to] (from)}
              <dt>{from}</dt>
              <dd>{to}</dd>
            {/each}
          </dl>
        </details>
      {/if}
    {:else if step === 'target' && plan}
      <fieldset class="choices">
        <legend class="sr-only">{$t('frameleaf_eagle_target_label')}</legend>
        <label class="choice" class:on={target.mode === 'inside'}>
          <input
            type="radio"
            name="eagle-target"
            checked={target.mode === 'inside'}
            onchange={() => (target.mode = 'inside')}
          />
          <Icon icon={mdiFolderArrowDownOutline} size="20" aria-hidden />
          <span>
            <strong>{$t('frameleaf_eagle_target_inside')}</strong>
            <small>{$t('frameleaf_eagle_target_inside_hint')}</small>
          </span>
        </label>
        <label class="choice" class:on={target.mode === 'top'}>
          <input
            type="radio"
            name="eagle-target"
            checked={target.mode === 'top'}
            onchange={() => (target.mode = 'top')}
          />
          <Icon icon={mdiFolderHomeOutline} size="20" aria-hidden />
          <span>
            <strong>{$t('frameleaf_eagle_target_top')}</strong>
            <small>{$t('frameleaf_eagle_target_top_hint', { values: { count: plan.topLevel } })}</small>
          </span>
        </label>
      </fieldset>
      {#if target.mode === 'inside'}
        <div class="field">
          <span class="label">{$t('frameleaf_eagle_collection')}</span>
          <button
            type="button"
            class="new-row"
            class:chosen={target.inside === 'new'}
            aria-pressed={target.inside === 'new'}
            onclick={() => (target.inside = 'new')}
          >
            <Icon icon={mdiFolderPlusOutline} size="17" aria-hidden />
            <span>{$t('frameleaf_eagle_new_collection', { values: { name: EAGLE_DEFAULT_COLLECTION } })}</span>
          </button>
          {#if albumsFailed}<InlineError
              compact
              message={$t('frameleaf_boards_collections_unavailable')}
              onRetry={() => void loadAlbums()}
            />{:else}<AlbumDestinationPicker
              {albums}
              value={target.inside === 'new' ? null : target.inside}
              onChange={(id) => (target.inside = id ?? 'new')}
              name="eagle-collection"
              label={$t('frameleaf_eagle_collection')}
            />{/if}
        </div>
      {/if}
      {#if preview}
        <div class="preview" aria-live="polite">
          <Icon icon={mdiFileTreeOutline} size="18" aria-hidden />
          <span>
            <strong
              >{$t('frameleaf_eagle_preview_where', {
                values: { count: plan.collections, where: preview.inside ?? $t('frameleaf_eagle_top_level') },
              })}</strong
            >
            <small>{$t('frameleaf_eagle_preview_top', { values: { names: preview.top.join(' · ') } })}</small>
            <small>
              {$t('frameleaf_eagle_preview_unfiled', {
                values: { where: preview.inside ?? $t('frameleaf_pro_unfiled') },
              })}
              {#if preview.clashes.length > 0}
                {$t('frameleaf_eagle_preview_clash', {
                  values: {
                    names: preview.clashes.join(', '),
                    renamed: preview.clashes.map((name) => `${name} (Eagle)`).join(', '),
                  },
                })}
              {/if}
            </small>
          </span>
        </div>
      {/if}
    {:else if (step === 'progress' || step === 'stop') && run}
      {#if step === 'stop'}
        <ul class="consequences">
          <li>
            <Icon icon={mdiCheck} size="16" aria-hidden />{$t('frameleaf_eagle_stop_stays', {
              values: { count: run.done },
            })}
          </li>
          <li>
            <Icon icon={mdiCheck} size="16" aria-hidden />{$t('frameleaf_eagle_stop_rest', {
              values: { count: run.total - run.done },
            })}
          </li>
          <li><Icon icon={mdiCheck} size="16" aria-hidden />{$t('frameleaf_eagle_stop_unchanged')}</li>
          <li><Icon icon={mdiCheck} size="16" aria-hidden />{$t('frameleaf_eagle_stop_later')}</li>
        </ul>
      {:else}
        <div class="progress-head">
          <strong>{$t('frameleaf_eagle_progress_count', { values: { done: run.done, total: run.total } })}</strong>
          <span class="muted">
            {minutesLeft === undefined
              ? $t('frameleaf_eagle_progress_percent', { values: { percent } })
              : $t('frameleaf_eagle_progress_left', { values: { percent, minutes: minutesLeft } })}
          </span>
        </div>
        <span
          class="bar"
          role="progressbar"
          aria-label={$t('frameleaf_eagle_progress_label')}
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}><span style:width="{percent}%"></span></span
        >
        {#if run.error}<InlineError compact message={$t('frameleaf_eagle_failed_start')} />{/if}
        {#if run.state === 'stopping'}<p class="muted small" role="status">{$t('frameleaf_eagle_stopping')}</p>{/if}
        <ul class="phases">
          <li class:now={run.collections < (plan?.collections ?? 0)}>
            <Icon icon={mdiFolderMultipleOutline} size="16" aria-hidden />{$t('frameleaf_eagle_phase_making')}
          </li>
          <li class="now">
            <Icon icon={mdiTrayArrowUp} size="16" aria-hidden />{$t('frameleaf_eagle_phase_sending', {
              values: { done: run.done, total: run.total },
            })}
          </li>
          <li class="now">
            <Icon icon={mdiFolderMultipleOutline} size="16" aria-hidden />{$t('frameleaf_eagle_phase_filing')}
          </li>
          <li><Icon icon={mdiPaletteOutline} size="16" aria-hidden />{$t('frameleaf_eagle_phase_colours')}</li>
        </ul>
        {#if run.recent.length > 0}
          <ul class="recent" aria-label={$t('frameleaf_eagle_recent')}>
            {#each run.recent as item (item.id)}
              <li>
                <span>
                  {item.name}
                  <small class:already={item.duplicate}>
                    {#if item.duplicate}<Icon icon={mdiCheckDecagramOutline} size="13" aria-hidden />{/if}
                    {recentDetail(item.duplicate, item.collections)}
                  </small>
                </span>
              </li>
            {/each}
          </ul>
        {/if}
        <p class="muted small">
          {$t('frameleaf_eagle_progress_totals', { values: { added: run.done - doneAlready, already: doneAlready } })}
        </p>
        <div class="note-box">
          <Icon icon={mdiTabRemove} size="18" aria-hidden />
          <span>{$t('frameleaf_eagle_progress_note')}</span>
        </div>
      {/if}
    {:else if (step === 'report' || step === 'stopped') && plan && result}
      <p>{result.stopped ? $t('frameleaf_eagle_report_stopped') : $t('frameleaf_eagle_report_done')}</p>
      {#if run?.error}<InlineError compact message={$t('frameleaf_eagle_failed_start')} />{/if}
      <div class="columns">
        <section aria-labelledby="eagle-ledger">
          <h3 id="eagle-ledger">{$t('frameleaf_eagle_ledger_items')}</h3>
          <table class="ledger">
            <caption class="sr-only">{$t('frameleaf_eagle_ledger_caption')}</caption>
            <tbody>
              <tr><th scope="row">{$t('frameleaf_eagle_ledger_added')}</th><td>{number(result.added)}</td></tr>
              <tr>
                <th scope="row">
                  <span class="with-icon"
                    ><Icon icon={mdiCheckDecagramOutline} size="15" aria-hidden />{$t(
                      'frameleaf_eagle_ledger_already',
                    )}</span
                  >
                  <small>{$t('frameleaf_eagle_ledger_already_detail')}</small>
                </th>
                <td>{number(result.already)}</td>
              </tr>
              <tr>
                <th scope="row">
                  {$t('frameleaf_eagle_ledger_cant')}
                  <small>{$t('frameleaf_eagle_ledger_cant_detail')}</small>
                </th>
                <td>{number(result.leftOut)}</td>
              </tr>
              {#if result.notReached > 0 || result.stopped}
                <tr>
                  <th scope="row">
                    {$t('frameleaf_eagle_ledger_stopped')}
                    <small>{$t('frameleaf_eagle_ledger_stopped_detail')}</small>
                  </th>
                  <td>{number(result.notReached)}</td>
                </tr>
              {/if}
            </tbody>
            <tfoot>
              <tr><th scope="row">{$t('frameleaf_eagle_ledger_found')}</th><td>{number(plan.found)}</td></tr>
            </tfoot>
          </table>
          <p class="check" class:off={!accounted}>
            <Icon icon={accounted ? mdiCheckCircleOutline : mdiAlertOutline} size="16" aria-hidden />
            {accounted
              ? $t(
                  result.stopped || result.failed.length > 0
                    ? 'frameleaf_eagle_reconciled_partial'
                    : 'frameleaf_eagle_reconciled',
                )
              : $t('frameleaf_eagle_not_reconciled')}
          </p>
          <h3>
            {result.stopped
              ? $t('frameleaf_eagle_with_items', { values: { count: result.added + result.already } })
              : $t('frameleaf_eagle_also')}
          </h3>
          <ul class="counts compact">
            {@render count(
              mdiFolderMultipleOutline,
              result.collections,
              $t('frameleaf_eagle_label_collections_short', { values: { count: result.collections } }),
            )}
            {@render count(
              mdiTagOutline,
              result.tags,
              $t('frameleaf_eagle_label_tags', { values: { count: result.tags } }),
            )}
            {@render count(
              mdiStarOutline,
              result.rated,
              $t('frameleaf_eagle_label_ratings', { values: { count: result.rated } }),
            )}
            {@render count(
              mdiNoteTextOutline,
              result.notes,
              $t('frameleaf_eagle_label_notes', { values: { count: result.notes } }),
            )}
            {#if EAGLE_ANNOTATIONS_AVAILABLE}
              {@render count(
                mdiDrawPen,
                result.annotations,
                $t('frameleaf_eagle_label_annotations', { values: { count: result.annotations } }),
              )}
            {/if}
          </ul>
          <h3>{$t('frameleaf_eagle_differently')}</h3>
          {@render differently()}
        </section>
        <section aria-labelledby="eagle-left">
          <h3 id="eagle-left">
            {$t('frameleaf_eagle_ledger_cant')}
            <small>· {$t('frameleaf_eagle_cant_count', { values: { count: result.leftOut } })}</small>
          </h3>
          {@render leftOut()}
        </section>
      </div>
    {/if}
  </div>

  {#snippet actions()}
    {#if step === 'pick'}
      <Button onclick={close}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={!library || reading} onclick={() => void check()}
        >{$t('frameleaf_eagle_check_library')}</Button
      >
    {:else if step === 'summary'}
      <Button onclick={() => (step = 'pick')}>{$t('back')}</Button>
      <span class="spacer"></span>
      <Button onclick={close}>{$t('cancel')}</Button>
      {#if saved && plan}
        <Button variant="primary" disabled={!!checking} onclick={() => begin(saved)}
          >{$t('frameleaf_eagle_carry_on')}</Button
        >
      {:else}
        <Button
          variant="primary"
          disabled={!plan || !!checking}
          onclick={() => {
            step = 'target';
            void loadAlbums();
          }}>{$t('continue')}</Button
        >
      {/if}
    {:else if step === 'target'}
      <Button onclick={() => (step = 'summary')}>{$t('back')}</Button>
      <span class="spacer"></span>
      <Button onclick={close}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={!plan || plan.coming === 0} onclick={() => begin()}
        >{$t('frameleaf_eagle_import_count', { values: { count: plan?.coming ?? 0 } })}</Button
      >
    {:else if step === 'progress'}
      <Button variant="danger" disabled={run?.state !== 'running'} onclick={() => (step = 'stop')}
        >{$t('frameleaf_eagle_stop_import')}</Button
      >
      <span class="spacer"></span>
      <Button variant="primary" onclick={close}>{$t('frameleaf_eagle_hide')}</Button>
    {:else if step === 'stop'}
      <Button onclick={() => (step = 'progress')}>{$t('frameleaf_eagle_keep_importing')}</Button>
      <Button
        variant="danger"
        onclick={() => {
          run?.stop();
          step = 'progress';
        }}>{$t('frameleaf_eagle_stop_keep', { values: { count: run?.done ?? 0 } })}</Button
      >
    {:else if step === 'report'}
      <Button onclick={close}>{$t('close')}</Button>
      <Button variant="primary" onclick={showInBoards}
        ><Icon icon={mdiFolderOpenOutline} size="16" aria-hidden />{$t('frameleaf_eagle_show_in_boards')}</Button
      >
    {:else if step === 'stopped'}
      <Button onclick={close}>{$t('close')}</Button>
      {#if result && result.notReached + result.failed.length > 0}
        <Button variant="primary" onclick={() => void carryOnAfterStop()}
          >{$t('frameleaf_eagle_import_rest', { values: { count: result.notReached + result.failed.length } })}</Button
        >
      {:else}
        <Button variant="primary" onclick={showInBoards}>{$t('frameleaf_eagle_show_in_boards')}</Button>
      {/if}
    {/if}
  {/snippet}
</Dialog>

<style>
  .hidden-input,
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .eagle {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-4);
    width: min(30rem, 100%);
    color: var(--fl-text);
    font-size: 0.875rem;
    line-height: 1.45;
  }
  .eagle.wide {
    width: 48rem;
    max-width: 100%;
  }
  p {
    margin: 0;
  }
  .muted {
    color: var(--fl-muted);
  }
  .small,
  small {
    font-size: 0.8125rem;
  }
  h3 {
    margin: 0 0 var(--fl-space-2);
    color: var(--fl-muted);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  h3 small {
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
  }
  .stepper {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-5);
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
  .stepper li {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
  }
  .stepper li > span {
    display: inline-grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    border: 1px solid var(--fl-border-strong);
    border-radius: 50%;
    font-size: 0.6875rem;
  }
  .stepper li.now {
    color: var(--fl-text);
  }
  .stepper li.now > span {
    border-color: var(--fl-accent);
    color: var(--fl-accent);
  }
  .stepper li.done > span {
    border-color: transparent;
    background: var(--fl-accent-soft);
    color: var(--fl-accent);
  }
  .choices {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: var(--fl-space-3);
    margin: 0;
    padding: 0;
    border: 0;
  }
  .choice {
    position: relative;
    display: flex;
    gap: var(--fl-space-3);
    padding: var(--fl-space-3) var(--fl-space-4);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    cursor: pointer;
  }
  .choice input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .choice:has(input:focus-visible) {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .choice.on,
  .choice:has(input:checked) {
    border-color: var(--fl-accent);
    background: var(--fl-accent-soft);
  }
  .choice.on :global(svg) {
    color: var(--fl-accent);
  }
  .choice.is-disabled {
    cursor: not-allowed;
    opacity: 0.7;
  }
  .choice span,
  .preview > span,
  .counts li > span {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .choice small,
  .preview small,
  .counts small,
  .library-card small,
  .library-empty small {
    color: var(--fl-muted);
  }
  .library-card,
  .library-empty {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    padding: var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .library-empty {
    flex-direction: column;
    align-items: flex-start;
  }
  .library-card > span:nth-child(2) {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .library-icon {
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: var(--fl-radius-sm);
    background: var(--fl-raised);
    color: var(--fl-accent);
  }
  .note-line {
    padding: var(--fl-space-2) var(--fl-space-3);
    border-radius: var(--fl-radius-sm);
    background: var(--fl-accent-soft);
  }
  .columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
    gap: var(--fl-space-6);
  }
  .counts,
  .named-lists,
  .phases,
  .recent,
  .consequences {
    display: flex;
    flex-direction: column;
    margin: 0 0 var(--fl-space-4);
    padding: 0;
    list-style: none;
  }
  .counts {
    gap: var(--fl-space-3);
  }
  .counts.compact {
    gap: var(--fl-space-2);
  }
  .counts li {
    display: flex;
    gap: var(--fl-space-3);
  }
  .counts li > :global(svg),
  .phases :global(svg) {
    flex: none;
    color: var(--fl-accent);
  }
  .total {
    padding-block-start: var(--fl-space-3);
    border-block-start: 1px solid var(--fl-border);
    color: var(--fl-muted);
  }
  .map summary {
    cursor: pointer;
    font-weight: 500;
  }
  .map dl {
    display: grid;
    grid-template-columns: minmax(8rem, auto) 1fr;
    gap: var(--fl-space-2) var(--fl-space-4);
    margin: var(--fl-space-3) 0 0;
  }
  .map dt {
    font-weight: 600;
  }
  .map dd {
    margin: 0;
    color: var(--fl-muted);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-2);
  }
  .label {
    font-weight: 600;
  }
  .new-row {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: none;
    color: var(--fl-text);
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .new-row.chosen {
    border-color: var(--fl-accent);
    background: var(--fl-accent-soft);
  }
  .preview,
  .note-box {
    display: flex;
    gap: var(--fl-space-3);
    padding: var(--fl-space-3);
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .note-box :global(svg),
  .preview :global(svg) {
    flex: none;
    color: var(--fl-muted);
  }
  .progress-head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--fl-space-2);
  }
  .bar {
    display: block;
    height: 6px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--fl-raised);
  }
  .bar > span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--fl-accent);
    transition: width var(--fl-duration-base) var(--fl-ease);
  }
  .phases {
    gap: var(--fl-space-2);
    color: var(--fl-muted);
  }
  .phases li {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
  }
  .phases li.now {
    color: var(--fl-text);
  }
  .recent {
    gap: var(--fl-space-2);
  }
  .recent li > span {
    display: flex;
    flex-direction: column;
    overflow-wrap: anywhere;
  }
  .recent small {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    color: var(--fl-muted);
  }
  .recent small.already {
    color: var(--fl-success);
  }
  .consequences {
    gap: var(--fl-space-3);
  }
  .consequences li {
    display: flex;
    gap: var(--fl-space-2);
  }
  .consequences :global(svg) {
    flex: none;
    color: var(--fl-success);
  }
  .ledger {
    width: 100%;
    border-collapse: collapse;
  }
  .ledger th,
  .ledger td {
    padding: var(--fl-space-2) 0;
    border-block-end: 1px solid var(--fl-border);
    text-align: start;
    vertical-align: top;
  }
  .ledger th {
    font-weight: 500;
  }
  .with-icon {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
  }
  .with-icon :global(svg) {
    color: var(--fl-success);
  }
  .ledger th small {
    display: block;
    color: var(--fl-muted);
    font-weight: 400;
  }
  .ledger td {
    padding-inline-start: var(--fl-space-4);
    font-variant-numeric: tabular-nums;
    text-align: end;
  }
  .ledger tfoot th,
  .ledger tfoot td {
    border-block-end: 0;
    font-weight: 700;
  }
  .check {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    margin-block: var(--fl-space-3) var(--fl-space-4);
    color: var(--fl-success);
  }
  .check.off {
    color: var(--fl-warning);
  }
  .spacer {
    flex: 1;
  }
</style>
