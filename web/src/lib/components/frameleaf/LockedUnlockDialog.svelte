<script lang="ts">
  /**
   * The in-place "Unlock Locked content" dialog, ported from the design template's
   * `LockedControl` (`LockedContent.jsx`). It opens over the current page from the top bar's
   * Locked control and the account menu, so unlocking never leaves the page; the PIN prompt route
   * stays for deep links that need an elevated session before they can render.
   *
   * States follow the prototype: a session without a PIN is sent to PIN settings, six digits
   * unlock through the real `unlockAuthSession` endpoint, and a rejected code is cleared at once.
   * The PIN never leaves this component except in that request.
   */
  import PinCells from '$lib/components/frameleaf/PinCells.svelte';
  import {
    SESSION_UNLOCK_TIMEOUT_MS,
    sessionAccess,
    setSessionLockPending,
    trackSessionUnlock,
  } from '$lib/frameleaf/session-access.svelte';
  import { isWrongPinError, requestSessionLock } from '$lib/frameleaf/session-lock';
  import { onDestroy, tick, untrack } from 'svelte';
  import { Route } from '$lib/route';
  import { getAuthStatus, isHttpError, unlockAuthSession } from '@immich/sdk';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import { mdiClose, mdiShieldLockOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    open = $bindable(false),
    onUnlocked,
  }: {
    open?: boolean;
    /** Called once the server has elevated the session; the dialog closes itself first. */
    onUnlocked: () => void;
  } = $props();

  // `unavailable` is only a revoked session (401); a network failure is `offline` and can retry.
  type Access = 'loading' | 'ready' | 'no-pin' | 'unavailable' | 'offline';

  let access = $state<Access>('loading');
  let pin = $state('');
  let error = $state('');
  let working = $state(false);
  // Plain mirror of `working`: the native dialog's close event can fire inside an effect teardown,
  // where Svelte reads state as it was before the change, so abandon() must not trust `working`.
  let unlockInFlight = false;
  const setWorking = (value: boolean) => {
    working = value;
    unlockInFlight = value;
  };

  const hintId = $props.id();
  const titleId = `${hintId}-title`;
  const errorId = `${hintId}-error`;
  let dialog: HTMLDialogElement;
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  $effect(() => {
    if (!open) {
      return;
    }
    // Only `open` drives the native dialog: focus handlers that run inside showModal() must not
    // become dependencies, or their state changes would close the dialog mid-unlock.
    return untrack(() => {
      if (!dialog || dialog.open) {
        return;
      }
      const previous = document.activeElement;
      dialog.showModal();
      return () => {
        dialog.close();
        if (previous instanceof HTMLElement && previous.isConnected) {
          previous.focus();
        }
      };
    });
  });
  let active = true;
  let revision = 0;
  const abandon = () => {
    revision++;
    if (unlockInFlight) {
      setSessionLockPending(true);
      void requestSessionLock();
    }
    open = false;
    pin = '';
  };
  onDestroy(() => {
    active = false;
    abandon();
  });

  const load = async () => {
    const request = ++revision;
    access = 'loading';
    try {
      const status = await getAuthStatus();
      if (!active || !open || request !== revision) {
        return;
      }
      access = status.pinCode ? 'ready' : 'no-pin';
    } catch (error) {
      if (active && open && request === revision) {
        access = isHttpError(error) && error.status === 401 ? 'unavailable' : 'offline';
      }
    }
  };

  $effect(() => {
    if (!open) {
      if (unlockInFlight) {
        abandon();
      }
      pin = '';
      error = '';
      return;
    }
    void load();
  });

  const unlock = async (code = pin) => {
    if (!active || !open || sessionAccess.lockPending || unlockInFlight || code.length !== 6) {
      return;
    }
    setWorking(true);
    error = '';
    const request = ++revision;
    const privacyRevision = sessionAccess.revision;
    try {
      await trackSessionUnlock(
        unlockAuthSession(
          { sessionUnlockDto: { pinCode: code } },
          // bounded, so a stalled request cannot hold a pending lock forever
          { signal: AbortSignal.timeout(SESSION_UNLOCK_TIMEOUT_MS) },
        ),
      );
      setWorking(false);
      if (
        !active ||
        !open ||
        request !== revision ||
        sessionAccess.lockPending ||
        privacyRevision !== sessionAccess.revision
      ) {
        await requestSessionLock();
        return;
      }
      pin = '';
      open = false;
      onUnlocked();
    } catch (error_) {
      // This explicit rejection occurs before the server mutates the session.
      const wrongPin = isWrongPinError(error_);
      // Retire this request before the shared lock closes its native dialog.
      setWorking(false);
      if (!wrongPin) {
        // Other failures do not prove the server rejected the elevation.
        await requestSessionLock();
      }
      if (!active || !open || request !== revision) {
        return;
      }
      // The rejected code never lingers; the cells reset for a fresh attempt with focus back on them.
      pin = '';
      error = wrongPin ? $t('frameleaf_locked_dialog_wrong_pin') : $t('frameleaf_locked_dialog_unlock_failed');
      void tick().then(() => dialog?.querySelector<HTMLInputElement>('.pin-input')?.focus());
    } finally {
      setWorking(false);
    }
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    void unlock();
  };
</script>

<dialog
  bind:this={dialog}
  class="frameleaf locked-dialog"
  data-theme={appTheme}
  aria-labelledby={titleId}
  oncancel={(event) => {
    event.preventDefault();
    abandon();
  }}
  onclose={abandon}
>
  <form autocomplete="off" onsubmit={submit}>
    <header>
      <span class="locked-dialog-mark" aria-hidden="true"><Icon icon={mdiShieldLockOutline} size="26" /></span>
      <button class="locked-close" type="button" aria-label={$t('frameleaf_locked_dialog_close')} onclick={abandon}>
        <Icon icon={mdiClose} size="20" />
      </button>
    </header>
    <h2 id={titleId}>{$t('frameleaf_locked_unlock_content')}</h2>
    {#if access === 'loading'}
      <p role="status">{$t('loading')}</p>
    {:else if access === 'unavailable'}
      <p>{$t('frameleaf_locked_dialog_unavailable')}</p>
    {:else if access === 'offline'}
      <p role="alert">{$t('frameleaf_locked_dialog_offline')}</p>
    {:else if access === 'no-pin'}
      <p>{$t('frameleaf_locked_dialog_no_pin')}</p>
    {:else}
      <p>{$t('frameleaf_locked_dialog_body')}</p>
      <PinCells
        bind:value={pin}
        autofocus
        error={!!error}
        disabled={working}
        label={$t('frameleaf_locked_dialog_pin_label')}
        describedBy={error ? `${hintId} ${errorId}` : hintId}
        context="locked"
        oncomplete={(code) => void unlock(code)}
      />
      <p class="locked-hint" id={hintId}>{$t('frameleaf_locked_dialog_hint_timeout')}</p>
    {/if}
    {#if error}<p id={errorId} role="alert" class="locked-error">{error}</p>{/if}
    <footer>
      <a class="locked-settings" href={Route.userSettings()} onclick={abandon}
        >{$t('frameleaf_locked_dialog_pin_settings')}</a
      >
      <div>
        <button type="button" onclick={abandon}>{$t('cancel')}</button>
        {#if access === 'offline'}
          <button type="button" class="locked-primary" onclick={() => void load()}>{$t('retry')}</button>
        {/if}
        {#if access === 'ready'}
          <button type="submit" class="locked-primary" disabled={working || pin.length !== 6}
            >{$t('frameleaf_locked_dialog_unlock')}</button
          >
        {/if}
      </div>
    </footer>
  </form>
</dialog>

<style>
  .locked-dialog {
    position: fixed;
    inset: 0;
    margin: auto;
    width: min(430px, calc(100vw - 32px));
    box-sizing: border-box;
    border: 1px solid var(--fl-border, #42464b);
    border-radius: 18px;
    padding: 26px;
    background: var(--fl-panel, #24272b);
    color: var(--fl-text, #f0f1f2);
    box-shadow: 0 20px 80px #0007;
  }
  .locked-dialog::backdrop {
    background: #1119239c;
    backdrop-filter: blur(4px);
  }
  .locked-dialog header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }
  .locked-dialog-mark {
    display: grid;
    place-items: center;
    width: 47px;
    height: 47px;
    border-radius: 12px;
    background: var(--fl-raised, rgba(127, 127, 127, 0.13));
    color: var(--fl-accent, #e1b879);
  }
  .locked-dialog h2 {
    font-size: 21px;
    letter-spacing: -0.4px;
    line-height: 1.3;
    margin: 0 0 9px;
    font-weight: 650;
  }
  .locked-dialog p {
    line-height: 1.55;
    font-size: 13px;
    color: var(--fl-muted, #b6bdc7);
    margin: 8px 0 20px;
  }
  .locked-dialog button {
    background: transparent;
    color: inherit;
    border: 1px solid var(--fl-border, #42464b);
    border-radius: 8px;
    min-height: 36px;
    padding: 0 12px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .locked-dialog button.locked-close {
    border: 0;
    padding: 6px;
    display: grid;
    place-items: center;
  }
  .locked-dialog p.locked-hint {
    font-size: 11px;
    margin: 10px 0;
    color: var(--fl-muted, #b6bdc7);
  }
  .locked-dialog p.locked-error {
    color: var(--danger, #ef9b97);
    margin: 14px 0;
  }
  .locked-dialog footer {
    margin-top: 25px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .locked-dialog footer > div {
    display: flex;
    gap: 8px;
  }
  .locked-dialog .locked-settings {
    padding: 0;
    border: 0;
    color: var(--fl-muted, #b6bdc7);
  }
  .locked-dialog button.locked-primary {
    background: var(--fl-accent, #e1b879);
    color: var(--fl-accent-text, #17191c);
    border-color: transparent;
    font-weight: 650;
  }
  .locked-dialog button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  @media (max-width: 600px) {
    .locked-dialog {
      padding: 22px;
    }
  }
</style>
