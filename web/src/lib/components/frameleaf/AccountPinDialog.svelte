<script lang="ts">
  /**
   * Administrator PIN actions (FL-76), from the `set-pin` and `reset-pin` branches of the
   * design template's `ResourceAction` in `design/frameleaf/template/src/AccountsLibraries.jsx`.
   *
   * Both go through the existing admin update endpoint: a six-digit code sets or replaces the
   * PIN (`UserAdminService.update` hashes it with bcrypt) and `null` clears it. That same
   * update now drops the elevated state of the account's sessions, so a device that already
   * unlocked with the old PIN cannot keep reaching Locked content afterwards.
   *
   * Entry uses the shared `PinCells` control, so the admin surface, the sign-in PIN prompt and
   * the Locked unlock dialog all behave identically, including paste. The digits live only in
   * this component's local state and are dropped as soon as the dialog closes; nothing logs or
   * persists them.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PinCells from '$lib/components/frameleaf/PinCells.svelte';
  import { handleUpdateUserAdmin } from '$lib/services/user-admin.service';
  import type { UserAdminResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  let {
    user,
    mode,
    hasPin = false,
    onClose,
  }: {
    user: UserAdminResponseDto;
    /** `set` writes a new PIN; `clear` removes whatever PIN the account has. */
    mode: 'set' | 'clear';
    /** Whether the account has a PIN now: setting one is then "Change PIN" (CC-30). */
    hasPin?: boolean;
    onClose: () => void;
  } = $props();

  // The template names the dialog and its action after the action (`AccountsLibraries.jsx` 1416-1434, 2285).
  const label = $derived(
    mode === 'clear'
      ? $t('frameleaf_users_pin_reset')
      : hasPin
        ? $t('frameleaf_users_pin_change')
        : $t('frameleaf_users_pin_set'),
  );

  let open = $state(true);
  let pinCode = $state('');
  let confirmPinCode = $state('');
  let working = $state(false);

  const mismatch = $derived(confirmPinCode.length === 6 && pinCode !== confirmPinCode);
  const valid = $derived(mode === 'clear' || (pinCode.length === 6 && pinCode === confirmPinCode));
  const hintId = $props.id();

  $effect(() => {
    if (open) {
      return;
    }

    // The entered digits never outlive the dialog.
    pinCode = '';
    confirmPinCode = '';
    onClose();
  });

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!valid || working) {
      return;
    }

    working = true;
    try {
      const success = await handleUpdateUserAdmin(user, { pinCode: mode === 'clear' ? null : pinCode });
      if (success) {
        open = false;
      }
    } finally {
      working = false;
    }
  };
</script>

<Dialog title={label} closeLabel={$t('close')} bind:open>
  <form onsubmit={submit}>
    <p id={hintId}>
      {mode === 'clear'
        ? $t('frameleaf_users_pin_reset_description', { values: { name: user.name } })
        : $t('frameleaf_users_pin_set_description', { values: { name: user.name } })}
    </p>

    {#if mode === 'set'}
      <div class="field">
        <span>{$t('frameleaf_users_pin_label')}</span>
        <PinCells
          bind:value={pinCode}
          autofocus
          label={$t('frameleaf_users_pin_label')}
          describedBy={hintId}
          disabled={working}
        />
      </div>
      <div class="field">
        <span>{$t('frameleaf_users_pin_confirm_label')}</span>
        <PinCells
          bind:value={confirmPinCode}
          label={$t('frameleaf_users_pin_confirm_label')}
          error={mismatch}
          disabled={working}
        />
      </div>
      {#if mismatch}
        <p class="error" role="alert">{$t('frameleaf_users_pin_mismatch')}</p>
      {/if}
    {/if}

    <footer>
      <Button type="button" disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button type="submit" variant="primary" disabled={!valid || working}>
        {label}
      </Button>
    </footer>
  </form>
</Dialog>

<style>
  form {
    margin-top: 0.75rem;
    min-width: min(24rem, 100%);
  }
  p {
    margin: 0 0 1rem;
    color: var(--fl-text);
  }
  .field {
    display: grid;
    gap: 0.375rem;
    margin-bottom: 1rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .error {
    margin: 0 0 1rem;
    font-size: var(--fl-font-small);
    color: var(--fl-danger);
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
