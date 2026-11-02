<script lang="ts">
  /**
   * FL-721 (prototype "Use recovery key…" and "Forgot it?", spec §7.5): the recovery key opens the
   * files, and the person chooses a new PIN or passphrase (`recoverLockedEncryption`). Nobody else,
   * an administrator included, can do this for them.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PinCells from '$lib/components/frameleaf/PinCells.svelte';
  import NewPassphraseFields from '$lib/components/frameleaf/settings/security/locked-encryption/NewPassphraseFields.svelte';
  import { passphraseReady } from '$lib/frameleaf/locked-encryption';
  import { isCompletePin } from '$lib/frameleaf/personal-access';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { LockedEncryptionMode, recoverLockedEncryption } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  import './locked-encryption.css';

  let { mode, onClose }: { mode: LockedEncryptionMode; onClose: (recovered?: boolean) => void } = $props();

  let open = $state(true);
  let recoveryKey = $state('');
  let pin = $state('');
  let pinAgain = $state('');
  let phrase = $state('');
  let again = $state('');
  let working = $state(false);
  let error = $state('');
  let recovered = false;

  const advanced = $derived(mode === LockedEncryptionMode.Advanced);
  const pinMismatch = $derived(pinAgain.length === 6 && pin !== pinAgain);
  const ready = $derived(
    recoveryKey.trim().length > 0 &&
      (advanced ? passphraseReady(phrase, again) : isCompletePin(pin) && pin === pinAgain),
  );

  $effect(() => {
    if (open) {
      return;
    }
    recoveryKey = pin = pinAgain = phrase = again = '';
    onClose(recovered);
  });

  const recover = async () => {
    if (working || !ready) {
      return;
    }
    working = true;
    error = '';
    try {
      await recoverLockedEncryption({
        lockedEncryptionRecoverDto: advanced
          ? { recoveryKey: recoveryKey.trim(), newPassphrase: phrase }
          : { recoveryKey: recoveryKey.trim(), newPinCode: pin },
      });
      recovered = true;
      open = false;
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('frameleaf_le_recover_failed');
    } finally {
      working = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_le_recover_title')} closeLabel={$t('close')} bind:open>
  <div class="le-form">
    <p>{$t(advanced ? 'frameleaf_le_recover_body_passphrase' : 'frameleaf_le_recover_body_pin')}</p>
    <label>
      {$t('frameleaf_le_recovery_key')}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="le-text"
        type="text"
        autocomplete="off"
        spellcheck="false"
        maxlength={256}
        placeholder="FLRK-…"
        autofocus
        disabled={working}
        bind:value={recoveryKey}
      />
    </label>
    {#if advanced}
      <NewPassphraseFields bind:phrase bind:again disabled={working} />
    {:else}
      <div class="le-label">
        <span>{$t('frameleaf_le_new_pin')}</span>
        <PinCells bind:value={pin} label={$t('frameleaf_le_new_pin')} disabled={working} />
      </div>
      <div class="le-label">
        <span>{$t('frameleaf_le_new_pin_again')}</span>
        <PinCells
          bind:value={pinAgain}
          label={$t('frameleaf_le_new_pin_again')}
          error={pinMismatch}
          disabled={working}
        />
      </div>
      {#if pinMismatch}
        <p class="le-error" role="alert">{$t('frameleaf_le_pin_mismatch')}</p>
      {/if}
    {/if}
    {#if error}
      <p class="le-error" role="alert">{error}</p>
    {/if}
  </div>
  {#snippet actions()}
    <Button disabled={working} onclick={() => (open = false)}>{$t('frameleaf_le_cancel')}</Button>
    <Button variant="primary" disabled={working || !ready} onclick={() => void recover()}>
      {$t(advanced ? 'frameleaf_le_recover_save_passphrase' : 'frameleaf_le_recover_save_pin')}
    </Button>
  {/snippet}
</Dialog>
