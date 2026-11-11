<script lang="ts">
  /**
   * FL-1449: media, the second half of the popup's Page tab. The page's own address chooses what is
   * offered: a whole channel or account is followed, one video or post is downloaded (its creator
   * added under Creators, not followed), and any other site lists the media it plays. Your Library
   * looks at the page as soon as this half is chosen and fills in the real names; nothing is
   * downloaded, and no creator is followed, until the button is pressed. The Library then does the
   * work, and the Saving tab shows how it is going. Connect shares one site's sign-in with your
   * Library when a download needs it.
   */
  import { onMount } from "svelte";
  import CertificateHelp from "./CertificateHelp.svelte";
  import CollectionPicker from "./CollectionPicker.svelte";
  import Icon from "./Icon.svelte";
  import type {
    MediaCapabilityView,
    MediaOperationView,
    MediaProblem,
  } from "./media-api";
  import type {
    FoundView,
    MediaReplyData,
    MediaRequest,
    SiteView,
  } from "./media-background";
  import {
    creatorAddress,
    defaultSaves,
    downloadRequest,
    followable,
    followRequest,
    hasCreator,
    historyOf,
    InspectionWatch,
    itemSummary,
    MEDIA_INTERVALS,
    MEDIA_PLATFORMS,
    MEDIA_QUALITY_LABELS,
    MEDIA_REACHES,
    pageChoice,
    savesVideo,
    type InspectionReply,
    type MediaInterval,
    type MediaReach,
  } from "./media-panel";
  import type { MediaQualityChoice, MediaSaveChoices } from "./media-queue";
  import {
    requestMediaHosts,
    requestMediaWatch,
    requestServerAccess,
    requestSiteAccess,
    sendRequest,
    type ExtensionReply,
  } from "./platform";
  import type { ConnectionStatus } from "./settings";
  import { hostOf, SIGN_IN_PROBLEMS } from "./sign-in-words";

  let {
    connection,
    onQueued,
  }: {
    connection: ConnectionStatus;
    /** A download or a follow was handed to the saving list. */
    onQueued: () => void;
  } = $props();

  const NOT_A_PAGE = "Open a web page in this tab, then try again.";
  const NOT_FOLLOWABLE =
    "This page isn’t a creator’s profile or feed your Library can follow. Open the creator’s own page and try again.";
  type View = "loading" | "main" | "collection" | "site";
  let view = $state<View>("loading");
  let capability = $state<MediaCapabilityView | null>(null);
  let granted = $state(true);
  let problem = $state<MediaProblem | null>(null);
  let error = $state("");
  let busy = $state(false);
  let page = $state<NonNullable<MediaReplyData["page"]> | null>(null);
  let siteStatus = $state<NonNullable<MediaReplyData["siteStatus"]> | null>(
    null,
  );
  let started = false;
  /** What your Library says is at this page (or at what was ticked on any other site). */
  let operation = $state<MediaOperationView | null>(null);
  let reading = $state(false);
  let readError = $state("");
  /** The creator behind one video or post, looked up only when "Follow them too" is turned on. */
  let preview = $state<MediaOperationView | null>(null);
  let previewing = $state(false);
  /** The button was pressed while your Library was still looking: it carries on when it answers. */
  let wanted = $state(false);
  /** The download went to the saving list but the follow did not: only the follow is tried again. */
  let downloadSent = $state(false);
  // choices. How far back has no default: it is always asked.
  let saves = $state<MediaSaveChoices>({});
  let reach = $state<MediaReach | "">("");
  let since = $state("");
  let quality = $state<MediaQualityChoice>("best");
  let interval = $state<MediaInterval>(60);
  let followToo = $state(false);
  let albumId = $state("");
  // any other site
  let found = $state<FoundView | null>(null);
  let picked = $state<string[]>([]);
  let site = $state<SiteView | null>(null);
  let disposed = false;

  const origin = $derived(connection.binding.origin);
  const collections = $derived(connection.catalog?.albums ?? []);
  const choice = $derived(pageChoice(page?.url));
  const platform = $derived(MEDIA_PLATFORMS[choice.platform]);
  const history = $derived(historyOf(reach, since));
  const video = $derived(savesVideo(choice.platform, operation));
  const creator = $derived(operation?.creator ?? "");
  /** Where "Follow them too" would follow; without one the switch is not offered. */
  const canFollowToo = $derived(
    choice.kind === "download" && !!page && operation?.state === "ready"
      ? !!creatorAddress(page.url, operation.creatorId)
      : false,
  );
  const count = $derived(
    (found?.items ?? []).filter((item) => picked.includes(item.id)).length,
  );
  const waiting = $derived(wanted && (reading || previewing));
  const siteName = $derived(platform.name || siteStatus?.host || "");

  const replyOf = (reply: ExtensionReply): InspectionReply =>
    reply.ok
      ? { ok: true, operation: reply.media?.operation }
      : { ok: false, error: reply.error, problem: reply.mediaProblem };
  const readCheck = (id: string) =>
    sendRequest({ type: "media-poll", id }).then(replyOf);
  /** A problem with the Library itself replaces the panel; anything else is said beside the form. */
  function gate(kind?: MediaProblem) {
    if (kind === "unreachable" || kind === "unsupported" || kind === "grant")
      problem = kind;
  }
  // Both drop a reply for a check the panel has moved on from (see InspectionWatch).
  const main = new InspectionWatch(
    readCheck,
    (value) => {
      operation = value;
      reading = value.state === "inspecting";
      if (!reading) settled();
    },
    (message, kind) => {
      reading = false;
      wanted = false;
      readError = message;
      gate(kind);
    },
  );
  const creatorCheck = new InspectionWatch(
    readCheck,
    (value) => {
      preview = value;
      previewing = value.state === "inspecting";
      if (previewing) return;
      if (followable(value)) advance();
      else stopFollowToo(value.error ?? NOT_FOLLOWABLE);
    },
    (message, kind) => {
      stopFollowToo(message);
      gate(kind);
    },
  );

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
      if (!disposed)
        error = "Could not reach the extension. Reopen it and try again.";
    }
    return null;
  }
  async function load() {
    const reply = await ask({ type: "media-state" });
    view = "main";
    if (!reply) return false;
    capability = reply.capability ?? null;
    granted = reply.granted !== false;
    const samePage = reply.page?.url === page?.url;
    const moved =
      !samePage || reply.siteStatus?.connected !== siteStatus?.connected;
    page = reply.page ?? null;
    siteStatus = reply.siteStatus ?? null;
    if (!samePage) {
      saves = defaultSaves(choice.platform);
      reach = "";
      since = "";
      quality = "best";
      interval = 60;
      albumId = "";
    }
    if (granted && capability?.available && (moved || !started)) {
      started = true;
      begin(reply.draft);
    }
    return true;
  }
  /** Looks at the page in the tab, the way its address says it should be looked at. */
  function begin(draft?: MediaReplyData["draft"]) {
    main.leave();
    creatorCheck.leave();
    operation = null;
    preview = null;
    reading = false;
    previewing = false;
    readError = "";
    wanted = false;
    followToo = false;
    downloadSent = false;
    if (!page) {
      readError = NOT_A_PAGE;
      return;
    }
    if (choice.kind === "other") {
      void find();
      return;
    }
    const mode = choice.kind === "follow" ? "subscribe" : "page";
    reading = true;
    // a check a just-closed popup started for this same page is carried on with
    if (draft?.mode === mode) main.resume(draft.operation);
    else
      void main.begin(() =>
        sendRequest({ type: "media-inspect", mode }).then(replyOf),
      );
  }
  /** Your Library has finished looking. */
  function settled() {
    const value = operation;
    if (!value) return;
    let wrong = "";
    if (value.state !== "ready")
      wrong = value.error ?? "Your Library couldn’t read this page.";
    else if (choice.kind === "follow" && !followable(value))
      wrong = NOT_FOLLOWABLE;
    else if (choice.kind !== "follow" && value.items.length === 0)
      wrong = "There is nothing to download at this address.";
    if (wrong) {
      readError = wrong;
      wanted = false;
    } else advance();
  }
  /** The primary button. */
  function press() {
    error = "";
    if (choice.kind === "other") {
      const urls = (found?.items ?? [])
        .filter((item) => item.url && picked.includes(item.id))
        .map((item) => item.url!);
      if (urls.length === 0) return;
      // Only what you ticked is sent, and only as addresses; your Library looks before it downloads.
      operation = null;
      readError = "";
      albumId = "";
      reading = true;
      wanted = true;
      void main.begin(() =>
        sendRequest({ type: "media-inspect", mode: "found", urls }).then(
          replyOf,
        ),
      );
      return;
    }
    wanted = true;
    advance();
  }
  /** Carries out a press once everything it needs has come back. */
  function advance() {
    if (!wanted || busy || reading || (followToo && previewing)) return;
    wanted = false;
    void send();
  }
  const choices = () => ({
    platform: choice.platform,
    reach,
    since,
    saves,
    quality,
    interval,
  });
  async function send() {
    if (busy) return;
    if (choice.kind === "follow") {
      const request = followRequest(operation, choices());
      if (!request) return;
      busy = true;
      const reply = await ask(request);
      busy = false;
      if (reply) finish();
      return;
    }
    const request = downloadRequest(operation, {
      label:
        (choice.kind === "download" && operation?.items[0]?.title) ||
        page?.title ||
        "Media",
      video,
      quality,
      ...(albumId && { albumId }),
    });
    if (!request) {
      // Your Library found no creator to file this under, so it asks where to keep it.
      if (
        operation?.state === "ready" &&
        operation.items.length > 0 &&
        !hasCreator(operation)
      )
        view = "collection";
      return;
    }
    const follow = followToo ? followRequest(preview, choices()) : null;
    if (followToo && !follow) return;
    busy = true;
    const sent = downloadSent || (await ask(request)) !== null;
    if (sent && follow) {
      downloadSent = true;
      const followed = await ask(follow);
      busy = false;
      if (followed) finish();
      else if (!disposed)
        error = `The download has started. Following didn’t: ${error} Press the button to try following again.`;
      return;
    }
    busy = false;
    if (sent) finish();
  }
  function finish() {
    main.leave();
    creatorCheck.leave();
    // the popup moves to the Saving tab and puts this half of the Page tab away
    onQueued();
  }
  /** Stops waiting for your Library; what it was asked is not acted on when it answers. */
  function cancelCheck() {
    main.leave();
    reading = false;
    wanted = false;
    operation = null;
    view = "main";
  }
  function stopFollowToo(message = "") {
    creatorCheck.leave();
    followToo = false;
    preview = null;
    previewing = false;
    wanted = false;
    if (message) error = message;
  }
  function setFollowToo(on: boolean) {
    if (!on) {
      stopFollowToo();
      return;
    }
    error = "";
    followToo = true;
    previewing = true;
    void creatorCheck.begin(() =>
      sendRequest({
        type: "media-inspect",
        mode: "creator",
        ...(operation?.creatorId && { creatorId: operation.creatorId }),
      }).then(replyOf),
    );
  }
  async function find(type: "media-find" | "media-watch" = "media-find") {
    busy = true;
    const reply = await ask({ type });
    busy = false;
    if (!reply?.found) return;
    const first = found === null;
    found = reply.found;
    picked = picked.filter((id) => found?.items.some((item) => item.id === id));
    // the first thing found starts ticked, as in the design; after that the ticks are yours
    if (first)
      picked = found.items
        .filter((item) => item.url)
        .slice(0, 1)
        .map((item) => item.id);
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
      view = "site";
    }
  }
  /** Back from Connect: a page is looked at again when its site was connected or disconnected. */
  async function leaveSite() {
    site = null;
    error = "";
    view = "main";
    await load();
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
      if (reply.ok) {
        started = false;
        await load();
      } else if (reply.problem) {
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
    if (answered) {
      started = false;
      await load();
    }
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
      main.leave();
      creatorCheck.leave();
    };
  });
</script>

{#snippet siteRow()}
  {#if capability?.cookies && siteStatus}
    <div class="media-site">
      <Icon name="accountKeyOutline" size={18} />
      <span>
        <strong>{siteName}</strong>
        <small
          >{siteStatus.connected
            ? "Connected · your Library signs in as you"
            : "Not connected · only public posts can be saved"}</small
        >
      </span>
      <button
        type="button"
        class="small"
        disabled={busy}
        onclick={() => void openSite()}
        >{siteStatus.connected ? "Manage" : "Connect"}</button
      >
    </div>
  {/if}
{/snippet}

{#snippet reachChoice()}
  <fieldset class="media-choice" disabled={busy}>
    <legend
      >How far back{#if !reach}<em> · choose one</em>{/if}</legend
    >
    {#each MEDIA_REACHES as option (option.id)}
      <label
        ><input type="radio" bind:group={reach} value={option.id} /><span
          >{option.label}</span
        ></label
      >
      {#if option.id === "since" && reach === "since"}
        <input type="date" aria-label="Since" bind:value={since} required />
      {/if}
    {/each}
  </fieldset>
{/snippet}

{#snippet qualityChoice()}
  <div class="media-field">
    <label for="media-quality">Video quality</label>
    <select id="media-quality" bind:value={quality} disabled={busy}>
      {#each MEDIA_QUALITY_LABELS as option (option.id)}
        <option value={option.id}>{option.label}</option>
      {/each}
    </select>
  </div>
{/snippet}

{#snippet looking()}
  {#if readError}
    <p class="error" role="alert">{readError}</p>
    <div class="row-actions">
      <button type="button" disabled={busy} onclick={() => begin()}
        >Try again</button
      >
    </div>
  {:else if reading}
    <p class="hint" role="status">
      Your Library is looking at this page… This can take a minute.
    </p>
  {:else if operation && (!operation.complete || operation.limitation)}
    <p class="hint warning" role="status">
      {operation.limitation ??
        "The site returned a limited list. Connecting the site may show more."}
    </p>
  {/if}
{/snippet}

{#if view === "loading"}
  <p class="hint" role="status">Checking your Library…</p>
{:else if problem === "unreachable"}
  <CertificateHelp {origin} retrying={busy} onRetry={retry} />
{:else if problem === "unsupported"}
  <div class="sign-in-notice info" role="status">
    <Icon name="informationOutline" size={18} />
    <span>
      <strong>Your Library needs an update for this</strong>
      Downloading media and following creators need a newer Frameleaf on your Library.
      Saving images, links and screenshots works as before.
    </span>
  </div>
{:else if capability && !capability.available && !problem}
  <div class="sign-in-notice info" role="status">
    <Icon name="informationOutline" size={18} />
    <span>
      <strong>Media downloads aren’t available on this Library</strong>
      Whoever looks after your Library can turn them on. Saving images, links and
      screenshots works as before.
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
{:else if view === "main" && !capability}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="row-actions">
    <button type="button" disabled={busy} onclick={() => void load()}
      >Try again</button
    >
  </div>
{:else if view === "main" && choice.kind === "follow" && page}
  <form
    class="stack"
    onsubmit={(event) => {
      event.preventDefault();
      press();
    }}
  >
    <div class="page-card">
      <span class="page-card-icon"><Icon name="rss" size={20} /></span>
      <span>
        <strong>{creator || page.title}</strong>
        <small
          >{platform.name}
          {choice.what}{#if operation?.state === "ready" && operation.items.length > 0}
            · about {operation.items.length} posts{/if}</small
        >
      </span>
    </div>
    {@render looking()}
    {#if platform.saves.length > 0}
      <fieldset class="media-choice" disabled={busy}>
        <legend>What to save</legend>
        {#each platform.saves as option (option.id)}
          <label
            ><input
              type="checkbox"
              role="switch"
              checked={saves[option.id] ?? option.on}
              onchange={(event) =>
                (saves = {
                  ...saves,
                  [option.id]: event.currentTarget.checked,
                })}
            /><span>{option.label}</span></label
          >
        {/each}
      </fieldset>
    {/if}
    {@render reachChoice()}
    <div class="media-pair">
      {#if choice.platform === "youtube"}{@render qualityChoice()}{/if}
      <div class="media-field">
        <label for="media-interval">Look for new posts</label>
        <select id="media-interval" bind:value={interval} disabled={busy}>
          {#each MEDIA_INTERVALS as option (option.id)}
            <option value={option.id}>{option.label}</option>
          {/each}
        </select>
      </div>
    </div>
    {@render siteRow()}
    <p class="hint">
      Saved to {creator || page.title}’s page under Creators in Boards. You can
      change any of this there later.
    </p>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button
      class="primary wide"
      type="submit"
      disabled={busy || waiting || !history || !!readError}
      ><Icon name="rss" />{busy
        ? "Following…"
        : waiting
          ? "Waiting for your Library…"
          : "Follow and download"}</button
    >
  </form>
{:else if view === "main" && choice.kind === "download" && page}
  <form
    class="stack"
    onsubmit={(event) => {
      event.preventDefault();
      press();
    }}
  >
    <div class="page-card">
      <span class="page-card-icon"
        ><Icon name={video ? "playBoxOutline" : "imageOutline"} size={20} /></span
      >
      <span>
        <strong>{operation?.items[0]?.title || page.title}</strong>
        <small
          >{[creator || platform.name, itemSummary(operation)]
            .filter(Boolean)
            .join(" · ")}</small
        >
      </span>
    </div>
    {@render looking()}
    {#if video}{@render qualityChoice()}{/if}
    <ul class="promises" aria-label="Comes with it">
      {#each video ? ["Thumbnail", "Title and description", "Tags and when it was posted"] : ["The post’s words", "Tags and when it was posted"] as kept (kept)}
        <li><Icon name="check" size={14} />{kept}</li>
      {/each}
    </ul>
    {#if canFollowToo}
      <fieldset class="media-choice" disabled={busy}>
        <label
          ><input
            type="checkbox"
            role="switch"
            checked={followToo}
            onchange={(event) => setFollowToo(event.currentTarget.checked)}
          /><span>Follow {creator || "them"} too</span></label
        >
      </fieldset>
      {#if followToo}{@render reachChoice()}{/if}
    {/if}
    {@render siteRow()}
    <p class="hint">
      {creator || "Its creator"} is added under Creators in Boards so this has a
      home. {canFollowToo
        ? "You aren’t following them unless you turn that on."
        : "You aren’t following them."}
    </p>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button
      class="primary wide"
      type="submit"
      disabled={busy || waiting || (followToo && !history) || !!readError}
      ><Icon name="download" />{busy
        ? "Starting…"
        : waiting
          ? "Waiting for your Library…"
          : `Download this ${choice.what}`}</button
    >
  </form>
{:else if view === "main" && wanted && reading}
  <p class="lead" role="status">
    Your Library is looking at what you chose…
  </p>
  <p class="hint">This can take a minute. Nothing is downloaded yet.</p>
  <div class="row-actions">
    <button type="button" onclick={cancelCheck}>Cancel</button>
  </div>
{:else if view === "main"}
  {#if !page}
    <p class="error" role="alert">{NOT_A_PAGE}</p>
  {:else}
    {#if found && found.items.length > 0}
      <fieldset class="media-list" aria-label="On this page">
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
                  ? `Stream${item.parts ? ` · sent in ${item.parts} small parts, saved as one video` : ""}`
                  : item.kind === "file"
                    ? "File"
                    : `${item.parts} parts of a stream. Its playlist wasn’t seen: reload the page while watching the tab`}
                · {item.host}</small
              ></span
            ></label
          >
        {/each}
      </fieldset>
    {:else if found}
      <p class="lead">
        No media seen on this page yet. Start the video, then look again.
      </p>
    {:else if busy}
      <p class="hint" role="status">Looking at this page…</p>
    {/if}
    {#if found}
      <div class="media-site" class:on={found.watching} role={found.watching ? "status" : undefined}>
        <Icon name="eyeOutline" size={18} />
        <span>
          <strong
            >{found.watching
              ? "Watching this tab"
              : "Can’t see the video you want?"}</strong
          >
          <small
            >{found.watching
              ? "Press play on the page, then come back here. Watching stops when you leave the page."
              : "Let Save to Frameleaf watch this tab while you press play. Your browser asks you first."}</small
          >
        </span>
        {#if found.watching}
          <button
            type="button"
            class="small"
            disabled={busy}
            onclick={() => void find()}>Look again</button
          >
        {:else}
          <button
            type="button"
            class="small"
            disabled={busy}
            onclick={() => void watchTab()}>Watch this tab</button
          >
        {/if}
      </div>
      {#if found.hosts.length > 0}
        <p class="hint">
          This page loads media from {found.hosts
            .map((host) => host.replace(/^https?:\/\//, ""))
            .join(", ")}. Watching sees those only if you allow it.
        </p>
        <div class="row-actions">
          <button
            type="button"
            class="small"
            disabled={busy}
            onclick={() => void allowHosts()}>Allow those sites</button
          >
        </div>
      {/if}
      {#if !found.watching}
        <div class="row-actions">
          <button
            type="button"
            class="small"
            disabled={busy}
            onclick={() => void find()}>Look again</button
          >
        </div>
      {/if}
    {/if}
    {@render siteRow()}
    <p class="hint">Saved under Creators in Boards as “{page.host}”.</p>
    {#if readError}<p class="error" role="alert">{readError}</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if !found && !busy}
      <div class="row-actions">
        <button type="button" onclick={() => void find()}>Try again</button>
      </div>
    {/if}
    <button
      class="primary wide"
      type="button"
      disabled={busy || count === 0}
      onclick={press}
      ><Icon name="download" />Download {count} to your Library</button
    >
  {/if}
{:else if view === "collection" && operation}
  <form
    class="stack"
    onsubmit={(event) => {
      event.preventDefault();
      void send();
    }}
  >
    <p class="lead">
      Your Library couldn’t tell who made this, so there is no creator to file
      it under. Choose a collection to keep it in.
    </p>
    <CollectionPicker
      {collections}
      bind:value={albumId}
      disabled={busy}
      canCreate={false}
      onRefresh={async () => void (await sendRequest({ type: "refresh" }))}
    />
    {#if collections.length === 0}
      <small class="hint"
        >You have no collections yet.
        <a href={`${origin}/pro`} target="_blank" rel="noopener noreferrer"
          >Make one in Boards</a
        >, then reopen this.</small
      >
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="row-actions">
      <button type="button" disabled={busy} onclick={() => (view = "main")}
        >Back</button
      >
      <button class="primary" type="submit" disabled={busy || !albumId}
        >{busy
          ? "Starting…"
          : choice.kind === "download"
            ? `Download this ${choice.what}`
            : `Download ${operation.items.length} to your Library`}</button
      >
    </div>
  </form>
{:else if view === "site" && site}
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
    <button type="button" disabled={busy} onclick={() => void leaveSite()}>Back</button>
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
{/if}
