<script lang="ts">
  /**
   * FL-831: Turn on two-step sign-in, in four steps (the FL-776 prototype's `Setup`): 1 what it is and
   * the password, 2 scan the QR code (or type the key), 3 a code from the app, which turns it on, and
   * 4 the ten recovery codes, shown this once. Done waits for "I saved them somewhere safe"; closing
   * before that says to save them first.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Points from '$lib/components/frameleaf/settings/kit/Points.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import TwoStepCodeField from '$lib/components/frameleaf/access/two-step/TwoStepCodeField.svelte';
  import TwoStepError from '$lib/components/frameleaf/access/two-step/TwoStepError.svelte';
  import TwoStepPasswordField from '$lib/components/frameleaf/access/two-step/TwoStepPasswordField.svelte';
  import TwoStepRecoveryCodes from '$lib/components/frameleaf/access/two-step/TwoStepRecoveryCodes.svelte';
  import TwoStepScan from '$lib/components/frameleaf/access/two-step/TwoStepScan.svelte';
  import { RECOVERY_CODE_COUNT, TRUST_DAYS, isCode, twoStepRefusal } from '$lib/frameleaf/two-step';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { enableTwoFactor, setupTwoFactor, type TwoFactorSetupResponseDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  import '$lib/frameleaf/two-step.css';

  let { onClose }: { onClose: (turnedOn?: boolean) => void } = $props();

  let open = $state(true);
  let step = $state<1 | 2 | 3 | 4>(1);
  let password = $state('');
  let code = $state('');
  let error = $state('');
  let wrong = $state(false);
  let working = $state(false);
  let saved = $state(false);
  let said = $state('');
  let key = $state<TwoFactorSetupResponseDto>();
  let codes = $state<string[]>([]);
  const ids = $props.id();

  const title = $derived(
    {
      1: $t('frameleaf_two_step_setup_title'),
      2: $t('frameleaf_two_step_scan_title'),
      3: $t('frameleaf_two_step_confirm_title'),
      4: $t('frameleaf_two_step_codes_title'),
    }[step],
  );

  $effect(() => {
    if (!open) {
      password = '';
      onClose(step === 4);
      codes = [];
    }
  });

  const problem = (error_: unknown) => {
    const refusal = twoStepRefusal(error_);
    return refusal?.kind === 'locked'
      ? $t('frameleaf_two_step_wait', { values: { minutes: refusal.minutes } })
      : (getServerErrorMessage(error_) ?? $t('frameleaf_two_step_failed'));
  };

  const start = async () => {
    if (!password || working) {
      return;
    }
    working = true;
    error = '';
    try {
      key = await setupTwoFactor({ twoFactorPasswordDto: { password } });
      password = '';
      step = 2;
    } catch (error_) {
      error = problem(error_);
    } finally {
      working = false;
    }
  };

  const confirm = async () => {
    if (!isCode(code) || working) {
      return;
    }
    working = true;
    error = '';
    wrong = false;
    try {
      ({ recoveryCodes: codes } = await enableTwoFactor({ twoFactorCodeDto: { code } }));
      step = 4;
    } catch (error_) {
      const refusal = twoStepRefusal(error_);
      if (refusal?.kind === 'wrong') {
        wrong = true;
      } else {
        error = problem(error_);
      }
      code = '';
    } finally {
      working = false;
    }
  };

  const requestClose = () => {
    if (step === 4 && !saved) {
      said = $t('frameleaf_two_step_save_first');
      return;
    }
    if (!working) {
      open = false;
    }
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (step === 1) {
      void start();
    } else if (step === 3) {
      void confirm();
    }
  };
</script>

<Dialog {title} closeLabel={$t('close')} size="medium" bind:open onRequestClose={requestClose}>
  <form class="ts-dialog" id="{ids}-form" onsubmit={submit} novalidate>
    <Said message={said} onDismiss={() => (said = '')} />
    <span class="ts-step">{$t('frameleaf_two_step_step', { values: { number: step, count: 4 } })}</span>
    {#if step === 1}
      <p>{$t('frameleaf_two_step_setup_intro')}</p>
      <Points
        rows={[
          { text: $t('frameleaf_two_step_setup_app') },
          { text: $t('frameleaf_two_step_setup_codes', { values: { count: RECOVERY_CODE_COUNT } }) },
          { text: $t('frameleaf_two_step_setup_trust', { values: { days: TRUST_DAYS } }) },
        ]}
      />
      <TwoStepPasswordField bind:value={password} invalid={!!error} />
      {#if error}<TwoStepError message={error} />{/if}
    {:else if step === 2 && key}
      <p>{$t('frameleaf_two_step_scan_intro')}</p>
      <TwoStepScan otpauthUri={key.otpauthUri} secret={key.secret} />
    {:else if step === 3}
      <p>{$t('frameleaf_two_step_confirm_intro')}</p>
      {#if wrong}
        <TwoStepError id="{ids}-wrong" message={$t('frameleaf_two_step_confirm_wrong')} />
      {/if}
      <TwoStepCodeField
        bind:value={code}
        autofocus
        invalid={wrong && !code}
        describedBy={wrong ? `${ids}-wrong` : undefined}
      />
      {#if error}<TwoStepError message={error} />{/if}
      <p class="ts-quiet">{$t('frameleaf_two_step_confirm_note')}</p>
    {:else if step === 4}
      <p>{$t('frameleaf_two_step_codes_intro')}</p>
      <TwoStepRecoveryCodes {codes} bind:saved />
    {/if}
  </form>

  {#snippet actions()}
    {#if step === 1}
      <Button disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={!password || working} onclick={() => void start()}
        >{$t('frameleaf_two_step_continue')}</Button
      >
    {:else if step === 2}
      <Button onclick={() => (step = 1)}>{$t('frameleaf_two_step_back')}</Button>
      <Button variant="primary" onclick={() => (step = 3)}>{$t('frameleaf_two_step_added')}</Button>
    {:else if step === 3}
      <Button disabled={working} onclick={() => ((step = 2), (wrong = false), (error = ''))}
        >{$t('frameleaf_two_step_back')}</Button
      >
      <Button variant="primary" disabled={!isCode(code) || working} onclick={() => void confirm()}
        >{$t('frameleaf_two_step_turn_on')}</Button
      >
    {:else}
      <Button variant="primary" disabled={!saved} onclick={() => (open = false)}>{$t('frameleaf_two_step_done')}</Button
      >
    {/if}
  {/snippet}
</Dialog>
