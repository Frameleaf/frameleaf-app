<script lang="ts">
  /**
   * FL-721: what opening Locked asks when the key isn't open (prototype `AfterRestart`, spec §7.6).
   *
   * - `own`, Advanced Security: the passphrase, after a restart or the ask-again time
   *   (`unlockLockedEncryption`).
   * - `own`, PIN mode: the Locked PIN, which loads the key as it unlocks the session (`unlockAuthSession`).
   * - `finishing`: the same, while turning off waits for it after a restart (spec §4.3).
   * - `partner`: "Type Taylor’s passphrase", a partner's item protected by Advanced Security (spec §6.2,
   *   `unlockPartnerLockedEncryption`).
   *
   * Nothing typed here outlives the dialog, and a refused secret is cleared at once.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PinCells from '$lib/components/frameleaf/PinCells.svelte';
  import { isCompletePin } from '$lib/frameleaf/personal-access';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    LockedEncryptionMode,
    unlockAuthSession,
    unlockLockedEncryption,
    unlockPartnerLockedEncryption,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiInformationOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import './locked-encryption.css';

  type Props = {
    kind: 'own' | 'partner';
    /** Own key: what opens it. */
    mode?: LockedEncryptionMode;
    /** Own key: turning off is waiting for it. */
    finishing?: boolean;
    askAgainHours?: number | null;
    /** Partner: whose passphrase. */
    ownerId?: string;
    ownerName?: string;
    onClose: (unlocked?: boolean) => void;
  };

  let {
    kind,
    mode = LockedEncryptionMode.Advanced,
    finishing = false,
    askAgainHours = 72,
    ownerId = '',
    ownerName = '',
    onClose,
  }: Props = $props();

  let open = $state(true);
  let secret = $state('');
  let working = $state(false);
  let error = $state('');
  let unlocked = false;

  const pin = $derived(kind === 'own' && mode === LockedEncryptionMode.Pin);
  const ready = $derived(pin ? isCompletePin(secret) : secret.length > 0);

  const title = $derived(
    kind === 'partner'
      ? $t('frameleaf_le_partner_title', { values: { name: ownerName } })
      : finishing
        ? $t(pin ? 'frameleaf_le_finish_title_pin' : 'frameleaf_le_finish_title_passphrase')
        : $t(pin ? 'frameleaf_le_pin_prompt_title' : 'frameleaf_le_restart_title'),
  );
  const body = $derived.by(() => {
    if (kind === 'partner') {
      return $t('frameleaf_le_partner_body', { values: { name: ownerName } });
    }
    if (finishing) {
      return $t('frameleaf_le_finish_body');
    }
    if (pin) {
      return $t('frameleaf_le_pin_prompt_body');
    }
    const again =
      askAgainHours === null
        ? $t('frameleaf_le_restart_again_restart')
        : $t('frameleaf_le_restart_again_hours', { values: { hours: askAgainHours } });
    return `${$t('frameleaf_le_restart_body')} ${again}`;
  });

  $effect(() => {
    if (open) {
      return;
    }
    secret = '';
    onClose(unlocked);
  });

  const send = async () => {
    if (kind === 'partner') {
      await unlockPartnerLockedEncryption({ lockedEncryptionPartnerUnlockDto: { ownerId, passphrase: secret } });
    } else if (pin) {
      await unlockAuthSession({ sessionUnlockDto: { pinCode: secret } });
    } else {
      await unlockLockedEncryption({ lockedEncryptionUnlockDto: { passphrase: secret } });
    }
  };

  const submit = async (event?: Event) => {
    event?.preventDefault();
    if (working || !ready) {
      return;
    }
    working = true;
    error = '';
    try {
      await send();
      unlocked = true;
      open = false;
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('frameleaf_le_unlock_failed');
      secret = '';
    } finally {
      working = false;
    }
  };
</script>

<Dialog {title} closeLabel={$t('close')} bind:open>
  <form class="le-form" autocomplete="off" onsubmit={submit}>
    <p>{body}</p>
    {#if pin}
      <div class="le-label">
        <span>{$t('frameleaf_le_locked_pin')}</span>
        <PinCells bind:value={secret} autofocus label={$t('frameleaf_le_locked_pin')} disabled={working} />
      </div>
    {:else}
      <label>
        {$t('frameleaf_le_passphrase')}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="le-text"
          type="password"
          autocomplete="current-password"
          placeholder={$t('frameleaf_le_passphrase')}
          maxlength={1024}
          autofocus
          disabled={working}
          bind:value={secret}
        />
      </label>
    {/if}
    {#if error}
      <p class="le-error" role="alert">{error}</p>
    {/if}
    {#if kind === 'own' && !pin}
      <p class="le-note">
        <Icon icon={mdiInformationOutline} size="14" aria-hidden />
        <span>{$t('frameleaf_le_restart_forgot')}</span>
      </p>
    {/if}
  </form>
  {#snippet actions()}
    <Button disabled={working} onclick={() => (open = false)}>{$t('frameleaf_le_not_now')}</Button>
    <Button variant="primary" disabled={working || !ready} onclick={() => void submit()}>
      {$t('frameleaf_le_unlock')}
    </Button>
  {/snippet}
</Dialog>
