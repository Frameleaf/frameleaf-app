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
   *
   * It keeps its own native dialog, because closing it by any route has to abandon an unlock that
   * is still in flight, but it looks and moves like every other Frameleaf dialog: the sheet
   * corner, elevation, scrim and Sheet entrance come from the same tokens and keyframes as
   * Dialog.svelte, and the buttons are the shared ones. A correct PIN reports the unlock at once
   * and then shows an open lock for a beat before the sheet leaves; a wrong one keeps PinCells'
   * shake. Under Reduce Motion the entrance and exit are a short crossfade.
   */
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import PinCells from '$lib/components/frameleaf/PinCells.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import { leave, prefersReducedMotion } from '$lib/frameleaf/motion';
  import { DURATION, ICON_SIZE } from '$lib/frameleaf/tokens';
  import {
    SESSION_UNLOCK_TIMEOUT_MS,
    sessionAccess,
    setSessionLockPending,
    trackSessionUnlock,
  } from '$lib/frameleaf/session-access.svelte';
  import { isWrongPinError, requestSessionLock } from '$lib/frameleaf/session-lock';
  import { onDestroy, tick, untrack } from 'svelte';
  import { getAuthStatus, isHttpError, unlockAuthSession } from '@frameleaf/sdk';
  import { Icon, Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import { mdiClose, mdiLockOpenVariantOutline, mdiShieldLockOutline } from '@mdi/js';
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

  /** The PIN section of the account's settings. */
  const PIN_SETTINGS = '/user-settings?isOpen=user-pin-code-settings';

  let access = $state<Access>('loading');
  /** The PIN was right: the open lock shows for a beat, then the sheet leaves. */
  let unlocked = $state(false);
  let successTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelExit: (() => void) | undefined;
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
    clearTimeout(successTimer);
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
      // The native dialog is closed by now; drop the success moment and the exit's held last frame.
      clearTimeout(successTimer);
      cancelExit?.();
      cancelExit = undefined;
      unlocked = false;
      return;
    }
    void load();
  });

  const unlock = async (code = pin) => {
    if (!active || !open || unlocked || sessionAccess.lockPending || unlockInFlight || code.length !== 6) {
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
      unlocked = true;
      // The session is unlocked now, so the page behind is told at once; the sheet then leaves.
      onUnlocked();
      successTimer = setTimeout(
        () => {
          cancelExit = leave(dialog, 'sheet', () => (open = false), { backdrop: true });
        },
        prefersReducedMotion() ? 0 : DURATION.spring,
      );
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
  class="frameleaf locked-dialog fl-continuous-corners"
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
      <span class="locked-dialog-mark" class:is-unlocked={unlocked} aria-hidden="true">
        {#key unlocked}
          <span class="locked-dialog-icon">
            <Icon icon={unlocked ? mdiLockOpenVariantOutline : mdiShieldLockOutline} size={ICON_SIZE.hero} />
          </span>
        {/key}
      </span>
      <IconButton label={$t('frameleaf_locked_dialog_close')} onclick={abandon}>
        <Icon icon={mdiClose} size={ICON_SIZE.lg} />
      </IconButton>
    </header>
    <h2 id={titleId}>
      {access === 'no-pin' ? $t('frameleaf_locked_dialog_set_up_pin') : $t('frameleaf_locked_dialog_title')}
    </h2>
    {#if access === 'loading'}
      <!-- The PIN row at its final size, so the sheet does not jump when the answer arrives. -->
      <div class="locked-loading" role="status" aria-label={$t('loading')}>
        <Skeleton variant="text" lines={2} />
        <Skeleton variant="block" height="3.25rem" />
      </div>
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
        disabled={working || unlocked}
        label={$t('frameleaf_locked_dialog_pin_label')}
        describedBy={error ? `${hintId} ${errorId}` : hintId}
        context="locked"
        oncomplete={(code) => void unlock(code)}
      />
      {#if unlocked}
        <p class="locked-hint locked-success" id={hintId} role="status">{$t('frameleaf_locked_revealed')}</p>
      {:else}
        <p class="locked-hint" id={hintId}>{$t('frameleaf_locked_dialog_hint_timeout')}</p>
      {/if}
    {/if}
    {#if error}<p id={errorId} role="alert" class="locked-error">{error}</p>{/if}
    <footer>
      {#if access === 'ready'}
        <a class="locked-settings" href={PIN_SETTINGS} onclick={abandon}>{$t('frameleaf_locked_dialog_pin_settings')}</a
        >
      {/if}
      <div>
        <button type="button" class="button" onclick={abandon}>{$t('cancel')}</button>
        {#if access === 'offline'}
          <button type="button" class="button primary" onclick={() => void load()}>{$t('retry')}</button>
        {/if}
        {#if access === 'no-pin'}
          <!-- The one way forward when there is no PIN yet. -->
          <a class="button primary" href={PIN_SETTINGS} onclick={abandon}>{$t('frameleaf_locked_dialog_set_up_pin')}</a>
        {/if}
        {#if access === 'ready'}
          <button type="submit" class="button primary" disabled={working || unlocked || pin.length !== 6}
            >{$t('frameleaf_locked_dialog_unlock')}</button
          >
        {/if}
      </div>
    </footer>
  </form>
</dialog>

<style>
  /*
   * The same sheet as Dialog.svelte: radius, elevation, scrim and the Sheet entrance all come from
   * the token scale and the shared keyframes (base.css `fl-fade-in`, `fl-sheet-in`).
   */
  .locked-dialog {
    position: fixed;
    inset: 0;
    margin: auto;
    width: min(430px, calc(100vw - 32px));
    box-sizing: border-box;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-sheet);
    padding: var(--fl-space-6);
    background: var(--fl-panel);
    color: var(--fl-text);
    box-shadow: var(--fl-shadow-4);
    animation:
      fl-fade-in var(--fl-duration-fade) var(--fl-ease) both,
      fl-sheet-in var(--fl-duration-sheet) var(--fl-spring) both;
  }
  .locked-dialog::backdrop {
    background: var(--fl-scrim);
    -webkit-backdrop-filter: var(--fl-scrim-blur);
    backdrop-filter: var(--fl-scrim-blur);
    animation: fl-fade-in var(--fl-duration-fade) var(--fl-ease) both;
  }
  @supports (corner-shape: squircle) {
    .locked-dialog {
      border-radius: calc(var(--fl-radius-sheet) * 1.8);
    }
  }
  @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
    .locked-dialog::backdrop {
      background: var(--fl-scrim);
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }
  .locked-dialog header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--fl-space-4);
  }
  .locked-dialog-mark {
    display: grid;
    place-items: center;
    width: var(--fl-control-height-touch);
    height: var(--fl-control-height-touch);
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    color: var(--fl-accent);
    transition: background-color var(--fl-motion) var(--fl-ease);
  }
  .locked-dialog-mark.is-unlocked {
    background: var(--fl-accent-soft);
  }
  .locked-dialog-icon {
    display: inline-flex;
  }
  /* The quiet success moment: the open lock pops in on the spring. */
  .is-unlocked .locked-dialog-icon {
    animation: fl-pop-in var(--fl-duration) var(--fl-spring) both;
  }
  .locked-dialog h2 {
    margin: 0 0 var(--fl-space-2);
    font: var(--fl-type-headline);
    letter-spacing: var(--fl-tracking-headline);
  }
  .locked-dialog p {
    margin: var(--fl-space-2) 0 var(--fl-space-5);
    color: var(--fl-muted);
    font-size: var(--fl-font-size);
    line-height: 1.5;
  }
  .locked-loading {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-4);
    margin: var(--fl-space-2) 0 var(--fl-space-5);
  }
  .locked-dialog p.locked-hint {
    margin: var(--fl-space-3) 0;
    font-size: var(--fl-font-small);
  }
  .locked-dialog p.locked-success {
    color: var(--fl-text);
  }
  .locked-dialog p.locked-error {
    margin: var(--fl-space-3) 0;
    color: var(--fl-danger);
  }
  .locked-dialog footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3);
    margin-top: var(--fl-space-6);
  }
  .locked-dialog footer > div {
    display: flex;
    gap: var(--fl-space-2);
    margin-inline-start: auto;
  }
  .locked-dialog .locked-settings {
    display: inline-flex;
    align-items: center;
    min-height: var(--fl-control-height);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .locked-dialog a.button {
    display: inline-flex;
    align-items: center;
    min-height: var(--fl-control-height);
    text-decoration: none;
  }
  @media (max-width: 600px) {
    .locked-dialog {
      padding: var(--fl-space-5);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .locked-dialog {
      animation: fl-fade-in var(--fl-duration-reduced) var(--fl-ease) both !important;
    }
  }
</style>
