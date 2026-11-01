<script lang="ts">
  /**
   * FL-721 (prototype "Add a passphrase…", "Use my PIN instead…", "Change passphrase", spec §7.5):
   * changes only the key that opens the files; nothing is encrypted again (`updateLockedEncryption`).
   *
   * - `add-passphrase`: a new passphrase, then the PIN.
   * - `use-pin`: the passphrase, then the PIN, after saying a PIN can be guessed by someone with the disk.
   * - `change-passphrase`: the current passphrase, then a new one twice.
   */
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import NewPassphraseFields from '$lib/components/frameleaf/settings/security/locked-encryption/NewPassphraseFields.svelte';
  import SecretField from '$lib/components/frameleaf/settings/security/locked-encryption/SecretField.svelte';
  import { passphraseReady } from '$lib/frameleaf/locked-encryption';
  import { isCompletePin } from '$lib/frameleaf/personal-access';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { LockedEncryptionMode, updateLockedEncryption } from '@frameleaf/sdk';
  import { mdiAlertOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import './locked-encryption.css';

  type Change = 'add-passphrase' | 'use-pin' | 'change-passphrase';

  let { change, onClose }: { change: Change; onClose: (changed?: boolean) => void } = $props();

  let open = $state(true);
  let current = $state('');
  let pin = $state('');
  let phrase = $state('');
  let again = $state('');
  let working = $state(false);
  let error = $state('');
  let changed = false;

  const ready = $derived(
    change === 'add-passphrase'
      ? passphraseReady(phrase, again) && isCompletePin(pin)
      : change === 'use-pin'
        ? current.length > 0 && isCompletePin(pin)
        : current.length > 0 && passphraseReady(phrase, again),
  );
  const title = $derived(
    $t(
      change === 'add-passphrase'
        ? 'frameleaf_le_add_passphrase_title'
        : change === 'use-pin'
          ? 'frameleaf_le_use_pin_title'
          : 'frameleaf_le_change_passphrase_title',
    ),
  );

  $effect(() => {
    if (open) {
      return;
    }
    current = pin = phrase = again = '';
    onClose(changed);
  });

  const save = async () => {
    if (working || !ready) {
      return;
    }
    working = true;
    error = '';
    try {
      const lockedEncryptionUpdateDto =
        change === 'add-passphrase'
          ? { mode: LockedEncryptionMode.Advanced, newPassphrase: phrase, currentSecret: pin }
          : change === 'use-pin'
            ? { mode: LockedEncryptionMode.Pin, currentSecret: current, pinCode: pin }
            : { currentSecret: current, newPassphrase: phrase };
      await updateLockedEncryption({ lockedEncryptionUpdateDto });
      changed = true;
      open = false;
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('frameleaf_le_change_failed');
      current = pin = '';
    } finally {
      working = false;
    }
  };
</script>

<Dialog {title} closeLabel={$t('close')} bind:open>
  <div class="le-form">
    {#if change === 'add-passphrase'}
      <p>{$t('frameleaf_le_add_passphrase_body')}</p>
      <NewPassphraseFields bind:phrase bind:again disabled={working} />
      <SecretField kind="pin" bind:value={pin} disabled={working} />
    {:else if change === 'use-pin'}
      <Notice tone="warn" icon={mdiAlertOutline} title={$t('frameleaf_le_use_pin_notice_title')}>
        {$t('frameleaf_le_use_pin_notice_body')}
      </Notice>
      <SecretField kind="passphrase" bind:value={current} autofocus disabled={working} />
      <SecretField kind="pin" bind:value={pin} disabled={working} />
    {:else}
      <p>{$t('frameleaf_le_change_passphrase_body')}</p>
      <SecretField
        kind="passphrase"
        label={$t('frameleaf_le_current_passphrase')}
        bind:value={current}
        autofocus
        disabled={working}
      />
      <NewPassphraseFields bind:phrase bind:again disabled={working} />
    {/if}
    {#if error}
      <p class="le-error" role="alert">{error}</p>
    {/if}
  </div>
  {#snippet actions()}
    <Button disabled={working} onclick={() => (open = false)}>{$t('frameleaf_le_cancel')}</Button>
    <Button variant="primary" disabled={working || !ready} onclick={() => void save()}>{$t('frameleaf_le_save')}</Button
    >
  {/snippet}
</Dialog>
