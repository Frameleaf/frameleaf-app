<script lang="ts">
  import { onMount } from "svelte";
  import { CaptureFailure, normalizeServerAddress } from "./api";
  import Header from "./Header.svelte";
  import Icon from "./Icon.svelte";
  import Promises from "./Promises.svelte";
  import QueuePanel from "./QueuePanel.svelte";
  import {
    requestServerAccess,
    sendRequest,
    watchConnection,
    type ExtensionReply,
  } from "./platform";
  import type { ConnectionStatus } from "./settings";
  let address = $state("");
  let token = $state("");
  let allowLocalhost = $state(false);
  let connection = $state<ConnectionStatus | null>(null);
  let working = $state(false);
  let error = $state("");
  let changing = $state(false);
  let showWaiting = $state(false);
  let waiting = $state(0);
  const connected = $derived(connection?.status === "connected");
  const removed = $derived(connection?.status === "needs-attention");
  const server = $derived(
    connection ? connection.binding.origin.replace(/^https?:\/\//, "") : "",
  );
  const collectionCount = $derived(connection?.catalog?.albums.length ?? 0);
  const keysLink = $derived.by(() => {
    try {
      return (
        normalizeServerAddress(address, allowLocalhost) +
        "/user-settings?isOpen=api-keys"
      );
    } catch {
      return null;
    }
  });
  function accept(reply: ExtensionReply) {
    connection = reply.connection ?? null;
    if (!reply.ok) error = reply.error;
    else if (reply.connection?.status !== "needs-attention") error = "";
  }
  onMount(() => {
    const stop = watchConnection(() => {
      void sendRequest({ type: "status" })
        .then(accept)
        .catch(() => {
          connection = null;
          error =
            "Could not read the connection. Reopen the extension and try again.";
        });
    });
    void sendRequest({ type: "refresh" })
      .then((reply) => {
        accept(reply);
        if (connection) {
          address = connection.binding.origin;
          allowLocalhost = address.startsWith("http:");
        }
      })
      .catch(() => {
        error =
          "Could not open the connection. Reopen the extension and try again.";
      });
    return stop;
  });
  async function connect(event: SubmitEvent) {
    event.preventDefault();
    if (working) return;
    working = true;
    error = "";
    try {
      const origin = await requestServerAccess(address, allowLocalhost);
      const reply = await sendRequest({
        type: "connect",
        address: origin,
        token: token.trim(),
        allowLocalhost,
      });
      accept(reply);
      if (reply.ok) {
        token = "";
        changing = false;
        showWaiting = false;
      }
    } catch (reason) {
      error =
        reason instanceof CaptureFailure
          ? reason.message
          : "Could not connect. Check site access and try again.";
    } finally {
      working = false;
    }
  }
  async function disconnect() {
    if (working) return;
    working = true;
    try {
      accept(await sendRequest({ type: "disconnect" }));
      changing = false;
    } catch {
      error = "Could not disconnect. Reopen the extension and try again.";
    } finally {
      working = false;
    }
  }
</script>

{#snippet localSwitch()}
  <label class="switch">
    <span>
      <strong>Allow a local server without HTTPS (this computer only)</strong>
      <small
        >For a server on this computer (localhost). Anywhere else needs HTTPS.
        This applies when you connect.</small
      >
    </span>
    <input
      type="checkbox"
      role="switch"
      bind:checked={allowLocalhost}
      disabled={working}
    />
  </label>
{/snippet}

{#snippet connectForm(submitLabel: string)}
  <form class="connect-form" onsubmit={connect}>
    <div class="field">
      <label for="server">Server address</label>
      <input
        id="server"
        type="url"
        required
        bind:value={address}
        placeholder="https://photos.example.com"
        autocomplete="url"
        disabled={working}
        aria-describedby="address-help"
      />
      <small class="hint" id="address-help"
        >Include the path if your server has one, such as /frameleaf.</small
      >
    </div>
    <div class="field">
      <label for="capture-key">Browser key</label>
      <input
        id="capture-key"
        type="password"
        required
        bind:value={token}
        placeholder="Paste the key from Frameleaf"
        autocomplete="off"
        spellcheck="false"
        disabled={working}
        aria-describedby="key-help"
      />
      <small class="hint" id="key-help"
        >Make one in Frameleaf: Settings › API keys › New key › Browser
        extension.{#if keysLink}
          <a href={keysLink} target="_blank" rel="noopener noreferrer"
            >Open API keys<span class="visually-hidden"> (opens a new tab)</span
            ></a
          >{/if}</small
      >
    </div>
    {#if !connected}{@render localSwitch()}{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button
      class="primary"
      type="submit"
      disabled={working || !address.trim() || !token.trim()}
      >{working ? "Connecting…" : submitLabel}</button
    >
  </form>
{/snippet}

<main class="sheet options-sheet">
  <Header origin={connected ? connection?.binding.origin : null} />
  {#if connected && connection}
    <div class="sheet-body">
      <h2>Settings</h2>
      <dl class="facts">
        <dt>Server</dt>
        <dd class="address">{server}</dd>
        {#if connection.binding.userName}
          <dt>Signed in as</dt>
          <dd>{connection.binding.userName}</dd>
        {/if}
        <dt>Collections</dt>
        <dd>
          {collectionCount}
          {connection.catalog ? "you can save into" : "(refreshing…)"}
        </dd>
      </dl>
      {@render localSwitch()}
      <p class="hint">
        To stop this browser saving to Frameleaf, disconnect here, or remove its
        key in Frameleaf › Settings › API keys.
      </p>
      {#if error && !changing}<p class="error" role="alert">{error}</p>{/if}
      <details bind:open={changing}>
        <summary>Use a different server or key</summary>
        {@render connectForm("Connect")}
      </details>
    </div>
    <footer class="sheet-foot">
      <button
        type="button"
        class="danger"
        onclick={disconnect}
        disabled={working}>Disconnect</button
      >
    </footer>
  {:else}
    <div class="sheet-body">
      {#if removed}
        <div class="notice">
          <Icon name="keyRemove" size={28} />
          <div>
            <h2>This browser key was removed</h2>
            <p>
              Nothing more can be saved with it. {waiting
                ? `${waiting} ${waiting === 1 ? "item" : "items"} still waiting ${waiting === 1 ? "is" : "are"}`
                : "Items still waiting are"} kept until you connect again. Paste
              a new browser key to carry on.
            </p>
            <button type="button" onclick={() => (showWaiting = !showWaiting)}
              >{showWaiting ? "Hide waiting items" : "See waiting items"}</button
            >
          </div>
        </div>
        <div hidden={!showWaiting}><QueuePanel bind:unfinished={waiting} /></div>
      {:else}
        <p class="lead">
          Connect to your Frameleaf server to save images, links and
          screenshots into Boards.
        </p>
      {/if}
      {@render connectForm(removed ? "Connect again" : "Connect")}
      <Promises />
    </div>
  {/if}
</main>
