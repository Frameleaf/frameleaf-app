<script lang="ts">
  /**
   * FL-831: Move to a new phone, in three steps (the FL-776 prototype's `Move`): 1 the password and a
   * code from the old phone (or a recovery code if it's gone), 2 scan a new code with the new phone,
   * 3 a code from the new phone, which swaps it in. The old phone works until the last step, so a
   * half-finished move never locks anyone out; recovery codes and trusted browsers stay as they are.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import TextLink from '$lib/components/frameleaf/settings/kit/TextLink.svelte';
  import TwoStepCodeField from '$lib/components/frameleaf/access/two-step/TwoStepCodeField.svelte';
  import TwoStepError from '$lib/components/frameleaf/access/two-step/TwoStepError.svelte';
  import TwoStepPasswordField from '$lib/components/frameleaf/access/two-step/TwoStepPasswordField.svelte';
  import TwoStepScan from '$lib/components/frameleaf/access/two-step/TwoStepScan.svelte';
  import { isCode, isRecoveryCode, twoStepRefusal } from '$lib/frameleaf/two-step';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { confirmTwoFactorMove, startTwoFactorMove, type TwoFactorSetupResponseDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  import '$lib/frameleaf/two-step.css';

  let { onClose }: { onClose: (moved?: boolean) => void } = $props();

  let open = $state(true);
  let step = $state<1 | 2 | 3>(1);
  let password = $state('');
  let code = $state('');
  let recovery = $state(false);
  let working = $state(false);
  let wrong = $state(false);
  let error = $state('');
  let key = $state<TwoFactorSetupResponseDto>();
  let moved = false;
  const ids = $props.id();
  const ready = $derived(!!password && (recovery ? isRecoveryCode(code) : isCode(code)));
  const title = $derived(
    {
      1: $t('frameleaf_two_step_move_title'),
      2: $t('frameleaf_two_step_move_scan_title'),
      3: $t('frameleaf_two_step_move_confirm_title'),
    }[step],
  );

  $effect(() => {
    if (!open) {
      password = '';
      onClose(moved);
    }
  });

  const problem = (error_: unknown) => {
    const refusal = twoStepRefusal(error_);
    return refusal?.kind === 'locked'
      ? $t('frameleaf_two_step_wait', { values: { minutes: refusal.minutes } })
      : (getServerErrorMessage(error_) ?? $t('frameleaf_two_step_failed'));
  };

  const check = async () => {
    if (!ready || working) {
      return;
    }
    working = true;
    error = '';
    try {
      key = await startTwoFactorMove({
        twoFactorProofDto: { password, ...(recovery ? { recoveryCode: code } : { code }) },
      });
      password = '';
      code = '';
      step = 2;
    } catch (error_) {
      error = problem(error_);
      code = '';
    } finally {
      working = false;
    }
  };

  const finish = async () => {
    if (!isCode(code) || working) {
      return;
    }
    working = true;
    error = '';
    wrong = false;
    try {
      await confirmTwoFactorMove({ twoFactorCodeDto: { code } });
      moved = true;
      open = false;
    } catch (error_) {
      if (twoStepRefusal(error_)?.kind === 'wrong') {
        wrong = true;
      } else {
        error = problem(error_);
      }
      code = '';
    } finally {
      working = false;
    }
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (step === 1) {
      void check();
    } else if (step === 3) {
      void finish();
    }
  };
</script>

<Dialog
  {title}
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
  <form class="ts-dialog" onsubmit={submit} novalidate>
    <span class="ts-step">{$t('frameleaf_two_step_step', { values: { number: step, count: 3 } })}</span>
    {#if step === 1}
      <p>{$t('frameleaf_two_step_move_intro')}</p>
      <TwoStepPasswordField bind:value={password} />
      {#key recovery}
        <TwoStepCodeField bind:value={code} {recovery} />
      {/key}
      {#if error}<TwoStepError message={error} />{/if}
      <TextLink onclick={() => ((recovery = !recovery), (code = ''))}
        >{recovery ? $t('frameleaf_two_step_move_use_app') : $t('frameleaf_two_step_move_use_recovery')}</TextLink
      >
    {:else if step === 2 && key}
      <p>{$t('frameleaf_two_step_move_scan_intro')}</p>
      <TwoStepScan otpauthUri={key.otpauthUri} secret={key.secret} />
    {:else if step === 3}
      <p>{$t('frameleaf_two_step_move_confirm_intro')}</p>
      {#if wrong}
        <TwoStepError id="{ids}-wrong" message={$t('frameleaf_two_step_move_wrong')} />
      {/if}
      <TwoStepCodeField
        bind:value={code}
        autofocus
        invalid={wrong && !code}
        describedBy={wrong ? `${ids}-wrong` : undefined}
      />
      {#if error}<TwoStepError message={error} />{/if}
      <p class="ts-quiet">{$t('frameleaf_two_step_move_note')}</p>
    {/if}
  </form>
  {#snippet actions()}
    {#if step === 1}
      <Button disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={!ready || working} onclick={() => void check()}
        >{$t('frameleaf_two_step_continue')}</Button
      >
    {:else if step === 2}
      <Button onclick={() => (step = 1)}>{$t('frameleaf_two_step_back')}</Button>
      <Button variant="primary" onclick={() => (step = 3)}>{$t('frameleaf_two_step_added')}</Button>
    {:else}
      <Button disabled={working} onclick={() => ((step = 2), (wrong = false), (error = ''))}
        >{$t('frameleaf_two_step_back')}</Button
      >
      <Button variant="primary" disabled={!isCode(code) || working} onclick={() => void finish()}
        >{$t('frameleaf_two_step_move_finish')}</Button
      >
    {/if}
  {/snippet}
</Dialog>
