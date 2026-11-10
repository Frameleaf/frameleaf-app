<script lang="ts">
  /**
   * FL-859: Remove a passkey (the approved FL-767 prototype, `Passkeys.jsx`): a confirmation only, not
   * the password (owner, 2026-11-07). Removing the last one says the password is the way in again.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { removePasskey, type PasskeyResponseDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  import './passkeys.css';

  let { passkey, last, onClose }: { passkey: PasskeyResponseDto; last: boolean; onClose: (removed?: boolean) => void } =
    $props();

  let open = $state(true);
  let working = $state(false);
  let error = $state('');
  let removed = false;

  $effect(() => {
    if (!open) {
      onClose(removed);
    }
  });

  const remove = async () => {
    working = true;
    error = '';
    try {
      await removePasskey({ id: passkey.id });
      removed = true;
      open = false;
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('frameleaf_passkey_remove_failed');
    } finally {
      working = false;
    }
  };
</script>

<Dialog
  title={$t('frameleaf_passkey_remove_title', { values: { name: passkey.name } })}
  closeLabel={$t('close')}
  bind:open
>
  <div class="pk-dialog">
    <p>
      {$t('frameleaf_passkey_remove_body')}
      {#if last}{$t('frameleaf_passkey_remove_last_body')}{/if}
    </p>
    <p class="pk-quiet">{$t('frameleaf_passkey_remove_tidy', { values: { address: passkey.rpId } })}</p>
    {#if error}<p class="pk-quiet" role="alert">{error}</p>{/if}
  </div>
  {#snippet actions()}
    <Button disabled={working} onclick={() => (open = false)}>{$t('frameleaf_passkey_keep')}</Button>
    <Button variant="danger" disabled={working} onclick={() => void remove()}>{$t('frameleaf_passkey_remove')}</Button>
  {/snippet}
</Dialog>
