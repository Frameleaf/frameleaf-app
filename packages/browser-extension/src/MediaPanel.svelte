<script lang="ts">
  /**
   * FL-1427: media, in the popup's Page tab. Download this page, Find media and Subscribe to creator all ask
   * your Library to look first and show what it found; nothing is downloaded, and no creator is
   * followed, until you choose what and where. The Library then does the work, and the Saving tab
   * shows how it is going. Connect this site shares one site's sign-in with your Library when a
   * download needs it.
   */
  import { onMount } from "svelte";
  import CertificateHelp from "./CertificateHelp.svelte";
  import CollectionPicker from "./CollectionPicker.svelte";
  import Icon from "./Icon.svelte";
  import TagPicker from "./TagPicker.svelte";
  import type {
    MediaCapabilityView,
    MediaOperationView,
    MediaProblem,
  } from "./media-api";
  import type {
    FoundView,
    MediaMode,
    MediaReplyData,
    MediaRequest,
    SiteView,
  } from "./media-background";
  import {
    requestMediaHosts,
    requestMediaWatch,
    requestServerAccess,
    requestSiteAccess,
    sendRequest,
  } from "./platform";
  import type { ConnectionStatus } from "./settings";
  import { hostOf, SIGN_IN_PROBLEMS } from "./sign-in-words";

  let {
    connection,
    open = $bindable(false),
    onQueued,
  }: {
    connection: ConnectionStatus;
    /** Past the three choices, so the rest of the tab makes room. */
    open?: boolean;
    /** A download or subscription was handed to the saving list. */
    onQueued: () => void;
  } = $props();

  type Step =
    | "loading"
    | "menu"
    | "inspecting"
    | "choose"
    | "subscribe"
    | "found"
    | "site";
  let step = $state<Step>("loading");
  let capability = $state<MediaCapabilityView | null>(null);
  let granted = $state(true);
  let problem = $state<MediaProblem | null>(null);
  let error = $state("");
  let busy = $state(false);
  let mode = $state<MediaMode>("page");
  let label = $state("");
  let operation = $state<MediaOperationView | null>(null);
  // download
  let chosen = $state<string[]>([]);
  let albumId = $state("");
  let tagIds = $state<string[]>([]);
  let reimport = $state(false);
  // subscription: history has no default, it is always your choice
  let history = $state<"" | "all" | "since" | "new">("");
  let since = $state("");
  let interval = $state<15 | 60 | 360 | 1440>(60);
  let parentId = $state("");
  // find media
  let found = $state<FoundView | null>(null);
  let picked = $state<string[]>([]);
  let site = $state<SiteView | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  $effect(() => {
    open = step !== "loading" && step !== "menu";
  });
  const origin = $derived(connection.binding.origin);
  const collections = $derived(connection.catalog?.albums ?? []);
  const kinds = $derived(
    operation
      ? [...new Set(operation.items.map((item) => item.kind))]
          .map(
            (kind) =>
              ({ image: "Images", video: "Videos", audio: "Audio" })[kind],
          )
          .join(", ")
      : "",
  );
  const intervals = [
    { value: 15, label: "15 minutes" },
    { value: 60, label: "Hour" },
    { value: 360, label: "6 hours" },
    { value: 1440, label: "Day" },
  ] as const;

  async function ask(request: MediaRequest): Promise<MediaReplyData | null> {
    error = "";
    try {
      const reply = await sendRequest(request);
      if (disposed) return null;
      if (reply.ok) {
        problem = null;
        return reply.media ?? {};
      }
      error = reply.error;
      problem = reply.mediaProblem ?? null;
    } catch {
      error = "Could not reach the extension. Reopen it and try again.";
    }
    return null;
  }
  async function load() {
    const reply = await ask({ type: "media-state" });
    if (!reply) {
      step = "menu";
      return false;
    }
    capability = reply.capability ?? null;
    granted = reply.granted !== false;
    if (reply.draft && granted) {
      mode = reply.draft.mode;
      label = reply.draft.label;
      show(reply.draft.operation);
    } else step = "menu";
    return true;
  }
  /** Moves on from what the Library says about an inspection. */
  function show(value: MediaOperationView) {
    clearTimeout(timer);
    operation = value;
    if (value.state === "inspecting") {
      step = "inspecting";
      timer = setTimeout(() => void poll(value.id), 1500);
      return;
    }
    if (value.state !== "ready") {
      step = "menu";
      error = value.error ?? "Your Library couldn’t read this page.";
      return;
    }
    if (mode === "subscribe") {
      if (value.kind !== "feed" || !value.creator) {
        step = "menu";
        error =
          "This page isn’t a creator’s profile or feed your Library can follow. Open the creator’s own page and try again.";
        return;
      }
      history = "";
      step = "subscribe";
      return;
    }
    // One post: everything in it is ticked. A feed or playlist: nothing is, until you choose.
    chosen = value.kind === "feed" ? [] : value.items.map((item) => item.id);
    step = "choose";
  }
  async function poll(id: string) {
    const reply = await ask({ type: "media-poll", id });
    if (disposed || step !== "inspecting") return;
    if (reply?.operation) show(reply.operation);
    // any error ends the wait; only a reply that simply hasn't come yet is asked for again
    else if (problem || error) step = "menu";
    else timer = setTimeout(() => void poll(id), 3000);
  }
  async function inspectPage(next: "page" | "subscribe") {
    busy = true;
    mode = next;
    const reply = await ask({ type: "media-inspect", mode: next });
    busy = false;
    if (reply?.operation) show(reply.operation);
  }
  async function inspectFound() {
    const urls = (found?.items ?? [])
      .filter((item) => item.url && picked.includes(item.id))
      .map((item) => item.url!);
    busy = true;
    mode = "found";
    const reply = await ask({ type: "media-inspect", mode: "found", urls });
    busy = false;
    if (reply?.operation) show(reply.operation);
  }
  async function download() {
    if (!operation || !albumId || chosen.length === 0) return;
    busy = true;
    const reply = await ask({
      type: "media-download",
      label: label || operation.creator || "Media",
      inspectionId: operation.id,
      itemIds: chosen,
      albumId,
      tagIds,
      overrideSuppression: reimport,
    });
    busy = false;
    if (reply) finish();
  }
  async function subscribe() {
    if (!operation || !history || (history === "since" && !since)) return;
    busy = true;
    const reply = await ask({
      type: "media-subscribe",
      label: [operation.creator, operation.provider]
        .filter(Boolean)
        .join(" · "),
      inspectionId: operation.id,
      history:
        history === "since"
          ? {
              mode: "since",
              since: new Date(`${since}T00:00:00`).toISOString(),
            }
          : { mode: history },
      intervalMinutes: interval,
      ...(parentId && { parentId }),
    });
    busy = false;
    if (reply) finish();
  }
  function finish() {
    back();
    onQueued();
  }
  function back() {
    clearTimeout(timer);
    operation = null;
    found = null;
    site = null;
    picked = [];
    chosen = [];
    reimport = false;
    error = "";
    step = "menu";
  }
  async function find(type: "media-find" | "media-watch" = "media-find") {
    busy = true;
    const reply = await ask({ type });
    busy = false;
    if (reply?.found) {
      found = reply.found;
      picked = picked.filter((id) =>
        found?.items.some((item) => item.id === id),
      );
      step = "found";
    }
  }
  /** Asked for here, on your press, for this one page. */
  async function watchTab() {
    if (!found) return;
    if (await requestMediaWatch(found.origin).catch(() => false))
      await find("media-watch");
    else error = "Watching this tab wasn’t allowed. Nothing more is looked at.";
  }
  async function allowHosts() {
    if (!found) return;
    if (await requestMediaHosts(found.hosts).catch(() => false)) await find();
    else error = "Those sites weren’t allowed. Nothing more is looked at.";
  }
  async function openSite() {
    busy = true;
    const reply = await ask({ type: "media-site" });
    busy = false;
    if (reply?.site) {
      site = reply.site;
      step = "site";
    }
  }
  async function allowSite() {
    if (!site) return;
    if (await requestSiteAccess(site.origins).catch(() => false))
      await openSite();
    else
      error =
        "Reading this site’s sign-in wasn’t allowed, so nothing was shared.";
  }
  async function connectSite() {
    if (!site) return;
    busy = true;
    const reply = await ask({
      type: "media-connect",
      ...(site.connection && { connectionId: site.connection.id }),
    });
    busy = false;
    if (reply?.site) site = reply.site;
  }
  async function disconnectSite() {
    if (!site?.connection) return;
    busy = true;
    const reply = await ask({
      type: "media-disconnect",
      id: site.connection.id,
    });
    busy = false;
    if (reply) await openSite();
  }
  /** Media downloads need your say-so on your Library's own page, once. */
  async function allowMedia() {
    busy = true;
    error = "";
    try {
      const allowLocalhost = origin.startsWith("http:");
      const address = await requestServerAccess(origin, allowLocalhost);
      // Chrome closes this popup while its sign-in window is open; it carries on without it.
      const reply = await sendRequest({
        type: "sign-in",
        address,
        allowLocalhost,
        grant: "media",
      });
      if (reply.ok) await load();
      else if (reply.problem) {
        // a sign-in that failed outright, in the sign-in's own words
        const words = SIGN_IN_PROBLEMS[reply.problem];
        error = `${words.title}. ${words.body(hostOf(origin))}`;
      } else error = reply.error;
    } catch {
      error = "Could not open your Library’s page. Try again.";
    } finally {
      busy = false;
    }
  }
  async function retry() {
    busy = true;
    const answered = (await ask({ type: "media-check" })) !== null;
    busy = false;
    if (answered) await load();
    // A Library that answers, even to say no, has a certificate this browser accepts.
    return answered || problem !== "unreachable";
  }
  function toggle(list: string[], id: string, on: boolean) {
    return on
      ? [...new Set([...list, id])]
      : list.filter((item) => item !== id);
  }
  onMount(() => {
    disposed = false;
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  });
</script>

{#if step === "loading"}
  <p class="hint" role="status">Checking your Library…</p>
{:else if problem === "unreachable"}
  <CertificateHelp {origin} retrying={busy} onRetry={retry} />
{:else if problem === "unsupported" || (capability && !capability.available && !problem)}
  <div class="sign-in-notice info" role="status">
    <Icon name="informationOutline" size={18} />
    <span>
      <strong>Media downloads aren’t available on this Library</strong>
      {problem === "unsupported"
        ? "Your Library needs an update first."
        : "Whoever looks after your Library can turn them on."}
      Saving images, links and screenshots works as before.
    </span>
  </div>
{:else if !granted || problem === "grant"}
  <div class="sign-in-notice info" role="status">
    <Icon name="shieldLockOutline" size={18} />
    <span>
      <strong>Allow media downloads</strong>
      Save to Frameleaf can only save into Boards so far. To download media, connect
      sites and follow creators, allow it once on your Library’s own page. You stay
      signed in.
    </span>
  </div>
  {#if error && problem !== "grant"}<p class="error" role="alert">
      {error}
    </p>{/if}
  <button
    class="primary wide"
    type="button"
    disabled={busy}
    onclick={() => void allowMedia()}
    >{busy ? "Waiting for your Library…" : "Allow on your Library"}</button
  >
{:else if step === "menu"}
  <p class="lead">
    Or have your Library download this page’s media. It looks first, you choose
    what to keep, and it carries on after you close the browser.
  </p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="media-actions">
    <button
      type="button"
      disabled={busy}
      onclick={() => void inspectPage("page")}
      ><Icon name="download" size={20} /><span
        ><strong>Download this page</strong><small
          >The video, audio or images this page is about</small
        ></span
      ></button
    >
    <button type="button" disabled={busy} onclick={() => void find()}
      ><Icon name="playBoxOutline" size={20} /><span
        ><strong>Find media</strong><small
          >List what this page plays, and choose</small
        ></span
      ></button
    >
    <button
      type="button"
      disabled={busy}
      onclick={() => void inspectPage("subscribe")}
      ><Icon name="rss" size={20} /><span
        ><strong>Subscribe to creator</strong><small
          >Keep saving this creator’s new posts</small
        ></span
      ></button
    >
  </div>
  {#if capability?.cookies}
    <button
      type="button"
      class="link-button"
      disabled={busy}
      onclick={() => void openSite()}
      ><Icon name="keyOutline" />Connect this site, for media you need to be
      signed in to see</button
    >
  {/if}
  <p class="hint">
    Nothing is sent to your Library until you choose one of these.
  </p>
{:else if step === "inspecting"}
  <p class="lead" role="status">
    Your Library is looking at {mode === "found"
      ? "what you chose"
      : "this page"}…
  </p>
  <p class="hint">
    This can take a minute. You can close this window and open it again.
  </p>
  <div class="row-actions">
    <button type="button" onclick={back}>Cancel</button>
  </div>
{:else if step === "choose" && operation}
  <form
    class="stack"
    onsubmit={(event) => {
      event.preventDefault();
      void download();
    }}
  >
    {#if operation.kind === "feed"}
      <p class="lead">
        This address is a feed or playlist. Choose what to save: nothing is
        downloaded unless you tick it.
      </p>
    {/if}
    {#if !operation.complete || operation.limitation}
      <p class="hint warning" role="status">
        {operation.limitation ??
          "The site returned a limited list. Your Library shows up to 500 at a time."}
      </p>
    {/if}
    {#if operation.items.length === 0}
      <p class="hint">There is nothing to download at this address.</p>
    {:else}
      <fieldset class="media-list">
        <legend
          >{chosen.length} of {operation.items.length} selected{operation.creator
            ? ` · ${operation.creator}`
            : ""}</legend
        >
        {#each operation.items as item (item.id)}
          <label
            ><input
              type="checkbox"
              checked={chosen.includes(item.id)}
              disabled={busy}
              onchange={(event) =>
                (chosen = toggle(chosen, item.id, event.currentTarget.checked))}
            /><span
              >{item.title}<small
                >{{ image: "Image", video: "Video", audio: "Audio" }[
                  item.kind
                ]}</small
              ></span
            ></label
          >
        {/each}
      </fieldset>
      <CollectionPicker
        {collections}
        bind:value={albumId}
        disabled={busy}
        canCreate={false}
        onRefresh={async () => void (await sendRequest({ type: "refresh" }))}
      />
      <TagPicker
        tags={connection.catalog?.tags ?? []}
        bind:selected={tagIds}
        disabled={busy}
      />
      <label class="media-check"
        ><input type="checkbox" bind:checked={reimport} disabled={busy} /><span
          >Download again media you removed before<small
            >Brings a matching item back from Trash if it is still there.</small
          ></span
        ></label
      >
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="row-actions">
      <button type="button" disabled={busy} onclick={back}>Back</button>
      <button
        class="primary"
        type="submit"
        disabled={busy || !albumId || chosen.length === 0}
        >{busy ? "Starting…" : "Start download"}</button
      >
    </div>
  </form>
{:else if step === "subscribe" && operation}
  <form
    class="stack"
    onsubmit={(event) => {
      event.preventDefault();
      void subscribe();
    }}
  >
    <dl class="media-facts">
      <dt>Creator</dt>
      <dd>{operation.creator}</dd>
      <dt>Site</dt>
      <dd>{operation.provider ?? "Unknown"}</dd>
      {#if kinds}
        <dt>Media types</dt>
        <dd>{kinds}</dd>
      {/if}
    </dl>
    {#if !operation.complete || operation.limitation}
      <p class="hint warning" role="status">
        {operation.limitation ??
          "Your Library has yet to confirm that all of this creator’s history can be reached. Connecting the site may show more."}
      </p>
    {/if}
    <fieldset class="media-list">
      <legend>History to save</legend>
      <label
        ><input
          type="radio"
          bind:group={history}
          value="new"
          disabled={busy}
        /><span>New posts only</span></label
      >
      <label
        ><input
          type="radio"
          bind:group={history}
          value="since"
          disabled={busy}
        /><span>Since a date</span></label
      >
      <label
        ><input
          type="radio"
          bind:group={history}
          value="all"
          disabled={busy}
        /><span>All history your Library can reach</span></label
      >
    </fieldset>
    {#if history === "since"}
      <div class="field">
        <label for="media-since">Start date</label>
        <input
          id="media-since"
          type="date"
          bind:value={since}
          disabled={busy}
          required
        />
      </div>
    {/if}
    <div class="field">
      <label for="media-interval">Check every</label>
      <select id="media-interval" bind:value={interval} disabled={busy}>
        {#each intervals as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </div>
    <div class="field">
      <label for="media-parent">Private parent collection (optional)</label>
      <select id="media-parent" bind:value={parentId} disabled={busy}>
        <option value="">Top level</option>
        {#each collections as collection (collection.id)}
          <option value={collection.id}>{collection.albumName}</option>
        {/each}
      </select>
      <small class="hint"
        >Your Library makes a private collection named Creator · Site. A parent
        must be private too. Items you remove stay out of future checks.</small
      >
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <p class="hint">
      Pause, change or stop a subscription in Boards, under Creator
      subscriptions.
      <a href={`${origin}/pro`} target="_blank" rel="noopener noreferrer"
        >Open Boards<span class="visually-hidden"> (opens a new tab)</span></a
      >
    </p>
    <div class="row-actions">
      <button type="button" disabled={busy} onclick={back}>Back</button>
      <button
        class="primary"
        type="submit"
        disabled={busy || !history || (history === "since" && !since)}
        >{busy ? "Subscribing…" : "Subscribe"}</button
      >
    </div>
  </form>
{:else if step === "found" && found}
  {#if found.items.length === 0}
    <p class="lead">
      No media seen on this page yet. Start the video, then look again. Watching
      the tab catches media the page loads from now on.
    </p>
  {:else}
    <fieldset class="media-list">
      <legend>{picked.length} selected</legend>
      {#each found.items as item (item.id)}
        <label
          ><input
            type="checkbox"
            checked={picked.includes(item.id)}
            disabled={busy ||
              !item.url ||
              (picked.length >= 20 && !picked.includes(item.id))}
            onchange={(event) =>
              (picked = toggle(picked, item.id, event.currentTarget.checked))}
          /><span
            >{item.name}<small
              >{item.kind === "stream"
                ? `Stream${item.parts ? ` · ${item.parts} parts seen` : ""}`
                : item.kind === "file"
                  ? "File"
                  : `${item.parts} parts of a stream. Its playlist wasn’t seen: reload the page while watching the tab`}
              · {item.host}</small
            ></span
          ></label
        >
      {/each}
    </fieldset>
  {/if}
  {#if found.watching}
    <p class="hint" role="status">
      Watching this tab. It stops, and the list is cleared, when the tab goes to
      another page.
    </p>
  {/if}
  {#if found.hosts.length > 0}
    <p class="hint">
      This page loads media from {found.hosts
        .map((host) => host.replace(/^https?:\/\//, ""))
        .join(", ")}. Watching sees those only if you allow it.
    </p>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="row-actions">
    {#if !found.watching}
      <button type="button" disabled={busy} onclick={() => void watchTab()}
        >Watch this tab</button
      >
    {/if}
    {#if found.hosts.length > 0}
      <button type="button" disabled={busy} onclick={() => void allowHosts()}
        >Allow those sites</button
      >
    {/if}
    <button type="button" disabled={busy} onclick={() => void find()}
      >Look again</button
    >
  </div>
  <div class="row-actions">
    <button type="button" disabled={busy} onclick={back}>Back</button>
    <button
      class="primary"
      type="button"
      disabled={busy || picked.length === 0}
      onclick={() => void inspectFound()}>Check with your Library</button
    >
  </div>
{:else if step === "site" && site}
  <p class="lead">
    Connect {site.host} so your Library can download what you can see there when signed
    in.
  </p>
  {#if site.connection}
    <p class="hint" role="status">
      {site.connection.status === "connected" ? "Connected" : "Expired"} · {site
        .connection.label}
      · your Library keeps access to {site.connection.domains.join(", ")}.
    </p>
  {/if}
  {#if !origin.startsWith("https://")}
    <p class="hint warning">
      Site access can only be shared with a Library opened over HTTPS.
    </p>
  {:else if !site.allowed}
    <p class="hint">
      Your browser will ask to let Save to Frameleaf read your sign-in for
      {site.origins.map((item) => item.replace("https://", "")).join(" and ")}.
      Nothing else in your browser is read.
    </p>
  {:else if site.reason === "partitioned"}
    <p class="hint warning">
      This site keeps its sign-in in a way your Library can’t use from the
      browser. Connect it in Boards instead.
    </p>
  {:else if site.reason}
    <p class="hint warning">
      You don’t seem to be signed in to this site in this browser. Sign in on
      the page, then try again.
    </p>
  {:else if site.domains}
    <p class="hint">
      Your sign-in for <strong>{site.domains.join(", ")}</strong> ({site.count}
      {site.count === 1 ? "cookie" : "cookies"}) is sent once, straight to your
      Library over HTTPS. Your Library keeps it, encrypted, for downloads and
      scheduled checks on those domains until you disconnect. The extension
      keeps no copy.
    </p>
  {/if}
  <p class="hint">
    Bluesky and Reddit connect with an app password or token in Boards, under
    Connected sites.
    <a href={`${origin}/pro`} target="_blank" rel="noopener noreferrer"
      >Open Boards<span class="visually-hidden"> (opens a new tab)</span></a
    >
  </p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="row-actions">
    <button type="button" disabled={busy} onclick={back}>Back</button>
    {#if site.connection}
      <button
        type="button"
        disabled={busy}
        onclick={() => void disconnectSite()}>Disconnect</button
      >
    {/if}
    {#if origin.startsWith("https://")}
      {#if !site.allowed}
        <button
          class="primary"
          type="button"
          disabled={busy}
          onclick={() => void allowSite()}>Allow and continue</button
        >
      {:else if site.domains}
        <button
          class="primary"
          type="button"
          disabled={busy}
          onclick={() => void connectSite()}
          >{busy
            ? "Sharing…"
            : site.connection
              ? "Refresh access"
              : "Share with your Library"}</button
        >
      {/if}
    {/if}
  </div>
{:else}
  <div class="row-actions">
    <button type="button" onclick={back}>Back</button>
  </div>
{/if}
