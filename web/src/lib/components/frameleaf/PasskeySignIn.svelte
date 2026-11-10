<script lang="ts">
  /**
   * FL-859: "Sign in with a passkey" on the sign-in page (the approved FL-767 prototype, `AuthScreens.jsx`
   * `passkeyBlock`): the button, its waiting card while the browser's window is open (Cancel there, or
   * here, returns quietly with no error), and on a plain http address the reason it isn't offered, said
   * where the button would be with a link to the secure address (owner, 2026-11-07). On the home sign-in
   * the email field also offers saved passkeys (`autocomplete="username webauthn"`) where the browser
   * can. A passkey sign-in skips the two-step code: the server makes the session straight away.
   */
  import { ceremonyProblem, passkeysInThisBrowser, serverCode } from '$lib/frameleaf/passkeys';
  import {
    getPasskeyLoginOptions,
    loginWithPasskey,
    type LoginResponseDto,
    type PasskeyCredentialDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiFingerprint, mdiInformationOutline } from '@mdi/js';
  import {
    WebAuthnAbortService,
    browserSupportsWebAuthnAutofill,
    startAuthentication,
    type PublicKeyCredentialRequestOptionsJSON,
  } from '@simplewebauthn/browser';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import '$lib/components/frameleaf/access/passkeys.css';

  let {
    rememberMe,
    disabled = false,
    autofill = false,
    secureUrl = null,
    onSignedIn,
    onBusy,
    shown = $bindable(false),
  }: {
    rememberMe: boolean;
    disabled?: boolean;
    /** Offer saved passkeys from the email field (the home sign-in, which has one). */
    autofill?: boolean;
    /** The server's https address, linked from the note on a plain http address. */
    secureUrl?: string | null;
    onSignedIn: (user: LoginResponseDto) => void | Promise<void>;
    onBusy?: (busy: boolean) => void;
    /** Whether anything is drawn: the button, its waiting card or the http note. */
    shown?: boolean;
  } = $props();

  type State = 'checking' | 'ready' | 'waiting' | 'http' | 'hidden';
  let view = $state<State>('checking');
  let error = $state('');
  let alive = true;
  /** The newest ceremony; an older one (the email field's, given way to the button) answers nothing. */
  let ceremonyId = 0;

  const here = passkeysInThisBrowser();
  const secureHost = $derived.by(() => {
    try {
      const url = secureUrl ? new URL(secureUrl) : null;
      return url?.protocol === 'https:' ? url : null;
    } catch {
      return null;
    }
  });

  const setView = (next: State) => {
    view = next;
    shown = next !== 'checking' && next !== 'hidden';
    onBusy?.(next === 'waiting');
  };

  /** A fresh challenge; null when the server says passkeys can't work at this address. */
  const options = async () => {
    const answer = await getPasskeyLoginOptions();
    return answer.passkeysAvailable && answer.options
      ? (answer.options as unknown as PublicKeyCredentialRequestOptionsJSON)
      : null;
  };

  const messageFor = (problem: unknown) => {
    switch (serverCode(problem)) {
      case 'passkey_not_recognised': {
        return $t('frameleaf_passkey_login_not_recognised');
      }
      case 'passkey_expired': {
        return $t('frameleaf_passkey_login_expired');
      }
      default: {
        return $t('frameleaf_passkey_login_failed');
      }
    }
  };

  /** The browser's answer, sent to the server; a cancelled window is not an error. */
  const finish = async (ceremony: Promise<unknown>) => {
    const id = ++ceremonyId;
    const current = () => alive && id === ceremonyId;
    let credential;
    try {
      credential = await ceremony;
    } catch (problem) {
      if (!current()) {
        return;
      }
      setView('ready');
      if (ceremonyProblem(problem) !== 'cancelled') {
        error = $t('frameleaf_passkey_login_failed');
      }
      return;
    }
    if (!current()) {
      return;
    }
    setView('waiting');
    try {
      const user = await loginWithPasskey({
        passkeyLoginDto: { credential: credential as PasskeyCredentialDto, rememberMe },
      });
      if (current()) {
        await onSignedIn(user);
      }
    } catch (problem) {
      if (current()) {
        setView('ready');
        error = messageFor(problem);
      }
    }
  };

  const startAutofill = async () => {
    if (!autofill || !(await browserSupportsWebAuthnAutofill())) {
      return;
    }
    const optionsJSON = await options().catch(() => null);
    if (optionsJSON && alive && view === 'ready') {
      // resolves when someone picks a passkey from the email field's suggestions
      void finish(startAuthentication({ optionsJSON, useBrowserAutofill: true }));
    }
  };

  onMount(async () => {
    if (!here.ok) {
      setView(here.reason === 'http' ? 'http' : 'hidden');
      return;
    }
    try {
      const first = await options();
      if (!alive) {
        return;
      }
      setView(first ? 'ready' : 'hidden');
    } catch {
      if (alive) {
        setView('hidden');
      }
      return;
    }
    await startAutofill();
  });

  onDestroy(() => {
    alive = false;
    WebAuthnAbortService.cancelCeremony();
  });

  const start = async () => {
    if (disabled || view === 'waiting') {
      return;
    }
    error = '';
    // the email field's quiet request gives way to this one
    ceremonyId++;
    WebAuthnAbortService.cancelCeremony();
    setView('waiting');
    let optionsJSON;
    try {
      optionsJSON = await options();
    } catch (problem) {
      if (alive) {
        setView('ready');
        error = messageFor(problem);
      }
      return;
    }
    if (!alive) {
      return;
    }
    if (!optionsJSON) {
      setView('hidden');
      return;
    }
    await finish(startAuthentication({ optionsJSON }));
  };

  const cancel = () => {
    ceremonyId++;
    WebAuthnAbortService.cancelCeremony();
    error = '';
    setView('ready');
  };
</script>

{#if error}
  <p class="auth-error" role="alert"><Icon icon={mdiAlertCircleOutline} size="16" /><span>{error}</span></p>
{/if}
{#if view === 'waiting'}
  <div class="auth-passkey-wait" role="status">
    <p class="pk-waiting"><span class="pk-spinner" aria-hidden="true"></span>{$t('frameleaf_passkey_login_waiting')}</p>
    <p class="pk-quiet">{$t('frameleaf_passkey_login_waiting_body')}</p>
    <button type="button" class="auth-link" onclick={cancel}>{$t('cancel')}</button>
  </div>
{:else if view === 'ready'}
  <button type="button" class="button auth-oauth" {disabled} onclick={start}
    ><Icon icon={mdiFingerprint} size="20" />{$t('frameleaf_passkey_login_button')}</button
  >
{:else if view === 'http'}
  <!-- Owner (2026-11-07): said where the button would be, not hidden under Advanced. -->
  <p class="auth-info" role="note">
    <Icon icon={mdiInformationOutline} size="16" /><span
      >{$t('frameleaf_passkey_login_http', { values: { address: location.origin } })}
      {#if secureHost}
        <a class="auth-link" href={new URL(location.pathname + location.search, secureHost).href}
          >{$t('frameleaf_passkey_login_http_open', { values: { host: secureHost.host } })}</a
        >
      {/if}</span
    >
  </p>
{/if}
