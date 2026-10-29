<script lang="ts">
  /**
   * The extension's options page (FL-655): the same Connect, Settings, Switch server, "Signed out on
   * the server" and key fallback panels as the popup, on a page that stays open while you sign in.
   */
  import { onMount } from "svelte";
  import Connect from "./Connect.svelte";
  import Header from "./Header.svelte";
  import Icon from "./Icon.svelte";
  import QueuePanel from "./QueuePanel.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";
  import SignedOut from "./SignedOut.svelte";
  import { sendRequest, watchConnection, type ExtensionReply } from "./platform";
  import type {
    ConnectionStatus,
    RecentServer,
    SignInNotice,
  } from "./settings";

  let connection = $state<ConnectionStatus | null>(null);
  let recent = $state<RecentServer[]>([]);
  let notice = $state<SignInNotice | null>(null);
  let loading = $state(true);
  let error = $state("");
  let view = $state<"main" | "switch" | "key">("main");
  let keyAddress = $state("");
  let allowLocalhost = $state(false);
  let showWaiting = $state(false);
  let waiting = $state(0);
  const connected = $derived(connection?.status === "connected");
  const problem = $derived(
    notice?.kind === "problem"
      ? { problem: notice.problem, origin: notice.origin }
      : null,
  );

  function accept(reply: ExtensionReply) {
    connection = reply.connection ?? null;
    if (reply.ok) {
      recent = reply.recent ?? recent;
      notice = reply.notice === undefined ? notice : reply.notice;
      error = "";
    } else error = reply.error;
  }
  const load = () =>
    sendRequest({ type: "sign-in-state" })
      .then(accept)
      .catch(() => {
        error =
          "Could not read the connection. Reopen the extension and try again.";
      });
  onMount(() => {
    const stop = watchConnection(() => {
      void load();
    });
    void sendRequest({ type: "refresh" })
      .catch(() => {})
      .then(load)
      .finally(() => {
        if (connection)
          allowLocalhost = connection.binding.origin.startsWith("http:");
        // the options page is where a signed-in browser lands too; no welcome needed here
        if (notice?.kind === "welcome")
          void sendRequest({ type: "dismiss-notice" }).catch(() => {});
        loading = false;
      });
    return stop;
  });
</script>

<main class="sheet options-sheet">
  <Header origin={connected ? connection?.binding.origin : null} />
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
  {:else if !connected && connection.method === "sign-in"}
    <SignedOut {connection} />
  {:else if !connected}
    <div class="sheet-body">
      <div class="notice">
        <Icon name="keyRemove" size={28} />
        <div>
          <h2>This browser key was removed</h2>
          <p>
            Nothing more can be saved with it. {waiting
              ? `${waiting} ${waiting === 1 ? "item" : "items"} still waiting ${waiting === 1 ? "is" : "are"}`
              : "Items still waiting are"} kept until you connect again.
          </p>
          <button type="button" onclick={() => (showWaiting = !showWaiting)}
            >{showWaiting ? "Hide waiting items" : "See waiting items"}</button
          >
        </div>
      </div>
      <div hidden={!showWaiting}><QueuePanel bind:unfinished={waiting} /></div>
    </div>
    <Connect
      {recent}
      initialAddress={connection.binding.origin}
      bind:allowLocalhost
      onKey={(address) => {
        keyAddress = address;
        view = "key";
      }}
    />
  {:else if view === "switch"}
    <Connect
      mode="switch"
      {recent}
      current={connection.binding.origin}
      bind:allowLocalhost
      onBack={() => (view = "main")}
    />
  {:else}
    <SettingsPanel
      {connection}
      bind:allowLocalhost
      onSwitch={() => (view = "switch")}
    />
  {/if}
  {#if error && !loading}<p class="error banner" role="alert">{error}</p>{/if}
</main>
