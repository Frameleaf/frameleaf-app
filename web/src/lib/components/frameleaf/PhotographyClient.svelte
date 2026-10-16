<script lang="ts">
  /**
   * The client's private gallery: a photographer's customer opens an invitation, favourites
   * photographs, leaves notes, sends selections, approves edits and downloads.
   *
   * Favourites and notes save by themselves a moment after the last change, with a quiet status
   * beside the count; there is no Save button to find, and leaving with something unsaved asks first.
   * "Send selections" stays the one deliberate action. Everything shown is translated.
   *
   * The entrance opens the invitation straight away and asks for a password only when the gallery
   * has one. A photographer's Client preview (`#preview=` from the workspace) shows the same pages
   * with nothing saved or sent.
   */
  import { onMount, onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiChevronLeft,
    mdiChevronRight,
    mdiClockOutline,
    mdiEyeOutline,
    mdiHeart,
    mdiHeartOutline,
    mdiLockOutline,
  } from '@mdi/js';
  import { locale } from '$lib/stores/preferences.store';
  import {
    galleryRequest,
    galleryMedia,
    galleryFile,
    galleryLogo,
    openGallerySession,
    type GuestGallery,
    type GuestPhoto,
    type Annotation,
    type PresentationBlock,
    type PublicBrand,
  } from '$lib/frameleaf/photography/workflow-api';
  import Dialog from './Dialog.svelte';
  import PhotographyStatus, { photographyErrorKey, photographyLabelKey } from './PhotographyStatus.svelte';
  import '$lib/frameleaf/photography/gallery.css';
  let { galleryId }: { galleryId: string } = $props();
  let gallery = $state<GuestGallery | null>(null);
  let session = $state('');
  let invitation = $state('');
  let password = $state('');
  /** The invitation is good and its gallery has a password: the entrance asks for it. */
  let needsPassword = $state(false);
  /** The studio's look for the entrance, before the gallery itself is open. */
  let gateBrand = $state<PublicBrand | null>(null);
  /** The server ended access (expired, revoked or a bad link): the entrance says so. */
  let accessEnded = $state(false);
  let busy = $state(false);
  let error = $state('');
  let notice = $state('');
  let dirty = $state(false);
  // Autosave: `edits` counts changes, so a save knows whether more arrived while it was away.
  const AUTOSAVE_MS = 800;
  let saveState = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveRunning: Promise<boolean> | null = null;
  /** The tab is being hidden or closed: saves ask the browser to finish them after the page goes. */
  let leaving = false;
  /** A request that outlives the page may carry 64 KB at most; a larger save goes the normal way. */
  const KEEPALIVE_LIMIT = 60_000;
  let edits = 0;
  let justFavorited = $state('');
  let expiresAt = $state('');
  let choices = $state<string[]>([]);
  let notes = $state<Record<string, string>>({});
  let annotations = $state<Record<string, Annotation[]>>({});
  let marking = $state(false);
  let annotationStart: { x: number; y: number; pointerId: number } | null = null;
  let annotationDraft = $state<Annotation | null>(null);
  let slideIndexes = $state<Record<string, number>>({});
  let thumbnails = $state<Record<string, string>>({});
  let logo = $state('');
  let coverPreview = $state('');
  let coverImageId = '';
  let preview = $state('');
  let comparison = $state<Record<string, string>>({});
  let compareIds = $state<string[]>([]);
  let compareOpen = $state(false);
  let opened = $state<GuestPhoto | null>(null);
  let openedOutput = $state<NonNullable<GuestPhoto['outputs']>[number] | null>(null);
  let downloadChoices = $state<string[]>([]);
  let confirmSubmit = $state(false);
  let chapter = $state('');
  let favoritesOnly = $state(false);
  let limit = $state(80);
  let generation = 0;
  let previewRequest = 0;
  let disposed = false;
  let thumbnailLoading = false;
  let thumbnailPending = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const storageKey = () => `photography-gallery:${galleryId}`;
  const filtered = $derived(
    (gallery?.photos ?? []).filter(
      (photo) => (!chapter || photo.chapterId === chapter) && (!favoritesOnly || choices.includes(photo.id)),
    ),
  );
  const visible = $derived(filtered.slice(0, limit));
  /** The photographer's Client preview: the client's pages, with nothing saved, sent or bought. */
  const ownerPreview = $derived(!!gallery?.preview);
  const downloads = $derived(gallery?.photos.filter((photo) => photo.canDownload) ?? []);
  const readyOutputs = $derived(
    gallery?.photos.flatMap((photo) =>
      (photo.outputs ?? []).filter((output) => output.canDownload).map((output) => ({ photo, output })),
    ) ?? [],
  );
  const approvalRevision = $derived(
    openedOutput ? (openedOutput.approvalPreviewUrl ? openedOutput.revisionId : null) : opened?.approvalRevisionId,
  );
  const downloadChoiceIds = $derived(new Set(downloadChoices));
  const chosenOutputs = $derived(readyOutputs.filter(({ output }) => downloadChoiceIds.has(output.id)));
  const archiveCount = $derived(readyOutputs.length > 0 ? chosenOutputs.length : downloads.length);
  /** Finished files are ready to keep: the cover calls it the client's finished collection. */
  const finished = $derived(downloads.length > 0 || readyOutputs.length > 0);
  const archiveParts = $derived(Math.ceil(archiveCount / 1000));
  const cover = $derived(
    gallery?.photos.find((photo) => photo.id === gallery?.presentation.coverCaptureId) ?? gallery?.photos[0],
  );
  /** The studio's initials for the round mark beside its name when it has no logo ("Cedar & Light" → CL). */
  const monogram = (name: string) =>
    name
      .split(/\s+/)
      .filter((word) => /\p{L}/u.test(word.charAt(0)))
      .slice(0, 2)
      .map((word) => word.charAt(0).toUpperCase())
      .join('');
  const money = (total: number, currency: string) =>
    new Intl.NumberFormat($locale, { style: 'currency', currency }).format(total / 100);
  const selectedPrice = $derived(
    gallery ? Math.max(0, choices.length - gallery.pricing.includedCount) * gallery.pricing.additionalPrice : 0,
  );
  function blockPhotos(block: PresentationBlock) {
    const candidates = filtered.filter((photo) => !block.chapterId || photo.chapterId === block.chapterId);
    const byId = new Map(candidates.map((photo) => [photo.id, photo]));
    const explicit = block.selection === 'explicit' || (block.selection === undefined && block.captureIds.length > 0);
    const photos = explicit
      ? block.captureIds.map((id) => byId.get(id)).filter((photo): photo is GuestPhoto => !!photo)
      : candidates;
    return block.type === 'full'
      ? photos.slice(0, 1)
      : block.type === 'pair'
        ? photos.slice(0, 2)
        : block.type === 'slideshow'
          ? photos
          : photos.slice(0, limit);
  }
  const displayed = $derived.by(() =>
    gallery?.presentation.blocks?.length
      ? gallery.presentation.blocks.flatMap((block) => {
          if (['chapter', 'caption'].includes(block.type)) {
            return [];
          }
          const photos = blockPhotos(block);
          return block.type === 'slideshow'
            ? photos.slice(
                Math.min(slideIndexes[block.id] ?? 0, photos.length - 1),
                Math.min(slideIndexes[block.id] ?? 0, photos.length - 1) + 1,
              )
            : photos;
        })
      : visible,
  );
  function closePhoto() {
    previewRequest++;
    if (preview) {
      URL.revokeObjectURL(preview);
    }
    preview = '';
    opened = null;
    openedOutput = null;
    marking = false;
    annotationStart = null;
    annotationDraft = null;
  }
  const clearImages = () => {
    for (const url of Object.values(thumbnails)) {
      URL.revokeObjectURL(url);
    }
    for (const url of Object.values(comparison)) {
      URL.revokeObjectURL(url);
    }
    closePhoto();
    if (logo) {
      URL.revokeObjectURL(logo);
    }
    if (coverPreview) {
      URL.revokeObjectURL(coverPreview);
    }
    coverPreview = '';
    coverImageId = '';
    logo = '';
    thumbnails = {};
    comparison = {};
    compareOpen = false;
  };
  function endAccess(message = $t('frameleaf_photography_client_access_expired')) {
    generation++;
    clearTimeout(saveTimer);
    saveState = 'idle';
    clearImages();
    gallery = null;
    session = '';
    choices = [];
    notes = {};
    annotations = {};
    downloadChoices = [];
    dirty = false;
    compareIds = [];
    thumbnailPending = false;
    sessionStorage.removeItem(storageKey());
    clearTimeout(expiryTimer);
    error = message;
    accessEnded = true;
    busy = false;
  }
  function failure(cause: unknown) {
    const status = (cause as { status?: number })?.status;
    const message = $t(photographyErrorKey(cause));
    if ([401, 403, 410].includes(status ?? 0)) {
      endAccess(message);
    } else {
      error = message;
    }
  }
  function remember() {
    sessionStorage.setItem(storageKey(), JSON.stringify({ session, expiresAt }));
    clearTimeout(expiryTimer);
    const remaining = new Date(expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      endAccess();
      return;
    }
    expiryTimer = setTimeout(() => endAccess(), Math.min(remaining, 2_147_483_647));
  }
  /**
   * Opens the invitation: first without a password, straight from the link; the password form
   * appears only when the gallery answers that it needs one.
   */
  async function enter(event?: SubmitEvent) {
    event?.preventDefault();
    if (busy || !invitation) {
      return;
    }
    busy = true;
    error = '';
    try {
      const tried = password;
      const result = await openGallerySession(galleryId, invitation, tried);
      if (disposed) {
        return;
      }
      if ('passwordRequired' in result) {
        needsPassword = true;
        gateBrand = result.brand ?? gateBrand;
        password = '';
        if (tried) {
          error = $t('frameleaf_photography_client_password_wrong');
        }
        return;
      }
      session = result.session;
      expiresAt = result.expiresAt;
      password = '';
      invitation = '';
      needsPassword = false;
      remember();
      await reload();
    } catch (error_) {
      if (!disposed) {
        failure(error_);
      }
    } finally {
      if (!disposed) {
        busy = false;
      }
    }
  }
  function accept(result: GuestGallery, retainDraft = false) {
    const initial = gallery === null;
    const liveGeneration = (value: GuestGallery | null) =>
      value?.publishedGenerationId === undefined
        ? `${value?.publication?.id ?? ''}:${value?.publication?.status === 'ready' ? 'ready' : 'pending'}`
        : value.publishedGenerationId;
    if (liveGeneration(gallery) !== liveGeneration(result)) {
      clearImages();
    }
    const allowed = new Set(result.photos.map((photo) => photo.id));
    for (const [id, url] of Object.entries(thumbnails)) {
      if (allowed.has(id)) {
        continue;
      }

      URL.revokeObjectURL(url);
      delete thumbnails[id];
    }
    for (const [id, url] of Object.entries(comparison)) {
      if (allowed.has(id)) {
        continue;
      }

      URL.revokeObjectURL(url);
      delete comparison[id];
    }
    if (opened && !allowed.has(opened.id)) {
      closePhoto();
    }
    if (opened) {
      opened = result.photos.find((photo) => photo.id === opened?.id) ?? null;
    }
    if (openedOutput) {
      openedOutput = opened?.outputs?.find((output) => output.id === openedOutput?.id) ?? null;
    }
    gallery = result;
    choices = retainDraft ? choices.filter((id) => allowed.has(id)) : [...result.choices];
    notes = retainDraft
      ? Object.fromEntries(Object.entries(notes).filter(([id]) => allowed.has(id)))
      : Object.fromEntries(result.notes.map((note) => [note.captureId, note.text]));
    annotations = retainDraft
      ? Object.fromEntries(Object.entries(annotations).filter(([id]) => allowed.has(id)))
      : Object.fromEntries(result.notes.map((note) => [note.captureId, structuredClone(note.annotations ?? [])]));
    const availableOutputs = result.photos.flatMap((photo) =>
      (photo.outputs ?? []).filter((output) => output.canDownload),
    );
    downloadChoices = initial
      ? result.photos.flatMap((photo) => {
          const output =
            photo.outputs?.find((item) => item.canDownload && item.kind === 'print') ??
            photo.outputs?.find((item) => item.canDownload);
          return output ? [output.id] : [];
        })
      : downloadChoices.filter((id) => availableOutputs.some((output) => output.id === id));
    if (!retainDraft) {
      dirty = false;
    }
    compareIds = compareIds.filter((id) => allowed.has(id));
    void prepareThumbnails();
  }
  async function reload() {
    if (!session) {
      return;
    }
    const current = ++generation;
    busy = true;
    error = '';
    try {
      const result = await galleryRequest<GuestGallery>(galleryId, session);
      if (disposed || current !== generation) {
        return;
      }
      accept(result, dirty);
    } catch (error_) {
      if (!disposed && current === generation) {
        failure(error_);
      }
    } finally {
      if (!disposed && current === generation) {
        busy = false;
      }
    }
  }
  async function prepareThumbnails() {
    if (!gallery || !session) {
      return;
    }
    if (thumbnailLoading) {
      thumbnailPending = true;
      return;
    }
    thumbnailLoading = true;
    try {
      const current = generation;
      if (gallery.brand.logoUrl && !logo) {
        try {
          const blob = await galleryLogo(galleryId, session);
          if (!disposed && current === generation) {
            logo = URL.createObjectURL(blob);
          }
        } catch (error_) {
          if (!disposed && current === generation) {
            failure(error_);
          }
        }
      }
      if (coverImageId !== cover?.id) {
        if (coverPreview) {
          URL.revokeObjectURL(coverPreview);
        }
        coverPreview = '';
        coverImageId = '';
      }
      const missing: { photo: GuestPhoto; kind: 'thumbnail' | 'preview' }[] = [cover, ...displayed]
        .filter((photo): photo is GuestPhoto => !!photo)
        .filter(
          (photo, index, list) =>
            !Object.hasOwn(thumbnails, photo.id) && list.findIndex((row) => row.id === photo.id) === index,
        )
        .map((photo) => ({ photo, kind: 'thumbnail' }));
      if (cover && !coverPreview && gallery.presentation.coverTreatment !== 'quiet') {
        missing.unshift({ photo: cover, kind: 'preview' });
      }
      // A bounded four-worker queue keeps large contact sheets from opening a request per photograph at once.
      await Promise.all(
        Array.from({ length: Math.min(4, missing.length) }, async () => {
          while (missing.length > 0 && !disposed && current === generation) {
            const { photo, kind } = missing.shift()!;
            try {
              const blob = await galleryMedia(galleryId, photo.id, kind, session);
              if (disposed || current !== generation) {
                return;
              }
              if (kind === 'preview') {
                coverPreview = URL.createObjectURL(blob);
                coverImageId = photo.id;
              } else {
                thumbnails[photo.id] = URL.createObjectURL(blob);
              }
            } catch (error_) {
              if (!disposed && current === generation) {
                failure(error_);
              }
              return;
            }
          }
        }),
      );
    } finally {
      thumbnailLoading = false;
      if (thumbnailPending && !disposed && session) {
        thumbnailPending = false;
        void prepareThumbnails();
      }
    }
  }
  /** A favourite, note or marked area changed: save it a moment after the last change. */
  function changed() {
    if (ownerPreview) {
      // The photographer's preview tries favourites and notes on the page only; the server keeps
      // a preview from changing anything, so nothing is sent.
      notice = '';
      return;
    }
    edits++;
    dirty = true;
    leaving = false;
    notice = '';
    saveState = 'saving';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveChoices(), AUTOSAVE_MS);
  }
  /**
   * Saves favourites and notes now, without locking the page. One save runs at a time; changes made
   * while it is away are kept and saved straight after. Resolves true once nothing is left unsaved.
   */
  async function saveChoices(options: { leaving?: boolean } = {}): Promise<boolean> {
    clearTimeout(saveTimer);
    // Once the page is on its way out, every save in this run is allowed to outlive it.
    leaving ||= !!options.leaving;
    if (saveRunning) {
      return saveRunning;
    }
    saveRunning = (async () => {
      while (gallery && session && dirty && !disposed) {
        const access = session;
        const saving = edits;
        saveState = 'saving';
        try {
          const body = {
            expectedRevision: gallery.revision,
            captureIds: choices,
            notes: [...new Set([...Object.keys(notes), ...Object.keys(annotations)])]
              .filter((id) => notes[id]?.trim() || (annotations[id]?.length ?? 0) > 0)
              .map((captureId) => ({
                captureId,
                text: notes[captureId] ?? '',
                ...(annotations[captureId]?.length && { annotations: $state.snapshot(annotations[captureId]) }),
              })),
          };
          const result = await (leaving && JSON.stringify(body).length < KEEPALIVE_LIMIT
            ? galleryRequest<GuestGallery>(galleryId, session, '/choices', 'PUT', body, { keepalive: true })
            : galleryRequest<GuestGallery>(galleryId, session, '/choices', 'PUT', body));
          if (disposed || session !== access) {
            return false;
          }
          if (edits === saving) {
            accept(result);
            saveState = 'saved';
            return true;
          }
          // More changed while this was saving: keep it, and save again with the new revision.
          accept(result, true);
        } catch (error_) {
          if (!disposed && session === access) {
            saveState = 'error';
            failure(error_);
          }
          return false;
        }
      }
      return !dirty;
    })();
    try {
      return await saveRunning;
    } finally {
      saveRunning = null;
    }
  }
  async function submit() {
    if (!gallery || busy || ownerPreview) {
      return;
    }
    error = '';
    if (!(await saveChoices()) || !gallery || !session) {
      return;
    }
    const current = ++generation;
    busy = true;
    try {
      const result = await galleryRequest<GuestGallery>(galleryId, session, '/submit', 'POST', {
        expectedRevision: gallery.revision,
      });
      if (disposed || current !== generation) {
        return;
      }
      accept(result);
      confirmSubmit = false;
      notice = $t('frameleaf_photography_client_selections_sent');
    } catch (error_) {
      if (!disposed && current === generation) {
        failure(error_);
      }
    } finally {
      if (!disposed && current === generation) {
        busy = false;
      }
    }
  }
  function favorite(id: string) {
    const adding = !choices.includes(id);
    choices = adding ? [...choices, id] : choices.filter((value) => value !== id);
    justFavorited = adding ? id : '';
    changed();
  }
  /** Previous or next photograph in the current view, without closing the dialog. */
  function step(direction: number) {
    const next = filtered[filtered.findIndex((photo) => photo.id === opened?.id) + direction];
    if (opened && next) {
      void openPhoto(next);
    }
  }
  const neighbour = (direction: number) =>
    opened ? filtered[filtered.findIndex((photo) => photo.id === opened?.id) + direction] : undefined;
  function onDialogKey(event: KeyboardEvent) {
    if (!opened || marking || compareOpen || confirmSubmit || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))) {
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      step(event.key === 'ArrowRight' ? 1 : -1);
    }
  }
  async function openPhoto(photo: GuestPhoto) {
    closePhoto();
    opened = photo;
    openedOutput = null;
    marking = false;
    error = '';
    const current = generation;
    const request = previewRequest;
    try {
      const blob = await galleryMedia(galleryId, photo.id, 'preview', session);
      if (disposed || current !== generation || request !== previewRequest || opened?.id !== photo.id || openedOutput) {
        return;
      }
      preview = URL.createObjectURL(blob);
    } catch (error_) {
      if (!disposed && current === generation && request === previewRequest) {
        failure(error_);
      }
    }
  }
  async function openOutput(photo: GuestPhoto, output: NonNullable<GuestPhoto['outputs']>[number]) {
    if (!output.approvalPreviewUrl || !output.revisionId || busy) {
      return;
    }
    closePhoto();
    opened = photo;
    openedOutput = output;
    marking = false;
    const current = generation;
    const request = previewRequest;
    try {
      const blob = await galleryFile(
        galleryId,
        session,
        `/photos/${encodeURIComponent(photo.id)}/outputs/${encodeURIComponent(output.id)}/preview`,
        false,
      );
      if (
        !disposed &&
        current === generation &&
        request === previewRequest &&
        opened?.id === photo.id &&
        openedOutput?.id === output.id
      ) {
        preview = URL.createObjectURL(blob);
      }
    } catch (error_) {
      if (!disposed && current === generation && request === previewRequest) {
        failure(error_);
      }
    }
  }
  function addAnnotation() {
    if (!opened || busy || (annotations[opened.id]?.length ?? 0) >= 20) {
      return;
    }
    annotations[opened.id] ??= [];
    annotations[opened.id].push({ x: 0.25, y: 0.25, width: 0.5, height: 0.5, text: '' });
    changed();
  }
  function point(event: PointerEvent) {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  }
  function beginAnnotation(event: PointerEvent) {
    if (!marking || busy || !opened || (annotations[opened.id]?.length ?? 0) >= 20) {
      return;
    }
    event.preventDefault();
    annotationStart = { ...point(event), pointerId: event.pointerId };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  function drawAnnotation(event: PointerEvent) {
    if (!annotationStart || event.pointerId !== annotationStart.pointerId) {
      return;
    }
    const end = point(event);
    annotationDraft = {
      x: Math.min(end.x, annotationStart.x),
      y: Math.min(end.y, annotationStart.y),
      width: Math.abs(end.x - annotationStart.x),
      height: Math.abs(end.y - annotationStart.y),
      text: '',
    };
  }
  function finishAnnotation(event: PointerEvent) {
    drawAnnotation(event);
    if (opened && annotationDraft && annotationDraft.width > 0.005 && annotationDraft.height > 0.005) {
      annotations[opened.id] ??= [];
      annotations[opened.id].push(annotationDraft);
      changed();
    }
    annotationStart = null;
    annotationDraft = null;
    marking = false;
  }
  function adjustAnnotation(annotation: Annotation, field: 'x' | 'y' | 'width' | 'height', value: number) {
    if (!Number.isFinite(value)) {
      return;
    }
    const maximum =
      field === 'x'
        ? 1 - annotation.width
        : field === 'y'
          ? 1 - annotation.height
          : field === 'width'
            ? 1 - annotation.x
            : 1 - annotation.y;
    annotation[field] = Math.round(Math.max(0, Math.min(maximum, value / 100)) * 10_000) / 10_000;
    changed();
  }
  async function compare() {
    if (compareIds.length !== 2) {
      return;
    }
    for (const url of Object.values(comparison)) {
      URL.revokeObjectURL(url);
    }
    comparison = {};
    compareOpen = true;
    const current = generation;
    try {
      for (const id of compareIds) {
        const blob = await galleryMedia(galleryId, id, 'preview', session);
        if (disposed || current !== generation || !compareOpen) {
          return;
        }
        comparison[id] = URL.createObjectURL(blob);
      }
    } catch (error_) {
      if (!disposed && current === generation) {
        failure(error_);
      }
    }
  }
  function downloadBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function download(photo: GuestPhoto, output?: NonNullable<GuestPhoto['outputs']>[number]) {
    if (!(output ? output.canDownload : photo.canDownload) || busy || ownerPreview) {
      return;
    }
    busy = true;
    error = '';
    try {
      const blob = output
        ? await galleryFile(
            galleryId,
            session,
            `/photos/${encodeURIComponent(photo.id)}/outputs/${encodeURIComponent(output.id)}`,
            false,
          )
        : await galleryMedia(galleryId, photo.id, 'download', session);
      if (!disposed && session) {
        downloadBlob(blob, `photo-${photo.number}${output ? `-${output.id}` : ''}.jpg`);
      }
    } catch (error_) {
      if (!disposed) {
        failure(error_);
      }
    } finally {
      if (!disposed) {
        busy = false;
      }
    }
  }
  async function zip(part = 0) {
    if (busy || ownerPreview || archiveCount === 0 || !Number.isSafeInteger(part) || part < 0 || part >= archiveParts) {
      return;
    }
    busy = true;
    error = '';
    try {
      const request = await galleryRequest<{ id: string }>(galleryId, session, '/zip', 'POST', {
        ...(readyOutputs.length > 0
          ? {
              outputs: chosenOutputs
                .slice(part * 1000, (part + 1) * 1000)
                .map(({ photo, output }) => ({ captureId: photo.id, outputId: output.id })),
            }
          : { captureIds: downloads.slice(part * 1000, (part + 1) * 1000).map((photo) => photo.id) }),
      });
      if (disposed || !session) {
        return;
      }
      const blob = await galleryFile(galleryId, session, `/zip/${encodeURIComponent(request.id)}`, true);
      if (!disposed && session) {
        downloadBlob(blob, `edited-photographs${archiveParts > 1 ? `-part-${part + 1}` : ''}.zip`);
      }
    } catch (error_) {
      if (!disposed) {
        failure(error_);
      }
    } finally {
      if (!disposed) {
        busy = false;
      }
    }
  }
  async function approval(photo: GuestPhoto, approved: boolean) {
    if (!gallery || !approvalRevision || busy || ownerPreview) {
      return;
    }
    const current = ++generation;
    busy = true;
    error = '';
    try {
      const result = await galleryRequest<GuestGallery>(galleryId, session, '/approve', 'POST', {
        expectedRevision: gallery.revision,
        captureId: photo.id,
        revisionId: approvalRevision,
        approved,
        note: notes[photo.id] ?? '',
      });
      if (disposed || current !== generation) {
        return;
      }
      accept(result);
      notice = approved
        ? $t('frameleaf_photography_client_approved')
        : $t('frameleaf_photography_client_revision_sent');
    } catch (error_) {
      if (!disposed && current === generation) {
        failure(error_);
      }
    } finally {
      if (!disposed && current === generation) {
        busy = false;
      }
    }
  }
  async function checkout(orderId: string) {
    if (busy || ownerPreview) {
      return;
    }
    busy = true;
    error = '';
    try {
      const result = await galleryRequest<{ url: string }>(
        galleryId,
        session,
        `/orders/${encodeURIComponent(orderId)}/checkout`,
        'POST',
        {},
      );
      const url = new URL(result.url);
      if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') {
        error = $t('frameleaf_photography_client_checkout_unverified');
        return;
      }
      if (!disposed) {
        location.assign(url.href);
      }
    } catch (error_) {
      if (!disposed) {
        failure(error_);
      }
    } finally {
      if (!disposed) {
        busy = false;
      }
    }
  }
  async function acceptOrder(orderId: string) {
    if (!gallery || busy || ownerPreview) {
      return;
    }
    const current = ++generation;
    busy = true;
    error = '';
    try {
      const result = await galleryRequest<GuestGallery>(
        galleryId,
        session,
        `/orders/${encodeURIComponent(orderId)}/accept`,
        'POST',
        { expectedRevision: gallery.revision },
      );
      if (disposed || current !== generation) {
        return;
      }
      accept(result);
      notice = $t('frameleaf_photography_client_order_accepted');
    } catch (error_) {
      if (!disposed && current === generation) {
        failure(error_);
      }
    } finally {
      if (!disposed && current === generation) {
        busy = false;
      }
    }
  }
  onMount(() => {
    const hash = new URLSearchParams(location.hash.slice(1));
    invitation = hash.get('invitation') ?? '';
    const previewSession = hash.get('preview') ?? '';
    if (invitation) {
      history.replaceState(history.state, '', location.pathname + location.search);
      sessionStorage.removeItem(storageKey());
      // Straight in: the password form appears only if this gallery has one.
      void enter();
    } else if (previewSession) {
      // A photographer's Client preview: a short session made by the workspace, kept like a client's.
      history.replaceState(history.state, '', location.pathname + location.search);
      session = previewSession;
      expiresAt = hash.get('expires') || new Date(Date.now() + 3_600_000).toISOString();
      remember();
      void reload();
    } else {
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey()) ?? 'null');
        if (saved?.session && new Date(saved.expiresAt).getTime() > Date.now()) {
          session = saved.session;
          expiresAt = saved.expiresAt;
          remember();
          void reload();
        }
      } catch {
        sessionStorage.removeItem(storageKey());
      }
    }
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        leaving = false;
      }
      if (document.visibilityState === 'visible' && session) {
        void reload();
      } else if (dirty) {
        // Leaving the tab: save now, without waiting for the pause, in a request that survives a close.
        void saveChoices({ leaving: true });
      }
    };
    // Closing with something unsaved asks first, and the save is started straight away.
    const guard = (event: BeforeUnloadEvent) => {
      if (!dirty) {
        return;
      }
      void saveChoices({ leaving: true });
      event.preventDefault();
    };
    document.addEventListener('visibilitychange', refresh);
    addEventListener('beforeunload', guard);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      removeEventListener('beforeunload', guard);
    };
  });
  onDestroy(() => {
    disposed = true;
    generation++;
    clearImages();
    clearTimeout(expiryTimer);
    clearTimeout(saveTimer);
    password = '';
    invitation = '';
  });
  const photoState = (code: string) => {
    const key = photographyLabelKey('photo', code);
    return key ? $t(key) : code;
  };
  const orderState = (code: string) => {
    const key = photographyLabelKey('order', code);
    return key ? $t(key) : code;
  };
  // The "Choose your files" list can hold thousands of rows, so the words they share are read once
  // and each row only fills in its number.
  const fileWords = $derived({
    fullResolution: $t('frameleaf_photography_full_resolution'),
    branded: $t('frameleaf_photography_client_studio_branding'),
    clean: $t('frameleaf_photography_client_clean_edit'),
    photo: $t('frameleaf_photography_photo_number', { values: { number: '\u{1}' } }).split('\u{1}'),
  });
  const photoLabel = (number: number) => fileWords.photo.join(String(number));
  const outputSummary = (output: NonNullable<GuestPhoto['outputs']>[number]) =>
    `${
      output.kind === 'print'
        ? fileWords.fullResolution
        : $t('frameleaf_photography_pixels', { values: { count: output.exportSpec.maxEdge } })
    } · ${output.branded ? fileWords.branded : fileWords.clean}`;
</script>

<svelte:window onkeydown={onDialogKey} />

<svelte:head
  ><meta name="robots" content="noindex,nofollow,noarchive" /><meta
    name="referrer"
    content="no-referrer"
  /></svelte:head
>
{#if gallery}
  <div
    class="pc"
    data-template={gallery.presentation.template}
    data-spacing={gallery.presentation.spacing}
    data-font={gallery.presentation.font}
    data-palette={gallery.presentation.palette}
    style={`--pc-accent:${gallery.brand.color};--pc-studio-bg:${gallery.brand.background};--pc-studio-text:${gallery.brand.textColor}`}
  >
    {#if ownerPreview}<p class="pc-preview-banner" role="status">
        <Icon icon={mdiEyeOutline} size="18" aria-hidden={true} />{$t('frameleaf_photography_client_preview_banner')}
      </p>{/if}
    {@render studioHeader(gallery.brand, logo)}
    <section class="pc-cover" id="collection" data-treatment={gallery.presentation.coverTreatment}>
      {#if cover && (coverPreview || thumbnails[cover.id]) && gallery.presentation.coverTreatment !== 'quiet'}<img
          src={coverPreview || thumbnails[cover.id]}
          alt={$t('frameleaf_photography_client_cover_alt')}
          style={`object-position:center ${gallery.presentation.coverFocal}%`}
        />{/if}
      <div class="pc-cover-copy">
        <span
          >{finished
            ? $t('frameleaf_photography_client_finished_collection')
            : $t('frameleaf_photography_client_private_gallery')}</span
        >
        <h1>{gallery.title}</h1>
        <p class="pc-cover-meta">
          {[
            gallery.recipient.name,
            gallery.date ? new Date(`${gallery.date}T12:00:00`).toLocaleDateString($locale, { dateStyle: 'long' }) : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <p>{gallery.presentation.introduction || $t('frameleaf_photography_client_intro_default')}</p>
        {#if gallery.mode !== 'edited-delivery' && !finished}<p class="pc-package-line">
            {$t('frameleaf_photography_client_pricing', {
              values: {
                count: gallery.pricing.includedCount,
                price: money(gallery.pricing.additionalPrice, gallery.pricing.currency),
              },
            })}
          </p>{/if}
      </div>
    </section>
    <main id="photographs" class="pc-main">
      {#if error}<div class="pc-notice" role="alert">
          {error}<button type="button" disabled={busy} onclick={reload}>{$t('frameleaf_error_retry')}</button>
        </div>{/if}
      {#if notice}<p class="pc-notice" role="status">{notice}</p>{/if}
      <div class="pc-toolbar">
        <div>
          <h2>
            {favoritesOnly
              ? $t('frameleaf_photography_client_your_favourites')
              : $t('frameleaf_photography_client_the_photographs')}
          </h2>
          <p>
            {$t('frameleaf_photography_client_counts', {
              values: { photos: gallery.photos.length, favourites: choices.length },
            })}{gallery.pricing.selectionDeadline
              ? ` · ${$t('frameleaf_photography_client_choose_by', { values: { date: new Date(gallery.pricing.selectionDeadline).toLocaleDateString($locale) } })}`
              : ''}
          </p>
        </div>
        <div class="pc-actions">
          <button
            type="button"
            aria-pressed={favoritesOnly}
            onclick={() => {
              favoritesOnly = !favoritesOnly;
              void prepareThumbnails();
            }}>{$t('frameleaf_photography_client_favourites_count', { values: { count: choices.length } })}</button
          ><PhotographyStatus
            state={saveState}
            savingLabel={$t('frameleaf_photography_saving')}
            savedLabel={$t('frameleaf_photography_client_saved')}
            errorLabel={$t('frameleaf_photography_client_not_saved')}
            retryLabel={$t('frameleaf_error_retry')}
            onRetry={() => void saveChoices()}
          /><button
            type="button"
            class="pc-primary"
            disabled={busy || ownerPreview || choices.length === 0}
            onclick={() => (confirmSubmit = true)}>{$t('frameleaf_photography_client_send_selections')}</button
          >
        </div>
      </div>
      {#if gallery.presentation.showChapters && gallery.chapters.length > 0}<nav
          class="pc-chapters"
          aria-label={$t('frameleaf_photography_client_chapters')}
        >
          <button
            type="button"
            aria-pressed={!chapter}
            onclick={() => {
              chapter = '';
              limit = 80;
              void prepareThumbnails();
            }}>{$t('frameleaf_photography_client_all_photographs')}</button
          >{#each gallery.chapters as row (row.id)}<button
              type="button"
              aria-pressed={chapter === row.id}
              onclick={() => {
                chapter = row.id;
                limit = 80;
                void prepareThumbnails();
              }}>{row.title}</button
            >{/each}
        </nav>{/if}
      {#if chapter}<div class="pc-chapter-intro">
          <h2>{gallery.chapters.find((row) => row.id === chapter)?.title}</h2>
          <p>{gallery.chapters.find((row) => row.id === chapter)?.description}</p>
        </div>{/if}
      {#if compareIds.length}<div class="pc-compare-tools">
          <span>{$t('frameleaf_photography_client_compare_count', { values: { count: compareIds.length } })}</span
          ><button type="button" disabled={compareIds.length !== 2} onclick={compare}
            >{$t('frameleaf_photography_compare')}</button
          ><button type="button" onclick={() => (compareIds = [])}>{$t('frameleaf_photography_client_clear')}</button>
        </div>{/if}
      {#snippet photoCard(photo: GuestPhoto)}<article class="pc-photo">
          <button
            type="button"
            class="pc-image"
            aria-label={$t('frameleaf_photography_client_view_photo', { values: { number: photo.number } })}
            onclick={() => openPhoto(photo)}
            >{#if thumbnails[photo.id]}<img
                src={thumbnails[photo.id]}
                alt={$t('frameleaf_photography_photo_number', { values: { number: photo.number } })}
                loading="lazy"
              />{:else}<span>{$t('frameleaf_photography_client_preparing')}</span>{/if}</button
          >
          <div class="pc-photo-caption">
            <div>
              {#if gallery?.presentation.showNumbers}<span>#{String(photo.number).padStart(3, '0')}</span>{/if}<small
                >{photoState(photo.status)}</small
              >
            </div>
            <div class="pc-actions">
              <button
                type="button"
                class="pc-heart"
                class:is-fresh={justFavorited === photo.id}
                aria-label={choices.includes(photo.id)
                  ? $t('frameleaf_photography_client_remove_favourite_photo', { values: { number: photo.number } })
                  : $t('frameleaf_photography_client_add_favourite_photo', { values: { number: photo.number } })}
                aria-pressed={choices.includes(photo.id)}
                onclick={() => favorite(photo.id)}
                ><Icon
                  icon={choices.includes(photo.id) ? mdiHeart : mdiHeartOutline}
                  size="20"
                  aria-hidden={true}
                /></button
              ><label
                ><input
                  type="checkbox"
                  aria-label={$t('frameleaf_photography_client_compare_photo', { values: { number: photo.number } })}
                  checked={compareIds.includes(photo.id)}
                  disabled={!compareIds.includes(photo.id) && compareIds.length === 2}
                  onchange={(event) =>
                    (compareIds = event.currentTarget.checked
                      ? [...compareIds, photo.id]
                      : compareIds.filter((id) => id !== photo.id))}
                />{$t('frameleaf_photography_compare')}</label
              >{#if photo.outputs?.some((output) => output.canDownload)}<button
                  type="button"
                  disabled={busy}
                  onclick={() => openPhoto(photo)}>{$t('frameleaf_photography_client_download_options')}</button
                >{:else if photo.canDownload}<button type="button" disabled={busy} onclick={() => download(photo)}
                  >{$t('frameleaf_photography_client_download')}</button
                >{/if}
            </div>
          </div>
        </article>{/snippet}
      {#if gallery.presentation.blocks?.length}
        {#each gallery.presentation.blocks as block (block.id)}{@const photos = blockPhotos(block)}
          <section class="pc-block" data-kind={block.type}>
            {#if block.type === 'chapter'}<div class="pc-chapter-intro">
                <h2>
                  {gallery.chapters.find((row) => row.id === block.chapterId)?.title ??
                    $t('frameleaf_photography_client_the_collection')}
                </h2>
                <p>{block.text || gallery.chapters.find((row) => row.id === block.chapterId)?.description}</p>
              </div>
            {:else if block.type === 'caption'}<p class="pc-story-caption">{block.text}</p>
            {:else if block.type === 'slideshow'}{#if photos.length}{@const slide = Math.min(
                  slideIndexes[block.id] ?? 0,
                  photos.length - 1,
                )}
                <div class="pc-grid">{@render photoCard(photos[slide])}</div>
                <div class="pc-actions">
                  <button
                    type="button"
                    disabled={slide === 0}
                    onclick={() => {
                      slideIndexes[block.id] = slide - 1;
                      void prepareThumbnails();
                    }}>{$t('frameleaf_photography_client_previous')}</button
                  ><span>{slide + 1} / {photos.length}</span><button
                    type="button"
                    disabled={slide >= photos.length - 1}
                    onclick={() => {
                      slideIndexes[block.id] = slide + 1;
                      void prepareThumbnails();
                    }}>{$t('frameleaf_photography_client_next')}</button
                  >
                </div>{/if}
            {:else}<div class="pc-grid">
                {#each photos as photo (photo.id)}{@render photoCard(photo)}{/each}
              </div>{/if}
            {#if !['chapter', 'caption'].includes(block.type) && block.text}<p class="pc-story-caption">
                {block.text}
              </p>{/if}
          </section>{/each}
      {:else}<div class="pc-grid">
          {#each visible as photo (photo.id)}{@render photoCard(photo)}{:else}<p>
              {$t('frameleaf_photography_client_none_in_view')}
            </p>{/each}
        </div>{/if}
      {#if limit < gallery.photos.length}<button
          type="button"
          onclick={() => {
            limit += 80;
            void prepareThumbnails();
          }}>{$t('frameleaf_photography_client_show_more')}</button
        >{/if}
      <section id="your-order" class="pc-orders">
        <div>
          <span class="pc-eyebrow">{$t('frameleaf_photography_client_your_collection')}</span>
          <h2>{$t('frameleaf_photography_section_orders')}</h2>
          <p>
            {$t('frameleaf_photography_client_pricing', {
              values: {
                count: gallery.pricing.includedCount,
                price: money(gallery.pricing.additionalPrice, gallery.pricing.currency),
              },
            })}
          </p>
          <p>{gallery.pricing.terms}</p>
        </div>
        <div>
          {#each gallery.rounds as round (round.id)}<p>
              {$t('frameleaf_photography_client_round_sent', {
                values: { count: round.captureIds.length, date: new Date(round.createdAt).toLocaleDateString($locale) },
              })}
            </p>{/each}{#each gallery.orders as order (order.id)}<article class="pc-order">
              <strong
                >{$t('frameleaf_photography_photographs_count', { values: { count: order.captureIds.length } })} · {money(
                  order.total,
                  order.currency,
                )}</strong
              >
              <p>
                {orderState(order.status)} · {order.paymentTiming === 'before-editing'
                  ? $t('frameleaf_photography_payment_before_editing')
                  : $t('frameleaf_photography_payment_after_approval')}
              </p>
              {#if order.status === 'quoted'}<p>{order.terms}</p>
                <button
                  type="button"
                  class="pc-primary"
                  disabled={busy || ownerPreview}
                  onclick={() => acceptOrder(order.id)}>{$t('frameleaf_photography_client_accept_order')}</button
                >{:else if order.status === 'accepted' && order.total > 0 && gallery.checkoutAvailable}<button
                  type="button"
                  disabled={busy || ownerPreview}
                  onclick={() => checkout(order.id)}>{$t('frameleaf_photography_client_pay')}</button
                >{:else if order.status === 'accepted' && order.total > 0}<p>
                  {$t('frameleaf_photography_client_arrange_payment')}
                </p>
                {#if gallery.brand.email}<a href={`mailto:${gallery.brand.email}`}
                    >{$t('frameleaf_photography_client_contact_studio')}</a
                  >{/if}{/if}
            </article>{:else}<p>
              {$t('frameleaf_photography_client_order_pending')}
            </p>{/each}{#if readyOutputs.length > 0}<div class="pc-download-choices">
              <h3>{$t('frameleaf_photography_client_choose_files')}</h3>
              {#each readyOutputs as item (item.output.id)}<label
                  ><input
                    type="checkbox"
                    checked={downloadChoiceIds.has(item.output.id)}
                    onchange={(event) => {
                      downloadChoices = event.currentTarget.checked
                        ? [...downloadChoices, item.output.id]
                        : downloadChoices.filter((id) => id !== item.output.id);
                    }}
                  />{photoLabel(item.photo.number)} · {item.output.label} · {outputSummary(item.output)}</label
                >{/each}
            </div>{:else if downloads.length}<p>
              {$t('frameleaf_photography_client_ready_downloads', { values: { count: downloads.length } })}
            </p>
          {/if}
          {#if readyOutputs.length || downloads.length}
            {#if archiveParts > 1}<p>
                {$t('frameleaf_photography_client_zip_parts', { values: { files: archiveCount, parts: archiveParts } })}
              </p>
              {#each Array.from({ length: archiveParts }, (_, part) => part) as part (part)}<button
                  type="button"
                  class="pc-primary"
                  disabled={busy || ownerPreview}
                  onclick={() => zip(part)}
                  >{$t('frameleaf_photography_client_download_part', {
                    values: { part: part + 1, files: Math.min(1000, archiveCount - part * 1000) },
                  })}</button
                >{/each}
            {:else}<button
                type="button"
                class="pc-primary"
                disabled={busy || ownerPreview || archiveCount === 0}
                onclick={() => zip()}
                >{readyOutputs.length > 0
                  ? $t('frameleaf_photography_client_download_selected')
                  : $t('frameleaf_photography_client_download_collection')}</button
              >{/if}
          {/if}
        </div>
      </section>
    </main>
    {@render studioFooter(gallery.brand)}
    <Dialog
      open={!!opened}
      title={opened
        ? $t('frameleaf_photography_photo_number', { values: { number: opened.number } })
        : $t('frameleaf_photography_client_photograph')}
      closeLabel={$t('close')}
      wide
      onRequestClose={closePhoto}
      >{#if opened}<div class="pc-dialog">
          {#if error}<p role="alert">{error}</p>{/if}
          {#if notice}<p role="status">{notice}</p>{/if}
          {#if openedOutput}<p>{openedOutput.label} · {$t('frameleaf_photography_client_review_version')}</p>{/if}
          <div class="pc-stepper">
            <button
              type="button"
              aria-label={$t('frameleaf_photography_client_previous')}
              disabled={!neighbour(-1)}
              onclick={() => step(-1)}><Icon icon={mdiChevronLeft} size="20" aria-hidden={true} /></button
            >
            <span
              >{$t('frameleaf_photography_client_position', {
                values: { index: filtered.findIndex((photo) => photo.id === opened?.id) + 1, count: filtered.length },
              })}</span
            >
            <button
              type="button"
              aria-label={$t('frameleaf_photography_client_next')}
              disabled={!neighbour(1)}
              onclick={() => step(1)}><Icon icon={mdiChevronRight} size="20" aria-hidden={true} /></button
            >
          </div>
          {#if preview}<button
              type="button"
              class="pc-annotated-image"
              class:marking
              aria-label={marking
                ? $t('frameleaf_photography_client_marking_label')
                : $t('frameleaf_photography_photo_number', { values: { number: opened.number } })}
              onpointerdown={beginAnnotation}
              onpointermove={drawAnnotation}
              onpointerup={finishAnnotation}
              onpointercancel={() => {
                annotationStart = null;
                annotationDraft = null;
              }}
              onkeydown={(event) => {
                if (!(marking && (event.key === 'Enter' || event.key === ' '))) {
                  return;
                }

                event.preventDefault();
                addAnnotation();
                marking = false;
              }}
              ><img
                src={preview}
                alt={$t('frameleaf_photography_photo_number', { values: { number: opened.number } })}
              />{#each annotations[opened.id] ?? [] as area, index (index)}<span
                  class="pc-annotation"
                  style={`left:${area.x * 100}%;top:${area.y * 100}%;width:${area.width * 100}%;height:${area.height * 100}%`}
                  ><span>{index + 1}</span></span
                >{/each}{#if annotationDraft}<span
                  class="pc-annotation"
                  style={`left:${annotationDraft.x * 100}%;top:${annotationDraft.y * 100}%;width:${annotationDraft.width * 100}%;height:${annotationDraft.height * 100}%`}
                ></span>{/if}</button
            >{:else}<p role="status">{$t('frameleaf_photography_client_loading_photo')}</p>{/if}<label
            >{$t('frameleaf_photography_client_note_label')}<textarea
              maxlength="2000"
              rows="3"
              bind:value={notes[opened.id]}
              oninput={changed}
              placeholder={$t('frameleaf_photography_client_note_placeholder')}></textarea></label
          >
          <div class="pc-actions">
            <button
              type="button"
              disabled={busy || !preview || (annotations[opened.id]?.length ?? 0) >= 20}
              aria-pressed={marking}
              onclick={() => {
                marking = !marking;
              }}>{$t('frameleaf_photography_client_mark_area')}</button
            ><button
              type="button"
              disabled={busy || !preview || (annotations[opened.id]?.length ?? 0) >= 20}
              onclick={addAnnotation}>{$t('frameleaf_photography_client_add_area')}</button
            >
          </div>
          {#if marking}<p role="status">{$t('frameleaf_photography_client_marking_hint')}</p>{/if}
          {#each annotations[opened.id] ?? [] as area, index (index)}<div class="pc-area-controls">
              <label
                >{$t('frameleaf_photography_client_area_note', { values: { number: index + 1 } })}<textarea
                  maxlength="500"
                  rows="2"
                  bind:value={area.text}
                  oninput={changed}></textarea></label
              >
              <div class="pc-area-bounds">
                {#each ['x', 'y', 'width', 'height'] as field (field)}<label
                    >{field === 'x'
                      ? $t('frameleaf_photography_client_area_left')
                      : field === 'y'
                        ? $t('frameleaf_photography_client_area_top')
                        : field === 'width'
                          ? $t('frameleaf_photography_client_area_width')
                          : $t('frameleaf_photography_client_area_height')}<input
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      value={Math.round(area[field as keyof Pick<Annotation, 'x' | 'y' | 'width' | 'height'>] * 1000) /
                        10}
                      onchange={(event) =>
                        adjustAnnotation(
                          area,
                          field as 'x' | 'y' | 'width' | 'height',
                          event.currentTarget.valueAsNumber,
                        )}
                    /></label
                  >{/each}
              </div>
              <button
                type="button"
                disabled={busy}
                onclick={() => {
                  annotations[opened!.id].splice(index, 1);
                  changed();
                }}>{$t('frameleaf_photography_client_remove_area', { values: { number: index + 1 } })}</button
              >
            </div>{/each}
          <div class="pc-actions">
            <button type="button" aria-pressed={choices.includes(opened.id)} onclick={() => favorite(opened!.id)}
              >{choices.includes(opened.id)
                ? $t('frameleaf_photography_client_remove_favourite')
                : $t('frameleaf_photography_client_add_favourite')}</button
            ><PhotographyStatus
              state={saveState}
              savingLabel={$t('frameleaf_photography_saving')}
              savedLabel={$t('frameleaf_photography_client_saved')}
              errorLabel={$t('frameleaf_photography_client_not_saved')}
              retryLabel={$t('frameleaf_error_retry')}
              onRetry={() => void saveChoices()}
            />{#if approvalRevision}<button
                type="button"
                disabled={busy || ownerPreview || !preview}
                onclick={() => approval(opened!, true)}>{$t('frameleaf_photography_client_approve')}</button
              ><button
                type="button"
                disabled={busy || ownerPreview || !preview || !notes[opened.id]?.trim()}
                onclick={() => approval(opened!, false)}>{$t('frameleaf_photography_client_request_adjustment')}</button
              >{/if}{#if (opened.outputs?.length ?? 0) === 0 && opened.canDownload}<button
                type="button"
                disabled={busy}
                onclick={() => download(opened!)}>{$t('frameleaf_photography_client_download_edited')}</button
              >{/if}
          </div>
          {#if opened.outputs?.length}<div class="pc-version-outputs">
              <h3>{$t('frameleaf_photography_client_edited_files')}</h3>
              {#each opened.outputs as output (output.id)}<div class="pc-output">
                  <strong>{output.label}</strong><span>{outputSummary(output)}</span>{#if output.canDownload}<button
                      type="button"
                      disabled={busy}
                      onclick={() => download(opened!, output)}
                      >{$t('frameleaf_photography_client_download_named', { values: { name: output.label } })}</button
                    >{:else}<span
                      >{output.blockedReason === 'payment'
                        ? $t('frameleaf_photography_client_blocked_payment')
                        : output.blockedReason === 'approval'
                          ? $t('frameleaf_photography_client_blocked_approval')
                          : output.blockedReason === 'render'
                            ? $t('frameleaf_photography_client_blocked_render')
                            : $t('frameleaf_photography_client_blocked_other')}</span
                    >{/if}{#if output.approvalPreviewUrl}<button
                      type="button"
                      disabled={busy}
                      onclick={() => openOutput(opened!, output)}
                      >{$t('frameleaf_photography_client_review_named', { values: { name: output.label } })}</button
                    >{/if}
                </div>{/each}
            </div>{/if}
        </div>{/if}</Dialog
    >
    <Dialog
      bind:open={compareOpen}
      title={$t('frameleaf_photography_client_compare_title')}
      closeLabel={$t('close')}
      wide
      onRequestClose={() => (compareOpen = false)}
      ><div class="pc-comparison">
        {#if error}<p role="alert">{error}</p>{/if}
        {#each compareIds as id (id)}<div>
            {#if comparison[id]}<img
                src={comparison[id]}
                alt={$t('frameleaf_photography_photo_number', {
                  values: { number: gallery.photos.find((photo) => photo.id === id)?.number ?? '' },
                })}
              />{:else}<p role="status">{$t('loading')}</p>{/if}<button
              type="button"
              aria-pressed={choices.includes(id)}
              onclick={() => favorite(id)}
              ><Icon
                icon={choices.includes(id) ? mdiHeart : mdiHeartOutline}
                size="18"
                aria-hidden={true}
              />{choices.includes(id)
                ? $t('frameleaf_photography_client_favourite')
                : $t('frameleaf_photography_client_choose_favourite')}</button
            >
          </div>{/each}
      </div></Dialog
    >
    <Dialog
      bind:open={confirmSubmit}
      title={$t('frameleaf_photography_client_send_title')}
      closeLabel={$t('close')}
      onRequestClose={() => (confirmSubmit = false)}
      ><div class="pc-dialog">
        <p>
          {$t('frameleaf_photography_client_selected_count', { values: { count: choices.length } })}
        </p>
        <p>
          {$t('frameleaf_photography_client_additional_price', {
            values: { price: money(selectedPrice, gallery.pricing.currency) },
          })}
        </p>
        <p>{gallery.pricing.terms}</p>
        <p>{$t('frameleaf_photography_client_send_note')}</p>
        {#if error}<p role="alert">{error}</p>{/if}
        <button type="button" class="pc-primary" disabled={busy} onclick={submit}
          >{busy
            ? $t('frameleaf_photography_client_sending')
            : $t('frameleaf_photography_client_send_to_studio')}</button
        >
      </div></Dialog
    >
  </div>
{:else}
  <!-- The entrance (PhotographyClient.jsx `pc-access`): straight in, a password only when there is one. -->
  <div
    class="pc pc-gate"
    style={gateBrand
      ? `--pc-accent:${gateBrand.color};--pc-studio-bg:${gateBrand.background};--pc-studio-text:${gateBrand.textColor}`
      : undefined}
  >
    {#if gateBrand}{@render studioHeader(gateBrand, '')}{/if}
    <main class="pc-access">
      <Icon icon={accessEnded ? mdiClockOutline : mdiLockOutline} size="32" aria-hidden={true} />
      <h1>
        {accessEnded
          ? $t('frameleaf_photography_client_expired_title')
          : $t('frameleaf_photography_client_access_title')}
      </h1>
      {#if accessEnded}<p role="alert">{error || $t('frameleaf_photography_client_expired_body')}</p>
      {:else if needsPassword}<p>{$t('frameleaf_photography_client_password_hint')}</p>
        <form onsubmit={enter}>
          <label
            >{$t('frameleaf_photography_client_password')}<input
              type="password"
              autocomplete="current-password"
              required
              bind:value={password}
            /></label
          ><button type="submit" disabled={busy}
            >{busy ? $t('frameleaf_photography_client_opening') : $t('frameleaf_photography_client_open')}</button
          >
        </form>
        {#if error}<p role="alert">{error}</p>{/if}
      {:else if busy}<p role="status">{$t('frameleaf_photography_client_opening_yours')}</p>
      {:else}{#if error}<p role="alert">{error}</p>{/if}
        <p>{$t('frameleaf_photography_client_open_invitation')}</p>{/if}
      {#if gateBrand?.email}<a href={`mailto:${gateBrand.email}`}
          >{$t('frameleaf_photography_client_contact_named', { values: { name: gateBrand.name } })}</a
        >{/if}
    </main>
    {#if gateBrand}{@render studioFooter(gateBrand)}{/if}
  </div>
{/if}

{#snippet studioHeader(brand: PublicBrand, logoUrl: string)}<header class="pc-header">
    <a href="#collection" class="pc-studio"
      >{#if logoUrl}<img src={logoUrl} alt="" />{:else}<span class="pc-monogram" aria-hidden="true"
          >{monogram(brand.name)}</span
        >{/if}{brand.name}</a
    >
    <nav aria-label={$t('frameleaf_photography_client_collection')}>
      <a href="#photographs" aria-current="page">{$t('frameleaf_photography_client_gallery_nav')}</a
      >{#if brand.email || brand.phone}<a href="#contact">{$t('frameleaf_photography_client_contact_nav')}</a>{/if}
    </nav>
  </header>{/snippet}

{#snippet studioFooter(brand: PublicBrand)}<footer class="pc-footer" id="contact">
    <span
      >{$t('frameleaf_photography_client_footer_copyright', {
        values: { year: String(new Date().getFullYear()), name: brand.name },
      })}</span
    >
    <span>{$t('frameleaf_photography_client_footer_note')}</span>
    <span class="pc-footer-contact"
      >{#if brand.email}<a href={`mailto:${brand.email}`}>{brand.email}</a>{/if}{#if brand.phone}<a
          href={`tel:${brand.phone.replaceAll(/[^+0-9]/g, '')}`}>{brand.phone}</a
        >{/if}</span
    >
  </footer>{/snippet}
