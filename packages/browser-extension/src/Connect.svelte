<script lang="ts">
  /**
   * FL-655: Connect (prototype `Connect` in ExtensionSignIn.jsx, README points 50, 54, 56 to 60). The
   * server address, the servers this browser signed in to before, the local-server switch, the three
   * promises and Sign in, which opens the browser's sign-in window on the server's own page. Also
   * "Switch server" (with Back), a sign-in problem said above the form with the address kept, and
   * "Use a key instead" for a server too old to sign in.
   */
  import { CaptureFailure } from "./api";
  import Icon from "./Icon.svelte";
  import LocalSwitch from "./LocalSwitch.svelte";
  import Promises from "./Promises.svelte";
  import {
    checkServerAddress,
    hostOf,
    lastUsed,
    SIGN_IN_PROBLEMS,
  } from "./sign-in-words";
  import { requestServerAccess, sendRequest } from "./platform";
  import type { RecentServer, SignInProblem } from "./settings";

  let {
    recent = [],
    mode = "connect",
    problem = null,
    current = null,
    initialAddress = "",
    allowLocalhost = $bindable(false),
    onBack,
    onKey,
    onConnected,
  }: {
    recent?: RecentServer[];
    /** `switch`: Switch server; `key`: the key fallback. */
    mode?: "connect" | "switch" | "key";
    /** What went wrong last time, with the server it was for. */
    problem?: { problem: SignInProblem; origin: string } | null;
    /** The server signed in to now (Switch server leaves it out of the list). */
    current?: string | null;
    initialAddress?: string;
    allowLocalhost?: boolean;
    onBack?: () => void;
    /** "Use a key instead". */
    onKey?: (address: string) => void;
    /** After a key connected (the sign-in itself finishes in the background). */
    onConnected?: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let address = $state(initialAddress);
  let token = $state("");
  let invalid = $state("");
  let error = $state("");
  let working = $state(false);
  let waiting = $state(false);
  /** The problem this form just met (the stored one is for a popup opened again). */
  let met = $state<{ problem: SignInProblem; origin: string } | null>(null);

  const currentProblem = $derived(met ?? problem);
  const shown = $derived(
    currentProblem ? SIGN_IN_PROBLEMS[currentProblem.problem] : null,
  );
  const problemHost = $derived(
    currentProblem ? hostOf(currentProblem.origin) : "",
  );
  const typedHost = $derived(hostOf(address.trim()));
  const choices = $derived(
    recent.filter((item) => mode !== "switch" || item.origin !== current),
  );
  const keysLink = $derived.by(() => {
    const checked = checkServerAddress(address, allowLocalhost);
    return checked.ok
      ? `${checked.origin}/user-settings?isOpen=api-keys`
      : null;
  });

  function choose(item: RecentServer) {
    address = item.origin;
    invalid = "";
    if (item.origin.startsWith("http:")) allowLocalhost = true;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (working) return;
    const checked = checkServerAddress(address, allowLocalhost);
    if (!checked.ok) {
      invalid = checked.problem;
      return;
    }
    invalid = "";
    error = "";
    working = true;
    try {
      const origin = await requestServerAccess(checked.origin, allowLocalhost);
      if (mode === "key") {
        const reply = await sendRequest({
          type: "connect",
          address: origin,
          token: token.trim(),
          allowLocalhost,
        });
        if (reply.ok) {
          token = "";
          onConnected?.();
        } else error = reply.error;
        return;
      }
      // Chrome closes this popup while its sign-in window is open; signing in carries on without it.
      waiting = true;
      const reply = await sendRequest({
        type: "sign-in",
        address: origin,
        allowLocalhost,
        switching: mode === "switch",
      });
      if (!reply.ok && reply.problem) met = { problem: reply.problem, origin };
      else if (!reply.ok) error = reply.error;
      else met = null;
    } catch (reason) {
      error =
        reason instanceof CaptureFailure
          ? reason.message
          : "Could not start signing in. Try again.";
    } finally {
      working = false;
      waiting = false;
    }
  }
</script>

<form class="sheet-form" onsubmit={submit} novalidate>
  <div class="sheet-body">
    {#if mode === "switch"}
      <p class="lead">
        Choose the server to sign in to. You’ll be signed out of {hostOf(
          current ?? "",
        )} first. Items still waiting for it are kept, and saved when you sign back
        in to it.
      </p>
    {:else if mode === "key"}
      <p class="lead">
        For a server that can’t sign in from the browser yet. Paste a key made
        in Frameleaf on that server.
      </p>
    {:else}
      <p class="lead">
        Sign in with your Frameleaf account to save images, links and
        screenshots into Boards.
      </p>
    {/if}
    {#if shown && mode !== "key"}
      <div
        class="sign-in-notice {shown.tone}"
        role={shown.tone === "info" ? "status" : "alert"}
      >
        <Icon
          name={shown.tone === "info" ? "informationOutline" : "alertCircleOutline"}
          size={18}
        />
        <span><strong>{shown.title}</strong>{shown.body(problemHost)}</span>
      </div>
    {/if}
    {#if waiting}
      <p class="hint" role="status">
        Finish signing in in the window that opened. You can close this one.
      </p>
    {/if}
    <div class="field">
      <label for="server">Server address</label>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        id="server"
        bind:value={address}
        oninput={() => (invalid = "")}
        placeholder="photos.example.com"
        autocomplete="url"
        spellcheck="false"
        autofocus={mode === "switch"}
        disabled={working}
        aria-invalid={invalid || currentProblem?.problem === "address"
          ? true
          : undefined}
        aria-describedby="server-help"
      />
      {#if invalid}
        <small class="error" id="server-help">{invalid}</small>
      {:else}
        <small class="hint" id="server-help"
          >The address you use to open Frameleaf in your browser.</small
        >
      {/if}
    </div>
    {#if mode !== "key" && choices.length > 0}
      <div class="field">
        <span class="label" id="recent-label">Recently used</span>
        <ul class="recent" aria-labelledby="recent-label">
          {#each choices as item (item.origin)}
            {@const when = lastUsed(item)}
            <li>
              <button
                type="button"
                aria-pressed={typedHost === hostOf(item.origin)}
                disabled={working}
                onclick={() => choose(item)}
              >
                <Icon name="serverOutline" size={16} />
                <span>
                  <strong>{hostOf(item.origin)}</strong>
                  {#if item.account || when}<small
                      >{[item.account, when].filter(Boolean).join(" · ")}</small
                    >{/if}
                </span>
                {#if typedHost === hostOf(item.origin)}<Icon
                    name="check"
                    size={16}
                  />{/if}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    {#if mode === "key"}
      <div class="field">
        <label for="capture-key">Key from Frameleaf</label>
        <input
          id="capture-key"
          type="password"
          required
          bind:value={token}
          placeholder="Paste the key"
          autocomplete="off"
          spellcheck="false"
          disabled={working}
          aria-describedby="key-help"
        />
        <small class="hint" id="key-help"
          >Make one in Frameleaf: Settings › API keys › New key › For a browser
          that can’t sign in.{#if keysLink}
            <a href={keysLink} target="_blank" rel="noopener noreferrer"
              >Open<span class="visually-hidden"> API keys (opens a new tab)</span
              ></a
            >{/if}</small
        >
      </div>
    {/if}
    <LocalSwitch bind:checked={allowLocalhost} disabled={working} />
    <Promises />
    {#if mode !== "key"}
      <p class="hint">
        You sign in on your server’s own page. Your password never goes into
        the extension.
      </p>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
  <footer class="sheet-foot">
    {#if onBack}
      <button type="button" class="foot-back" disabled={working} onclick={onBack}
        ><Icon name="arrowLeft" size={16} />Back</button
      >
    {/if}
    {#if mode === "key"}
      <button
        class="primary"
        type="submit"
        disabled={working || !address.trim() || !token.trim()}
        >{working ? "Connecting…" : "Connect"}</button
      >
    {:else if shown?.key}
      <button type="submit" disabled={working}>Try again</button>
      <button
        type="button"
        class="primary"
        disabled={working}
        onclick={() => onKey?.(address)}
        ><Icon name="keyOutline" size={16} />Use a key instead</button
      >
    {:else}
      <button class="primary" type="submit" disabled={working}
        ><Icon name="login" size={16} />{working
          ? "Signing in…"
          : shown?.tone === "warn"
            ? "Try again"
            : "Sign in"}</button
      >
    {/if}
  </footer>
</form>
