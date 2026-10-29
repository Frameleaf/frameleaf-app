<script lang="ts">
  /**
   * FL-655: Settings when signed in (prototype `Settings`, README point 53): the server with
   * Switch server, the account, the collections you can save into, the local-server switch and
   * Sign out. Sign out removes the access on the server; waiting items always stay.
   */
  import Account from "./Account.svelte";
  import Icon from "./Icon.svelte";
  import LocalSwitch from "./LocalSwitch.svelte";
  import { sendRequest } from "./platform";
  import { hostOf } from "./sign-in-words";
  import type { ConnectionStatus } from "./settings";

  let {
    connection,
    allowLocalhost = $bindable(false),
    onBack,
    onSwitch,
  }: {
    connection: ConnectionStatus;
    allowLocalhost?: boolean;
    onBack?: () => void;
    onSwitch: () => void;
  } = $props();

  let working = $state(false);
  let error = $state("");
  /** Sign out failed on the server: offer signing out of this browser only, said plainly. */
  let stuck = $state(false);
  const server = $derived(hostOf(connection.binding.origin));
  const signedIn = $derived(connection.method === "sign-in");
  const browser = /\bEdg\//.test(navigator.userAgent) ? "Edge" : "Chrome";

  async function signOut(localOnly = false) {
    if (working) return;
    working = true;
    error = "";
    try {
      const reply = await sendRequest(
        localOnly ? { type: "disconnect", localOnly: true } : { type: "disconnect" },
      );
      if (!reply.ok) {
        error = reply.error;
        stuck = signedIn;
      }
    } catch {
      error = "Could not sign out. Reopen the extension and try again.";
    } finally {
      working = false;
    }
  }
</script>

{#if onBack}
  <div class="sub-head">
    <button
      type="button"
      class="icon-button"
      aria-label="Back"
      title="Back"
      onclick={onBack}><Icon name="arrowLeft" size={18} /></button
    >
    <h2>Settings</h2>
  </div>
{/if}
<div class="sheet-body">
  {#if !onBack}<h2>Settings</h2>{/if}
  <div class="setting">
    <span class="label">Server</span>
    <div class="setting-row">
      <span class="setting-value address"
        ><Icon name="serverOutline" size={16} />{server}</span
      >
      <button type="button" class="small" disabled={working} onclick={onSwitch}
        >Switch server</button
      >
    </div>
  </div>
  <div class="setting">
    <span class="label">Account</span>
    <Account name={connection.binding.userName} detail={server} />
  </div>
  <dl class="facts">
    <dt>Collections</dt>
    <dd>
      {connection.catalog
        ? `${connection.catalog.albums.length} you can save into`
        : "Refreshing…"}
    </dd>
  </dl>
  <LocalSwitch bind:checked={allowLocalhost} disabled={working} />
  <p class="hint">
    {#if signedIn}
      In Frameleaf this browser is listed as “Save to Frameleaf · {browser}” in
      Settings › API keys. Removing it there signs this browser out too.
      Signing out keeps any items still waiting.
    {:else}
      This browser uses a key made in Frameleaf. Signing out forgets it here;
      remove the key in Frameleaf › Settings › API keys. Signing out keeps any
      items still waiting.
    {/if}
  </p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if stuck}
    <p class="hint">
      You can sign out of this browser only. Its access then stays valid in
      Frameleaf until you remove “Save to Frameleaf · {browser}” in Settings ›
      API keys.
    </p>
    <button
      type="button"
      class="small"
      disabled={working}
      onclick={() => signOut(true)}>Sign out of this browser only</button
    >
  {/if}
</div>
<footer class="sheet-foot">
  <button type="button" class="danger" disabled={working} onclick={() => signOut()}
    ><Icon name="logout" size={16} />{working ? "Signing out…" : "Sign out"}</button
  >
</footer>
