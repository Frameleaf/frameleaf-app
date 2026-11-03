<script lang="ts">
  /**
   * FL-721: turning Locked encryption off (prototype `TurnOff`): what changes, then the PIN or
   * passphrase that starts decrypting (`disableLockedEncryption`, spec §7.4).
   */
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PinCells from '$lib/components/frameleaf/PinCells.svelte';
  import { isCompletePin } from '$lib/frameleaf/personal-access';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { disableLockedEncryption, LockedEncryptionMode } from '@frameleaf/sdk';
  import { mdiAlertOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import './locked-encryption.css';

  let {
    mode,
    items,
    onClose,
  }: {
    mode: LockedEncryptionMode;
    items?: string;
    onClose: (turnedOff?: boolean) => void;
  } = $props();

  let open = $state(true);
  let step = $state<'check' | 'confirm'>('check');
  let sure = $state(false);
  let secret = $state('');
  let working = $state(false);
  let error = $state('');
  let turnedOff = false;

  const advanced = $derived(mode === LockedEncryptionMode.Advanced);
  const what = $derived(items ?? $t('frameleaf_le_items_unknown'));
  const ready = $derived(advanced ? secret.length > 0 : isCompletePin(secret));

  $effect(() => {
    if (open) {
      return;
    }
    secret = '';
    onClose(turnedOff);
  });

  const decrypt = async () => {
    if (working || !ready) {
      return;
    }
    working = true;
    error = '';
    try {
      await disableLockedEncryption({
        lockedEncryptionDisableDto: advanced ? { passphrase: secret } : { pinCode: secret },
      });
      turnedOff = true;
      open = false;
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('frameleaf_le_off_failed');
      secret = '';
    } finally {
      working = false;
    }
  };
</script>

<Dialog
  title={step === 'check'
    ? $t('frameleaf_le_off_check_title')
    : $t('frameleaf_le_off_confirm_title', { values: { items: what } })}
  closeLabel={$t('close')}
  size="medium"
  bind:open
>
  <div class="le-form">
    {#if step === 'check'}
      <Notice tone="warn" icon={mdiAlertOutline} title={$t('frameleaf_le_off_notice_title')}>
        {$t('frameleaf_le_off_notice_body')}
      </Notice>
      <ul>
        <li>{$t('frameleaf_le_off_time')}</li>
        <li>{$t('frameleaf_le_off_recovery')}</li>
        <li>{$t('frameleaf_le_off_backups')}</li>
        <li>{$t('frameleaf_le_off_admin')}</li>
      </ul>
      <label class="le-check">
        <input type="checkbox" bind:checked={sure} />
        {$t('frameleaf_le_off_sure')}
      </label>
    {:else}
      <form
        class="le-form"
        autocomplete="off"
        onsubmit={(event) => {
          event.preventDefault();
          void decrypt();
        }}
      >
        <p>{$t(advanced ? 'frameleaf_le_off_confirm_passphrase' : 'frameleaf_le_off_confirm_pin')}</p>
        {#if advanced}
          <label>
            {$t('frameleaf_le_passphrase')}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="le-text"
              type="password"
              autocomplete="current-password"
              maxlength={1024}
              placeholder={$t('frameleaf_le_passphrase')}
              autofocus
              disabled={working}
              bind:value={secret}
            />
          </label>
        {:else}
          <div class="le-label">
            <span>{$t('frameleaf_le_locked_pin')}</span>
            <PinCells bind:value={secret} autofocus label={$t('frameleaf_le_locked_pin')} disabled={working} />
          </div>
        {/if}
        {#if error}
          <p class="le-error" role="alert">{error}</p>
        {/if}
      </form>
    {/if}
  </div>
  {#snippet actions()}
    {#if step === 'confirm'}
      <Button disabled={working} onclick={() => (step = 'check')}>{$t('frameleaf_le_back')}</Button>
      <Button variant="danger" disabled={working || !ready} onclick={() => void decrypt()}>
        {$t('frameleaf_le_off_decrypt')}
      </Button>
    {:else}
      <Button onclick={() => (open = false)}>{$t('frameleaf_le_off_keep')}</Button>
      <Button variant="primary" disabled={!sure} onclick={() => (step = 'confirm')}
        >{$t('frameleaf_le_continue')}</Button
      >
    {/if}
  {/snippet}
</Dialog>
