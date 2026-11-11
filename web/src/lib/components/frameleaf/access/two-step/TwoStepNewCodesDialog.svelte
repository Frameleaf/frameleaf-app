<script lang="ts">
  /**
   * FL-831: Make new recovery codes (the FL-776 prototype's `NewCodes`): the password, then ten new
   * codes shown this once. Every old code stops working; the authenticator app doesn't change.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import TwoStepError from '$lib/components/frameleaf/access/two-step/TwoStepError.svelte';
  import TwoStepPasswordField from '$lib/components/frameleaf/access/two-step/TwoStepPasswordField.svelte';
  import TwoStepRecoveryCodes from '$lib/components/frameleaf/access/two-step/TwoStepRecoveryCodes.svelte';
  import { RECOVERY_CODE_COUNT, twoStepRefusal } from '$lib/frameleaf/two-step';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { regenerateRecoveryCodes } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  import '$lib/frameleaf/two-step.css';

  let { onClose }: { onClose: (made?: boolean) => void } = $props();

  let open = $state(true);
  let password = $state('');
  let codes = $state<string[]>([]);
  let saved = $state(false);
  let working = $state(false);
  let error = $state('');
  let said = $state('');
  const shown = $derived(codes.length > 0);

  $effect(() => {
    if (!open) {
      password = '';
      onClose(shown);
      codes = [];
    }
  });

  const make = async (event?: SubmitEvent) => {
    event?.preventDefault();
    if (!password || working) {
      return;
    }
    working = true;
    error = '';
    try {
      ({ recoveryCodes: codes } = await regenerateRecoveryCodes({ twoFactorPasswordDto: { password } }));
      password = '';
    } catch (error_) {
      const refusal = twoStepRefusal(error_);
      error =
        refusal?.kind === 'locked'
          ? $t('frameleaf_two_step_wait', { values: { minutes: refusal.minutes } })
          : (getServerErrorMessage(error_) ?? $t('frameleaf_two_step_failed'));
    } finally {
      working = false;
    }
  };

  const requestClose = () => {
    if (shown && !saved) {
      said = $t('frameleaf_two_step_save_first');
      return;
    }
    if (!working) {
      open = false;
    }
  };
</script>

<Dialog
  title={shown ? $t('frameleaf_two_step_new_shown_title') : $t('frameleaf_two_step_new_title')}
  closeLabel={$t('close')}
  size="medium"
  bind:open
  onRequestClose={requestClose}
>
  <form class="ts-dialog" onsubmit={make} novalidate>
    <Said message={said} onDismiss={() => (said = '')} />
    {#if shown}
      <p>{$t('frameleaf_two_step_new_shown_body')}</p>
      <TwoStepRecoveryCodes {codes} bind:saved />
    {:else}
      <p>{$t('frameleaf_two_step_new_body', { values: { count: RECOVERY_CODE_COUNT } })}</p>
      <TwoStepPasswordField bind:value={password} invalid={!!error} />
      {#if error}<TwoStepError message={error} />{/if}
    {/if}
  </form>
  {#snippet actions()}
    {#if shown}
      <Button variant="primary" disabled={!saved} onclick={() => (open = false)}>{$t('frameleaf_two_step_done')}</Button
      >
    {:else}
      <Button disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={!password || working} onclick={() => void make()}
        >{$t('frameleaf_two_step_new_make')}</Button
      >
    {/if}
  {/snippet}
</Dialog>
