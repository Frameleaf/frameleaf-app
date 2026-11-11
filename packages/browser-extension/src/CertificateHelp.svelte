<script lang="ts">
  /**
   * FL-1427: your Library didn't answer over HTTPS. Often that is a Library using the certificate it
   * made for itself, which the browser hasn't been told to trust. This offers the two things that
   * fix it: open the Library's exact address so the browser shows its certificate and you can accept
   * it, then Retry, which always makes a real request. If accepting it in the browser isn't enough
   * for an extension, it says how to trust the certificate on this computer.
   *
   * Nothing here can skip the check: there is no setting that makes an untrusted certificate work.
   */
  import Icon from "./Icon.svelte";
  import { openLibrary } from "./platform";
  import { hostOf } from "./sign-in-words";

  let {
    origin,
    retrying = false,
    onRetry,
  }: {
    /** The Library's exact address, as signed in to. */
    origin: string;
    retrying?: boolean;
    /** Makes a real request to the Library and resolves to whether it answered. */
    onRetry: () => Promise<boolean>;
  } = $props();

  /** A retry that still got no answer: accepting it in the browser wasn't enough. */
  let stillFailing = $state(false);
  const secure = $derived(origin.startsWith("https://"));

  async function retry() {
    stillFailing = !(await onRetry());
  }
</script>

<div class="sign-in-notice warn" role="alert">
  <Icon name="alertCircleOutline" size={18} />
  <span>
    <strong>Your Library didn’t answer</strong>
    Check that {hostOf(origin)} is turned on and reachable from this computer.
    {#if secure}
      If it uses the certificate it made for itself, open it, accept the
      certificate when the browser asks, then press Retry.
    {/if}
  </span>
</div>
{#if stillFailing && secure}
  <div class="stack" role="status">
    <p class="hint">
      Still no answer. If your Library opens in a tab but not here, add its
      certificate to this computer’s trusted certificates. Open your Library,
      select “Not secure” in the address bar, view the certificate and export
      it. Then:
    </p>
    <ul class="hint cert-steps">
      <li>
        <strong>macOS:</strong> open the file in Keychain Access, open the certificate,
        and under Trust choose Always Trust.
      </li>
      <li>
        <strong>Windows:</strong> open the file, choose Install Certificate, and place
        it in Trusted Root Certification Authorities.
      </li>
      <li>
        <strong>Linux:</strong> in the browser’s settings, open Manage certificates,
        and import it under Authorities, trusted for websites.
      </li>
    </ul>
    <p class="hint">Restart the browser, then press Retry.</p>
  </div>
{/if}
<div class="row-actions">
  {#if secure}
    <button type="button" onclick={() => void openLibrary(origin)}
      ><Icon name="openInNew" size={16} />Open Library</button
    >
  {/if}
  <button
    type="button"
    class="primary"
    disabled={retrying}
    onclick={() => void retry()}>{retrying ? "Trying…" : "Retry"}</button
  >
</div>
