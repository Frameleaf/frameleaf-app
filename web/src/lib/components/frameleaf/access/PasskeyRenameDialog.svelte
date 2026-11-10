<script lang="ts">
  /** FL-859: Rename passkey (the approved FL-767 prototype, `Passkeys.jsx`). */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { PASSKEY_NAME_LENGTH, cleanName } from '$lib/frameleaf/passkeys';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { updatePasskey, type PasskeyResponseDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  import './passkeys.css';

  let { passkey, onClose }: { passkey: PasskeyResponseDto; onClose: (renamed?: PasskeyResponseDto) => void } = $props();

  let open = $state(true);
  let name = $state(passkey.name);
  let working = $state(false);
  let error = $state('');
  let renamed: PasskeyResponseDto | undefined;

  $effect(() => {
    if (!open) {
      onClose(renamed);
    }
  });

  const save = async (event?: SubmitEvent) => {
    event?.preventDefault();
    const chosen = name.trim();
    if (!chosen || working) {
      return;
    }
    working = true;
    error = '';
    try {
      renamed = await updatePasskey({ id: passkey.id, passkeyUpdateDto: { name: chosen } });
      open = false;
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('frameleaf_passkey_rename_failed');
    } finally {
      working = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_passkey_rename_title')} closeLabel={$t('close')} bind:open>
  <form class="pk-dialog" onsubmit={save}>
    <label class="pk-field">
      {$t('frameleaf_passkey_name')}
      <small>{$t('frameleaf_passkey_name_hint')}</small>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        autofocus
        maxlength={PASSKEY_NAME_LENGTH}
        value={name}
        disabled={working}
        oninput={(event) => (name = cleanName(event.currentTarget.value))}
      />
    </label>
    {#if error}<p class="pk-quiet" role="alert">{error}</p>{/if}
  </form>
  {#snippet actions()}
    <Button disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
    <Button variant="primary" disabled={!name.trim() || working} onclick={() => void save()}>{$t('save')}</Button>
  {/snippet}
</Dialog>
