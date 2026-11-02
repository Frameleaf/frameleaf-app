<script lang="ts">
  /**
   * FL-721: turning Locked encryption on (prototype `TurnOn`): how the files are protected, a
   * passphrase for Advanced Security, the two confirmations, the PIN that starts it, and the recovery
   * key the server returns once.
   *
   * The prototype shows the recovery key before the confirmations. The server makes the key in the
   * same request that turns encryption on (spec §7.1, §10), so here it comes last, straight after
   * "Encrypt now", and the dialog can't be closed until "I’ve saved my recovery key…" is ticked.
   */
  import Choice from '$lib/components/frameleaf/settings/kit/Choice.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PinCells from '$lib/components/frameleaf/PinCells.svelte';
  import RecoveryKeyBox from '$lib/components/frameleaf/settings/security/locked-encryption/RecoveryKeyBox.svelte';
  import NewPassphraseFields from '$lib/components/frameleaf/settings/security/locked-encryption/NewPassphraseFields.svelte';
  import { passphraseReady } from '$lib/frameleaf/locked-encryption';
  import { isCompletePin } from '$lib/frameleaf/personal-access';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { enableLockedEncryption, LockedEncryptionMode } from '@frameleaf/sdk';
  import { mdiAlertOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import './locked-encryption.css';

  type Step = 'how' | 'passphrase' | 'check' | 'confirm' | 'recovery';

  let {
    items,
    onClose,
  }: {
    /** "223 Locked items", or "your Locked photos and videos" while the count isn't known. */
    items?: string;
    onClose: (result?: { mode: LockedEncryptionMode }) => void;
  } = $props();

  let open = $state(true);
  let step = $state<Step>('how');
  let mode = $state<LockedEncryptionMode>(LockedEncryptionMode.Pin);
  let phrase = $state('');
  let again = $state('');
  let lose = $state(false);
  let admin = $state(false);
  let pin = $state('');
  let saved = $state(false);
  let recoveryKey = $state('');
  let working = $state(false);
  let error = $state('');

  const advanced = $derived(mode === LockedEncryptionMode.Advanced);
  const what = $derived(items ?? $t('frameleaf_le_items_unknown'));
  const next: Record<Exclude<Step, 'confirm' | 'recovery'>, Step> = {
    how: 'passphrase',
    passphrase: 'check',
    check: 'confirm',
  };
  const goNext = () => {
    if (step === 'how') {
      step = advanced ? 'passphrase' : 'check';
    } else if (step === 'passphrase' || step === 'check') {
      step = next[step];
    }
  };
  const goBack = () => {
    switch (step) {
      case 'passphrase': {
        step = 'how';
        break;
      }
      case 'check': {
        step = advanced ? 'passphrase' : 'how';
        break;
      }
      case 'confirm': {
        step = 'check';
        break;
      }
      case 'how':
      case 'recovery': {
        // The first step has no Back, and the recovery key step can't go back.
        break;
      }
    }
  };

  const ready = $derived(
    step === 'how'
      ? true
      : step === 'passphrase'
        ? passphraseReady(phrase, again)
        : step === 'check'
          ? lose && admin
          : step === 'confirm'
            ? isCompletePin(pin)
            : saved,
  );

  const titles = $derived<Record<Step, string>>({
    how: $t('frameleaf_le_on_how_title'),
    passphrase: $t('frameleaf_le_on_passphrase_title'),
    check: $t('frameleaf_le_on_check_title'),
    confirm: $t('frameleaf_le_on_confirm_title', { values: { items: what } }),
    recovery: $t('frameleaf_le_on_recovery_title'),
  });

  let result: { mode: LockedEncryptionMode } | undefined;
  $effect(() => {
    if (open) {
      return;
    }
    phrase = '';
    again = '';
    pin = '';
    recoveryKey = '';
    onClose(result);
  });

  const encrypt = async () => {
    if (working || !isCompletePin(pin)) {
      return;
    }
    working = true;
    error = '';
    try {
      const response = await enableLockedEncryption({
        lockedEncryptionEnableDto: advanced ? { mode, pinCode: pin, passphrase: phrase } : { mode, pinCode: pin },
      });
      recoveryKey = response.recoveryKey;
      result = { mode };
      pin = '';
      phrase = '';
      again = '';
      step = 'recovery';
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('frameleaf_le_on_failed');
      pin = '';
    } finally {
      working = false;
    }
  };

  // The recovery key is shown once: the dialog stays until it is saved.
  const requestClose = () => {
    if (step !== 'recovery' || saved) {
      open = false;
    }
  };
</script>

<Dialog title={titles[step]} closeLabel={$t('close')} size="medium" bind:open onRequestClose={requestClose}>
  <div class="le-form">
    {#if step === 'how'}
      <p>{$t('frameleaf_le_on_how_body')}</p>
      <Choice
        label={$t('frameleaf_le_on_how_label')}
        value={mode}
        options={[
          {
            value: LockedEncryptionMode.Pin,
            label: $t('frameleaf_le_mode_pin'),
            detail: $t('frameleaf_le_mode_pin_detail'),
          },
          {
            value: LockedEncryptionMode.Advanced,
            label: $t('frameleaf_le_mode_advanced'),
            detail: $t('frameleaf_le_mode_advanced_detail'),
          },
        ]}
        onChange={(value) => (mode = value as LockedEncryptionMode)}
      />
    {:else if step === 'passphrase'}
      <p>{$t('frameleaf_le_on_passphrase_body')}</p>
      <NewPassphraseFields bind:phrase bind:again />
    {:else if step === 'check'}
      <Notice tone="warn" icon={mdiAlertOutline} title={$t('frameleaf_le_on_check_notice_title')}>
        {$t(advanced ? 'frameleaf_le_on_check_notice_passphrase' : 'frameleaf_le_on_check_notice_pin', {
          values: { items: what },
        })}
      </Notice>
      <ul>
        <li>{$t('frameleaf_le_on_check_time')}</li>
        <li>{$t(advanced ? 'frameleaf_le_on_check_backups_passphrase' : 'frameleaf_le_on_check_backups_pin')}</li>
        <li>{$t('frameleaf_le_on_check_later')}</li>
      </ul>
      <label class="le-check">
        <input type="checkbox" bind:checked={lose} />
        {$t(advanced ? 'frameleaf_le_on_check_lose_passphrase' : 'frameleaf_le_on_check_lose_pin')}
      </label>
      <label class="le-check">
        <input type="checkbox" bind:checked={admin} />
        {$t('frameleaf_le_on_check_admin')}
      </label>
    {:else if step === 'confirm'}
      <p>{$t(advanced ? 'frameleaf_le_on_confirm_advanced' : 'frameleaf_le_on_confirm_pin')}</p>
      <div class="le-label">
        <span>{$t('frameleaf_le_locked_pin')}</span>
        <PinCells bind:value={pin} autofocus label={$t('frameleaf_le_locked_pin')} disabled={working} />
      </div>
      {#if error}
        <p class="le-error" role="alert">{error}</p>
      {/if}
    {:else}
      <p>{$t(advanced ? 'frameleaf_le_on_recovery_body_passphrase' : 'frameleaf_le_on_recovery_body_pin')}</p>
      <RecoveryKeyBox {recoveryKey} bind:saved />
    {/if}
  </div>
  {#snippet actions()}
    {#if step === 'how'}
      <Button onclick={() => (open = false)}>{$t('frameleaf_le_cancel')}</Button>
    {:else if step !== 'recovery'}
      <Button disabled={working} onclick={goBack}>{$t('frameleaf_le_back')}</Button>
    {/if}
    {#if step === 'confirm'}
      <Button variant="primary" disabled={working || !ready} onclick={() => void encrypt()}>
        {$t('frameleaf_le_encrypt_now')}
      </Button>
    {:else if step === 'recovery'}
      <Button variant="primary" disabled={!ready} onclick={() => (open = false)}>{$t('frameleaf_le_continue')}</Button>
    {:else}
      <Button variant="primary" disabled={!ready} onclick={goNext}>
        {step === 'check' ? $t('frameleaf_le_on_check_continue') : $t('frameleaf_le_continue')}
      </Button>
    {/if}
  {/snippet}
</Dialog>
