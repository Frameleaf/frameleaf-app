<script lang="ts">
  import { cropCapture, ScreenshotFailure } from "./capture";
  import { checkWholeCapture } from "./whole-page-capture";
  import {
    WHOLE_PAGE_LIMIT,
    isWholePageInfo,
    wholePageCaption,
    wholePageFilename,
    withCutNote,
  } from "./whole-page";
  import QueuePanel from "./QueuePanel.svelte";
  import CollectionPicker from "./CollectionPicker.svelte";
  import Header from "./Header.svelte";
  import Icon from "./Icon.svelte";
  import TagPicker from "./TagPicker.svelte";
  import type { CollectionChoice } from "./collections";
  import { enqueueCapture, QueueFailure } from "./queue";
  import { captureInput, bookmarkInput } from "./capture-input";
  import { sameBinding } from "./api";
  import { openOptions, requestMediaOrigins } from "./platform";
  import { onMount } from "svelte";
  import { acquireCandidate, mediaOrigin, MediaFailure } from "./acquisition";
  import { requestMediaAccess, watchMediaAccess } from "./platform";
  import {
    candidateFormat,
    filterCandidates,
    type CaptureCandidate,
  } from "./candidates";
  import { sanitizeSourceUrl } from "./source-url";
  import { sendRequest, watchConnection, type QueueItem } from "./platform";
  import type { CapturePreview } from "./preview";
  import type { ConnectionStatus } from "./settings";
  let preview = $state<CapturePreview | null>(null);
  let connection = $state<ConnectionStatus | null>(null);
  let error = $state("");
  let loading = $state(true);
  let selected = $state<string[]>([]);
  let minWidth = $state(0);
  let format = $state("");
  let albumId = $state("");
  let tagIds = $state<string[]>([]);
  let note = $state("");
  let sourcePage = $state("");
  let bookmarkTarget = $state("");
  let bookmarkQueued = $state(false);
  let bookmarkTaskId = $state("");
  let queueItems = $state<QueueItem[]>([]);
  // Latched: a failed queue read empties the list, but a saved link stays saved.
  let bookmarkSaved = $state(false);
  $effect(() => {
    if (
      !bookmarkSaved &&
      queueItems.some(
        (item) =>
          item.id === bookmarkTaskId &&
          (item.state === "saved" || item.state === "duplicate"),
      )
    )
      bookmarkSaved = true;
  });
  $effect(() => {
    if (bookmarkSaved && notice === "Saving the link.") notice = "Link saved.";
  });
  let sourceTitle = $state("");
  let saving = $state(false);
  let creating = $state(false);
  let preparingScreenshot = $state(false);
  let screenshotBlob = $state<Blob | null>(null);
  let screenshotUrl = $state("");
  let screenshotDone = $state(false);
  let screenshotDimensions = $state("");
  let busy = $derived(saving || creating || preparingScreenshot);
  let creationNeedsRefresh = $state(false);
  let queuedAny = $state(false);
  let bulkPreview = $state<string | null>(null);
  let notice = $state("");
  let saveController: AbortController | undefined;

  const imageBytes = new Map<string, Blob>();
  const approvedOrigins = new Set<string>();
  let thumbnails = $state<Record<string, string>>({});
  let previewErrors = $state<Record<string, string>>({});
  let downloading = $state<string | null>(null);
  let download: AbortController | undefined;
  function clearImages() {
    download?.abort();
    saveController?.abort();
    for (const url of Object.values(thumbnails)) URL.revokeObjectURL(url);
    imageBytes.clear();
    thumbnails = {};
    previewErrors = {};
    approvedOrigins.clear();
    if (screenshotUrl) URL.revokeObjectURL(screenshotUrl);
    screenshotUrl = "";
    screenshotBlob = null;
    preparingScreenshot = false;
  }
  async function previewImage(candidate: CaptureCandidate) {
    if (!preview || downloading || busy) return;
    const currentPreview = preview.id;
    const controller = new AbortController();
    download = controller;
    downloading = candidate.id;
    previewErrors[candidate.id] = "";
    try {
      const origin = mediaOrigin(candidate.url);
      if (origin && !approvedOrigins.has(origin)) {
        if (!(await requestMediaAccess(origin)))
          throw new MediaFailure(
            "Access to these images wasn’t allowed. You can try again, or save the page link or a screenshot instead.",
          );
        approvedOrigins.add(origin);
      }
      const blob = await acquireCandidate(
        candidate,
        approvedOrigins,
        controller.signal,
      );
      if (controller.signal.aborted || preview?.id !== currentPreview) return;
      const used = [...imageBytes.values()].reduce(
        (total, value) => total + value.size,
        0,
      );
      if (used + blob.size > 512 * 1024 * 1024)
        throw new MediaFailure(
          "Previews have reached 512 MB. Clear previews to load more.",
        );
      const thumbnail = URL.createObjectURL(blob);
      imageBytes.set(candidate.id, blob);
      thumbnails[candidate.id] = thumbnail;
    } catch (reason) {
      if (!controller.signal.aborted && preview?.id === currentPreview)
        previewErrors[candidate.id] =
          reason instanceof MediaFailure
            ? reason.message
            : "Could not preview this image. Try again, or save the page link or a screenshot instead.";
    } finally {
      if (download === controller) {
        download = undefined;
        downloading = null;
      }
    }
  }
  function previewFailed(id: string, url: string) {
    if (thumbnails[id] !== url) return;
    if (thumbnails[id]) URL.revokeObjectURL(thumbnails[id]);
    delete thumbnails[id];
    imageBytes.delete(id);
    previewErrors[id] =
      "Your browser can’t show this image. Save the page link or a screenshot instead.";
  }
  const visible = $derived(
    filterCandidates(preview?.discovery.candidates ?? [], {
      minWidth,
      formats: format ? [format] : [],
    }),
  );
  async function load() {
    const failure = new URL(location.href).searchParams.get("error");
    if (failure === "page" || failure === "screenshot" || failure === "whole") {
      loading = false;
      error =
        failure === "whole"
          ? "The whole page wasn’t captured. The page was put back as it was, and nothing was saved. Keep the same tab open and focused, then try again, or choose What you can see."
          : failure === "screenshot"
            ? "The screenshot wasn’t taken. Go back to the same tab, check the connection and try again. Nothing was saved."
            : "Could not read that page or image. Go back to the page and try again, or save the page link from the toolbar.";
      return;
    }
    try {
      const reply = await sendRequest({
        type: "preview",
        id: new URL(location.href).searchParams.get("id") ?? "",
      });
      connection = reply.connection ?? null;
      const nextPreview = reply.ok ? (reply.preview ?? null) : null;
      if (preview?.id !== nextPreview?.id) {
        clearImages();
        notice = "";
        sourcePage = nextPreview?.discovery.pageUrl ?? "";
        bookmarkTarget = nextPreview?.discovery.bookmarkUrl ?? sourcePage;
        bookmarkQueued = false;
        bookmarkTaskId = "";
        bookmarkSaved = false;
        screenshotDone = false;
        screenshotDimensions = "";
        creationNeedsRefresh = false;
        queuedAny = false;
        sourceTitle = (nextPreview?.discovery.title ?? "").slice(0, 2000);
      }
      preview = nextPreview;
      error = reply.ok ? "" : reply.error;
      if (
        preview?.screenshot &&
        !screenshotBlob &&
        !screenshotDone &&
        !preparingScreenshot
      )
        void prepareScreenshot(preview);
      if (!preview) {
        selected = [];
        albumId = "";
        tagIds = [];
        note = "";
      }
    } catch {
      clearImages();
      preview = null;
      selected = [];
      error =
        "Could not reopen this page’s images. Go back to the page and find them again.";
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    if (!preview) return;
    const timer = setTimeout(
      () => void load(),
      Math.max(0, preview.createdAt + 15 * 60 * 1000 - Date.now()),
    );
    return () => clearTimeout(timer);
  });
  onMount(() => {
    void load();
    const stopConnection = watchConnection(() => void load());
    const stopMedia = watchMediaAccess(clearImages);
    return () => {
      stopConnection();
      stopMedia();
      clearImages();
    };
  });
  async function prepareScreenshot(current: CapturePreview) {
    const shot = current.screenshot;
    if (!shot?.dataUrl) {
      error =
        "This screenshot was cleared. Take it again from the toolbar.";
      return;
    }
    preparingScreenshot = true;
    try {
      if (!shot.dataUrl.startsWith("data:image/png;base64,"))
        throw new ScreenshotFailure();
      const original = await (await fetch(shot.dataUrl)).blob();
      let blob: Blob;
      if (shot.mode !== "whole")
        blob = await cropCapture(original, shot.viewport, shot.selection);
      else if (isWholePageInfo(shot.whole))
        blob = await checkWholeCapture(original, shot.whole);
      else throw new ScreenshotFailure();
      if (preview?.id !== current.id) return;
      screenshotBlob = blob;
      screenshotUrl = URL.createObjectURL(blob);
    } catch {
      if (preview?.id === current.id)
        error =
          "Could not prepare this screenshot. Take it again; nothing was saved.";
    } finally {
      if (preview?.id === current.id) preparingScreenshot = false;
    }
  }
  async function discardScreenshot() {
    if (!preview?.screenshot || busy) return;
    clearImages();
    screenshotDone = true;
    notice =
      "Screenshot discarded. To take another, open Save to Frameleaf from the toolbar and choose Screenshot.";
    preview.screenshot.dataUrl = null;
    await sendRequest({ type: "release-screenshot", id: preview.id }).catch(
      () => {},
    );
  }
  async function saveScreenshot() {
    if (
      !preview?.screenshot ||
      !screenshotBlob ||
      screenshotDone ||
      connection?.status !== "connected" ||
      busy ||
      !albumId
    )
      return;
    const id = preview.id;
    const mode = preview.screenshot.mode;
    const whole = mode === "whole" ? preview.screenshot.whole : undefined;
    saving = true;
    error = "";
    notice = "";
    try {
      const input = captureInput(
        {
          binding: connection.binding,
          albumId,
          tagIds: [...tagIds],
          note: whole ? withCutNote(note, whole) : note,
        },
        {
          id: "screenshot",
          kind: "image",
          url: "data:image/png,",
          pageUrl: sourcePage,
          title: sourceTitle,
        },
        screenshotBlob,
      );
      input.file!.filename = whole
        ? wholePageFilename(whole, siteName(sourcePage))
        : mode === "area"
          ? "screenshot-area.png"
          : "screenshot-visible.png";
      await enqueueCapture(input);
      if (preview?.id === id) {
        clearImages();
        screenshotDone = true;
        preview.screenshot.dataUrl = null;
        notice = whole?.cut
          ? `Saving, cut short at ${px(WHOLE_PAGE_LIMIT)} px. In Boards it’s called “${wholePageFilename(whole, siteName(sourcePage)).replace(/\.png$/, "")}”, and its note says where it stops.`
          : "Saving the screenshot.";
        queuedAny = true;
      }
      void sendRequest({ type: "wake-queue" }).catch(() => {});
      await sendRequest({ type: "release-screenshot", id }).catch(() => {});
    } catch (reason) {
      if (preview?.id === id)
        error =
          reason instanceof QueueFailure
            ? reason.message
            : "Could not save this screenshot. It’s still here; try again.";
    } finally {
      saving = false;
    }
  }
  async function saveSelected() {
    if (
      !preview ||
      connection?.status !== "connected" ||
      busy ||
      downloading ||
      !selected.length ||
      !albumId
    )
      return;
    if (!sanitizeSourceUrl(sourcePage)) {
      error = "Enter a valid source page address before saving.";
      return;
    }
    const previewId = preview.id;
    const form = {
      binding: connection.binding,
      albumId,
      tagIds: [...tagIds],
      note,
    };
    const source = {
      pageUrl: sourcePage,
      title: sourceTitle,
      capturedAt: new Date().toISOString(),
    };
    const batch = preview.discovery.candidates
      .filter((candidate) => selected.includes(candidate.id))
      .slice(0, 100);
    const origins = [
      ...new Set(
        batch
          .filter((candidate) => !imageBytes.has(candidate.id))
          .map((candidate) => mediaOrigin(candidate.url))
          .filter((origin): origin is string => !!origin),
      ),
    ];
    const controller = new AbortController();
    saveController = controller;
    saving = true;
    error = "";
    notice = "";
    let queued = 0;
    try {
      if (origins.length && !(await requestMediaOrigins(origins)))
        throw new MediaFailure(
          "Access to these images wasn’t allowed. Your selection is kept so you can try again.",
        );
      for (const origin of origins) approvedOrigins.add(origin);
      for (const candidate of batch) {
        if (
          controller.signal.aborted ||
          preview?.id !== previewId ||
          connection?.status !== "connected" ||
          !sameBinding(connection.binding, form.binding)
        )
          break;
        const blob =
          imageBytes.get(candidate.id) ??
          (await acquireCandidate(
            candidate,
            approvedOrigins,
            controller.signal,
          ));
        if (controller.signal.aborted || preview?.id !== previewId) break;
        await enqueueCapture(
          captureInput(
            form,
            { ...candidate, pageUrl: source.pageUrl, title: source.title },
            blob,
            source.capturedAt,
          ),
        );
        queued++;
        selected = selected.filter((id) => id !== candidate.id);
        if (thumbnails[candidate.id])
          URL.revokeObjectURL(thumbnails[candidate.id]);
        delete thumbnails[candidate.id];
        imageBytes.delete(candidate.id);
        if (preview?.id === previewId) {
          preview.discovery.candidates = preview.discovery.candidates.filter(
            (value) => value.id !== candidate.id,
          );
          notice = `Saving ${queued} ${queued === 1 ? "image" : "images"}.`;
          queuedAny = true;
        }
        // Delivery owns its controller after the atomic enqueue; closing this page cannot cancel it.
        void sendRequest({ type: "wake-queue" }).catch(() => {});
        await sendRequest({
          type: "release-candidates",
          id: previewId,
          candidateIds: [candidate.id],
        }).catch(() => {});
      }
    } catch (reason) {
      if (preview?.id === previewId)
        error =
          reason instanceof MediaFailure || reason instanceof QueueFailure
            ? reason.message
            : "Could not save all of this selection. Images already saving carry on; try the rest again.";
    } finally {
      if (saveController === controller) {
        saveController = undefined;
        saving = false;
      }
    }
  }
  async function saveBookmark() {
    if (
      !preview ||
      connection?.status !== "connected" ||
      busy ||
      downloading ||
      !albumId ||
      bookmarkQueued
    )
      return;
    const previewId = preview.id;
    saving = true;
    error = "";
    notice = "";
    try {
      const input = bookmarkInput(
        { binding: connection.binding, albumId, tagIds: [...tagIds], note },
        bookmarkTarget,
        sourcePage,
        sourceTitle,
      );
      const task = await enqueueCapture(input);
      if (preview?.id === previewId) {
        bookmarkQueued = true;
        bookmarkTaskId = task.id;
        notice = "Saving the link.";
        queuedAny = true;
      }
      void sendRequest({ type: "wake-queue" }).catch(() => {});
    } catch (reason) {
      if (preview?.id === previewId)
        error =
          reason instanceof QueueFailure
            ? reason.message
            : "Could not save this link. Check the address and try again.";
    } finally {
      saving = false;
    }
  }
  async function refreshCollections() {
    if (!preview || connection?.status !== "connected" || busy) return;
    const previewId = preview.id;
    const binding = connection.binding;
    creating = true;
    error = "";
    try {
      const reply = await sendRequest({ type: "refresh" });
      if (preview?.id !== previewId) return;
      if (!reply.ok) {
        error = reply.error;
        return;
      }
      if (
        reply.connection?.status !== "connected" ||
        !sameBinding(reply.connection.binding, binding)
      )
        return;
      connection = reply.connection;
      creationNeedsRefresh = false;
    } catch {
      error = "Could not refresh collections. Try again.";
    } finally {
      creating = false;
    }
  }
  async function createCollection(
    rawName: string,
    parentId: string,
  ): Promise<boolean> {
    if (
      !preview ||
      connection?.status !== "connected" ||
      busy ||
      creationNeedsRefresh
    )
      return false;
    const name = rawName.trim();
    if (!name || name.length > 255) {
      error = "Enter a collection name of 1 to 255 characters.";
      return false;
    }
    const previewId = preview.id;
    const binding = connection.binding;
    creating = true;
    error = "";
    notice = "";
    // An interrupted request may still have worked, so creating again waits for a refresh.
    creationNeedsRefresh = true;
    try {
      const reply = await sendRequest({
        type: "create-album",
        previewId,
        name,
        ...(parentId && { parentId }),
      });
      if (preview?.id !== previewId) return false;
      if (!reply.ok) {
        error = reply.error;
        return false;
      }
      if (
        reply.connection?.status !== "connected" ||
        !sameBinding(reply.connection.binding, binding)
      )
        return false;
      connection = reply.connection;
      if (
        !reply.albumId ||
        !connection.catalog?.albums.some((album) => album.id === reply.albumId)
      )
        throw new Error();
      albumId = reply.albumId;
      notice = `Made “${name}” and chose it. Nothing has been saved yet.`;
      creationNeedsRefresh = false;
      return true;
    } catch {
      error =
        "Could not confirm the new collection. Refresh collections and check where you are saving before trying again.";
      return false;
    } finally {
      creating = false;
    }
  }
  function toggle(id: string, checked: boolean) {
    selected = checked
      ? selected.length < 100
        ? [...selected, id]
        : selected
      : selected.filter((value) => value !== id);
  }
  const collections = $derived<CollectionChoice[]>(
    connection?.catalog?.albums ?? [],
  );
  const widths = [
    [0, "Any width"],
    [800, "800 px wide"],
    [1200, "1,200 px wide"],
    [1600, "1,600 px wide"],
  ] as const;
  const formats = ["jpeg", "png", "webp", "avif", "gif", "svg"];
  const host = (origin: string | null) =>
    origin ? origin.replace(/^https?:\/\//, "") : "this page";
  let approvedOriginsView = $state<string[]>([]);
  $effect(() => {
    // Keep a reactive copy so the privacy note updates when access is granted or cleared.
    void thumbnails;
    approvedOriginsView = [...approvedOrigins];
  });
  /** Image origins on screen that haven't been asked for anything yet. */
  const unaskedOrigins = $derived(
    [
      ...new Set(
        visible
          .map((candidate) => mediaOrigin(candidate.url))
          .filter((origin): origin is string => !!origin),
      ),
    ].filter(
      (origin) =>
        !approvedOriginsView.includes(origin) &&
        !visible.some(
          (candidate) =>
            mediaOrigin(candidate.url) === origin && thumbnails[candidate.id],
        ),
    ),
  );
  async function previewOrigin(origin: string) {
    if (!preview || downloading || busy || bulkPreview) return;
    bulkPreview = origin;
    const currentPreview = preview.id;
    try {
      for (const candidate of visible.filter(
        (value) => mediaOrigin(value.url) === origin && !thumbnails[value.id],
      )) {
        if (bulkPreview !== origin || preview?.id !== currentPreview) break;
        await previewImage(candidate);
        // Stop if access was refused or the download was cancelled.
        if (!approvedOrigins.has(origin) || previewErrors[candidate.id]) break;
      }
    } finally {
      bulkPreview = null;
    }
  }
  function cancelPreviews() {
    bulkPreview = null;
    download?.abort();
  }
  function selectAllShown() {
    const ids = visible.map((candidate) => candidate.id);
    selected = [...new Set([...selected, ...ids])].slice(0, 100);
  }
  const imageWord = (count: number) => (count === 1 ? "image" : "images");
  const screenshotSize = $derived(
    screenshotDimensions ? ` · ${screenshotDimensions}` : "",
  );
  const px = (value: number) => Math.round(value).toLocaleString("en-US");
  function siteName(page: string) {
    try {
      return new URL(page).hostname || "web page";
    } catch {
      return "web page";
    }
  }
  const wholeInfo = $derived(
    preview?.screenshot?.mode === "whole" &&
      isWholePageInfo(preview.screenshot.whole)
      ? preview.screenshot.whole
      : null,
  );
  let strip = $state<HTMLDivElement | null>(null);
  function showCut() {
    // A cut picture opens at the cut, so where it stops is the first thing seen.
    if (wholeInfo?.cut && strip) strip.scrollTop = strip.scrollHeight;
  }
  function label(url: string) {
    if (url.startsWith("data:")) return "Embedded image";
    if (url.startsWith("blob:")) return "Page image";
    return sanitizeSourceUrl(url) ?? "Image";
  }
</script>

{#snippet destination()}
  <CollectionPicker
    {collections}
    bind:value={albumId}
    disabled={busy}
    createLocked={creationNeedsRefresh}
    onCreate={createCollection}
    onRefresh={refreshCollections}
  />
  <TagPicker
    tags={connection?.catalog?.tags ?? []}
    bind:selected={tagIds}
    disabled={busy}
  />
  <div class="field">
    <label for="note">Note</label><textarea
      id="note"
      rows="2"
      maxlength="10000"
      placeholder="Optional"
      disabled={busy}
      bind:value={note}></textarea>
  </div>
{/snippet}

{#snippet source(includeTitle: boolean)}
  <details class="source">
    <summary>Where it came from</summary>
    {#if includeTitle}<div class="field">
        <label for="source-title">Source title</label><input
          id="source-title"
          maxlength="2000"
          disabled={busy}
          bind:value={sourceTitle}
        />
      </div>{/if}
    <div class="field">
      <label for="source-page">Source page</label><input
        id="source-page"
        type="url"
        maxlength="8192"
        disabled={busy}
        bind:value={sourcePage}
        aria-describedby="source-help"
      />
      <small class="hint" id="source-help"
        >Saved with it as where you found it. Anything after “?” or “#” is
        removed.</small
      >
    </div>
  </details>
{/snippet}

<main class="sheet capture-sheet">
  <Header
    origin={connection?.status === "connected"
      ? connection.binding.origin
      : null}
    onSettings={() => void openOptions()}
  />
  <div class="sheet-body">
    <h2 class="mode-title">
      {preview?.screenshot
        ? "Screenshot"
        : preview?.discovery.bookmarkUrl
          ? "Save this page"
          : "Save images"}
    </h2>
    {#if loading}<p role="status">Reading the page…</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if notice}<p class="notice-line" role="status">
        <Icon name="checkCircle" />{notice}
      </p>{/if}
    {#if queuedAny}<p class="hint">
        You can close this tab. Saving carries on in the background, even if
        you close the browser.
      </p>
      <details class="progress">
        <summary>See progress</summary>
        <QueuePanel {collections} bind:items={queueItems} />
      </details>{/if}
    {#if preview}
      {#if preview.screenshot}
        <section aria-label="Screenshot preview" class="stack">
          {#if preparingScreenshot}<p role="status">
              Preparing the screenshot…
            </p>{:else if screenshotUrl && wholeInfo}<figure class="shot">
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <div
                class="whole-strip"
                bind:this={strip}
                tabindex="0"
                aria-label={wholeInfo.cut
                  ? "Preview of the picture, scrolled to where it was cut"
                  : "Preview of the whole page"}
              >
                <img
                  class="whole-preview"
                  src={screenshotUrl}
                  alt={wholeInfo.cut
                    ? "The page down to where it was cut, to check before saving"
                    : "The whole page, to check before saving"}
                  onload={showCut}
                />
                {#if wholeInfo.cut}<div class="whole-cut">
                    <span
                      >Cut here at {px(WHOLE_PAGE_LIMIT)} px · the page goes on</span
                    >
                  </div>{:else}<div class="whole-end">
                    <Icon name="check" size={14} /> End of the page
                  </div>{/if}
              </div>
              <figcaption class:cut-caption={wholeInfo.cut}>
                {#if wholeInfo.cut}<Icon
                    name="alertOutline"
                    size={14}
                  />{/if}{wholePageCaption(wholeInfo)}
              </figcaption>
            </figure>
            {#if wholeInfo.cut}<div class="cut-warning" role="note">
                <Icon name="contentCut" size={18} />
                <span>
                  <strong>Too tall for one picture, so it was cut short</strong>
                  One picture holds up to {px(WHOLE_PAGE_LIMIT)} px. This one stops
                  {px(wholeInfo.pageHeight - wholeInfo.height)} px before the end
                  of the page, and is saved as cut short. For the rest, scroll down
                  and use Select an area.
                </span>
              </div>{:else}<p class="hint">
                Joined from {wholeInfo.screens}
                {wholeInfo.screens === 1 ? "screen" : "screens"}, top to bottom.{wholeInfo.keptBars
                  ? " Bars that stay on screen are kept once at the top."
                  : ""}
              </p>{/if}
            {#if wholeInfo.reduced}<p class="hint">
                Made a little smaller than your screen shows it, so the whole
                picture fits in one file.
              </p>{/if}
          {:else if screenshotUrl}<figure class="shot">
              <img
                class="screenshot-preview"
                src={screenshotUrl}
                alt="The screenshot to check before saving"
                onload={(event) => {
                  if (event.currentTarget instanceof HTMLImageElement)
                    screenshotDimensions = `${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`;
                }}
              />
              <figcaption>
                {preview.screenshot.mode === "area"
                  ? "Area"
                  : "Visible page"}{screenshotSize} · PNG
              </figcaption>
            </figure>{/if}
          <p class="hint">
            Check it before saving. This is a picture of the page, not its
            original images. Screenshots can be up to 40 million pixels.
          </p>
        </section>
        {@render destination()}
        {@render source(true)}
      {:else if preview.discovery.bookmarkUrl}
        <section aria-label="Page link" class="stack">
          <div class="page-card">
            <span class="page-card-icon" aria-hidden="true"
              ><Icon name="linkVariant" size={20} /></span
            >
            <span>
              <strong>{preview.discovery.title || "Untitled page"}</strong>
              <small class="address">{preview.discovery.pageUrl}</small>
            </span>
          </div>
          <div class="field">
            <label for="bookmark-title">Title</label><input
              id="bookmark-title"
              maxlength="2000"
              disabled={busy || bookmarkQueued}
              bind:value={sourceTitle}
            />
          </div>
          <div class="field">
            <label for="bookmark-target">Address</label><input
              id="bookmark-target"
              type="url"
              maxlength="8192"
              disabled={busy || bookmarkQueued}
              bind:value={bookmarkTarget}
              aria-describedby="bookmark-help"
            />
            <small class="hint warning" id="bookmark-help"
              >The whole address is kept, including anything after “?”. Remove
              personal details, such as booking or tracking codes, before
              saving.</small
            >
          </div>
          <p class="hint">
            Saves the address and title as a link in Boards. The page itself
            isn’t copied.
          </p>
        </section>
        {@render destination()}
        {@render source(false)}
      {:else}
        <section aria-label="Discovered images" class="stack">
          <p class="page-line">
            <strong>{preview.discovery.title || "Untitled page"}</strong>
            <span class="address">{preview.discovery.pageUrl}</span>
          </p>
          <div class="filters">
            <div class="filter-width">
              <label for="min-width">At least</label>
              <select id="min-width" bind:value={minWidth}>
                {#each widths as [value, text] (value)}<option {value}
                    >{text}</option
                  >{/each}
              </select>
            </div>
            <fieldset class="chips">
              <legend class="visually-hidden">Format</legend>
              <label class="chip"
                ><input
                  type="radio"
                  name="format"
                  value=""
                  bind:group={format}
                /><span>All</span></label
              >
              {#each formats as value (value)}<label class="chip"
                  ><input
                    type="radio"
                    name="format"
                    {value}
                    bind:group={format}
                  /><span>{value.toUpperCase()}</span></label
                >{/each}
            </fieldset>
          </div>
          <div class="selection-bar">
            <p role="status">
              {selected.length} of 100 selected · {visible.length} shown
            </p>
            {#if selected.length}<button
                type="button"
                class="link-button"
                onclick={() => (selected = [])}
                disabled={busy}>Clear selection</button
              >{:else}<button
                type="button"
                class="link-button"
                onclick={selectAllShown}
                disabled={busy || !visible.length}>Select all shown</button
              >{/if}
          </div>
          {#if unaskedOrigins.length}
            <div class="privacy">
              <Icon name="shieldLockOutline" size={18} />
              <div>
                <p>
                  Previews aren’t loaded yet, so {unaskedOrigins.length === 1
                    ? `${host(unaskedOrigins[0])} hasn’t`
                    : "these sites haven’t"} been asked for anything.
                </p>
                {#each unaskedOrigins.slice(0, 3) as origin (origin)}<button
                    type="button"
                    class="link-button"
                    disabled={busy || !!downloading || !!bulkPreview}
                    onclick={() => void previewOrigin(origin)}
                    >Show previews from {host(origin)}</button
                  >{/each}
              </div>
            </div>
          {/if}
          <div class="preview-actions">
            {#if downloading || bulkPreview}<button
                type="button"
                class="small"
                onclick={cancelPreviews}>Stop loading previews</button
              >{/if}
            <button
              type="button"
              class="small"
              disabled={busy || !Object.keys(thumbnails).length}
              onclick={clearImages}>Clear loaded previews</button
            >
          </div>
          {#if !visible.length}<p class="hint">
              No images on this page match. Try a smaller width or another
              format.
            </p>{/if}
          <ul class="candidate-list">
            {#each visible as candidate (candidate.id)}
              {@const origin = mediaOrigin(candidate.url)}
              <li class:on={selected.includes(candidate.id)}>
                <label class="candidate"
                  ><input
                    type="checkbox"
                    checked={selected.includes(candidate.id)}
                    disabled={busy ||
                      (selected.length >= 100 &&
                        !selected.includes(candidate.id))}
                    onchange={(event) =>
                      toggle(candidate.id, event.currentTarget.checked)}
                  />{#if thumbnails[candidate.id]}<img
                      class="candidate-thumbnail"
                      src={thumbnails[candidate.id]}
                      alt=""
                      onerror={(event) =>
                        previewFailed(
                          candidate.id,
                          event.currentTarget.getAttribute("src") ?? "",
                        )}
                    />{:else}<span
                      class="candidate-placeholder"
                      aria-hidden="true"
                      ><Icon name="imageOutline" size={20} /></span
                    >{/if}<span class="candidate-meta"
                    >{candidate.width
                      ? `${candidate.width} px`
                      : "Width unknown"} · {(
                      candidateFormat(candidate) ?? "image"
                    ).toUpperCase()}</span
                  ><span class="candidate-name address"
                    >{label(candidate.url)}</span
                  ></label
                >
                {#if !thumbnails[candidate.id]}<button
                    type="button"
                    class="preview-button"
                    aria-label={downloading === candidate.id
                      ? undefined
                      : `Preview from ${origin ?? "this page"}`}
                    disabled={busy || !!downloading || !!bulkPreview}
                    onclick={() => void previewImage(candidate)}
                    >{downloading === candidate.id
                      ? "Loading preview…"
                      : "Preview"}</button
                  >{/if}
                {#if previewErrors[candidate.id]}<p class="error" role="alert">
                    {previewErrors[candidate.id]}
                  </p>{/if}
              </li>
            {/each}
          </ul>
          <p class="hint">
            Icons and tracking pixels are left out. Images are saved at full
            size, up to 100 MB each.
          </p>
        </section>
        {@render destination()}
        {@render source(true)}
      {/if}
    {/if}
  </div>
  {#if preview}
    <footer class="sheet-foot">
      {#if preview.screenshot}
        <button
          type="button"
          disabled={busy || !screenshotUrl || screenshotDone}
          onclick={() => void discardScreenshot()}>Retake</button
        >
        <button
          class="primary"
          type="button"
          disabled={busy || !screenshotBlob || screenshotDone || !albumId}
          onclick={() => void saveScreenshot()}
          >{saving
            ? "Saving…"
            : wholeInfo?.cut
              ? "Save cut-short picture"
              : "Save screenshot"}</button
        >
      {:else if preview.discovery.bookmarkUrl}
        <button
          type="button"
          class="primary"
          disabled={busy || !!downloading || !albumId || bookmarkQueued}
          onclick={() => void saveBookmark()}
          >{bookmarkSaved
            ? "Link saved"
            : bookmarkQueued
              ? "Link is saving"
              : "Save link"}</button
        >
      {:else}
        <button
          class="primary"
          type="button"
          disabled={busy || !!downloading || !selected.length || !albumId}
          onclick={() => void saveSelected()}
          >{saving
            ? "Saving…"
            : selected.length
              ? `Save ${selected.length} ${imageWord(selected.length)}`
              : "Save images"}</button
        >
      {/if}
    </footer>
  {/if}
</main>
