<script lang="ts">
  /**
   * FL-38 (V-28): the Frameleaf face tagger, ported from the September 22 prototype's
   * `FaceTagEditor` (design/frameleaf/template/src/FaceTagger.jsx:37-745) and its styles
   * (face-tagger.css). It replaces the legacy fabric-canvas overlay (`FaceEditor.svelte`) and
   * `CreateFaceModal.svelte`.
   *
   * Differences from the prototype, which saved into a localStorage model:
   * - The asset's existing faces load as `detected` regions. The API can reassign
   *   (`reassignFacesById`) or delete (`deleteFace`) a face but has no endpoint to change an
   *   existing face's box, so a detected region's position is read-only here.
   * - New regions are saved with `createFace` in pixels of the loaded preview; people created
   *   in the dialog are created with `createPerson` only when a saved face uses them.
   * - The stale-revision banner (FaceTagger.jsx:710-717) is deferred by owner decision.
   */
  import '$lib/frameleaf/tokens.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import {
    boxFromPoints,
    checkPersonName,
    DEFAULT_FACE_BOX,
    draftFromFace,
    hasFaceTagChanges,
    imageContentRect,
    imagePoint,
    isDraftSavable,
    keyboardFaceBox,
    MAX_FACES,
    MAX_PERSON_NAME,
    moveFaceBox,
    planFaceTagSave,
    projectSavedFaces,
    pushHistory,
    rebaseAfterPartialSave,
    resizeFaceBox,
    toPercent,
    toPixelBox,
    adjustFaceBox,
    type DraftFace,
    type DraftPerson,
    type FaceBox,
    type FaceBoxField,
    type Point,
    type Size,
  } from '$lib/frameleaf/face-tags';
  import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import {
    AssetMediaSize,
    AssetTypeEnum,
    AssetVisibility,
    createFace,
    createPerson,
    deleteFace,
    getAllPeople,
    getFaces,
    reassignFacesById,
    type AssetFaceResponseDto,
    type AssetResponseDto,
    type PersonResponseDto,
  } from '@immich/sdk';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import { mdiCheck, mdiClose } from '@mdi/js';
  import { onDestroy, onMount, tick } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
    onClose: () => void;
    /** Re-reads the viewer's asset and faces after a save changed anything. */
    onSaved: () => void | Promise<void>;
  };

  const { asset, onClose, onSaved }: Props = $props();

  type Gesture = {
    mode: 'draw' | 'move' | 'resize';
    origin: Point;
    before: DraftFace[];
    face?: DraftFace;
    pointerId: number;
    box?: FaceBox | null;
  };

  const NEW_FACE = 'new-face-';
  const NEW_PERSON = 'new-person-';
  const PEOPLE_PAGE_SIZE = 1000;
  const COORDINATES: [FaceBoxField, string][] = [
    ['x', 'frameleaf_face_tagger_left'],
    ['y', 'frameleaf_face_tagger_top'],
    ['width', 'frameleaf_face_tagger_width'],
    ['height', 'frameleaf_face_tagger_height'],
  ];

  const ids = $props.id();
  const titleId = `${ids}-title`;
  const helpId = `${ids}-help`;

  let dialog: HTMLDialogElement;
  let stage = $state<HTMLDivElement>();
  let closeButton = $state<HTMLDivElement>();
  let searchInput = $state<HTMLInputElement>();
  let alive = true;

  let loading = $state(true);
  let baseline = $state<DraftFace[]>([]);
  let draft = $state<DraftFace[]>([]);
  let history = $state<DraftFace[][]>([]);
  let people = $state<PersonResponseDto[]>([]);
  /** People already on this asset's faces; they may be hidden, so getAllPeople can omit them. */
  let facePeople = $state<PersonResponseDto[]>([]);
  let addedPeople = $state<DraftPerson[]>([]);
  let selectedId = $state<string | null>(null);
  let drawing = $state(false);
  let preview = $state<FaceBox | null>(null);
  let gesture: Gesture | null = null;
  let query = $state('');
  let newName = $state('');
  let showNew = $state(false);
  let error = $state('');
  let saving = $state(false);
  let natural = $state<Size | null>(null);
  let viewport = $state<Size>({ width: 0, height: 0 });
  let imageFailed = $state(false);
  let loadFailed = $state(false);

  // Dialog.svelte: the dialog renders in the top layer, so it carries its own theme scope.
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  const isVideo = $derived(asset.type === AssetTypeEnum.Video);
  // A video is tagged on its preview frame (FaceTagger.jsx:397, " · Video preview").
  const source = $derived(getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash }));
  const content = $derived(imageContentRect(viewport, natural));

  /**
   * face-tags.mjs `canTagAsset`: only the owner tags faces, never on a trashed asset, and a
   * locked asset only while the session is unlocked. A lock that lands while the dialog is
   * open closes it (FaceTagger.jsx:24-35).
   */
  const available = $derived(
    authManager.authenticated &&
      !authManager.isSharedLink &&
      asset.ownerId === authManager.user.id &&
      !asset.isTrashed &&
      (asset.visibility !== AssetVisibility.Locked || sessionAccess.isElevated) &&
      !sessionAccess.lockPending &&
      !sessionAccess.concealed,
  );

  const candidates = $derived<(PersonResponseDto | DraftPerson)[]>([
    ...people,
    ...addedPeople.filter((person) => people.every((existing) => existing.id !== person.id)),
  ]);
  const names = $derived(new Map([...facePeople, ...candidates].map((person) => [person.id, person.name])));
  const selected = $derived(draft.find((face) => face.id === selectedId));
  const matched = $derived(
    candidates.filter((person) => person.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),
  );
  const plan = $derived(planFaceTagSave(baseline, draft, addedPeople));
  const changed = $derived(hasFaceTagChanges(plan) || addedPeople.length > 0);
  const valid = $derived(
    !!natural && !imageFailed && !loading && !loadFailed && isDraftSavable(draft, new Set(names.keys())),
  );
  const needsPerson = $derived(draft.some((face) => !face.personId && !face.detected));

  const labelFor = (face: DraftFace) =>
    (face.personId && names.get(face.personId)) ||
    (face.detected ? $t('frameleaf_face_tagger_unnamed_person') : $t('frameleaf_face_tagger_choose_person'));
  const snapshot = () => $state.snapshot(draft) as DraftFace[];
  const personsOf = (faces: AssetFaceResponseDto[]) =>
    faces.map((face) => face.person).filter((person): person is PersonResponseDto => !!person);
  const isNewPerson = (person: PersonResponseDto | DraftPerson): person is DraftPerson =>
    person.id.startsWith(NEW_PERSON);

  $effect(() => {
    if (!available) {
      onClose();
    }
  });

  const loadPeople = async () => {
    const rows: PersonResponseDto[] = [];
    for (let page = 1; ; page++) {
      const response = await getAllPeople({ page, size: PEOPLE_PAGE_SIZE, withHidden: false });
      rows.push(...response.people);
      if (!response.hasNextPage || response.people.length === 0) {
        return rows;
      }
    }
  };

  const load = async () => {
    try {
      const [faces, list] = await Promise.all([getFaces({ id: asset.id }), loadPeople()]);
      if (!alive) {
        return;
      }
      facePeople = personsOf(faces);
      people = list;
      baseline = faces.map((face) => draftFromFace(face));
      draft = faces.map((face) => draftFromFace(face));
      selectedId = draft[0]?.id ?? null;
      drawing = draft.length === 0;
    } catch {
      // face-tags.mjs:27-30
      loadFailed = true;
      error = $t('frameleaf_face_tagger_error_load');
    } finally {
      loading = false;
    }
  };

  const measure = () => {
    const rect = stage?.getBoundingClientRect();
    if (rect && (rect.width !== viewport.width || rect.height !== viewport.height)) {
      viewport = { width: rect.width, height: rect.height };
    }
  };

  onMount(() => {
    // FaceTagger.jsx:104-141
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    closeButton?.querySelector('button')?.focus();
    void load();

    // FaceTagger.jsx:120-141 also listens for window resizes; the observer already sees those.
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (stage) {
      observer?.observe(stage);
    }
    return () => {
      observer?.disconnect();
      document.body.style.overflow = overflow;
      if (dialog.open) {
        dialog.close();
      }
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
      }
    };
  });

  onDestroy(() => {
    alive = false;
    gesture = null;
  });

  // FaceTagger.jsx:142-160
  const checkpoint = (before = snapshot()) => {
    history = pushHistory(history, before);
  };

  const change = (next: DraftFace[]) => {
    checkpoint();
    draft = next;
    error = '';
  };

  const setBox = (id: string, box: FaceBox) => {
    change(draft.map((face) => (face.id === id ? { ...face, box } : face)));
  };

  const addBox = async (box: FaceBox = DEFAULT_FACE_BOX) => {
    if (!natural || saving || loading || draft.length >= MAX_FACES) {
      return;
    }
    const next: DraftFace = { id: `${NEW_FACE}${crypto.randomUUID()}`, personId: '', box, detected: false };
    change([...draft, next]);
    selectedId = next.id;
    drawing = false;
    query = '';
    await tick();
    searchInput?.focus();
  };

  const point = (event: PointerEvent, clampToImage = false) =>
    stage ? imagePoint(event.clientX, event.clientY, stage.getBoundingClientRect(), content, { clampToImage }) : null;

  // FaceTagger.jsx:170-249
  const start = (event: PointerEvent, mode: Gesture['mode'] = 'draw', face?: DraftFace) => {
    if (event.button > 0 || !content || saving || loading || (!drawing && mode === 'draw')) {
      return;
    }
    const origin = point(event);
    if (!origin) {
      return;
    }
    if (mode === 'draw' && draft.length >= MAX_FACES) {
      error = $t('frameleaf_face_tagger_error_max_faces');
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    stage?.setPointerCapture?.(event.pointerId);
    gesture = {
      mode,
      origin,
      before: snapshot(),
      face: face && ($state.snapshot(face) as DraftFace),
      pointerId: event.pointerId,
    };
    if (face) {
      selectedId = face.id;
    }
    preview = null;
    error = '';
  };

  const move = (event: PointerEvent) => {
    const active = gesture;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    const end = point(event, true);
    if (!end) {
      return;
    }
    if (active.mode === 'draw') {
      active.box = boxFromPoints(active.origin, end);
      preview = active.box;
      return;
    }
    const face = active.face!;
    const box =
      active.mode === 'move'
        ? moveFaceBox(face.box, end.x - active.origin.x, end.y - active.origin.y)
        : resizeFaceBox(face.box, end.x - face.box.x, end.y - face.box.y);
    active.box = box;
    draft = active.before.map((row) => (row.id === face.id ? { ...row, box } : row));
  };

  const finish = (event: PointerEvent) => {
    const active = gesture;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    move(event);
    gesture = null;
    stage?.releasePointerCapture?.(event.pointerId);
    preview = null;
    if (active.mode === 'draw') {
      if (active.box) {
        void addBox(active.box);
      } else {
        error = $t('frameleaf_face_tagger_error_draw_larger');
      }
    } else if (active.box && JSON.stringify(active.box) !== JSON.stringify(active.face?.box)) {
      checkpoint(active.before);
    }
  };

  const cancelGesture = () => {
    const active = gesture;
    if (!active) {
      return false;
    }
    draft = active.before;
    gesture = null;
    preview = null;
    return true;
  };

  const choose = (person: PersonResponseDto | DraftPerson) => {
    if (!selected || saving) {
      return;
    }
    const id = selected.id;
    change(draft.map((face) => (face.id === id ? { ...face, personId: person.id } : face)));
    showNew = false;
  };

  const createPersonInline = (event: SubmitEvent) => {
    event.preventDefault();
    if (!selected || saving) {
      return;
    }
    const result = checkPersonName(newName, [...facePeople, ...candidates]);
    if (result.problem) {
      error =
        result.problem === 'duplicate'
          ? $t('frameleaf_face_tagger_error_duplicate_name')
          : $t('frameleaf_face_tagger_error_name', { values: { max: MAX_PERSON_NAME } });
      return;
    }
    const person = { id: `${NEW_PERSON}${crypto.randomUUID()}`, name: result.name };
    addedPeople = [...addedPeople, person];
    choose(person);
    newName = '';
    query = '';
  };

  const removeSelected = () => {
    if (!selected) {
      return;
    }
    const id = selected.id;
    change(draft.filter((face) => face.id !== id));
    selectedId = draft.find((face) => face.id !== id)?.id ?? null;
  };

  const undo = () => {
    const previous = history.at(-1);
    if (!previous) {
      return;
    }
    draft = previous;
    history = history.slice(0, -1);
    selectedId = previous[0]?.id ?? null;
    error = '';
  };

  const refreshViewer = async () => {
    try {
      await onSaved();
    } catch {
      // The viewer re-reads its faces on the next navigation; the save itself landed.
    }
  };

  /** FaceTagger.jsx:284-314, applied through the real face and person endpoints. */
  const save = async () => {
    if (!valid || saving || !natural) {
      return;
    }
    const size = natural;
    const current = snapshot();
    const work = planFaceTagSave(baseline, current, $state.snapshot(addedPeople) as DraftPerson[]);
    saving = true;
    error = '';

    const personIds = new Map<string, string>();
    const created: PersonResponseDto[] = [];
    for (const person of work.newPeople) {
      try {
        const response = await createPerson({ personCreateDto: { name: person.name } });
        personIds.set(person.id, response.id);
        created.push(response);
      } catch {
        // Every face that uses this person is reported as failed below.
      }
    }
    const resolve = (id: string) => personIds.get(id) ?? (id.startsWith(NEW_PERSON) ? undefined : id);

    const failed = { deletes: new Set<string>(), reassigns: new Set<string>(), creates: new Set<string>() };
    for (const faceId of work.deletes) {
      try {
        // Permanent, like the People chip menu's "Remove face" (PersonFaceActions.svelte).
        await deleteFace({ id: faceId, assetFaceDeleteDto: { force: true } });
      } catch {
        failed.deletes.add(faceId);
      }
    }
    for (const { faceId, personId } of work.reassigns) {
      const id = resolve(personId);
      try {
        if (!id) {
          throw new Error('person not created');
        }
        await reassignFacesById({ id, faceDto: { id: faceId } });
      } catch {
        failed.reassigns.add(faceId);
      }
    }
    for (const { faceId, personId, box } of work.creates) {
      const id = resolve(personId);
      try {
        if (!id) {
          throw new Error('person not created');
        }
        await createFace({
          assetFaceCreateDto: {
            assetId: asset.id,
            personId: id,
            imageWidth: size.width,
            imageHeight: size.height,
            ...toPixelBox(box, size),
          },
        });
      } catch {
        failed.creates.add(faceId);
      }
    }

    const failures = failed.deletes.size + failed.reassigns.size + failed.creates.size;
    const attempted = work.deletes.length + work.reassigns.length + work.creates.length;
    if (created.length > 0 || failures < attempted) {
      await refreshViewer();
    }
    if (!alive) {
      return;
    }
    if (failures === 0) {
      onClose();
      return;
    }

    // Keep the dialog open with only the changes that still need saving (FaceTagger.jsx:299-303).
    people = [...people, ...created];
    addedPeople = addedPeople.filter((person) => !personIds.has(person.id));
    let server: DraftFace[];
    try {
      const faces = await getFaces({ id: asset.id });
      facePeople = personsOf(faces);
      server = faces.map((face) => draftFromFace(face));
    } catch {
      server = projectSavedFaces(baseline, work, failed, personIds);
    }
    if (!alive) {
      return;
    }
    baseline = server;
    draft = rebaseAfterPartialSave(server, current, failed, personIds);
    history = [];
    if (draft.every((face) => face.id !== selectedId)) {
      selectedId = draft[0]?.id ?? null;
    }
    error = $t('frameleaf_face_tagger_error_save');
    saving = false;
  };

  // FaceTagger.jsx:315-367
  const onKeydown = (event: KeyboardEvent) => {
    // A modal: the viewer's own shortcuts (navigation, zoom, playback) must not see these keys.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!cancelGesture() && !saving) {
        onClose();
      }
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest('input,textarea') || saving || !selected || selected.detected) {
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      return;
    }
    const box = keyboardFaceBox(selected.box, event.key, { shiftKey: event.shiftKey, altKey: event.altKey });
    if (box) {
      event.preventDefault();
      setBox(selected.id, box);
    }
  };

  const onImageLoad = (event: Event) => {
    const element = event.currentTarget as HTMLImageElement;
    if (element.naturalWidth > 0 && element.naturalHeight > 0) {
      natural = { width: element.naturalWidth, height: element.naturalHeight };
      measure();
    }
  };

  const onImageError = () => {
    imageFailed = true;
    natural = null;
    error = $t('frameleaf_face_tagger_error_image');
  };

  const select = (id: string) => {
    selectedId = id;
    drawing = false;
  };

  const statusText = $derived(
    needsPerson
      ? $t('frameleaf_face_tagger_status_choose')
      : changed
        ? $t('frameleaf_face_tagger_status_ready')
        : $t('frameleaf_face_tagger_status_idle'),
  );
</script>

<dialog
  bind:this={dialog}
  class="frameleaf face-tagger"
  data-theme={appTheme}
  aria-labelledby={titleId}
  onkeydown={onKeydown}
  oncancel={(event) => {
    event.preventDefault();
    if (!saving) {
      onClose();
    }
  }}
>
  <header class="ft-header">
    <div>
      <h2 id={titleId}>{$t('frameleaf_face_tagger_title')}</h2>
      <p>
        {isVideo
          ? $t('frameleaf_face_tagger_video_preview', { values: { name: asset.originalFileName } })
          : asset.originalFileName}
      </p>
    </div>
    <div bind:this={closeButton}>
      <IconButton label={$t('frameleaf_face_tagger_close')} disabled={saving} onclick={onClose}>
        <Icon icon={mdiClose} size="1.125rem" />
      </IconButton>
    </div>
  </header>
  <div class="ft-layout">
    <section class="ft-photo-panel" aria-label={$t('frameleaf_face_tagger_regions')}>
      <div class="ft-toolbar">
        <Button
          pressed={drawing}
          disabled={!natural || saving || loading}
          onclick={() => {
            drawing = !drawing;
            error = '';
          }}
        >
          {$t('frameleaf_face_tagger_draw_face')}
        </Button>
        <Button disabled={!natural || saving || loading || draft.length >= MAX_FACES} onclick={() => addBox()}>
          {$t('frameleaf_face_tagger_add_face')}
        </Button>
        <Button disabled={history.length === 0 || saving} onclick={undo}>{$t('undo')}</Button>
        <span>{$t('frameleaf_face_tagger_face_count', { values: { count: draft.length } })}</span>
      </div>
      <!-- The prototype's stage takes focus so its region shortcuts are reachable (FaceTagger.jsx:450-460). -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        bind:this={stage}
        class="ft-stage"
        class:drawing
        role="application"
        tabindex="0"
        aria-label={$t('frameleaf_face_tagger_stage')}
        aria-describedby={helpId}
        onpointerdown={(event) => start(event)}
        onpointermove={move}
        onpointerup={finish}
        onpointercancel={cancelGesture}
      >
        {#if imageFailed}
          <p class="ft-image-error">{$t('frameleaf_face_tagger_image_unavailable')}</p>
        {:else}
          <img
            src={source}
            alt={asset.originalFileName}
            draggable="false"
            onload={onImageLoad}
            onerror={onImageError}
          />
        {/if}
        {#if content}
          <div
            class="ft-image-plane"
            style:left="{content.left}px"
            style:top="{content.top}px"
            style:width="{content.width}px"
            style:height="{content.height}px"
          >
            {#each draft as face, index (face.id)}
              {@const label = labelFor(face)}
              <div
                class="ft-face-box"
                class:selected={face.id === selectedId}
                class:detected={face.detected}
                style:left="{face.box.x * 100}%"
                style:top="{face.box.y * 100}%"
                style:width="{face.box.width * 100}%"
                style:height="{face.box.height * 100}%"
              >
                <button
                  type="button"
                  class="ft-face-move"
                  aria-label={$t('frameleaf_face_tagger_face_label', { values: { index: index + 1, name: label } })}
                  aria-pressed={face.id === selectedId}
                  disabled={saving}
                  onclick={() => select(face.id)}
                  onpointerdown={(event) => {
                    if (face.detected) {
                      event.stopPropagation();
                      return;
                    }
                    start(event, 'move', face);
                  }}
                >
                  <span>{index + 1} · {label}</span>
                </button>
                {#if face.id === selectedId && !face.detected}
                  <button
                    type="button"
                    class="ft-resize"
                    aria-label={$t('frameleaf_face_tagger_resize', { values: { index: index + 1 } })}
                    title={$t('frameleaf_face_tagger_resize_hint')}
                    disabled={saving}
                    onpointerdown={(event) => start(event, 'resize', face)}
                  ></button>
                {/if}
              </div>
            {/each}
            {#if preview}
              <div
                class="ft-drawing-box"
                style:left="{preview.x * 100}%"
                style:top="{preview.y * 100}%"
                style:width="{preview.width * 100}%"
                style:height="{preview.height * 100}%"
              ></div>
            {/if}
          </div>
        {/if}
      </div>
      <p id={helpId} class="ft-help">
        {drawing ? $t('frameleaf_face_tagger_help_drawing') : $t('frameleaf_face_tagger_help_editing')}
      </p>
    </section>
    <aside class="ft-sidebar" aria-label={$t('frameleaf_face_tagger_details')}>
      {#if draft.length > 0}
        <div class="ft-face-list" role="group" aria-label={$t('frameleaf_face_tagger_faces_list')}>
          {#each draft as face, index (face.id)}
            <button
              type="button"
              class:active={face.id === selectedId}
              aria-pressed={face.id === selectedId}
              onclick={() => select(face.id)}
            >
              <span>{index + 1}</span>
              {labelFor(face)}
            </button>
          {/each}
        </div>
      {/if}
      {#if selected}
        {@const current = selected}
        <section class="ft-position">
          <div class="ft-section-title">
            <h3>{$t('frameleaf_face_tagger_position')}</h3>
            <Button variant="quiet" disabled={saving} onclick={removeSelected}>
              {$t('frameleaf_faces_remove_face')}
            </Button>
          </div>
          <div class="ft-coordinates">
            {#each COORDINATES as [key, labelKey] (key)}
              <label>
                {$t(labelKey)}
                <input
                  type="number"
                  aria-label={$t(labelKey)}
                  step="0.1"
                  min={key === 'width' || key === 'height' ? '0.5' : '0'}
                  max="100"
                  value={toPercent(current.box[key])}
                  disabled={saving || current.detected}
                  oninput={(event) => {
                    const value = event.currentTarget.value;
                    if (value !== '') {
                      setBox(current.id, adjustFaceBox(current.box, key, Number(value) / 100));
                    }
                  }}
                />
              </label>
            {/each}
          </div>
          <p>
            {current.detected ? $t('frameleaf_face_tagger_detected_note') : $t('frameleaf_face_tagger_position_note')}
          </p>
        </section>
        <section class="ft-assign">
          <h3>{$t('frameleaf_face_tagger_who')}</h3>
          <input
            bind:this={searchInput}
            type="search"
            aria-label={$t('frameleaf_faces_find_person')}
            placeholder={$t('frameleaf_faces_find_person')}
            bind:value={query}
            disabled={saving}
          />
          <div class="ft-person-list">
            {#each matched.slice(0, 100) as person (person.id)}
              {@const active = current.personId === person.id}
              <button type="button" disabled={saving} aria-pressed={active} class:active onclick={() => choose(person)}>
                {#if isNewPerson(person)}
                  <span class="ft-avatar-placeholder" aria-hidden="true">{person.name.charAt(0)}</span>
                {:else}
                  <PersonAvatar {person} size={36} />
                {/if}
                <span class="ft-person-name">{person.name}</span>
                {#if active}
                  <Icon icon={mdiCheck} size="17" aria-hidden="true" />
                {/if}
              </button>
            {/each}
            {#if matched.length === 0}
              <p>{$t('frameleaf_face_tagger_no_matches')}</p>
            {/if}
            {#if matched.length > 100}
              <p>{$t('frameleaf_face_tagger_keep_typing')}</p>
            {/if}
          </div>
          <div class="ft-new-person">
            <Button
              disabled={saving}
              pressed={showNew}
              onclick={() => {
                showNew = !showNew;
                newName = query;
              }}
            >
              {$t('create_person')}
            </Button>
          </div>
          {#if showNew}
            <form class="ft-create-person" onsubmit={createPersonInline}>
              <label>
                {$t('frameleaf_face_tagger_person_name')}
                <input
                  type="text"
                  aria-label={$t('frameleaf_faces_new_person_name')}
                  maxlength={MAX_PERSON_NAME}
                  bind:value={newName}
                  disabled={saving}
                />
              </label>
              <Button type="submit" disabled={!newName.trim() || saving}>
                {$t('frameleaf_face_tagger_create_and_assign')}
              </Button>
            </form>
          {/if}
        </section>
      {:else}
        <div class="ft-empty">
          <h3>{$t('frameleaf_face_tagger_empty_title')}</h3>
          <p>{$t('frameleaf_face_tagger_empty_body')}</p>
        </div>
      {/if}
    </aside>
  </div>
  {#if error}
    <div class="ft-message error" role="alert">{error}</div>
  {/if}
  <footer class="ft-footer">
    <span>{statusText}</span>
    <Button disabled={saving} onclick={onClose}>{$t('cancel')}</Button>
    <Button variant="primary" disabled={!valid || saving} onclick={save}>
      {saving ? $t('frameleaf_face_tagger_saving') : $t('frameleaf_face_tagger_save')}
    </Button>
  </footer>
</dialog>

<style>
  /* design/frameleaf/template/src/face-tagger.css, on the Frameleaf token scale. */
  .face-tagger {
    position: fixed;
    inset: 0;
    width: min(1180px, calc(100vw - 48px));
    height: min(840px, calc(100dvh - 48px));
    max-width: none;
    max-height: none;
    margin: auto;
    padding: 0;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-dialog);
    background: var(--fl-panel);
    color: var(--fl-text);
    overflow: hidden;
  }
  .face-tagger[open] {
    display: flex;
    flex-direction: column;
  }
  .face-tagger::backdrop {
    background: #080a0ed9;
  }
  .face-tagger :global(*) {
    box-sizing: border-box;
  }
  .ft-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 18px 22px;
    gap: 16px;
    border-bottom: 1px solid var(--fl-border);
    flex-shrink: 0;
  }
  .ft-header h2 {
    font-size: 17px;
    font-weight: 550;
    margin: 0 0 5px;
  }
  .ft-header p {
    font-size: 12px;
    margin: 0;
    color: var(--fl-muted);
  }
  .ft-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 310px;
    flex: 1;
    min-height: 0;
  }
  .ft-photo-panel {
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .ft-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
  }
  .ft-toolbar > span {
    margin-left: auto;
    font-size: 11px;
    color: var(--fl-muted);
  }
  .ft-stage {
    position: relative;
    min-height: 160px;
    flex: 1;
    overflow: hidden;
    background: #08090c;
    touch-action: none;
  }
  .ft-stage > img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    position: absolute;
    inset: 0;
    pointer-events: none;
    user-select: none;
  }
  .ft-stage.drawing {
    cursor: crosshair;
  }
  .ft-image-plane {
    position: absolute;
    pointer-events: none;
  }
  .ft-face-box {
    position: absolute;
    border: 2px solid #b9c4dc;
    box-shadow: 0 0 0 1px #05080a88;
    pointer-events: auto;
  }
  .ft-face-box.selected {
    border-color: #a1dbad;
    background: #96d3a316;
    z-index: 2;
  }
  .ft-face-box.detected {
    border-style: dashed;
  }
  .ft-face-move {
    position: static;
    width: 100%;
    height: 100%;
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    display: block;
    cursor: move;
  }
  .ft-face-box.detected .ft-face-move {
    cursor: pointer;
  }
  .ft-face-move > span {
    position: absolute;
    left: -2px;
    bottom: calc(100% + 3px);
    max-width: 220px;
    width: max-content;
    padding: 4px 6px;
    font-size: 10px;
    background: #11161bea;
    color: #fff;
    border-radius: 3px;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ft-resize {
    position: absolute;
    right: -7px;
    bottom: -7px;
    width: 14px;
    height: 14px;
    min-height: 0;
    min-width: 0;
    border: 1px solid #17291d;
    border-radius: 2px;
    padding: 0;
    background: #b7e7c1;
    cursor: nwse-resize;
  }
  .ft-stage.drawing .ft-face-box {
    pointer-events: none;
  }
  .ft-drawing-box {
    position: absolute;
    border: 2px dashed #b7e7c1;
    background: #96d3a322;
  }
  .ft-help {
    margin: 0;
    padding: 12px 16px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--fl-muted);
    min-height: 50px;
  }
  .ft-sidebar {
    border-left: 1px solid var(--fl-border);
    padding: 16px;
    overflow: auto;
  }
  .ft-face-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .ft-face-list button,
  .ft-person-list button {
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    padding: 6px 11px;
    font-size: 12px;
  }
  .ft-face-list button {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ft-face-list button:hover:not(:disabled),
  .ft-face-list button.active,
  .ft-person-list button:hover:not(:disabled),
  .ft-person-list button.active {
    border-color: var(--fl-accent);
  }
  .ft-face-list button > span {
    font-variant-numeric: tabular-nums;
    color: var(--fl-muted);
  }
  .ft-section-title {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: space-between;
    margin: 18px 0 12px;
  }
  .ft-sidebar h3 {
    font-size: 12px;
    font-weight: 550;
    margin: 0;
  }
  .ft-coordinates {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .ft-coordinates label,
  .ft-create-person label {
    display: grid;
    gap: 6px;
    font-size: 11px;
    color: var(--fl-muted);
  }
  .ft-sidebar input {
    width: 100%;
    min-width: 0;
    font-size: 12px;
  }
  .ft-position p,
  .ft-empty p,
  .ft-person-list p {
    color: var(--fl-muted);
    font-size: 11px;
    line-height: 1.5;
  }
  .ft-assign {
    margin-top: 20px;
    border-top: 1px solid var(--fl-border);
    padding-top: 16px;
  }
  .ft-assign h3 {
    margin-bottom: 10px;
  }
  .ft-person-list {
    display: grid;
    gap: 5px;
    max-height: 224px;
    overflow-y: auto;
    margin-top: 10px;
  }
  .ft-person-list button {
    display: flex;
    align-items: center;
    gap: 9px;
    text-align: left;
    background: transparent;
    border-color: transparent;
    padding: 6px;
  }
  .ft-person-name {
    flex: 1;
  }
  .ft-avatar-placeholder {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .ft-new-person {
    display: grid;
    margin-top: 12px;
  }
  .ft-create-person {
    display: grid;
    gap: 10px;
    margin-top: 12px;
  }
  .ft-empty {
    padding-top: 12px;
  }
  .ft-footer {
    display: flex;
    justify-content: flex-end;
    gap: 9px;
    align-items: center;
    border-top: 1px solid var(--fl-border);
    padding: 14px 18px;
    flex-shrink: 0;
  }
  .ft-footer > span {
    margin-right: auto;
    font-size: 11px;
    color: var(--fl-muted);
  }
  .ft-message {
    padding: 10px 18px;
    font-size: 12px;
    border-top: 1px solid var(--fl-border);
    flex-shrink: 0;
  }
  .ft-message.error {
    color: var(--fl-danger);
  }
  .ft-image-error {
    color: var(--fl-muted);
    padding: 30px;
    font-size: 13px;
    text-align: center;
  }
  @media (max-width: 760px) {
    .face-tagger {
      width: 100%;
      height: 100dvh;
      border-radius: 0;
      border: 0;
    }
    .ft-layout {
      grid-template-columns: minmax(0, 1fr) 275px;
    }
    .ft-header {
      padding: 12px 16px;
    }
    .ft-sidebar {
      padding: 12px;
    }
  }
  @media (max-width: 560px) {
    .ft-layout {
      display: block;
      overflow: auto;
    }
    .ft-photo-panel {
      height: clamp(320px, 50dvh, 480px);
    }
    .ft-sidebar {
      border-left: 0;
      border-top: 1px solid var(--fl-border);
      overflow: visible;
    }
    .ft-person-list {
      max-height: 180px;
      grid-template-columns: 1fr 1fr;
    }
    .ft-person-list button {
      min-width: 0;
    }
    .ft-person-name {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ft-footer {
      flex-wrap: wrap;
      padding: 10px 12px;
    }
    .ft-footer > span {
      flex-basis: 100%;
    }
    .ft-toolbar {
      gap: 6px;
      padding: 10px 12px;
    }
    .ft-help {
      padding: 8px 12px;
    }
  }
</style>
