<script lang="ts">
  import { beforeNavigate, goto } from '$app/navigation';
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import AuthPasswordField from '$lib/components/frameleaf/AuthPasswordField.svelte';
  import PinCells from '$lib/components/frameleaf/PinCells.svelte';
  import { sessionAccess, setSessionLockPending, trackSessionUnlock } from '$lib/frameleaf/session-access.svelte';
  import { requestSessionLock } from '$lib/frameleaf/session-lock';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { Route } from '$lib/route';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { resetPinCode, setupPinCode, unlockAuthSession } from '@immich/sdk';
  import { mdiAlertCircleOutline, mdiInformationOutline, mdiBackspaceOutline, mdiShieldLockOutline } from '@mdi/js';
  import { Icon } from '@immich/ui';
  import { onDestroy } from 'svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  let hasPinCode = $state(data.hasPinCode);
  let pinCode = $state('');
  let firstPin = $state('');
  let stage = $state<'enter' | 'confirm'>('enter');
  let errorMessage = $state('');
  let isVerified = $state(false);
  let working = $state(false);
  let resetting = $state(false);
  let resetRequested = $state(false);
  let relockFailed = $state(false);
  let resetPassword = $state('');
  let pinCard: HTMLDivElement;
  let active = true;
  let revision = 0;
  let pendingRequest = 0;
  let unlocking = false;
  let leaveDestination = $state<string | URL>();
  const heading = $derived(hasPinCode ? 'Enter your PIN' : stage === 'confirm' ? 'Confirm your PIN' : 'Create a PIN');
  const copy = $derived(
    hasPinCode ? 'Unlock Locked content for this session.' : 'Six digits protect your Locked content on this device.',
  );

  const focusPin = () => pinCard?.querySelector<HTMLInputElement>('.pin-input')?.focus();
  const clear = () => {
    pinCode = '';
    errorMessage = '';
    focusPin();
  };
  const current = (request: number) => active && request === revision;
  const begin = () => {
    working = true;
    pendingRequest = ++revision;
    return pendingRequest;
  };
  const advanceAfterSafe = async () => {
    if (!active || relockFailed) {
      return;
    }
    if (leaveDestination) {
      const destination = leaveDestination;
      leaveDestination = undefined;
      if (destination instanceof URL && destination.origin !== location.origin) {
        location.assign(destination.href);
        return;
      }
      await goto(destination);
    } else if (resetRequested) {
      resetRequested = false;
      resetting = true;
      errorMessage = '';
    }
  };
  const finish = (request: number) => {
    if (!active || request !== pendingRequest) {
      return;
    }
    working = false;
    void advanceAfterSafe();
  };
  const abandon = (destination: string | URL) => {
    if (unlocking) {
      setSessionLockPending(true);
      void requestSessionLock();
    }
    revision++;
    leaveDestination = destination;
    resetRequested = false;
    pinCode = '';
    firstPin = '';
    resetPassword = '';
    if (!working) {
      void advanceAfterSafe();
    }
  };
  const cancel = () => abandon(Route.photos());
  const requestReset = () => {
    if (unlocking) {
      setSessionLockPending(true);
      void requestSessionLock();
    }
    revision++;
    pinCode = '';
    firstPin = '';
    errorMessage = '';
    if (working) {
      resetRequested = true;
      return;
    }
    if (relockFailed) {
      resetRequested = true;
      return;
    }
    resetting = true;
  };
  const reconcileLock = async () => {
    await requestSessionLock();
    relockFailed = sessionAccess.lockPending;
    if (relockFailed && active) {
      errorMessage = 'Unable to confirm this session is locked. Retry locking before leaving.';
    }
  };
  $effect(() => {
    if (!relockFailed || sessionAccess.lockPending) {
      return;
    }

    relockFailed = false;
    void advanceAfterSafe();
  });
  const retryLock = async () => {
    if (working || !relockFailed) {
      return;
    }
    working = true;
    await reconcileLock();
    working = false;
    await advanceAfterSafe();
  };
  beforeNavigate(({ cancel: preventNavigation, to }) => {
    if ((!working && !relockFailed) || isVerified) {
      return;
    }
    preventNavigation();
    abandon(to?.url ?? Route.photos());
  });
  onDestroy(() => {
    if (unlocking && !isVerified) {
      setSessionLockPending(true);
      void requestSessionLock();
    }
    active = false;
    revision++;
    pinCode = '';
    firstPin = '';
    resetPassword = '';
  });
  const complete = async (code: string) => {
    if (!active || sessionAccess.lockPending || working || resetting || resetRequested || relockFailed) {
      return;
    }
    if (!hasPinCode) {
      if (stage === 'enter') {
        firstPin = code;
        stage = 'confirm';
        clear();
        return;
      }
      if (code !== firstPin) {
        firstPin = '';
        stage = 'enter';
        pinCode = '';
        errorMessage = "The PINs don't match. Start again.";
        focusPin();
        return;
      }
      const request = begin();
      try {
        await setupPinCode({ pinCodeSetupDto: { pinCode: code } });
        if (!current(request)) {
          return;
        }
        hasPinCode = true;
        firstPin = '';
        clear();
      } catch (error) {
        if (!current(request)) {
          return;
        }
        pinCode = '';
        errorMessage = getServerErrorMessage(error) || 'Unable to create your PIN.';
      } finally {
        finish(request);
      }
      return;
    }

    const request = begin();
    errorMessage = '';
    try {
      unlocking = true;
      const privacyRevision = sessionAccess.revision;
      await trackSessionUnlock(unlockAuthSession({ sessionUnlockDto: { pinCode: code } }));
      if (!current(request) || sessionAccess.lockPending || privacyRevision !== sessionAccess.revision) {
        await reconcileLock();
        return;
      }
      isVerified = true;
      pinCode = '';
      eventManager.emit('SessionAccessChanged', { isElevated: true });
      await goto(data.continueUrl);
    } catch (error) {
      isVerified = false;
      await reconcileLock();
      if (!current(request) || relockFailed) {
        return;
      }
      pinCode = '';
      errorMessage = getServerErrorMessage(error) || "That PIN isn't right. Try again.";
      focusPin();
    } finally {
      unlocking = false;
      finish(request);
    }
  };
  const press = (digit: string) => {
    if (!active || sessionAccess.lockPending || working || isVerified || resetting || resetRequested || relockFailed) {
      return;
    }
    const next = digit === 'back' ? pinCode.slice(0, -1) : (pinCode + digit).replaceAll(/\D/g, '').slice(0, 6);
    pinCode = next;
    errorMessage = '';
    focusPin();
    if (next.length === 6) {
      void complete(next);
    }
  };
  const restart = () => {
    if (working) {
      return;
    }
    firstPin = '';
    stage = 'enter';
    clear();
  };
  const reset = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!active || !resetPassword || working) {
      return;
    }
    const request = begin();
    errorMessage = '';
    try {
      await resetPinCode({ pinCodeResetDto: { password: resetPassword } });
      if (!current(request)) {
        return;
      }
      resetPassword = '';
      resetting = false;
      hasPinCode = false;
      restart();
    } catch (error) {
      if (!current(request)) {
        return;
      }
      resetPassword = '';
      errorMessage = getServerErrorMessage(error) || 'Unable to reset your PIN.';
    } finally {
      finish(request);
    }
  };
</script>

<AuthShell withHeader={false} keypad="auto">
  <div class="auth-card pin-card" bind:this={pinCard}>
    <span class="pin-mark"><Icon icon={mdiShieldLockOutline} size="26" /></span>
    <div class="auth-heading">
      <h1>{heading}</h1>
      <p>{copy}</p>
    </div>
    {#if relockFailed}
      <p class="auth-error" role="alert"><Icon icon={mdiAlertCircleOutline} size="16" /><span>{errorMessage}</span></p>
      <button type="button" class="button primary auth-submit" disabled={working} onclick={retryLock}>Retry lock</button
      >
    {:else if leaveDestination || resetRequested}
      <p class="auth-info" role="status">
        <Icon icon={mdiInformationOutline} size="16" /><span>Securing your session before continuing…</span>
      </p>
    {/if}
    {#if isVerified}
      <p class="auth-info" role="status">
        <Icon icon={mdiInformationOutline} size="16" /><span>Unlocked. Opening your library…</span>
      </p>
    {:else if resetting}
      <form class="auth-form" onsubmit={reset} novalidate>
        <p class="auth-info">
          <Icon icon={mdiInformationOutline} size="16" /><span>Enter your account password to reset your PIN.</span>
        </p>
        <AuthPasswordField
          id="pin-reset-password"
          label="Account password"
          autocomplete="current-password"
          autofocus
          bind:value={resetPassword}
        />
        {#if errorMessage}<p class="auth-error" role="alert">
            <Icon icon={mdiAlertCircleOutline} size="16" /><span>{errorMessage}</span>
          </p>{/if}
        <button type="submit" class="button primary auth-submit" disabled={working || !resetPassword}
          >{working ? 'Resetting…' : 'Reset PIN'}</button
        >
        <button
          type="button"
          class="auth-link"
          disabled={working}
          onclick={() => {
            resetting = false;
            errorMessage = '';
            resetPassword = '';
            focusPin();
          }}>Back to PIN</button
        >
      </form>
    {:else}
      <PinCells
        bind:value={pinCode}
        autofocus
        error={!!errorMessage}
        disabled={working || relockFailed}
        label={heading}
        describedBy="pin-prompt-hint"
        oncomplete={complete}
      />
      <p id="pin-prompt-hint" class="sr-only">Six digits. The PIN is checked as soon as all six are entered.</p>
      {#if errorMessage && !relockFailed}<p class="auth-error" role="alert">
          <Icon icon={mdiAlertCircleOutline} size="16" /><span>{errorMessage}</span>
        </p>
      {:else}<p class="auth-field-hint">
          {stage === 'confirm' && !hasPinCode
            ? 'Enter the same six digits again.'
            : 'Digits are checked automatically.'}
        </p>{/if}
      <div class="pin-keypad">
        {#each [1, 2, 3, 4, 5, 6, 7, 8, 9] as digit (digit)}
          <button
            type="button"
            aria-label={`Digit ${digit}`}
            disabled={working || relockFailed}
            onclick={() => press(String(digit))}>{digit}</button
          >
        {/each}
        <button type="button" class="pin-key-soft" onclick={cancel}>Cancel</button>
        <button type="button" aria-label="Digit 0" disabled={working || relockFailed} onclick={() => press('0')}
          >0</button
        >
        <button
          type="button"
          class="pin-key-soft"
          aria-label="Delete last digit"
          disabled={working || relockFailed}
          onclick={() => press('back')}><Icon icon={mdiBackspaceOutline} size="20" /></button
        >
      </div>
      <div class="pin-actions">
        <button type="button" class="button" onclick={cancel}>Cancel</button>
        {#if hasPinCode && data.hasPassword}<button
            type="button"
            class="auth-link"
            disabled={resetRequested}
            onclick={requestReset}>Reset PIN</button
          >{/if}
        {#if !hasPinCode && stage === 'confirm'}<button
            type="button"
            class="auth-link"
            disabled={working}
            onclick={restart}>Start over</button
          >{/if}
      </div>
      {#if hasPinCode && !data.hasPassword}
        <p class="auth-field-hint">Ask your server administrator to reset a forgotten PIN.</p>
      {/if}
    {/if}
  </div>
</AuthShell>
