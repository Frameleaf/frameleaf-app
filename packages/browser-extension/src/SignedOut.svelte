<script lang="ts">
  /**
   * FL-655: "Signed out on the server" (prototype `SignedOutOnServer`, README point 55): this
   * browser's access was removed in Frameleaf. Waiting items are kept and saved once you sign in
   * again; Sign in again goes straight to the sign-in window for the same server.
   */
  import Icon from "./Icon.svelte";
  import QueuePanel from "./QueuePanel.svelte";
  import { requestServerAccess, sendRequest } from "./platform";
  import { hostOf } from "./sign-in-words";
  import type { ConnectionStatus } from "./settings";

  let { connection }: { connection: ConnectionStatus } = $props();

  let waiting = $state(0);
  let showWaiting = $state(false);
  let working = $state(false);
  let error = $state("");
  const server = $derived(hostOf(connection.binding.origin));

  async function signInAgain() {
    if (working) return;
    working = true;
    error = "";
    try {
      const allowLocalhost = connection.binding.origin.startsWith("http:");
      const origin = await requestServerAccess(
        connection.binding.origin,
        allowLocalhost,
      );
      const reply = await sendRequest({
        type: "sign-in",
        address: origin,
        allowLocalhost,
      });
      if (!reply.ok && !reply.problem) error = reply.error;
    } catch {
      error = "Could not start signing in. Try again.";
    } finally {
      working = false;
    }
  }
</script>

<div class="sheet-body" hidden={!showWaiting}>
  <h2>Waiting items</h2>
  <QueuePanel bind:unfinished={waiting} />
</div>
<div class="sheet-body center" hidden={showWaiting}>
  <Icon name="accountOffOutline" size={36} />
  <h2>Signed out on the server</h2>
  <p>
    This browser’s access to {server} was removed in Frameleaf, so nothing more
    can be saved for now. {waiting
      ? `${waiting} ${waiting === 1 ? "item" : "items"} still waiting ${waiting === 1 ? "is" : "are"} kept here, and saved once you sign in again.`
      : "Items still waiting are kept here, and saved once you sign in again."}
  </p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>
<footer class="sheet-foot">
  <button type="button" onclick={() => (showWaiting = !showWaiting)}
    >{showWaiting ? "Back" : "See waiting items"}</button
  >
  <button
    class="primary"
    type="button"
    disabled={working}
    onclick={signInAgain}><Icon name="login" size={16} />Sign in again</button
  >
</footer>
