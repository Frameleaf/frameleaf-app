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
  import { onMount, tick } from "svelte";
  import { acquireCandidate, mediaOrigin, MediaFailure } from "./acquisition";
  import { hasMediaAccess, watchMediaAccess } from "./platform";
  import {
    candidateFormat,
    filterCandidates,
    type CaptureCandidate,
  } from "./candidates";
  import { sanitizeSourceUrl } from "./source-url";
  import { sendRequest, watchConnection } from "./platform";
  import type { CapturePreview } from "./preview";
  import {
    lastCollection,
    rememberCollection,
    type ConnectionStatus,
  } from "./settings";
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
  let notice = $state("");
  let saveController: AbortController | undefined;

  const approvedOrigins = new Set<string>();
  const savedCandidates = new Set<string>();
  const imageBytes = new Map<string, Blob>();
  let thumbnails = $state<Record<string, string>>({});
  let thumbnailController = new AbortController();
  const thumbnailQueue: CaptureCandidate[] = [];
  const queuedThumbnails = new Set<string>();
  let thumbnailsLoading = 0;
  /** Bumped by clearImages so rows already on screen ask for their thumbnails again. */
  let thumbnailRound = $state(0);
  function clearImages() {
    saveController?.abort();
    thumbnailController.abort();
    thumbnailController = new AbortController();
    thumbnailQueue.length = 0;
    queuedThumbnails.clear();
    thumbnailRound++;
    for (const url of Object.values(thumbnails)) URL.revokeObjectURL(url);
    thumbnails = {};
    imageBytes.clear();
    approvedOrigins.clear();
    if (screenshotUrl) URL.revokeObjectURL(screenshotUrl);
    screenshotUrl = "";
    screenshotBlob = null;
    preparingScreenshot = false;
  }
  /**
   * Thumbnails download by themselves as their rows come into view, a few at a time, the same way
   * saving does (no cookies, referrer or redirects); the bytes are kept for saving.
   */
  function showThumbnail(
    node: HTMLElement,
    row: { candidate: CaptureCandidate; round: number },
  ) {
    let { candidate } = row;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        if (queuedThumbnails.has(candidate.id)) return;
        queuedThumbnails.add(candidate.id);
        thumbnailQueue.push(candidate);
        pumpThumbnails();
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return {
      update(next: { candidate: CaptureCandidate; round: number }) {
        candidate = next.candidate;
        observer.disconnect();
        observer.observe(node);
      },
      destroy: () => observer.disconnect(),
    };
  }
  function pumpThumbnails() {
    // ponytail: 4 at once is plenty for a list scrolled by hand
    while (thumbnailsLoading < 4 && thumbnailQueue.length) {
      const candidate = thumbnailQueue.shift()!;
      thumbnailsLoading++;
      void loadThumbnail(candidate, thumbnailController.signal).finally(() => {
        thumbnailsLoading--;
        pumpThumbnails();
      });
    }
  }
  async function loadThumbnail(candidate: CaptureCandidate, signal: AbortSignal) {
    try {
      const origin = mediaOrigin(candidate.url);
      if (origin && !approvedOrigins.has(origin)) {
        if (!(await hasMediaAccess(origin))) throw new Error();
        approvedOrigins.add(origin);
      }
      const blob = await acquireCandidate(candidate, approvedOrigins, signal);
      // saved (and released) while it downloaded: nothing left to show it in
      if (
        signal.aborted ||
        savedCandidates.has(candidate.id) ||
        !preview?.discovery.candidates.some((item) => item.id === candidate.id)
      )
        return;
      const used = [...imageBytes.values()].reduce(
        (total, value) => total + value.size,
        0,
      );
      if (used + blob.size > 512 * 1024 * 1024) throw new Error();
      imageBytes.set(candidate.id, blob);
      thumbnails[candidate.id] = URL.createObjectURL(blob);
    } catch {
      // the row keeps its placeholder; saving tries again and says why
    }
  }
  function thumbnailFailed(id: string) {
    if (thumbnails[id]) URL.revokeObjectURL(thumbnails[id]);
    delete thumbnails[id];
    // bytes the browser can't show aren't kept for saving either; saving downloads again
    imageBytes.delete(id);
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
        savedCandidates.clear();
        notice = "";
        nudged = false;
        sourcePage = nextPreview?.discovery.pageUrl ?? "";
        bookmarkTarget = nextPreview?.discovery.bookmarkUrl ?? sourcePage;
        bookmarkQueued = false;
        screenshotDone = false;
        screenshotDimensions = "";
        creationNeedsRefresh = false;
        queuedAny = false;
        sourceTitle = (nextPreview?.discovery.title ?? "").slice(0, 2000);
      }
      // A reload can land before the background has released what was just queued; keep it gone.
      if (nextPreview && savedCandidates.size)
        nextPreview.discovery.candidates =
          nextPreview.discovery.candidates.filter(
            (candidate) => !savedCandidates.has(candidate.id),
          );
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
        void rememberCollection(input.binding.origin, input.albumId);
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
          .map((candidate) => mediaOrigin(candidate.url))
          .filter((origin): origin is string => !!origin)
          .filter((origin) => !approvedOrigins.has(origin)),
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
        savedCandidates.add(candidate.id);
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
          void rememberCollection(form.binding.origin, form.albumId);
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
      await enqueueCapture(input);
      if (preview?.id === previewId) {
        bookmarkQueued = true;
        notice = "Saving the link.";
        queuedAny = true;
        void rememberCollection(input.binding.origin, input.albumId);
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
    if (checked) void showDestination();
  }
  let destinationBox = $state<HTMLDivElement>();
  let nudged = false;
  let nudging = $state(false);
  /** The first pick on a page with no collection chosen brings the collection picker into view, once. */
  async function showDestination() {
    if (nudged || albumId) return;
    nudged = true;
    await tick();
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    destinationBox?.scrollIntoView({
      block: "center",
      behavior: still ? "auto" : "smooth",
    });
    nudging = true;
    setTimeout(() => (nudging = false), 2000);
  }
  $effect(() => {
    // Start in the collection last saved into on this server, while it still exists.
    if (albumId || connection?.status !== "connected") return;
    const origin = connection.binding.origin;
    const ids = collections.map((collection) => collection.id);
    void lastCollection(origin).then((id) => {
      if (
        !albumId &&
        id &&
        ids.includes(id) &&
        connection?.status === "connected" &&
        connection.binding.origin === origin
      )
        albumId = id;
    });
  });
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
  function selectAllShown() {
    const ids = visible.map((candidate) => candidate.id);
    selected = [...new Set([...selected, ...ids])].slice(0, 100);
    if (ids.length) void showDestination();
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
  <div class="destination" class:nudge={nudging} bind:this={destinationBox}>
    <CollectionPicker
      {collections}
      bind:value={albumId}
      disabled={busy}
      createLocked={creationNeedsRefresh}
      onCreate={createCollection}
      onRefresh={refreshCollections}
    />
  </div>
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
        <QueuePanel {collections} />
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
          {#if !visible.length}<p class="hint">
              No images on this page match. Try a smaller width or another
              format.
            </p>{/if}
          <ul class="candidate-list">
            {#each visible as candidate (candidate.id)}
              {@const thumbnail = thumbnails[candidate.id]}
              <li
                class:on={selected.includes(candidate.id)}
                use:showThumbnail={{ candidate, round: thumbnailRound }}
              >
                <label class="candidate"
                  ><input
                    type="checkbox"
                    checked={selected.includes(candidate.id)}
                    disabled={busy ||
                      (selected.length >= 100 &&
                        !selected.includes(candidate.id))}
                    onchange={(event) =>
                      toggle(candidate.id, event.currentTarget.checked)}
                  />{#if thumbnail}<img
                      class="candidate-thumbnail"
                      src={thumbnail}
                      alt=""
                      decoding="async"
                      onerror={() => thumbnailFailed(candidate.id)}
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
          disabled={busy || !albumId || bookmarkQueued}
          onclick={() => void saveBookmark()}
          >{bookmarkQueued ? "Link is saving" : "Save link"}</button
        >
      {:else}
        <button
          class="primary"
          type="button"
          disabled={busy || !selected.length || !albumId}
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
