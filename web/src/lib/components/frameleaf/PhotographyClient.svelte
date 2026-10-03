<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    galleryRequest,
    galleryMedia,
    galleryFile,
    galleryLogo,
    type GuestGallery,
    type GuestPhoto,
    type Annotation,
    type PresentationBlock,
  } from '$lib/frameleaf/photography/workflow-api';
  import Dialog from './Dialog.svelte';
  import '$lib/frameleaf/photography/gallery.css';
  let { galleryId }: { galleryId: string } = $props();
  let gallery = $state<GuestGallery | null>(null);
  let session = $state('');
  let invitation = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state('');
  let notice = $state('');
  let dirty = $state(false);
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
  const downloads = $derived(gallery?.photos.filter((photo) => photo.canDownload) ?? []);
  const readyOutputs = $derived(
    gallery?.photos.flatMap((photo) =>
      (photo.outputs ?? []).filter((output) => output.canDownload).map((output) => ({ photo, output })),
    ) ?? [],
  );
  const approvalRevision = $derived(
    openedOutput ? (openedOutput.approvalPreviewUrl ? openedOutput.revisionId : null) : opened?.approvalRevisionId,
  );
  const chosenOutputs = $derived(readyOutputs.filter(({ output }) => downloadChoices.includes(output.id)));
  const archiveCount = $derived(readyOutputs.length > 0 ? chosenOutputs.length : downloads.length);
  const archiveParts = $derived(Math.ceil(archiveCount / 1000));
  const cover = $derived(
    gallery?.photos.find((photo) => photo.id === gallery?.presentation.coverCaptureId) ?? gallery?.photos[0],
  );
  const money = (total: number, currency: string) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(total / 100);
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
  function endAccess(message = 'This invitation has expired or access has ended.') {
    generation++;
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
    busy = false;
  }
  function failure(cause: unknown) {
    const status = (cause as { status?: number })?.status;
    const message = cause instanceof Error ? cause.message : 'Please try again in a moment.';
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
  async function enter(event?: SubmitEvent) {
    event?.preventDefault();
    if (busy || !invitation) {
      return;
    }
    busy = true;
    error = '';
    try {
      const result = await galleryRequest<{ session: string; expiresAt: string }>(galleryId, '', '/session', 'POST', {
        token: invitation,
        password: password || undefined,
      });
      if (disposed) {
        return;
      }
      session = result.session;
      expiresAt = result.expiresAt;
      password = '';
      invitation = '';
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
  async function saveChoices() {
    if (!gallery || busy) {
      return;
    }
    const current = ++generation;
    busy = true;
    error = '';
    try {
      const result = await galleryRequest<GuestGallery>(galleryId, session, '/choices', 'PUT', {
        expectedRevision: gallery.revision,
        captureIds: choices,
        notes: [...new Set([...Object.keys(notes), ...Object.keys(annotations)])]
          .filter((id) => notes[id]?.trim() || (annotations[id]?.length ?? 0) > 0)
          .map((captureId) => ({
            captureId,
            text: notes[captureId] ?? '',
            ...(annotations[captureId]?.length && { annotations: $state.snapshot(annotations[captureId]) }),
          })),
      });
      if (disposed || current !== generation) {
        return;
      }
      accept(result);
      notice = 'Your favourites and notes are saved.';
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
  async function submit() {
    if (!gallery || busy) {
      return;
    }
    await saveChoices();
    if (error || !gallery || !session) {
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
      notice = 'Your selections have been sent to the studio.';
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
    choices = choices.includes(id) ? choices.filter((value) => value !== id) : [...choices, id];
    notice = 'Unsaved selections';
    dirty = true;
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
    dirty = true;
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
      dirty = true;
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
    dirty = true;
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
    if (!(output ? output.canDownload : photo.canDownload) || busy) {
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
    if (busy || archiveCount === 0 || !Number.isSafeInteger(part) || part < 0 || part >= archiveParts) {
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
    if (!gallery || !approvalRevision || busy) {
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
      notice = approved ? 'Photograph approved.' : 'Your revision request has been sent.';
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
    if (busy) {
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
        throw new Error('The checkout link could not be verified. Contact the studio.');
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
    if (!gallery || busy) {
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
      notice = 'Order accepted. The studio will prepare your photographs.';
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
    if (invitation) {
      history.replaceState(history.state, '', location.pathname + location.search);
      sessionStorage.removeItem(storageKey());
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
      if (document.visibilityState === 'visible' && session) {
        void reload();
      }
    };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  });
  onDestroy(() => {
    disposed = true;
    generation++;
    clearImages();
    clearTimeout(expiryTimer);
    password = '';
    invitation = '';
  });
</script>

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
    <header class="pc-header">
      <a href="#collection" class="pc-studio"
        >{#if logo}<img src={logo} alt="" />{/if}{gallery.brand.name}</a
      >
      <nav aria-label="Collection">
        <a href="#photographs">Photographs</a><a href="#your-order">Your order</a><button
          type="button"
          disabled={busy}
          onclick={reload}>Refresh</button
        >
      </nav>
    </header>
    <section class="pc-cover" id="collection" data-treatment={gallery.presentation.coverTreatment}>
      {#if cover && (coverPreview || thumbnails[cover.id]) && gallery.presentation.coverTreatment !== 'quiet'}<img
          src={coverPreview || thumbnails[cover.id]}
          alt="Collection cover"
          style={`object-position:center ${gallery.presentation.coverFocal}%`}
        />{/if}
      <div class="pc-cover-copy">
        <span>{gallery.brand.tagline}</span>
        <h1>{gallery.title}</h1>
        <p>{gallery.presentation.introduction || 'A collection of moments, just for you.'}</p>
        <a href="#photographs">Explore the collection ↓</a>
      </div>
    </section>
    <main id="photographs" class="pc-main">
      {#if error}<div class="pc-notice" role="alert">
          {error}<button type="button" disabled={busy} onclick={reload}>Try again</button>
        </div>{/if}
      {#if notice}<p class="pc-notice" role="status">{notice}</p>{/if}
      <div class="pc-toolbar">
        <div>
          <h2>{favoritesOnly ? 'Your favourites' : 'The photographs'}</h2>
          <p>
            {gallery.photos.length} photographs · {choices.length}
            {choices.length === 1 ? 'favourite' : 'favourites'}{gallery.pricing.selectionDeadline
              ? ` · Choose by ${new Date(gallery.pricing.selectionDeadline).toLocaleDateString()}`
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
            }}>Favourites {choices.length}</button
          ><button type="button" disabled={busy} onclick={saveChoices}>Save favourites</button><button
            type="button"
            class="pc-primary"
            disabled={busy || choices.length === 0}
            onclick={() => (confirmSubmit = true)}>Send selections</button
          >
        </div>
      </div>
      {#if gallery.presentation.showChapters && gallery.chapters.length > 0}<nav
          class="pc-chapters"
          aria-label="Photo chapters"
        >
          <button
            type="button"
            aria-pressed={!chapter}
            onclick={() => {
              chapter = '';
              limit = 80;
              void prepareThumbnails();
            }}>All photographs</button
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
          <span>{compareIds.length} of 2 photographs to compare</span><button
            type="button"
            disabled={compareIds.length !== 2}
            onclick={compare}>Compare</button
          ><button type="button" onclick={() => (compareIds = [])}>Clear</button>
        </div>{/if}
      {#snippet photoCard(photo: GuestPhoto)}<article class="pc-photo">
          <button
            type="button"
            class="pc-image"
            aria-label={`View photo ${photo.number}`}
            onclick={() => openPhoto(photo)}
            >{#if thumbnails[photo.id]}<img
                src={thumbnails[photo.id]}
                alt={`Photo ${photo.number}`}
                loading="lazy"
              />{:else}<span>Preparing photograph…</span>{/if}</button
          >
          <div class="pc-photo-caption">
            <div>
              {#if gallery?.presentation.showNumbers}<span>#{String(photo.number).padStart(3, '0')}</span>{/if}<small
                >{photo.status}</small
              >
            </div>
            <div class="pc-actions">
              <button
                type="button"
                aria-label={`${choices.includes(photo.id) ? 'Remove' : 'Add'} photo ${photo.number} ${choices.includes(photo.id) ? 'from' : 'to'} favourites`}
                aria-pressed={choices.includes(photo.id)}
                disabled={busy}
                onclick={() => favorite(photo.id)}>{choices.includes(photo.id) ? '♥' : '♡'}</button
              ><label
                ><input
                  type="checkbox"
                  aria-label={`Compare photo ${photo.number}`}
                  checked={compareIds.includes(photo.id)}
                  disabled={!compareIds.includes(photo.id) && compareIds.length === 2}
                  onchange={(event) =>
                    (compareIds = event.currentTarget.checked
                      ? [...compareIds, photo.id]
                      : compareIds.filter((id) => id !== photo.id))}
                />Compare</label
              >{#if photo.outputs?.some((output) => output.canDownload)}<button
                  type="button"
                  disabled={busy}
                  onclick={() => openPhoto(photo)}>Download options</button
                >{:else if photo.canDownload}<button type="button" disabled={busy} onclick={() => download(photo)}
                  >Download</button
                >{/if}
            </div>
          </div>
        </article>{/snippet}
      {#if gallery.presentation.blocks?.length}
        {#each gallery.presentation.blocks as block (block.id)}{@const photos = blockPhotos(block)}
          <section class="pc-block" data-kind={block.type}>
            {#if block.type === 'chapter'}<div class="pc-chapter-intro">
                <h2>{gallery.chapters.find((row) => row.id === block.chapterId)?.title ?? 'The collection'}</h2>
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
                    }}>Previous photograph</button
                  ><span>{slide + 1} / {photos.length}</span><button
                    type="button"
                    disabled={slide >= photos.length - 1}
                    onclick={() => {
                      slideIndexes[block.id] = slide + 1;
                      void prepareThumbnails();
                    }}>Next photograph</button
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
          {#each visible as photo (photo.id)}{@render photoCard(photo)}{:else}<p>No photographs in this view.</p>{/each}
        </div>{/if}
      {#if limit < gallery.photos.length}<button
          type="button"
          onclick={() => {
            limit += 80;
            void prepareThumbnails();
          }}>Show more photographs</button
        >{/if}
      <section id="your-order" class="pc-orders">
        <div>
          <span class="pc-eyebrow">Your collection</span>
          <h2>Selections & delivery</h2>
          <p>
            {gallery.pricing.includedCount} photographs included · {money(
              gallery.pricing.additionalPrice,
              gallery.pricing.currency,
            )} per additional photograph
          </p>
          <p>{gallery.pricing.terms}</p>
        </div>
        <div>
          {#each gallery.rounds as round (round.id)}<p>
              {round.captureIds.length} selections sent · {new Date(round.createdAt).toLocaleDateString()}
            </p>{/each}{#each gallery.orders as order (order.id)}<article class="pc-order">
              <strong>{order.captureIds.length} photographs · {money(order.total, order.currency)}</strong>
              <p>
                {order.status} · {order.paymentTiming === 'before-editing'
                  ? 'Payment before editing'
                  : 'Payment after approval'}
              </p>
              {#if order.status === 'quoted'}<p>{order.terms}</p>
                <button type="button" class="pc-primary" disabled={busy} onclick={() => acceptOrder(order.id)}
                  >Accept order & terms</button
                >{:else if order.status === 'accepted' && order.total > 0 && gallery.checkoutAvailable}<button
                  type="button"
                  disabled={busy}
                  onclick={() => checkout(order.id)}>Pay securely</button
                >{:else if order.status === 'accepted' && order.total > 0}<p>Contact the studio to arrange payment.</p>
                {#if gallery.brand.email}<a href={`mailto:${gallery.brand.email}`}>Contact the studio</a>{/if}{/if}
            </article>{:else}<p>
              Your studio will confirm the order after you send your selections.
            </p>{/each}{#if readyOutputs.length > 0}<div class="pc-download-choices">
              <h3>Choose your files</h3>
              {#each readyOutputs as item (item.output.id)}<label
                  ><input
                    type="checkbox"
                    checked={downloadChoices.includes(item.output.id)}
                    onchange={(event) => {
                      downloadChoices = event.currentTarget.checked
                        ? [...downloadChoices, item.output.id]
                        : downloadChoices.filter((id) => id !== item.output.id);
                    }}
                  />Photo {item.photo.number} · {item.output.label} · {item.output.kind === 'print'
                    ? 'Full resolution'
                    : `${item.output.exportSpec.maxEdge}px`} · {item.output.branded
                    ? 'Studio branding'
                    : 'Clean edit'}</label
                >{/each}
            </div>{:else if downloads.length}<p>{downloads.length} approved photographs ready to download.</p>
          {/if}
          {#if readyOutputs.length || downloads.length}
            {#if archiveParts > 1}<p>
                {archiveCount} files in {archiveParts} ZIP parts. Download each part separately.
              </p>
              {#each Array.from({ length: archiveParts }, (_, part) => part) as part (part)}<button
                  type="button"
                  class="pc-primary"
                  disabled={busy}
                  onclick={() => zip(part)}
                  >Download part {part + 1} ({Math.min(1000, archiveCount - part * 1000)} files)</button
                >{/each}
            {:else}<button type="button" class="pc-primary" disabled={busy || archiveCount === 0} onclick={() => zip()}
                >{readyOutputs.length > 0 ? 'Download selected files' : 'Download edited collection'}</button
              >{/if}
          {/if}
        </div>
      </section>
    </main>
    <footer class="pc-footer">
      <strong>{gallery.brand.name}</strong>
      <p>{gallery.brand.tagline}</p>
      <div>
        {#if gallery.brand.email}<a href={`mailto:${gallery.brand.email}`}>{gallery.brand.email}</a
          >{/if}{#if gallery.brand.phone}<a href={`tel:${gallery.brand.phone}`}>{gallery.brand.phone}</a>{/if}
      </div>
    </footer>
    <Dialog
      open={!!opened}
      title={opened ? `Photo ${opened.number}` : 'Photograph'}
      closeLabel="Close photograph"
      wide
      onRequestClose={closePhoto}
      >{#if opened}<div class="pc-dialog">
          {#if error}<p role="alert">{error}</p>{/if}
          {#if notice}<p role="status">{notice}</p>{/if}
          {#if openedOutput}<p>{openedOutput.label} · Review this version</p>{/if}
          {#if preview}<button
              type="button"
              class="pc-annotated-image"
              class:marking
              aria-label={marking ? 'Drag to mark an area, or press Enter to add an area' : `Photo ${opened.number}`}
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
                alt={`Photo ${opened.number}`}
              />{#each annotations[opened.id] ?? [] as area, index (index)}<span
                  class="pc-annotation"
                  style={`left:${area.x * 100}%;top:${area.y * 100}%;width:${area.width * 100}%;height:${area.height * 100}%`}
                  ><span>{index + 1}</span></span
                >{/each}{#if annotationDraft}<span
                  class="pc-annotation"
                  style={`left:${annotationDraft.x * 100}%;top:${annotationDraft.y * 100}%;width:${annotationDraft.width * 100}%;height:${annotationDraft.height * 100}%`}
                ></span>{/if}</button
            >{:else}<p role="status">Loading photograph…</p>{/if}<label
            >Note for the studio<textarea
              maxlength="2000"
              rows="3"
              bind:value={notes[opened.id]}
              oninput={() => {
                dirty = true;
                notice = 'Unsaved notes';
              }}
              placeholder="Tell us what you love or what you would like adjusted."></textarea></label
          >
          <div class="pc-actions">
            <button
              type="button"
              disabled={busy || !preview || (annotations[opened.id]?.length ?? 0) >= 20}
              aria-pressed={marking}
              onclick={() => {
                marking = !marking;
              }}>Mark an area</button
            ><button
              type="button"
              disabled={busy || !preview || (annotations[opened.id]?.length ?? 0) >= 20}
              onclick={addAnnotation}>Add area with controls</button
            >
          </div>
          {#if marking}<p role="status">Drag over the photograph to mark an area.</p>{/if}
          {#each annotations[opened.id] ?? [] as area, index (index)}<div class="pc-area-controls">
              <label
                >Area {index + 1} note<textarea
                  maxlength="500"
                  rows="2"
                  bind:value={area.text}
                  oninput={() => {
                    dirty = true;
                  }}></textarea></label
              >
              <div class="pc-area-bounds">
                {#each ['x', 'y', 'width', 'height'] as field (field)}<label
                    >{field === 'x' ? 'Left' : field === 'y' ? 'Top' : field === 'width' ? 'Width' : 'Height'} (%)<input
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
                  dirty = true;
                }}>Remove area {index + 1}</button
              >
            </div>{/each}
          <div class="pc-actions">
            <button type="button" aria-pressed={choices.includes(opened.id)} onclick={() => favorite(opened!.id)}
              >{choices.includes(opened.id) ? 'Remove favourite' : 'Add favourite'}</button
            ><button type="button" disabled={busy} onclick={saveChoices}>Save note</button>{#if approvalRevision}<button
                type="button"
                disabled={busy || !preview}
                onclick={() => approval(opened!, true)}>Approve photograph</button
              ><button
                type="button"
                disabled={busy || !preview || !notes[opened.id]?.trim()}
                onclick={() => approval(opened!, false)}>Request adjustment</button
              >{/if}{#if (opened.outputs?.length ?? 0) === 0 && opened.canDownload}<button
                type="button"
                disabled={busy}
                onclick={() => download(opened!)}>Download edited photograph</button
              >{/if}
          </div>
          {#if opened.outputs?.length}<div class="pc-version-outputs">
              <h3>Edited files</h3>
              {#each opened.outputs as output (output.id)}<div class="pc-output">
                  <strong>{output.label}</strong><span
                    >{output.kind === 'print' ? 'Full resolution' : `${output.exportSpec.maxEdge}px`} · {output.branded
                      ? 'Studio branding'
                      : 'Clean edit'}</span
                  >{#if output.canDownload}<button
                      type="button"
                      disabled={busy}
                      onclick={() => download(opened!, output)}>Download {output.label}</button
                    >{:else}<span
                      >{output.blockedReason === 'payment'
                        ? 'Available after payment'
                        : output.blockedReason === 'approval'
                          ? 'Awaiting approval'
                          : output.blockedReason === 'render'
                            ? 'Preparing this file'
                            : 'The studio will confirm availability'}</span
                    >{/if}{#if output.approvalPreviewUrl}<button
                      type="button"
                      disabled={busy}
                      onclick={() => openOutput(opened!, output)}>Review {output.label}</button
                    >{/if}
                </div>{/each}
            </div>{/if}
        </div>{/if}</Dialog
    >
    <Dialog
      bind:open={compareOpen}
      title="Find your favourite"
      closeLabel="Close comparison"
      wide
      onRequestClose={() => (compareOpen = false)}
      ><div class="pc-comparison">
        {#if error}<p role="alert">{error}</p>{/if}
        {#each compareIds as id (id)}<div>
            {#if comparison[id]}<img
                src={comparison[id]}
                alt={`Photo ${gallery.photos.find((photo) => photo.id === id)?.number}`}
              />{:else}<p role="status">Loading…</p>{/if}<button
              type="button"
              aria-pressed={choices.includes(id)}
              onclick={() => favorite(id)}>{choices.includes(id) ? 'Favourite ♥' : 'Choose favourite'}</button
            >
          </div>{/each}
      </div></Dialog
    >
    <Dialog
      bind:open={confirmSubmit}
      title="Send your selections?"
      closeLabel="Close selection confirmation"
      onRequestClose={() => (confirmSubmit = false)}
      ><div class="pc-dialog">
        <p>{choices.length} photographs selected.</p>
        <p>
          {money(selectedPrice, gallery.pricing.currency)} in additional selections, before any studio-confirmed package or
          bundle.
        </p>
        <p>{gallery.pricing.terms}</p>
        <p>The studio will confirm your order. You can send another selection round later.</p>
        <button type="button" class="pc-primary" disabled={busy} onclick={submit}>Send selections to studio</button>
      </div></Dialog
    >
  </div>
{:else}
  <main class="pc-access">
    <span class="pc-eyebrow">Your photography collection</span>
    <h1>A collection for you</h1>
    {#if error}<p role="alert">{error}</p>{/if}{#if invitation}<form onsubmit={enter}>
        <label
          >Gallery password (if provided)<input
            type="password"
            autocomplete="current-password"
            bind:value={password}
          /></label
        ><button type="submit" disabled={busy}>{busy ? 'Opening…' : 'Open collection'}</button>
      </form>{:else if busy}<p role="status">Opening your collection…</p>{:else}<p>
        Open the private invitation your studio sent you.
      </p>{/if}
  </main>
{/if}
