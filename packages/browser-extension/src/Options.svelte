<script lang="ts">
  import { onMount } from "svelte";
  import { CaptureFailure, normalizeServerAddress } from "./api";
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
  const settingsLink = $derived.by(() => {
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
      if (reply.ok) token = "";
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
    } catch {
      error = "Could not disconnect. Reopen the extension and try again.";
    } finally {
      working = false;
    }
  }
</script>

<main>
  <header>
    <img src="icons/icon48.png" width="40" height="40" alt="" />
    <h1>Save to Frameleaf</h1>
  </header>
  <p class="muted">
    Connect to your own Frameleaf server. No subscription required.
  </p>
  <section aria-labelledby="connection-title">
    <h2 id="connection-title">Connection</h2>
    <div aria-live="polite">
      {#if connection}
        <p>
          <strong
            >{connection.status === "connected"
              ? "Connected"
              : "Reconnect to continue"}</strong
          ><br /><span class="address">{connection.binding.origin}</span>
        </p>
        {#if connection.status === "connected" && connection.catalog}
          <p class="muted">
            {connection.catalog.albums.length} writable {connection.catalog
              .albums.length === 1
              ? "album"
              : "albums"} available.
          </p>
        {/if}
        <button
          type="button"
          class="quiet"
          onclick={disconnect}
          disabled={working}>Disconnect</button
        >
      {:else}<p class="muted">
          Choose where your inspiration will be saved.
        </p>{/if}
    </div>
  </section>
  <form onsubmit={connect}>
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
    <p class="hint" id="address-help">
      Include the path if your server lives under one, such as /frameleaf.
    </p>
    {#if settingsLink}
      <p>
        <a href={settingsLink} target="_blank" rel="noopener noreferrer"
          >Open your server’s access keys</a
        >
        and create a <strong>Browser capture</strong> key.
      </p>
    {/if}
    <label for="capture-key">Browser capture key</label>
    <input
      id="capture-key"
      type="password"
      required
      bind:value={token}
      autocomplete="off"
      spellcheck="false"
      disabled={working}
      aria-describedby="key-help"
    />
    <p class="hint" id="key-help">
      Kept on this device in the extension. Never sent to the pages you collect
      from.
    </p>
    <details>
      <summary>Local development</summary><label class="check"
        ><input
          type="checkbox"
          bind:checked={allowLocalhost}
          disabled={working}
        />Allow HTTP on this computer only</label
      >
    </details>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button
      class="primary"
      type="submit"
      disabled={working || !address.trim() || !token.trim()}
      >{working ? "Connecting…" : "Connect server"}</button
    >
  </form>
</main>
