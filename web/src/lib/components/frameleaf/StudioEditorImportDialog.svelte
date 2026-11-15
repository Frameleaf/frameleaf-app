<script lang="ts">
  /**
   * Import a project from another video editor (FL-1544, Beta; approved mock 2026-11-13, prototype
   * `StudioEditorImport.jsx`). Choose a file, check what comes over, find the media, import, and the
   * report. A Frameleaf bundle chosen here goes to the bundle import instead.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Spinner from '$lib/components/frameleaf/Spinner.svelte';
  import {
    chooseEditorImportFiles,
    defaultEditorImportUses,
    EDITOR_IMPORT_ACCEPT,
    EDITOR_IMPORT_APPS,
    editorImportClock,
    editorImportMediaChoices,
    editorImportMediaPlan,
    editorImportNoteKey,
    editorImportNoticeKey,
    filesForMissingMedia,
    groupEditorImportNotes,
    sumEditorImportCounts,
    sumEditorImportMedia,
    type EditorImportSource,
  } from '$lib/frameleaf/studio/editor-import';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { fileUploadHandler } from '$lib/utils/file-uploader';
  import {
    createStudioEditorImport,
    getStudioEditorImport,
    MediaOperationStatus,
    startStudioEditorImport,
    uploadStudioEditorImportFile,
    type StudioEditorImportBuildDto,
    type StudioEditorImportCheckDto,
    type StudioEditorImportDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertOutline,
    mdiCheck,
    mdiCheckCircleOutline,
    mdiCircleOutline,
    mdiFileQuestionOutline,
    mdiFolderOpenOutline,
    mdiFolderOutline,
    mdiMovieOpenOutline,
    mdiProgressClock,
    mdiUploadOutline,
    mdiWaveform,
  } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { locale, t, type Translations } from 'svelte-i18n';

  let {
    open = $bindable(false),
    onBundle,
    onOpenProject,
    onImported,
  }: {
    open?: boolean;
    /** A Frameleaf bundle (.zip) chosen here goes to the bundle import. */
    onBundle: (file: File) => void;
    onOpenProject: (projectId: string) => void;
    /** New projects exist; the library reloads. */
    onImported?: () => void;
  } = $props();

  type Step = 'pick' | 'check' | 'media' | 'progress' | 'report' | 'failed';
  const STEPPER = [
    ['pick', 'frameleaf_studio_editor_import_step_choose'],
    ['check', 'frameleaf_studio_editor_import_step_check'],
    ['media', 'frameleaf_studio_editor_import_step_media'],
    ['progress', 'frameleaf_studio_editor_import_step_import'],
  ] as const;
  const PHASES = ['reading', 'media', 'sending', 'building', 'checking'] as const;
  const RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
  const POLL_MS = 1500;
  const TERMINAL = new Set<string>([
    MediaOperationStatus.Completed,
    MediaOperationStatus.Failed,
    MediaOperationStatus.Cancelled,
  ]);

  let step = $state<Step>('pick');
  let busy = $state(false);
  let project = $state<File | null>(null);
  let sidecars = $state<File[]>([]);
  let frameRate = $state(24);
  let checkId = $state<string | null>(null);
  let check = $state<StudioEditorImportCheckDto | null>(null);
  let picks = $state(new Set<number>());
  let uses = $state(new Set<string>());
  let folder = $state<File[]>([]);
  let folderName = $state('');
  let phase = $state(0);
  let percent = $state(0);
  let builds = $state<StudioEditorImportBuildDto[]>([]);
  let buildFailures = $state(0);
  let fileInput = $state<HTMLInputElement>();
  let folderInput = $state<HTMLInputElement>();
  let mediaInput = $state<HTMLInputElement>();
  let stopped = false;

  onDestroy(() => {
    stopped = true;
  });

  const tr = (key: string, values?: Record<string, string | number>) => $t(key as Translations, { values });
  const size = (bytes: number) => getByteUnitString(bytes, $locale ?? undefined);
  const isEdl = $derived(!!project && project.name.toLowerCase().endsWith('.edl'));
  const app = $derived(check ? EDITOR_IMPORT_APPS[check.source as EditorImportSource] : undefined);
  const picked = $derived(check ? check.timelines.filter((timeline) => picks.has(timeline.index)) : []);
  const sending = $derived(check ? filesForMissingMedia(check.media, uses, folder) : new Map<string, File>());
  const plan = $derived(check ? editorImportMediaPlan(check.media, uses, sending) : null);
  const counts = $derived(sumEditorImportCounts(picked));
  const checkGroups = $derived(groupEditorImportNotes(picked.flatMap((timeline) => timeline.notes)));
  const reportGroups = $derived(groupEditorImportNotes(builds.flatMap((build) => build.notes)));
  const albumName = $derived(
    picked[0]
      ? app
        ? tr('frameleaf_studio_editor_import_album_name', { name: picked[0].name, app })
        : tr('frameleaf_studio_editor_import_album_name_plain', { name: picked[0].name })
      : '',
  );
  const totals = $derived(sumEditorImportMedia(builds));
  const title = $derived(tr(`frameleaf_studio_editor_import_title_${step === 'progress' ? 'progress' : step}`));

  const reset = () => {
    step = 'pick';
    project = null;
    sidecars = [];
    check = null;
    checkId = null;
    folder = [];
    folderName = '';
    builds = [];
    buildFailures = 0;
    phase = 0;
    percent = 0;
  };

  const choose = (files: File[]) => {
    const choice = chooseEditorImportFiles(files);
    if (choice.kind === 'bundle') {
      open = false;
      onBundle(choice.bundle);
    } else if (choice.kind === 'project') {
      project = choice.project;
      sidecars = choice.sidecars;
    }
  };
  const onFiles = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    choose([...(input.files ?? [])]);
    input.value = '';
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    choose([...(event.dataTransfer?.files ?? [])]);
  };
  const onMediaFolder = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    folder = [...(input.files ?? [])];
    folderName = folder[0]?.webkitRelativePath.split('/', 1)[0] ?? '';
    input.value = '';
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Follow a job until it settles, reporting each reading. */
  const follow = async (id: string, onRead?: (job: StudioEditorImportDto) => void) => {
    for (;;) {
      const job = await getStudioEditorImport({ id });
      onRead?.(job);
      if (TERMINAL.has(job.status) || stopped) {
        return job;
      }
      await sleep(POLL_MS);
    }
  };

  const fail = () => {
    step = 'failed';
    busy = false;
  };

  const startCheck = async () => {
    if (!project || busy) {
      return;
    }
    busy = true;
    try {
      const upload = await uploadStudioEditorImportFile({ studioBundleUploadCreateDto: { file: project } });
      const sidecarIds: string[] = [];
      for (const file of sidecars) {
        sidecarIds.push((await uploadStudioEditorImportFile({ studioBundleUploadCreateDto: { file } })).id);
      }
      step = 'check';
      const queued = await createStudioEditorImport({
        studioEditorImportCreateDto: {
          uploadId: upload.id,
          ...(sidecarIds.length > 0 && { sidecarUploadIds: sidecarIds }),
          ...(isEdl && { frameRate }),
        },
      });
      checkId = queued.id;
      const job = await follow(queued.id);
      if (!job.check) {
        return fail();
      }
      check = job.check;
      picks = new Set(job.check.timelines.map((timeline) => timeline.index));
      uses = defaultEditorImportUses(job.check.media);
      busy = false;
    } catch {
      fail();
    }
  };

  const startImport = async () => {
    if (!check || !checkId || picks.size === 0 || busy) {
      return;
    }
    busy = true;
    step = 'progress';
    phase = 2;
    percent = 0;
    try {
      const sent = new Map<string, string>();
      if (sending.size > 0) {
        const keyOf = new Map([...sending].map(([key, file]) => [file, key]));
        await fileUploadHandler({
          files: [...sending.values()],
          onResult: (file, result) => {
            const key = keyOf.get(file);
            if (key) {
              sent.set(key, result.id);
              percent = Math.round((sent.size / sending.size) * 40);
            }
          },
        });
      }
      phase = 3;
      const { jobs } = await startStudioEditorImport({
        id: checkId,
        studioEditorImportStartDto: {
          timelines: [...picks],
          media: editorImportMediaChoices(check.media, uses, sent),
          ...(albumName && { albumName }),
        },
      });
      const progress = new Map<string, number>();
      const results = await Promise.all(
        jobs.map((job) =>
          follow(job.id, (read) => {
            progress.set(job.id, read.progress);
            let total = 0;
            for (const value of progress.values()) {
              total += value;
            }
            percent = 40 + Math.round((total / jobs.length) * 0.6);
            phase = read.step === 'checking' ? 4 : 3;
          }),
        ),
      );
      builds = results.flatMap((job) => (job.build ? [job.build] : []));
      buildFailures = results.length - builds.length;
      busy = false;
      if (builds.length === 0) {
        return fail();
      }
      onImported?.();
      step = 'report';
    } catch {
      fail();
    }
  };

  const togglePick = (index: number) => {
    const next = new Set(picks);
    if (next.has(index)) {
      next.delete(index);
    } else {
      next.add(index);
    }
    picks = next;
  };
  const toggleUse = (key: string) => {
    const next = new Set(uses);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    uses = next;
  };
  const close = () => {
    open = false;
  };
</script>

{#snippet groups(list: { code: string; names: string[] }[])}
  {#if list.length === 0}
    <p class="muted">{tr('frameleaf_studio_editor_import_nothing')}</p>
  {:else}
    <ul class="groups">
      {#each list as group (group.code)}
        <li>
          <strong>{tr(editorImportNoteKey(group.code))} <small>· {group.names.length}</small></strong>
          <small>{tr(`${editorImportNoteKey(group.code)}_reason`)}</small>
          <ul class="names">
            {#each group.names as name (name)}
              <li>{name}</li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

{#snippet countList(withProjects: boolean)}
  <ul class="counts">
    {#if withProjects}
      <li>
        <Icon icon={mdiMovieOpenOutline} size="18" />
        <span>
          <strong>{tr('frameleaf_studio_editor_import_projects', { count: picked.length })}</strong>
          {#if (check?.timelines.length ?? 0) > 1}<small>{tr('frameleaf_studio_editor_import_one_each')}</small>{/if}
        </span>
      </li>
    {/if}
    {#each [['clips', counts.clips], ['transitions', counts.transitions], ['titles', counts.titles], ['sound', counts.sound], ['markers', counts.markers]] as const as [name, value] (name)}
      {#if value > 0}
        <li>
          <Icon icon={mdiCheck} size="18" />
          <span>
            <span>{tr(`frameleaf_studio_editor_import_${name}`, { count: value })}</span>
            {#if name === 'clips'}<small>{tr('frameleaf_studio_editor_import_clips_detail')}</small>{/if}
          </span>
        </li>
      {/if}
    {/each}
  </ul>
{/snippet}

<Dialog bind:open {title} closeLabel={$t('close')} size="medium" onClosed={reset}>
  <div class="sei" ondragover={(event) => event.preventDefault()} ondrop={onDrop} role="presentation">
    <div class="top">
      <span class="beta">{tr('frameleaf_studio_editor_import_beta')}</span>
      {#if step !== 'failed'}
        <ol class="stepper" aria-label={tr('frameleaf_studio_editor_import_steps')}>
          {#each STEPPER as [id, label], index (id)}
            {@const at = step === 'report' ? STEPPER.length : STEPPER.findIndex(([value]) => value === step)}
            <li
              class={index < at ? 'done' : index === at ? 'now' : ''}
              aria-current={index === at ? 'step' : undefined}
            >
              <span aria-hidden="true">
                {#if index < at}<Icon icon={mdiCheck} size="12" />{:else}{index + 1}{/if}
              </span>
              {tr(label)}
            </li>
          {/each}
        </ol>
      {/if}
    </div>

    {#if step === 'pick'}
      <p>{tr('frameleaf_studio_editor_import_pick_intro')}</p>
      {#if project}
        <div class="card">
          <Icon icon={mdiMovieOpenOutline} size="26" />
          <span>
            <strong>{project.name}</strong>
            <small>
              {size(project.size)}{#if sidecars.length > 0}
                · {tr('frameleaf_studio_editor_import_sidecars', { count: sidecars.length })}{/if}
            </small>
          </span>
          <Button onclick={() => fileInput?.click()}>{tr('frameleaf_studio_editor_import_choose_another')}</Button>
        </div>
        {#if isEdl}
          <label class="field">
            <span>{tr('frameleaf_studio_editor_import_frame_rate')}</span>
            <select bind:value={frameRate}>
              {#each RATES as rate (rate)}
                <option value={rate}>{rate}</option>
              {/each}
            </select>
            <small>{tr('frameleaf_studio_editor_import_frame_rate_hint')}</small>
          </label>
        {/if}
      {:else}
        <div class="empty">
          <Button initialFocus onclick={() => fileInput?.click()}>
            <Icon icon={mdiFolderOpenOutline} size="18" />
            {tr('frameleaf_studio_editor_import_choose_file')}
          </Button>
          <small>
            {tr('frameleaf_studio_editor_import_drop_hint')}
            <button type="button" class="link" onclick={() => folderInput?.click()}>
              {tr('frameleaf_studio_editor_import_choose_folder')}
            </button>
          </small>
        </div>
      {/if}
      <section>
        <h3>{tr('frameleaf_studio_editor_import_accepts_title')}</h3>
        <ul class="accepts">
          <li><strong>Premiere Pro</strong><span>{tr('frameleaf_studio_editor_import_accepts_premiere')}</span></li>
          <li><strong>DaVinci Resolve</strong><span>{tr('frameleaf_studio_editor_import_accepts_resolve')}</span></li>
          <li><strong>Final Cut Pro</strong><span>{tr('frameleaf_studio_editor_import_accepts_finalcut')}</span></li>
          <li>
            <strong>{tr('frameleaf_studio_editor_import_accepts_other')}</strong>
            <span>{tr('frameleaf_studio_editor_import_accepts_other_detail')}</span>
          </li>
          <li><strong>Frameleaf</strong><span>{tr('frameleaf_studio_editor_import_accepts_bundle')}</span></li>
        </ul>
      </section>
      <p class="muted small">{tr('frameleaf_studio_editor_import_pick_next')}</p>
    {:else if step === 'check' && !check}
      <p class="waiting" role="status"><Spinner /> {tr('frameleaf_studio_editor_import_reading')}</p>
    {:else if step === 'check' && check}
      <p>{tr('frameleaf_studio_editor_import_check_read', { file: check.fileName })}</p>
      {#each check.notices as notice, index (index)}
        <p class="note warn" role="note">
          <Icon icon={mdiAlertOutline} size="18" />
          <span>{tr(editorImportNoticeKey(notice.code), { subject: notice.subject ?? '' })}</span>
        </p>
      {/each}
      <div class="columns">
        <section>
          {#if check.timelines.length > 1}
            <h3>{tr('frameleaf_studio_editor_import_choose_timelines')}</h3>
            <ul class="picks">
              {#each check.timelines as timeline (timeline.index)}
                <li>
                  <label>
                    <input
                      type="checkbox"
                      checked={picks.has(timeline.index)}
                      onchange={() => togglePick(timeline.index)}
                    />
                    <span>
                      <strong>{timeline.name}</strong>
                      <small>
                        {tr('frameleaf_studio_editor_import_timeline_meta', {
                          length: editorImportClock(timeline.durationSeconds),
                          count: timeline.clips,
                        })}
                      </small>
                    </span>
                  </label>
                </li>
              {/each}
            </ul>
          {/if}
          <h3>{tr('frameleaf_studio_editor_import_what_comes_over')}</h3>
          {#if picked.length > 0}
            {@render countList(true)}
          {:else}
            <p class="muted">{tr('frameleaf_studio_editor_import_choose_one')}</p>
          {/if}
        </section>
        <section>
          <h3>{tr('frameleaf_studio_editor_import_differently')}</h3>
          {@render groups(checkGroups.differently)}
          <h3>{tr('frameleaf_studio_editor_import_cant')}</h3>
          {@render groups(checkGroups.cant)}
        </section>
      </div>
    {:else if step === 'media' && check && plan}
      {@const found = check.media.filter((item) => item.match === 'found')}
      {@const likely = check.media.filter((item) => item.match !== 'found' && item.match !== 'missing')}
      {@const missing = check.media.filter((item) => item.match === 'missing')}
      <p>{tr('frameleaf_studio_editor_import_media_intro', { count: plan.files })}</p>
      <section>
        <h3>{tr('frameleaf_studio_editor_import_found_title')} <small>· {found.length}</small></h3>
        <p class="note">
          <Icon icon={mdiCheckCircleOutline} size="18" />
          <span>{tr('frameleaf_studio_editor_import_found_note')}</span>
        </p>
      </section>
      {#if likely.length > 0}
        <section>
          <h3>{tr('frameleaf_studio_editor_import_likely_title')} <small>· {likely.length}</small></h3>
          <ul class="rows">
            {#each likely as item (item.key)}
              <li>
                <span class="thumb" aria-hidden="true">
                  <Icon icon={item.kind === 'audio' ? mdiWaveform : mdiMovieOpenOutline} size="20" />
                </span>
                <span class="row-text">
                  <strong>{item.name}</strong>
                  <small
                    >{tr('frameleaf_studio_editor_import_in_library_as', { name: item.assetName ?? item.name })}</small
                  >
                </span>
                <span class="sure">{tr(`frameleaf_studio_editor_import_sure_${item.match.replace('-', '_')}`)}</span>
                <label class="use">
                  <input type="checkbox" checked={uses.has(item.key)} onchange={() => toggleUse(item.key)} />
                  {tr('frameleaf_studio_editor_import_use_match')}
                </label>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
      {#if missing.length > 0}
        <section>
          <h3>{tr('frameleaf_studio_editor_import_missing_title')} <small>· {missing.length}</small></h3>
          <ul class="rows">
            {#each missing as item (item.key)}
              {@const file = sending.get(item.key)}
              <li>
                <span class="thumb" aria-hidden="true">
                  <Icon icon={file || item.carried ? mdiUploadOutline : mdiFileQuestionOutline} size="20" />
                </span>
                <span class="row-text">
                  <strong>{item.name}</strong>
                  <small>
                    {#if item.carried}
                      {tr('frameleaf_studio_editor_import_in_archive')}
                    {:else if file}
                      {tr('frameleaf_studio_editor_import_in_folder', { folder: folderName, size: size(file.size) })}
                    {:else if folderName}
                      {tr('frameleaf_studio_editor_import_not_in_folder', { folder: folderName })}
                    {/if}
                  </small>
                </span>
                <span class="sure" class:warn={!file && !item.carried}>
                  {file || item.carried
                    ? tr('frameleaf_studio_editor_import_will_be_added')
                    : tr('frameleaf_studio_editor_import_placeholder')}
                </span>
              </li>
            {/each}
          </ul>
          {#if folderName}
            <div class="card">
              <Icon icon={mdiFolderOutline} size="26" />
              <span>
                <strong>{folderName}</strong>
                <small>
                  {tr('frameleaf_studio_editor_import_folder_found', {
                    found: plan.upload,
                    total: missing.length,
                    size: size(plan.uploadBytes),
                  })}
                </small>
              </span>
              <Button onclick={() => mediaInput?.click()}>{tr('frameleaf_studio_editor_import_choose_another')}</Button>
            </div>
          {:else}
            <div class="empty">
              <Button onclick={() => mediaInput?.click()}>
                <Icon icon={mdiFolderOpenOutline} size="18" />
                {tr('frameleaf_studio_editor_import_choose_media_folder')}
              </Button>
              <small>{tr('frameleaf_studio_editor_import_media_folder_hint')}</small>
            </div>
          {/if}
        </section>
      {/if}
      <p class="total" role="note">
        {tr('frameleaf_studio_editor_import_total', {
          files: plan.files,
          found: plan.found,
          matched: plan.matched,
          added: plan.upload + plan.carried,
          placeholders: plan.placeholders,
        })}
      </p>
      {#if plan.upload + plan.carried > 0}
        <p class="muted small">{tr('frameleaf_studio_editor_import_album_note', { album: albumName })}</p>
      {/if}
    {:else if step === 'progress'}
      <div class="progress-head">
        <strong>{tr(`frameleaf_studio_editor_import_phase_${PHASES[phase]}`)}…</strong>
        <span class="muted">{percent}%</span>
      </div>
      <span class="bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <span style:width="{percent}%"></span>
      </span>
      <ul class="phases">
        {#each PHASES as name, index (name)}
          {#if name !== 'sending' || sending.size > 0}
            <li class:now={index === phase}>
              <Icon
                icon={index < phase ? mdiCheckCircleOutline : index === phase ? mdiProgressClock : mdiCircleOutline}
                size="18"
              />
              {tr(`frameleaf_studio_editor_import_phase_${name}`)}
            </li>
          {/if}
        {/each}
      </ul>
      <p class="muted small">
        {phase === 2 && sending.size > 0
          ? tr('frameleaf_studio_editor_import_keep_open')
          : tr('frameleaf_studio_editor_import_can_close')}
      </p>
    {:else if step === 'report'}
      <p class="note ok" role="status">
        <Icon icon={mdiCheckCircleOutline} size="18" />
        <span>
          {tr('frameleaf_studio_editor_import_report_done', {
            count: builds.length,
            file: check?.fileName ?? '',
            names: builds.map((build) => build.name).join(', '),
          })}
        </span>
      </p>
      {#if buildFailures > 0}
        <p class="note warn">{tr('frameleaf_studio_editor_import_some_failed', { count: buildFailures })}</p>
      {/if}
      <div class="columns">
        <section>
          <h3>{tr('frameleaf_studio_editor_import_what_came_over')}</h3>
          {@render countList(false)}
          <h3>{tr('frameleaf_studio_editor_import_media_title')}</h3>
          <ul class="counts">
            <li>
              <Icon icon={mdiCheck} size="18" />
              <span><span>{tr('frameleaf_studio_editor_import_used', { count: totals.used })}</span></span>
            </li>
            {#if totals.added > 0}
              <li>
                <Icon icon={mdiUploadOutline} size="18" />
                <span>
                  <span>{tr('frameleaf_studio_editor_import_added', { count: totals.added })}</span>
                  <small>{tr('frameleaf_studio_editor_import_added_album', { album: albumName })}</small>
                </span>
              </li>
            {/if}
            {#if totals.placeholders > 0}
              <li>
                <Icon icon={mdiFileQuestionOutline} size="18" />
                <span>
                  <span>{tr('frameleaf_studio_editor_import_placeholders', { count: totals.placeholders })}</span>
                  <small>{tr('frameleaf_studio_editor_import_placeholders_detail')}</small>
                </span>
              </li>
            {/if}
          </ul>
        </section>
        <section>
          <h3>{tr('frameleaf_studio_editor_import_differently')}</h3>
          {@render groups(reportGroups.differently)}
          <h3>{tr('frameleaf_studio_editor_import_couldnt')}</h3>
          {@render groups(reportGroups.cant)}
        </section>
      </div>
      <p class="muted small">{tr('frameleaf_studio_editor_import_report_footer')}</p>
    {:else if step === 'failed'}
      <p class="note warn" role="alert">
        <Icon icon={mdiAlertOutline} size="18" />
        <span>{tr('frameleaf_studio_editor_import_failed')}</span>
      </p>
    {/if}

    <input
      bind:this={fileInput}
      class="sr-only"
      type="file"
      accept={EDITOR_IMPORT_ACCEPT}
      multiple
      tabindex="-1"
      aria-hidden="true"
      onchange={onFiles}
    />
    <input
      bind:this={folderInput}
      class="sr-only"
      type="file"
      webkitdirectory
      tabindex="-1"
      aria-hidden="true"
      onchange={onFiles}
    />
    <input
      bind:this={mediaInput}
      class="sr-only"
      type="file"
      webkitdirectory
      tabindex="-1"
      aria-hidden="true"
      onchange={onMediaFolder}
    />
  </div>

  {#snippet actions()}
    {#if step === 'pick'}
      <Button onclick={close}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={!project || busy} onclick={startCheck}>
        {busy ? tr('frameleaf_studio_editor_import_sending_file') : tr('frameleaf_studio_editor_import_check_button')}
      </Button>
    {:else if step === 'check'}
      <Button onclick={reset} disabled={busy}>{$t('back')}</Button>
      <span class="spacer"></span>
      <Button onclick={close}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={!check || picks.size === 0} onclick={() => (step = 'media')}>
        {$t('continue')}
      </Button>
    {:else if step === 'media'}
      <Button onclick={() => (step = 'check')}>{$t('back')}</Button>
      <span class="spacer"></span>
      <Button onclick={close}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={busy} onclick={startImport}>
        {tr('frameleaf_studio_editor_import_start', { count: picks.size })}
      </Button>
    {:else if step === 'progress'}
      <span class="spacer"></span>
      <Button variant="primary" onclick={close}>{tr('frameleaf_studio_editor_import_hide')}</Button>
    {:else if step === 'report'}
      <Button onclick={close}>{$t('close')}</Button>
      <Button
        variant="primary"
        onclick={() => {
          close();
          onOpenProject(builds[0].projectId);
        }}
      >
        <Icon icon={mdiMovieOpenOutline} size="18" />
        {tr('frameleaf_studio_editor_import_open')}
      </Button>
    {:else}
      <Button onclick={reset}>{$t('back')}</Button>
      <Button variant="primary" onclick={close}>{$t('close')}</Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .sei {
    display: grid;
    gap: var(--fl-space-3);
  }
  .sei p {
    margin: 0;
  }
  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-3);
  }
  .beta {
    padding: 2px var(--fl-space-2);
    border-radius: var(--fl-radius-control);
    background: var(--fl-accent-soft);
    color: var(--fl-accent-text);
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .stepper {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .stepper li {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
  }
  .stepper li > span {
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border: 1px solid var(--fl-border);
    border-radius: 50%;
  }
  .stepper .now,
  .stepper .done {
    color: var(--fl-text);
  }
  .stepper .now > span,
  .stepper .done > span {
    border-color: var(--fl-accent);
    background: var(--fl-accent);
    color: var(--fl-accent-text, #fff);
  }
  h3 {
    margin: var(--fl-space-2) 0 var(--fl-space-1);
    font-size: var(--fl-font-size);
  }
  h3 small,
  .groups strong small {
    color: var(--fl-muted);
    font-weight: 400;
  }
  .muted {
    color: var(--fl-muted);
  }
  .small,
  small {
    font-size: var(--fl-font-small);
  }
  .card,
  .empty {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-3);
    padding: var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .card > span,
  .row-text {
    display: grid;
    flex: 1;
    min-width: 0;
  }
  .card small,
  .row-text small,
  .counts small,
  .groups small,
  .picks small {
    color: var(--fl-muted);
  }
  .empty {
    flex-direction: column;
    align-items: flex-start;
    border-style: dashed;
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--fl-accent);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  .field {
    display: grid;
    gap: var(--fl-space-1);
  }
  .accepts,
  .counts,
  .groups,
  .picks,
  .rows,
  .phases {
    display: grid;
    gap: var(--fl-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .accepts li {
    display: grid;
    grid-template-columns: minmax(8rem, 12rem) 1fr;
    gap: var(--fl-space-2);
  }
  .counts li,
  .phases li,
  .note {
    display: flex;
    align-items: flex-start;
    gap: var(--fl-space-2);
  }
  .counts li > span,
  .groups li {
    display: grid;
  }
  .names {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-1) var(--fl-space-2);
    margin: var(--fl-space-1) 0 0;
    padding: 0;
    list-style: none;
    font-size: var(--fl-font-small);
  }
  .picks label {
    display: flex;
    align-items: flex-start;
    gap: var(--fl-space-2);
  }
  .picks label > span {
    display: grid;
  }
  .columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--fl-space-6);
  }
  .rows li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-3);
  }
  .thumb {
    display: inline-grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
  }
  .sure {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .sure.warn,
  .note.warn {
    color: var(--fl-warning);
  }
  .note.ok {
    color: var(--fl-success-text, var(--fl-success));
  }
  .use {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
  }
  .total {
    padding-top: var(--fl-space-2);
    border-top: 1px solid var(--fl-border);
  }
  .waiting,
  .progress-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-2);
  }
  .waiting {
    justify-content: flex-start;
  }
  .bar {
    display: block;
    height: 6px;
    overflow: hidden;
    border-radius: 3px;
    background: var(--fl-border);
  }
  .bar > span {
    display: block;
    height: 100%;
    background: var(--fl-accent);
    transition: width var(--fl-motion) var(--fl-ease);
  }
  .phases li {
    color: var(--fl-muted);
  }
  .phases li.now {
    color: var(--fl-text);
    font-weight: 600;
  }
  .spacer {
    flex: 1;
  }
  @media (max-width: 600px) {
    .accepts li {
      grid-template-columns: 1fr;
    }
  }
</style>
