<script lang="ts">
  /**
   * Setting a PIN for the first time (FL-76). Entry uses the shared Frameleaf `PinCells`
   * control so it matches the sign-in PIN prompt and the Locked unlock dialog, which both
   * render this form when the account has no PIN yet. `setupPinCode` hashes the code server
   * side; the digits are cleared here as soon as it returns.
   */
  import PinCells from '$lib/components/frameleaf/PinCells.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { setupPinCode } from '@immich/sdk';
  import { Button, Field, Heading, toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';

  interface Props {
    onCreated?: (pinCode: string) => void;
    showLabel?: boolean;
  }

  let { onCreated, showLabel = true }: Props = $props();

  let newPinCode = $state('');
  let confirmPinCode = $state('');
  let isLoading = $state(false);
  let canSubmit = $derived(confirmPinCode.length === 6 && newPinCode === confirmPinCode);

  const handleSubmit = async (event: Event) => {
    event.preventDefault();
    await createPinCode();
  };

  const createPinCode = async () => {
    isLoading = true;
    try {
      await setupPinCode({ pinCodeSetupDto: { pinCode: newPinCode } });
      toastManager.primary($t('pin_code_setup_successfully'));
      onCreated?.(newPinCode);
      resetForm();
    } catch (error) {
      handleError(error, $t('unable_to_setup_pin_code'));
      // A rejected code never lingers client side.
      resetForm();
    } finally {
      isLoading = false;
    }
  };

  const resetForm = () => {
    newPinCode = '';
    confirmPinCode = '';
  };
</script>

<form autocomplete="off" onsubmit={handleSubmit}>
  <div class="flex flex-col place-content-center place-items-center gap-6">
    {#if showLabel}
      <Heading>{$t('setup_pin_code')}</Heading>
    {/if}
    <Field label={$t('new_pin_code')}>
      <PinCells bind:value={newPinCode} label={$t('new_pin_code')} disabled={isLoading} />
    </Field>
    <Field label={$t('confirm_new_pin_code')}>
      <PinCells
        bind:value={confirmPinCode}
        label={$t('confirm_new_pin_code')}
        error={confirmPinCode.length === 6 && newPinCode !== confirmPinCode}
        disabled={isLoading}
      />
    </Field>
  </div>

  <div class="mt-4 flex justify-end gap-2">
    <Button shape="round" color="secondary" type="button" size="small" onclick={resetForm}>
      {$t('clear')}
    </Button>
    <Button shape="round" type="submit" size="small" loading={isLoading} disabled={!canSubmit}>
      {$t('create')}
    </Button>
  </div>
</form>
