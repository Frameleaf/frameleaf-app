<script lang="ts">
  import { beforeNavigate, goto } from '$app/navigation';
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import AuthPasswordField from '$lib/components/frameleaf/AuthPasswordField.svelte';
  import PinCells from '$lib/components/frameleaf/PinCells.svelte';
  import {
    SESSION_UNLOCK_TIMEOUT_MS,
    sessionAccess,
    setSessionLockPending,
    trackSessionUnlock,
  } from '$lib/frameleaf/session-access.svelte';
  import { isWrongPinError, requestSessionLock } from '$lib/frameleaf/session-lock';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { Route } from '$lib/route';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { resetPinCode, setupPinCode, unlockAuthSession } from '@immich/sdk';
  import { mdiAlertCircleOutline, mdiInformationOutline, mdiBackspaceOutline, mdiShieldLockOutline } from '@mdi/js';
  import { Icon } from '@immich/ui';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
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
  const heading = $derived(
    hasPinCode
      ? $t('frameleaf_pin_enter_title')
      : stage === 'confirm'
        ? $t('frameleaf_pin_confirm_title')
        : $t('frameleaf_pin_create_title'),
  );
  const copy = $derived(hasPinCode ? $t('frameleaf_pin_unlock_body') : $t('frameleaf_pin_create_body'));

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
      errorMessage = $t('frameleaf_pin_relock_failed');
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
        errorMessage = $t('frameleaf_pin_mismatch');
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
        errorMessage = getServerErrorMessage(error) || $t('frameleaf_pin_create_failed');
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
      await trackSessionUnlock(
        unlockAuthSession(
          { sessionUnlockDto: { pinCode: code } },
          // bounded, so a stalled request cannot hold a pending lock forever
          { signal: AbortSignal.timeout(SESSION_UNLOCK_TIMEOUT_MS) },
        ),
      );
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
      // The server's explicit Wrong PIN rejection precedes any session change: nothing to relock,
      // so the prompt stays as it is (no shield, focus stays on the PIN) for another attempt.
      const wrongPin = isWrongPinError(error);
      if (!wrongPin) {
        // Any other failure does not prove the server rejected the elevation.
        await reconcileLock();
      }
      if (!current(request) || relockFailed) {
        return;
      }
      pinCode = '';
      errorMessage = wrongPin ? $t('frameleaf_locked_dialog_wrong_pin') : $t('frameleaf_locked_dialog_unlock_failed');
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
      errorMessage = getServerErrorMessage(error) || $t('frameleaf_pin_reset_failed');
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
      <button type="button" class="button primary auth-submit" disabled={working} onclick={retryLock}
        >{$t('frameleaf_pin_retry_lock')}</button
      >
    {:else if leaveDestination || resetRequested}
      <p class="auth-info" role="status">
        <Icon icon={mdiInformationOutline} size="16" /><span>{$t('frameleaf_pin_securing')}</span>
      </p>
    {/if}
    {#if isVerified}
      <p class="auth-info" role="status">
        <Icon icon={mdiInformationOutline} size="16" /><span>{$t('frameleaf_pin_unlocked')}</span>
      </p>
    {:else if resetting}
      <form class="auth-form" onsubmit={reset} novalidate>
        <p class="auth-info">
          <Icon icon={mdiInformationOutline} size="16" /><span>{$t('frameleaf_pin_reset_help')}</span>
        </p>
        <AuthPasswordField
          id="pin-reset-password"
          label={$t('frameleaf_pin_account_password')}
          autocomplete="current-password"
          autofocus
          bind:value={resetPassword}
        />
        {#if errorMessage}<p class="auth-error" role="alert">
            <Icon icon={mdiAlertCircleOutline} size="16" /><span>{errorMessage}</span>
          </p>{/if}
        <button type="submit" class="button primary auth-submit" disabled={working || !resetPassword}
          >{working ? $t('frameleaf_pin_resetting') : $t('frameleaf_pin_reset')}</button
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
          }}>{$t('frameleaf_pin_back')}</button
        >
      </form>
    {:else}
      <PinCells
        bind:value={pinCode}
        autofocus
        error={!!errorMessage}
        disabled={working || relockFailed}
        label={heading}
        describedBy={errorMessage && !relockFailed ? 'pin-prompt-hint pin-prompt-error' : 'pin-prompt-hint'}
        oncomplete={complete}
      />
      <p id="pin-prompt-hint" class="sr-only">{$t('frameleaf_pin_hint')}</p>
      {#if errorMessage && !relockFailed}<p id="pin-prompt-error" class="auth-error" role="alert">
          <Icon icon={mdiAlertCircleOutline} size="16" /><span>{errorMessage}</span>
        </p>
      {:else}<p class="auth-field-hint">
          {stage === 'confirm' && !hasPinCode ? $t('frameleaf_pin_hint_confirm') : $t('frameleaf_pin_hint_auto')}
        </p>{/if}
      <div class="pin-keypad">
        {#each [1, 2, 3, 4, 5, 6, 7, 8, 9] as digit (digit)}
          <button
            type="button"
            aria-label={$t('frameleaf_pin_digit', { values: { digit } })}
            disabled={working || relockFailed}
            onclick={() => press(String(digit))}>{digit}</button
          >
        {/each}
        <button type="button" class="pin-key-soft" onclick={cancel}>{$t('cancel')}</button>
        <button
          type="button"
          aria-label={$t('frameleaf_pin_digit', { values: { digit: 0 } })}
          disabled={working || relockFailed}
          onclick={() => press('0')}>0</button
        >
        <button
          type="button"
          class="pin-key-soft"
          aria-label={$t('frameleaf_pin_delete_digit')}
          disabled={working || relockFailed}
          onclick={() => press('back')}><Icon icon={mdiBackspaceOutline} size="20" /></button
        >
      </div>
      <div class="pin-actions">
        <button type="button" class="button" onclick={cancel}>{$t('cancel')}</button>
        {#if hasPinCode && data.hasPassword}<button
            type="button"
            class="auth-link"
            disabled={resetRequested}
            onclick={requestReset}>{$t('frameleaf_pin_reset')}</button
          >{/if}
        {#if !hasPinCode && stage === 'confirm'}<button
            type="button"
            class="auth-link"
            disabled={working}
            onclick={restart}>{$t('frameleaf_pin_start_over')}</button
          >{/if}
      </div>
      {#if hasPinCode && !data.hasPassword}
        <p class="auth-field-hint">{$t('frameleaf_pin_ask_admin')}</p>
      {/if}
    {/if}
  </div>
</AuthShell>
