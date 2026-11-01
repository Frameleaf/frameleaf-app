<script lang="ts">
  /**
   * FL-721 (prototype "Make a new key…", spec §7.5): the PIN or passphrase, then a new recovery key
   * to save (`createLockedEncryptionRecoveryKey`). The old key stops working. The new one is shown
   * once, so the dialog stays until it is saved.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import RecoveryKeyBox from '$lib/components/frameleaf/settings/security/locked-encryption/RecoveryKeyBox.svelte';
  import SecretField from '$lib/components/frameleaf/settings/security/locked-encryption/SecretField.svelte';
  import { isCompletePin } from '$lib/frameleaf/personal-access';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { createLockedEncryptionRecoveryKey, LockedEncryptionMode } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  import './locked-encryption.css';

  let { mode, onClose }: { mode: LockedEncryptionMode; onClose: (made?: boolean) => void } = $props();

  let open = $state(true);
  let secret = $state('');
  let recoveryKey = $state('');
  let saved = $state(false);
  let working = $state(false);
  let error = $state('');

  const advanced = $derived(mode === LockedEncryptionMode.Advanced);
  const ready = $derived(advanced ? secret.length > 0 : isCompletePin(secret));

  $effect(() => {
    if (open) {
      return;
    }
    const made = recoveryKey.length > 0;
    secret = recoveryKey = '';
    onClose(made);
  });

  const make = async () => {
    if (working || !ready) {
      return;
    }
    working = true;
    error = '';
    try {
      recoveryKey = (await createLockedEncryptionRecoveryKey({ lockedEncryptionRecoveryKeyDto: { secret } }))
        .recoveryKey;
      secret = '';
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('frameleaf_le_new_key_failed');
      secret = '';
    } finally {
      working = false;
    }
  };
  const requestClose = () => {
    if (!recoveryKey || saved) {
      open = false;
    }
  };
</script>

<Dialog
  title={recoveryKey ? $t('frameleaf_le_on_recovery_title') : $t('frameleaf_le_new_key_title')}
  closeLabel={$t('close')}
  bind:open
  onRequestClose={requestClose}
>
  <div class="le-form">
    {#if recoveryKey}
      <p>{$t(advanced ? 'frameleaf_le_on_recovery_body_passphrase' : 'frameleaf_le_on_recovery_body_pin')}</p>
      <RecoveryKeyBox {recoveryKey} bind:saved />
    {:else}
      <p>{$t('frameleaf_le_new_key_body')}</p>
      <SecretField kind={advanced ? 'passphrase' : 'pin'} bind:value={secret} autofocus disabled={working} />
      {#if error}
        <p class="le-error" role="alert">{error}</p>
      {/if}
    {/if}
  </div>
  {#snippet actions()}
    {#if recoveryKey}
      <Button variant="primary" disabled={!saved} onclick={() => (open = false)}>{$t('frameleaf_le_done')}</Button>
    {:else}
      <Button disabled={working} onclick={() => (open = false)}>{$t('frameleaf_le_cancel')}</Button>
      <Button variant="primary" disabled={working || !ready} onclick={() => void make()}>
        {$t('frameleaf_le_new_key_make')}
      </Button>
    {/if}
  {/snippet}
</Dialog>
