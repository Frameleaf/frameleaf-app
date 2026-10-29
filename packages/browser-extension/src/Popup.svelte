<script lang="ts">
  import { onMount, tick } from "svelte";
  import Account from "./Account.svelte";
  import Connect from "./Connect.svelte";
  import Header from "./Header.svelte";
  import Icon from "./Icon.svelte";
  import QueuePanel from "./QueuePanel.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";
  import SignedOut from "./SignedOut.svelte";
  import type { IconName } from "./icons";
  import { openOptions, sendRequest, watchConnection } from "./platform";
  import { hostOf } from "./sign-in-words";
  import { settledView } from "./views";
  import type {
    ConnectionStatus,
    RecentServer,
    SignInNotice,
  } from "./settings";
  type Tab = "images" | "page" | "screenshot" | "saving";
  const tabs: { id: Tab; label: string; icon: IconName }[] = [
    { id: "images", label: "Images", icon: "imageMultipleOutline" },
    { id: "page", label: "Page", icon: "linkVariant" },
    { id: "screenshot", label: "Screenshot", icon: "cropFree" },
    { id: "saving", label: "Saving", icon: "trayFull" },
  ];
  let connection = $state<ConnectionStatus | null>(null);
  let loading = $state(true);
  let error = $state("");
  let discovering = $state(false);
  let tab = $state<Tab>("images");
  let unfinished = $state(0);
  let showWaiting = $state(false);
  // FL-655: sign-in state, Settings and Switch server live in the popup too
  let recent = $state<RecentServer[]>([]);
  let notice = $state<SignInNotice | null>(null);
  let view = $state<"main" | "settings" | "switch" | "key">("main");
  let keyAddress = $state("");
  let allowLocalhost = $state(false);
  const problem = $derived(
    notice?.kind === "problem"
      ? { problem: notice.problem, origin: notice.origin }
      : null,
  );
  const connected = $derived(connection?.status === "connected");
  /** The server Switch server started from, so a finished switch closes the form. */
  let switchFrom = $state<string | null>(null);
  $effect(() => {
    if (loading) return;
    view = settledView(view, {
      connected,
      origin: connection?.binding.origin ?? null,
      switchFrom,
    });
  });
  async function loadSignIn() {
    try {
      const reply = await sendRequest({ type: "sign-in-state" });
      if (reply.ok) {
        recent = reply.recent ?? [];
        notice = reply.notice ?? null;
        connection = reply.connection ?? connection;
      }
    } catch {
      // the connection reply still shows something sensible
    }
  }
  function startSaving() {
    notice = null;
    void sendRequest({ type: "dismiss-notice" }).catch(() => {});
  }
  const tabButtons: Record<string, HTMLButtonElement> = {};
  async function discover(
    type: "discover" | "bookmark" | "visible" | "area" | "whole" = "discover",
  ) {
    discovering = true;
    error = "";
    try {
      const reply = await sendRequest(
        type === "visible" || type === "area" || type === "whole"
          ? { type: "screenshot", mode: type }
          : { type },
      );
      if (!reply.ok) error = reply.error;
      // The popup closes so it isn't in the picture; the page shows progress and Cancel.
      else if (type === "whole") window.close();
    } catch {
      error =
        "Could not read this page. Go back to the web page and try again.";
    } finally {
      discovering = false;
    }
  }
  function accept(reply: Awaited<ReturnType<typeof sendRequest>>) {
    connection = reply.connection ?? null;
    if (!reply.ok) error = reply.error;
    else if (reply.connection?.status !== "needs-attention") error = "";
  }
  onMount(() => {
    const stop = watchConnection(() => {
      void loadSignIn();
      void sendRequest({ type: "status" })
        .then(accept)
        .catch(() => {
          connection = null;
          error =
            "Could not read the connection. Open Settings to try again.";
        });
    });
    void sendRequest({ type: "refresh" })
      .then(accept)
      .catch(() => {
        error = "Could not read the connection. Open Settings to try again.";
      })
      .then(loadSignIn)
      .finally(() => {
        if (connection) allowLocalhost = connection.binding.origin.startsWith("http:");
        loading = false;
      });
    return stop;
  });
  async function tabKey(event: KeyboardEvent, index: number) {
    const keys: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: tabs.length - 1,
    };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const next = tabs[(keys[event.key] + tabs.length) % tabs.length];
    tab = next.id;
    await tick();
    tabButtons[next.id]?.focus();
  }
</script>

<main class="sheet popup-sheet">
  {#if view !== "settings"}
    <Header
      origin={connected && connection ? connection.binding.origin : null}
      onSettings={connected && view === "main"
        ? () => (view = "settings")
        : connection
          ? () => void openOptions()
          : undefined}
    />
  {/if}
  {#if loading}
    <div class="sheet-body"><p class="hint">Checking your connection…</p></div>
  {:else if view === "key"}
    <Connect
      mode="key"
      {recent}
      initialAddress={keyAddress}
      bind:allowLocalhost
      onBack={() => (view = "main")}
      onConnected={() => (view = "main")}
    />
  {:else if !connection || (!connected && problem)}
    <Connect
      {recent}
      {problem}
      initialAddress={problem?.origin ?? recent[0]?.origin ?? ""}
      bind:allowLocalhost
      onKey={(address) => {
        keyAddress = address;
        view = "key";
      }}
    />
  {:else if connection.status !== "connected" && connection.method === "sign-in"}
    <SignedOut {connection} />
  {:else if connection.status !== "connected"}
    <div class="sheet-body" hidden={!showWaiting}>
      <h2>Waiting items</h2>
      <QueuePanel bind:unfinished />
    </div>
    <div class="sheet-body center" hidden={showWaiting}>
      <Icon name="keyRemove" size={36} />
      <h2>This browser key was removed</h2>
      <p>
        Nothing more can be saved with it. {unfinished
          ? `${unfinished} ${unfinished === 1 ? "item" : "items"} still waiting ${unfinished === 1 ? "is" : "are"}`
          : "Items still waiting are"} kept here until you connect again.
      </p>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
    <footer class="sheet-foot">
      <button type="button" onclick={() => (showWaiting = !showWaiting)}
        >{showWaiting ? "Back" : "See waiting items"}</button
      >
      <button class="primary" type="button" onclick={() => void openOptions()}
        >Connect again</button
      >
    </footer>
  {:else if view === "settings"}
    <SettingsPanel
      {connection}
      bind:allowLocalhost
      onBack={() => (view = "main")}
      onSwitch={() => {
        switchFrom = connection?.binding.origin ?? null;
        view = "switch";
      }}
    />
  {:else if view === "switch"}
    <Connect
      mode="switch"
      {recent}
      current={connection.binding.origin}
      bind:allowLocalhost
      onBack={() => (view = "settings")}
    />
  {:else if notice?.kind === "welcome"}
    <div class="sheet-body center">
      <Icon name="checkCircle" size={36} />
      <h2>You’re signed in</h2>
      <Account
        name={connection.binding.userName}
        detail={hostOf(connection.binding.origin)}
      />
      <p>
        Open this window on any page to save its images, the page itself or a
        screenshot.
      </p>
    </div>
    <footer class="sheet-foot">
      <button class="primary" type="button" onclick={startSaving}
        >Start saving</button
      >
    </footer>
  {:else}
    <div class="tabs" role="tablist" aria-label="What to save">
      {#each tabs as item, index (item.id)}
        <button
          bind:this={tabButtons[item.id]}
          type="button"
          role="tab"
          id={`tab-${item.id}`}
          aria-selected={tab === item.id}
          aria-controls={`panel-${item.id}`}
          tabindex={tab === item.id ? 0 : -1}
          class:queue-tab={item.id === "saving"}
          onclick={() => (tab = item.id)}
          onkeydown={(event) => void tabKey(event, index)}
          ><Icon name={item.icon} />{item.label}{#if item.id === "saving" && unfinished}<span
              class="count"
              ><span class="visually-hidden">, </span>{unfinished}<span
                class="visually-hidden"> in progress</span
              ></span
            >{/if}</button
        >
      {/each}
    </div>
    {#if error}<p class="error banner" role="alert">{error}</p>{/if}
    <div
      class="sheet-body"
      role="tabpanel"
      id="panel-images"
      aria-labelledby="tab-images"
      hidden={tab !== "images"}
    >
      <p class="lead">
        Find the images on this page, then choose which ones to save.
      </p>
      <button
        class="primary wide"
        type="button"
        disabled={discovering}
        onclick={() => void discover()}
        >{discovering ? "Finding images…" : "Find images on this page"}</button
      >
      <p class="hint">
        Nothing is read from the page until you choose. Icons and tracking
        pixels are left out.
      </p>
    </div>
    <div
      class="sheet-body"
      role="tabpanel"
      id="panel-page"
      aria-labelledby="tab-page"
      hidden={tab !== "page"}
    >
      <p class="lead">
        Save this page as a link in Boards. You can check its title and address
        first. The page itself isn’t copied.
      </p>
      <button
        class="primary wide"
        type="button"
        disabled={discovering}
        onclick={() => void discover("bookmark")}>Save this page</button
      >
    </div>
    <div
      class="sheet-body"
      role="tabpanel"
      id="panel-screenshot"
      aria-labelledby="tab-screenshot"
      hidden={tab !== "screenshot"}
    >
      <div class="shot-choice">
        <button
          type="button"
          disabled={discovering}
          onclick={() => void discover("visible")}
          ><Icon name="monitorScreenshot" size={22} /><strong
            >What you can see</strong
          ><small>The visible part of the page</small></button
        >
        <button
          type="button"
          disabled={discovering}
          onclick={() => void discover("area")}
          ><Icon name="selectDrag" size={22} /><strong>Select an area</strong
          ><small>Drag, or use the arrow keys</small></button
        >
        <button
          type="button"
          disabled={discovering}
          onclick={() => void discover("whole")}
          ><Icon name="arrowExpandVertical" size={22} /><strong
            >Whole page</strong
          ><small>Scrolls to the end for you</small></button
        >
      </div>
      <p class="hint">
        You see the screenshot before anything is saved. To select an area, drag
        on the page, or move with the arrow keys and press Enter at each corner.
        For the whole page, this window closes while the page scrolls; Cancel on
        the page stops it. Esc cancels either.
      </p>
    </div>
    <div
      class="sheet-body"
      role="tabpanel"
      id="panel-saving"
      aria-labelledby="tab-saving"
      hidden={tab !== "saving"}
    >
      <QueuePanel
        collections={connection.catalog?.albums ?? []}
        bind:unfinished
      />
    </div>
  {/if}
</main>
