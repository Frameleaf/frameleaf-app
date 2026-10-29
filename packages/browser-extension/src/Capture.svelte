<script lang="ts">
  import QueuePanel from "./QueuePanel.svelte";
  import { enqueueCapture, QueueFailure } from "./queue";
  import { captureInput, bookmarkInput } from "./capture-input";
  import { sameBinding } from "./api";
  import { requestMediaOrigins } from "./platform";
  import { onMount } from "svelte";
  import { acquireCandidate, mediaOrigin, MediaFailure } from "./acquisition";
  import { requestMediaAccess, watchMediaAccess } from "./platform";
  import {
    filterCandidates,
    discoveryLimits,
    type CaptureCandidate,
  } from "./candidates";
  import { sanitizeSourceUrl } from "./source-url";
  import { sendRequest, watchConnection } from "./platform";
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
  let sourceTitle = $state("");
  let saving = $state(false);
  let creating = $state(false);
  let busy = $derived(saving || creating);
  let newAlbumName = $state("");
  let newAlbumParent = $state("");
  let creationNeedsRefresh = $state(false);
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
            "Image access was not granted. You can try again or choose a bookmark or screenshot.",
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
          "Loaded previews have reached 512 MiB. Clear previews to continue.",
        );
      const thumbnail = URL.createObjectURL(blob);
      imageBytes.set(candidate.id, blob);
      thumbnails[candidate.id] = thumbnail;
    } catch (reason) {
      if (!controller.signal.aborted && preview?.id === currentPreview)
        previewErrors[candidate.id] =
          reason instanceof MediaFailure
            ? reason.message
            : "Could not preview this image. Try again or choose a bookmark or screenshot.";
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
      "This image cannot be displayed by your browser. Choose a bookmark or screenshot instead.";
  }
  const visible = $derived(
    filterCandidates(preview?.discovery.candidates ?? [], {
      minWidth,
      formats: format ? [format] : [],
    }),
  );
  async function load() {
    if (new URL(location.href).searchParams.get("error") === "page") {
      loading = false;
      error =
        "Could not inspect the selected page or image. Return to its top-level webpage and try again, or use Save page bookmark from the toolbar.";
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
        newAlbumName = "";
        newAlbumParent = "";
        creationNeedsRefresh = false;
        sourceTitle = (nextPreview?.discovery.title ?? "").slice(0, 2000);
      }
      preview = nextPreview;
      error = reply.ok ? "" : reply.error;
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
        "Could not reopen this collection. Return to the webpage and find its images again.";
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
          "Image access was not granted. Your selection is retained so you can try again.",
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
          notice = `Queued ${queued} ${queued === 1 ? "image" : "images"}.`;
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
            : "Could not queue this selection. Queued images are retained; try the remaining selection again.";
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
      await enqueueCapture(input);
      if (preview?.id === previewId) {
        bookmarkQueued = true;
        notice = "Queued 1 bookmark.";
      }
      void sendRequest({ type: "wake-queue" }).catch(() => {});
    } catch (reason) {
      if (preview?.id === previewId)
        error =
          reason instanceof QueueFailure
            ? reason.message
            : "Could not queue this bookmark. Check the address and try again.";
    } finally {
      saving = false;
    }
  }
  async function createDestination(refreshOnly = false) {
    if (
      !preview ||
      connection?.status !== "connected" ||
      busy ||
      (!refreshOnly && creationNeedsRefresh)
    )
      return;
    const name = newAlbumName.trim();
    if (!refreshOnly && (!name || name.length > 255)) {
      error = "Enter an album name of 1 to 255 characters.";
      return;
    }
    const previewId = preview.id;
    const binding = connection.binding;
    creating = true;
    error = "";
    notice = "";
    if (!refreshOnly) creationNeedsRefresh = true;
    try {
      const reply = await sendRequest(
        refreshOnly
          ? { type: "refresh" }
          : {
              type: "create-album",
              previewId,
              name,
              ...(newAlbumParent && { parentId: newAlbumParent }),
            },
      );
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
      if (!refreshOnly) {
        if (
          !reply.albumId ||
          !connection.catalog?.albums.some(
            (album) => album.id === reply.albumId,
          )
        )
          throw new Error();
        albumId = reply.albumId;
        newAlbumName = "";
        notice = "Album created and selected. Captures have not been saved.";
      }
      creationNeedsRefresh = false;
    } catch {
      error =
        "Could not confirm album creation. Refresh albums and check the destination before trying again.";
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
  function albumName(id: string): string {
    const albums = connection?.catalog?.albums ?? [];
    const parts: string[] = [];
    const seen = new Set<string>();
    let current = albums.find((album) => album.id === id);
    while (current && !seen.has(current.id) && parts.length < 32) {
      seen.add(current.id);
      parts.unshift(current.albumName);
      current = albums.find((album) => album.id === current?.parentId);
    }
    return parts.join(" / ");
  }
  function label(url: string) {
    if (url.startsWith("data:")) return "Embedded image";
    if (url.startsWith("blob:")) return "Page image";
    return sanitizeSourceUrl(url) ?? "Image";
  }
</script>

<main
  class="collection"
  class:bookmark-collection={!!preview?.discovery.bookmarkUrl}
>
  <header>
    <img src="icons/icon48.png" width="32" height="32" alt="" />
    <h1>
      {preview?.discovery.bookmarkUrl ? "Save page bookmark" : "Collect images"}
    </h1>
  </header>
  {#if loading}<p role="status">Reading your collection…</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if preview}
    <p class="page-title">{preview.discovery.title || "Untitled page"}</p>
    <p class="address">{preview.discovery.pageUrl}</p>
    <div class="collection-layout">
      {#if preview.discovery.bookmarkUrl}<section aria-label="Bookmark preview">
          <h2>Page bookmark</h2>
          <p>
            Save a link with your tags and note. The page and its images will
            not be downloaded.
          </p>
        </section>{:else}
        <section aria-label="Discovered images">
          <div class="filters">
            <label
              >Minimum width <input
                type="number"
                min="0"
                max="100000"
                bind:value={minWidth}
              /></label
            >
            <div class="format-filter">
              <label for="format">Format</label>
              <select id="format" bind:value={format}>
                <option value="">All formats</option>
                {#each ["jpeg", "png", "webp", "avif", "gif", "svg"] as value}
                  <option {value}>{value.toUpperCase()}</option>
                {/each}
              </select>
            </div>
          </div>
          <p class="hint">
            Dimensions and formats are page hints. Unloaded content and other
            frames are excluded. Discovery is limited to {discoveryLimits.candidates}
            images and {discoveryLimits.elements.toLocaleString()} elements.
          </p>
          <div class="selection-bar">
            <p role="status">
              {selected.length} of 100 selected · {visible.length} shown
            </p>
            <button
              type="button"
              onclick={() => (selected = [])}
              disabled={busy || !selected.length}>Clear selection</button
            >
          </div>
          {#if !visible.length}<p>
              No matching images are available on this page.
            </p>{/if}
          <p class="hint">
            Previews download anonymously from the origin shown on each button.
            Permission is requested when needed. Redirected and protected images
            may need a bookmark or screenshot.
          </p>
          <div class="preview-actions">
            <button
              type="button"
              disabled={busy || !Object.keys(thumbnails).length}
              onclick={clearImages}>Clear loaded previews</button
            >
            {#if downloading}<button
                type="button"
                onclick={() => download?.abort()}>Cancel download</button
              >{/if}
          </div>
          <ul class="candidate-list">
            {#each visible as candidate (candidate.id)}
              <li>
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
                      aria-hidden="true">Image</span
                    >{/if}<span class="candidate-description"
                    ><span class="address">{label(candidate.url)}</span><span
                      class="muted"
                      >{candidate.width
                        ? `${candidate.width}px wide`
                        : "Width unknown"}{candidate.height
                        ? ` · ${candidate.height}px high`
                        : ""}</span
                    ></span
                  ></label
                >
                <button
                  type="button"
                  class="preview-button"
                  disabled={busy || !!downloading || !!thumbnails[candidate.id]}
                  onclick={() => void previewImage(candidate)}
                  >{downloading === candidate.id
                    ? "Loading preview…"
                    : thumbnails[candidate.id]
                      ? "Preview loaded"
                      : `Preview from ${mediaOrigin(candidate.url) ?? "this page"}`}</button
                >
                {#if previewErrors[candidate.id]}<p class="error" role="alert">
                    {previewErrors[candidate.id]}
                  </p>{/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}
      <aside aria-label="Destination">
        <h2>Destination</h2>
        <p class="address">{connection?.binding.origin}</p>
        <label for="album">Album</label>
        <select id="album" disabled={busy} bind:value={albumId}
          ><option value="">Choose a design album</option
          >{#each connection?.catalog?.albums ?? [] as album}<option
              value={album.id}>{albumName(album.id)}</option
            >{/each}</select
        >
        <details>
          <summary>Create an album</summary>
          <div class="album-create-form">
            <label for="new-album-name">New album name</label><input
              id="new-album-name"
              maxlength="255"
              disabled={busy || creationNeedsRefresh}
              bind:value={newAlbumName}
            />
            <label for="new-album-parent">Parent album</label><select
              id="new-album-parent"
              disabled={busy || creationNeedsRefresh}
              bind:value={newAlbumParent}
              ><option value="">Top level</option
              >{#each connection?.catalog?.albums ?? [] as album}<option
                  value={album.id}>{albumName(album.id)}</option
                >{/each}</select
            >
            <button
              type="button"
              disabled={busy || creationNeedsRefresh || !newAlbumName.trim()}
              onclick={() => void createDestination()}
              >Create and select album</button
            >
            {#if creationNeedsRefresh}<p class="hint">
                Check the refreshed album list before creating again; an
                interrupted request may have succeeded.
              </p>{/if}
            <button
              type="button"
              disabled={busy}
              onclick={() => void createDestination(true)}
              >Refresh albums</button
            >
          </div>
        </details>
        {#if connection?.catalog?.tags.length}<fieldset>
            <legend>Tags</legend>{#each connection.catalog.tags as tag}<label
                class="tag-choice"
                ><input
                  type="checkbox"
                  disabled={busy}
                  bind:group={tagIds}
                  value={tag.id}
                />{tag.value}</label
              >{/each}
          </fieldset>{/if}
        <label for="note">Note</label><textarea
          id="note"
          rows="4"
          maxlength="10000"
          disabled={busy}
          bind:value={note}></textarea>
        <label for="source-title">Source title</label><input
          id="source-title"
          maxlength="2000"
          disabled={busy}
          bind:value={sourceTitle}
        />
        <label for="source-page">Source page</label><input
          id="source-page"
          type="url"
          maxlength="8192"
          disabled={busy}
          bind:value={sourcePage}
        />
        <p class="hint">Source query parameters and fragments are removed.</p>
        {#if !preview.discovery.bookmarkUrl}<button
            class="primary"
            type="button"
            disabled={busy || !!downloading || !selected.length || !albumId}
            onclick={() => void saveSelected()}
            >{saving ? "Queuing images…" : "Save selected images"}</button
          >
          <p class="hint">
            This is a collection preview. Selected images have not been saved.
          </p>{/if}
        <label for="bookmark-target">Bookmark address</label><input
          id="bookmark-target"
          type="url"
          maxlength="8192"
          disabled={busy || bookmarkQueued}
          bind:value={bookmarkTarget}
        />
        <p class="hint">
          The confirmed bookmark address keeps its query parameters and
          fragment. Remove private values before saving.
        </p>
        <button
          type="button"
          class:primary={!!preview.discovery.bookmarkUrl}
          disabled={busy || !!downloading || !albumId || bookmarkQueued}
          onclick={() => void saveBookmark()}
          >{bookmarkQueued ? "Bookmark queued" : "Save page bookmark"}</button
        >
      </aside>
    </div>
  {/if}
  {#if connection?.status === "connected"}<QueuePanel />{/if}
</main>
