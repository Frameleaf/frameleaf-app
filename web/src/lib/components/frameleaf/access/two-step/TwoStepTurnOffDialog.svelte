<script lang="ts">
  /**
   * FL-831: Turn off two-step sign-in (the FL-776 prototype's `TurnOff`): the password and a code from
   * the authenticator app, or a recovery code, so nobody can turn it off from a browser left signed in.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import TextLink from '$lib/components/frameleaf/settings/kit/TextLink.svelte';
  import TwoStepCodeField from '$lib/components/frameleaf/access/two-step/TwoStepCodeField.svelte';
  import TwoStepError from '$lib/components/frameleaf/access/two-step/TwoStepError.svelte';
  import TwoStepPasswordField from '$lib/components/frameleaf/access/two-step/TwoStepPasswordField.svelte';
  import { isCode, isRecoveryCode, twoStepRefusal } from '$lib/frameleaf/two-step';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { disableTwoFactor } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  import '$lib/frameleaf/two-step.css';

  let { onClose }: { onClose: (turnedOff?: boolean) => void } = $props();

  let open = $state(true);
  let password = $state('');
  let code = $state('');
  let recovery = $state(false);
  let working = $state(false);
  let error = $state('');
  let turnedOff = false;
  const ready = $derived(!!password && (recovery ? isRecoveryCode(code) : isCode(code)));

  $effect(() => {
    if (!open) {
      password = '';
      onClose(turnedOff);
    }
  });

  const turnOff = async (event?: SubmitEvent) => {
    event?.preventDefault();
    if (!ready || working) {
      return;
    }
    working = true;
    error = '';
    try {
      await disableTwoFactor({
        twoFactorProofDto: { password, ...(recovery ? { recoveryCode: code } : { code }) },
      });
      turnedOff = true;
      open = false;
    } catch (error_) {
      const refusal = twoStepRefusal(error_);
      error =
        refusal?.kind === 'locked'
          ? $t('frameleaf_two_step_wait', { values: { minutes: refusal.minutes } })
          : (getServerErrorMessage(error_) ?? $t('frameleaf_two_step_failed'));
      code = '';
    } finally {
      working = false;
    }
  };
</script>

<Dialog
  title={$t('frameleaf_two_step_off_title')}
  closeLabel={$t('close')}
  size="medium"
  bind:open
  onRequestClose={() => {
    // Not while the server is answering: the change would happen with nobody told.
    if (!working) {
      open = false;
    }
  }}
>
  <form class="ts-dialog" onsubmit={turnOff} novalidate>
    <p>{$t('frameleaf_two_step_off_body')}</p>
    <TwoStepPasswordField bind:value={password} />
    {#key recovery}
      <TwoStepCodeField bind:value={code} {recovery} />
    {/key}
    {#if error}<TwoStepError message={error} />{/if}
    <TextLink onclick={() => ((recovery = !recovery), (code = ''))}
      >{recovery ? $t('frameleaf_two_step_off_use_app') : $t('frameleaf_two_step_off_use_recovery')}</TextLink
    >
  </form>
  {#snippet actions()}
    <Button disabled={working} onclick={() => (open = false)}>{$t('frameleaf_two_step_keep_on')}</Button>
    <Button variant="danger" disabled={!ready || working} onclick={() => void turnOff()}
      >{$t('frameleaf_two_step_turn_off')}</Button
    >
  {/snippet}
</Dialog>
