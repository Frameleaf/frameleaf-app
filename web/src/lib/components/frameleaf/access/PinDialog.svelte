<script lang="ts">
  /**
   * Your own Locked PIN (FL-67), from the `personal-pin-set`, `personal-pin-clear` and
   * `personal-pin-reset` forms of the design template's `PersonalForm`:
   *
   * - `create`: a new six-digit PIN and its confirmation (`setupPinCode`).
   * - `change`: the current PIN, then the new one twice (`changePinCode`).
   * - `clear`: the current PIN (`resetPinCode` with the PIN).
   * - `reset`: a forgotten PIN is cleared with the account password (`resetPinCode` with the
   *   password). Without password sign-in only an administrator can do it, which the dialog says.
   *
   * Digits use the shared `PinCells` entry. Nothing entered here outlives the dialog, and a
   * rejected code is cleared at once.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PinCells from '$lib/components/frameleaf/PinCells.svelte';
  import { canSubmitPin, type PinDialogMode } from '$lib/frameleaf/personal-access';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { changePinCode, resetPinCode, setupPinCode } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import './access.css';

  let { mode, onClose }: { mode: PinDialogMode; onClose: (changed?: boolean) => void } = $props();

  let open = $state(true);
  let current = $state('');
  let next = $state('');
  let confirm = $state('');
  let password = $state('');
  let working = $state(false);
  let error = $state('');
  let changed = false;

  const hintId = $props.id();
  const passwordLogin = $derived(featureFlagsManager.value.passwordLogin);
  const canSubmit = $derived(canSubmitPin(mode, { current, next, confirm, password }));
  const mismatch = $derived(confirm.length === 6 && next !== confirm);

  const titles = $derived<Record<PinDialogMode, string>>({
    create: $t('frameleaf_access_pin_create'),
    change: $t('frameleaf_access_pin_change'),
    clear: $t('frameleaf_access_pin_clear'),
    reset: $t('frameleaf_access_pin_reset'),
  });

  const clearFields = () => {
    current = '';
    next = '';
    confirm = '';
    password = '';
  };

  $effect(() => {
    if (open) {
      return;
    }

    clearFields();
    onClose(changed);
  });

  const send = async () => {
    switch (mode) {
      case 'create': {
        await setupPinCode({ pinCodeSetupDto: { pinCode: next } });
        eventManager.emit('UserPinCodeCreated');
        return $t('frameleaf_access_pin_created');
      }
      case 'change': {
        await changePinCode({ pinCodeChangeDto: { pinCode: current, newPinCode: next } });
        return $t('frameleaf_access_pin_changed');
      }
      case 'clear': {
        await resetPinCode({ pinCodeResetDto: { pinCode: current } });
        eventManager.emit('UserPinCodeReset');
        return $t('frameleaf_access_pin_cleared');
      }
      case 'reset': {
        await resetPinCode({ pinCodeResetDto: { password } });
        eventManager.emit('UserPinCodeReset');
        return $t('frameleaf_access_pin_cleared');
      }
    }
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (working || !canSubmit) {
      return;
    }

    working = true;
    error = '';
    try {
      const message = await send();
      changed = true;
      toastManager.primary(message);
      open = false;
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('frameleaf_access_pin_failed');
      // A rejected code never lingers.
      clearFields();
    } finally {
      working = false;
    }
  };
</script>

<Dialog title={titles[mode]} closeLabel={$t('close')} bind:open>
  <form class="fl-access-form" autocomplete="off" onsubmit={submit}>
    <p id={hintId}>
      {mode === 'reset' ? $t('frameleaf_access_pin_reset_description') : $t('frameleaf_access_pin_description')}
    </p>

    {#if mode === 'reset'}
      {#if passwordLogin}
        <label class="fl-access-field">
          <span>{$t('frameleaf_access_pin_account_password')}</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input
            type="password"
            required
            autofocus
            autocomplete="current-password"
            maxlength={256}
            disabled={working}
            bind:value={password}
          />
        </label>
      {:else}
        <p class="fl-access-footnote">{$t('frameleaf_access_pin_reset_no_password')}</p>
      {/if}
    {/if}

    {#if mode === 'change' || mode === 'clear'}
      <div class="fl-access-field">
        <span>{$t('frameleaf_access_pin_current')}</span>
        <PinCells
          bind:value={current}
          autofocus
          label={$t('frameleaf_access_pin_current')}
          describedBy={hintId}
          disabled={working}
        />
      </div>
    {/if}

    {#if mode === 'create' || mode === 'change'}
      <div class="fl-access-field">
        <span>{$t('frameleaf_access_pin_new')}</span>
        <PinCells
          bind:value={next}
          autofocus={mode === 'create'}
          label={$t('frameleaf_access_pin_new')}
          describedBy={hintId}
          disabled={working}
        />
      </div>
      <div class="fl-access-field">
        <span>{$t('frameleaf_access_pin_confirm')}</span>
        <PinCells bind:value={confirm} label={$t('frameleaf_access_pin_confirm')} error={mismatch} disabled={working} />
      </div>
      {#if mismatch}
        <p class="fl-access-error" role="alert">{$t('frameleaf_access_pin_mismatch')}</p>
      {/if}
    {/if}

    {#if error}
      <p class="fl-access-error" role="alert">{error}</p>
    {/if}

    <footer>
      <Button disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
      {#if mode !== 'reset' || passwordLogin}
        <Button type="submit" variant="primary" disabled={working || !canSubmit}>{titles[mode]}</Button>
      {/if}
    </footer>
  </form>
</Dialog>
