<script lang="ts">
  /**
   * Changing your own PIN (FL-76). Entry uses the shared Frameleaf `PinCells` control, the
   * same six digit cells the sign-in PIN prompt and the Locked unlock dialog use, so a PIN is
   * entered and pasted identically everywhere in the product. The endpoint is unchanged:
   * `changePinCode` verifies the current PIN server side and hashes the new one.
   *
   * None of the three codes leaves this component: they are sent once and the form is cleared
   * on success and on failure alike, and nothing here logs or persists them.
   */
  import PinCells from '$lib/components/frameleaf/PinCells.svelte';
  import PinCodeResetModal from '$lib/modals/PinCodeResetModal.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { changePinCode } from '@immich/sdk';
  import { Button, Field, Heading, modalManager, Text, toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';

  let currentPinCode = $state('');
  let newPinCode = $state('');
  let confirmPinCode = $state('');
  let isLoading = $state(false);
  let canSubmit = $derived(currentPinCode.length === 6 && confirmPinCode.length === 6 && newPinCode === confirmPinCode);

  const handleSubmit = async (event: Event) => {
    event.preventDefault();
    await handleChangePinCode();
  };

  const handleChangePinCode = async () => {
    isLoading = true;
    try {
      await changePinCode({ pinCodeChangeDto: { pinCode: currentPinCode, newPinCode } });
      resetForm();
      toastManager.primary($t('pin_code_changed_successfully'));
    } catch (error) {
      handleError(error, $t('unable_to_change_pin_code'));
      // A rejected code never lingers client side.
      resetForm();
    } finally {
      isLoading = false;
    }
  };

  const resetForm = () => {
    currentPinCode = '';
    newPinCode = '';
    confirmPinCode = '';
  };
</script>

<form autocomplete="off" onsubmit={handleSubmit}>
  <div class="flex flex-col place-content-center place-items-center gap-6">
    <Heading>{$t('change_pin_code')}</Heading>
    <Field label={$t('current_pin_code')}>
      <PinCells bind:value={currentPinCode} label={$t('current_pin_code')} disabled={isLoading} />
    </Field>
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
    <button type="button" onclick={() => modalManager.show(PinCodeResetModal, {})}>
      <Text color="muted" class="underline" size="small">{$t('forgot_pin_code_question')}</Text>
    </button>
  </div>

  <div class="mt-4 flex justify-end gap-2">
    <Button shape="round" color="secondary" type="button" size="small" onclick={resetForm}>
      {$t('clear')}
    </Button>
    <Button shape="round" type="submit" size="small" loading={isLoading} disabled={!canSubmit}>
      {$t('save')}
    </Button>
  </div>
</form>
