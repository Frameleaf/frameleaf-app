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
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PinCells from '$lib/components/frameleaf/PinCells.svelte';
  import { Route } from '$lib/route';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { getAuthStatus, unlockAuthSession } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiShieldLockOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    open = $bindable(false),
    onUnlocked,
  }: {
    open?: boolean;
    /** Called once the server has elevated the session; the dialog closes itself first. */
    onUnlocked: () => void;
  } = $props();

  type Access = 'loading' | 'ready' | 'no-pin' | 'unavailable';

  let access = $state<Access>('loading');
  let pin = $state('');
  let error = $state('');
  let working = $state(false);

  const hintId = $props.id();

  const load = async () => {
    access = 'loading';
    try {
      const status = await getAuthStatus();
      access = status.pinCode ? 'ready' : 'no-pin';
    } catch {
      access = 'unavailable';
    }
  };

  $effect(() => {
    if (!open) {
      pin = '';
      error = '';
      return;
    }
    void load();
  });

  const unlock = async (code = pin) => {
    if (working || code.length !== 6) {
      return;
    }
    working = true;
    error = '';
    try {
      await unlockAuthSession({ sessionUnlockDto: { pinCode: code } });
      pin = '';
      open = false;
      onUnlocked();
    } catch (error_) {
      // The rejected code never lingers; the cells reset for a fresh attempt.
      pin = '';
      error = getServerErrorMessage(error_) ?? $t('frameleaf_locked_dialog_wrong_pin');
    } finally {
      working = false;
    }
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    void unlock();
  };
</script>

<Dialog title={$t('frameleaf_locked_unlock_content')} closeLabel={$t('frameleaf_locked_dialog_close')} bind:open>
  <form class="locked-dialog" autocomplete="off" onsubmit={submit}>
    <span class="locked-mark" aria-hidden="true">
      <Icon icon={mdiShieldLockOutline} size="26" />
    </span>

    {#if access === 'loading'}
      <p role="status">{$t('loading')}</p>
    {:else if access === 'unavailable'}
      <p>{$t('frameleaf_locked_dialog_unavailable')}</p>
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
        describedBy={hintId}
        oncomplete={(code) => void unlock(code)}
      />
      <p class="locked-hint" id={hintId}>{$t('frameleaf_locked_dialog_hint_timeout')}</p>
    {/if}

    {#if error}
      <p role="alert" class="locked-error">{error}</p>
    {/if}

    <footer class="locked-footer">
      <a class="locked-settings" href={Route.userSettings()} onclick={() => (open = false)}>
        {$t('frameleaf_locked_dialog_pin_settings')}
      </a>
      <div class="locked-actions">
        <Button type="button" onclick={() => (open = false)}>{$t('cancel')}</Button>
        {#if access === 'ready'}
          <Button type="submit" variant="primary" disabled={working || pin.length !== 6}>
            {$t('frameleaf_locked_dialog_unlock')}
          </Button>
        {/if}
      </div>
    </footer>
  </form>
</Dialog>

<style>
  .locked-dialog {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    color: var(--fl-text);
  }
  .locked-dialog p {
    margin: 0;
  }
  .locked-mark {
    display: grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    border-radius: 50%;
    color: var(--fl-accent);
    background: var(--fl-raised);
  }
  .locked-hint {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    text-align: center;
  }
  .locked-error {
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
  }
  .locked-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-top: 0.25rem;
  }
  .locked-settings {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    text-decoration: underline;
  }
  .locked-settings:hover {
    color: var(--fl-text);
  }
  .locked-actions {
    display: flex;
    gap: 0.5rem;
  }
</style>
