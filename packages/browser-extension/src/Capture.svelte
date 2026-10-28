<script lang="ts">
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
  const imageBytes = new Map<string, Blob>();
  const approvedOrigins = new Set<string>();
  let thumbnails = $state<Record<string, string>>({});
  let previewErrors = $state<Record<string, string>>({});
  let downloading = $state<string | null>(null);
  let download: AbortController | undefined;
  function clearImages() {
    download?.abort();
    for (const url of Object.values(thumbnails)) URL.revokeObjectURL(url);
    imageBytes.clear();
    thumbnails = {};
    previewErrors = {};
    approvedOrigins.clear();
  }
  async function previewImage(candidate: CaptureCandidate) {
    if (!preview || downloading) return;
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
    try {
      const reply = await sendRequest({
        type: "preview",
        id: new URL(location.href).searchParams.get("id") ?? "",
      });
      connection = reply.connection ?? null;
      const nextPreview = reply.ok ? (reply.preview ?? null) : null;
      if (preview?.id !== nextPreview?.id) clearImages();
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

<main class="collection">
  <header>
    <img src="icons/icon48.png" width="32" height="32" alt="" />
    <h1>Collect images</h1>
  </header>
  {#if loading}<p role="status">Reading your collection…</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if preview}
    <p class="page-title">{preview.discovery.title || "Untitled page"}</p>
    <p class="address">{preview.discovery.pageUrl}</p>
    <div class="collection-layout">
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
            disabled={!selected.length}>Clear selection</button
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
            disabled={!Object.keys(thumbnails).length}
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
                  disabled={selected.length >= 100 &&
                    !selected.includes(candidate.id)}
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
                disabled={!!downloading || !!thumbnails[candidate.id]}
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
      <aside aria-label="Destination">
        <h2>Destination</h2>
        <p class="address">{connection?.binding.origin}</p>
        <label for="album">Album</label>
        <select id="album" bind:value={albumId}
          ><option value="">Choose a design album</option
          >{#each connection?.catalog?.albums ?? [] as album}<option
              value={album.id}>{albumName(album.id)}</option
            >{/each}</select
        >
        {#if connection?.catalog?.tags.length}<fieldset>
            <legend>Tags</legend>{#each connection.catalog.tags as tag}<label
                class="tag-choice"
                ><input
                  type="checkbox"
                  bind:group={tagIds}
                  value={tag.id}
                />{tag.value}</label
              >{/each}
          </fieldset>{/if}
        <label for="note">Note</label><textarea
          id="note"
          rows="4"
          maxlength="10000"
          bind:value={note}></textarea>
        <p class="hint">
          This is a collection preview. Selected images have not been saved.
        </p>
      </aside>
    </div>
  {/if}
</main>
