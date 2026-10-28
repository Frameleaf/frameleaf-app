<script lang="ts">
  import QueuePanel from "./QueuePanel.svelte";
  import { onMount } from "svelte";
  import { openOptions, sendRequest, watchConnection } from "./platform";
  import type { ConnectionStatus } from "./settings";
  let connection = $state<ConnectionStatus | null>(null);
  let loading = $state(true);
  let error = $state("");
  let discovering = $state(false);
  async function discover() {
    discovering = true;
    error = "";
    try {
      const reply = await sendRequest({ type: "discover" });
      if (!reply.ok) error = reply.error;
    } catch {
      error =
        "Could not inspect this page. Return to the webpage and try again.";
    } finally {
      discovering = false;
    }
  }
  onMount(() => {
    const stop = watchConnection(() => {
      void sendRequest({ type: "status" })
        .then((reply) => {
          connection = reply.connection ?? null;
          if (!reply.ok) error = reply.error;
          else if (reply.connection?.status !== "needs-attention") error = "";
        })
        .catch(() => {
          connection = null;
          error =
            "Could not read the connection. Open connection settings to try again.";
        });
    });
    void sendRequest({ type: "refresh" })
      .then((reply) => {
        connection = reply.connection ?? null;
        if (!reply.ok) error = reply.error;
        else if (reply.connection?.status !== "needs-attention") error = "";
      })
      .catch(() => {
        error =
          "Could not read the connection. Open connection settings to try again.";
      })
      .finally(() => {
        loading = false;
      });
    return stop;
  });
</script>

<main>
  <header>
    <img src="icons/icon48.png" width="32" height="32" alt="" />
    <h1>Save to Frameleaf</h1>
  </header>
  <div aria-live="polite">
    {#if loading}<p class="muted">Checking your connection…</p>
    {:else if connection}<p>
        <strong
          >{connection.status === "connected"
            ? "Connected"
            : "Reconnect to continue"}</strong
        ><br /><span class="address">{connection.binding.origin}</span>
      </p>
    {:else}<p class="muted">
        Connect your server to collect inspiration in Frameleaf.
      </p>{/if}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if connection?.status === "connected"}<button
      class="primary"
      type="button"
      disabled={discovering || loading}
      onclick={() => void discover()}
      >{discovering ? "Finding images…" : "Find images on this page"}</button
    >{/if}
  <button
    type="button"
    class:primary={!connection}
    onclick={() => void openOptions()}
    >{connection ? "Connection settings" : "Connect server"}</button
  >
  {#if connection?.status === "connected"}<QueuePanel />{/if}
</main>
