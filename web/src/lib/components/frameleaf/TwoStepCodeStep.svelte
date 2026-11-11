<script lang="ts">
  /**
   * FL-831: the step after the password for an account with two-step sign-in (the approved FL-776
   * prototype, `src/TwoStepScreens.jsx` `TwoStepCode`). A 6-digit code from the authenticator app, or a
   * recovery code, with "Trust this browser for 30 days". It replaces the form when the sign-in
   * expired (5 minutes after the password), when signing in paused after too many wrong codes (with
   * the wait counted down), and after the last recovery code was used.
   *
   * The token from the password step is kept in memory only, never stored.
   */
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAccountCircleOutline,
    mdiAlertCircleOutline,
    mdiCellphoneKey,
    mdiInformationOutline,
    mdiKeyAlertOutline,
    mdiKeyOutline,
    mdiLockClock,
    mdiTimerSandComplete,
  } from '@mdi/js';
  import {
    LOCK_MINUTES,
    SIGN_IN_MINUTES,
    TRUST_DAYS,
    WRONG_CODES_ALLOWED,
    cleanCode,
    cleanRecoveryCode,
    isCode,
    isRecoveryCode,
    triesLeft,
    twoStepRefusal,
  } from '$lib/frameleaf/two-step';
  import { getAuthStatus, loginTwoFactor, type LoginResponseDto } from '@frameleaf/sdk';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import '$lib/frameleaf/two-step.css';

  let {
    email,
    twoFactorToken,
    onSignedIn,
    onBack,
  }: {
    email: string;
    twoFactorToken: string;
    /** Signed in. `makeCodes` when the person chose to make new recovery codes straight away. */
    onSignedIn: (user: LoginResponseDto, makeCodes?: boolean) => void;
    /** Back to the password, keeping the email. */
    onBack: () => void;
  } = $props();

  type Screen = 'form' | 'expired' | 'locked' | 'last-recovery';
  let screen = $state<Screen>('form');
  let recovery = $state(false);
  let code = $state('');
  let wrong = $state(0);
  let trust = $state(false);
  let busy = $state(false);
  let lost = $state(false);
  let failed = $state('');
  let lockedUntil = $state(0);
  let now = $state(Date.now());
  let signedIn: LoginResponseDto | undefined;
  let alive = true;

  const ids = $props.id();
  const valid = $derived(recovery ? isRecoveryCode(code) : isCode(code));
  const lockedFor = $derived(Math.max(0, Math.ceil((lockedUntil - now) / 60_000)));

  // The server ends the sign-in five minutes after the password; say so then rather than on the next try.
  const expiry = setTimeout(() => {
    if (screen === 'form' && !busy) {
      screen = 'expired';
    }
  }, SIGN_IN_MINUTES * 60_000);
  const clock = setInterval(() => (now = Date.now()), 15_000);
  onDestroy(() => {
    alive = false;
    clearTimeout(expiry);
    clearInterval(clock);
  });

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy || !valid) {
      return;
    }
    busy = true;
    failed = '';
    try {
      const user = await loginTwoFactor({
        loginTwoFactorDto: {
          twoFactorToken,
          ...(recovery ? { recoveryCode: code } : { code }),
          trustDevice: trust,
        },
      });
      if (!alive) {
        return;
      }
      if (recovery) {
        // The last recovery code is gone: offer to make new ones before carrying on.
        const status = await getAuthStatus().catch(() => undefined);
        if (alive && status?.twoFactorEnabled && status.recoveryCodesRemaining === 0) {
          signedIn = user;
          screen = 'last-recovery';
          return;
        }
      }
      onSignedIn(user);
    } catch (error) {
      if (!alive) {
        return;
      }
      const refusal = twoStepRefusal(error);
      const wait = refusal?.kind === 'locked' ? refusal.minutes : LOCK_MINUTES;
      code = '';
      switch (refusal?.kind) {
        case 'expired': {
          screen = 'expired';
          break;
        }
        case 'locked': {
          now = Date.now();
          lockedUntil = now + wait * 60_000;
          screen = 'locked';
          break;
        }
        case 'wrong': {
          wrong += 1;
          break;
        }
        default: {
          failed = $t('frameleaf_two_step_failed');
        }
      }
    } finally {
      if (alive) {
        busy = false;
      }
    }
  };

  const onInput = (event: Event & { currentTarget: HTMLInputElement }) => {
    const value = event.currentTarget.value;
    code = recovery ? cleanRecoveryCode(value) : cleanCode(value);
    event.currentTarget.value = code;
  };

  const switchKind = () => {
    recovery = !recovery;
    code = '';
    wrong = 0;
    failed = '';
  };

  const triesText = $derived.by(() => {
    const left = triesLeft(wrong);
    return left > 0 ? $t('frameleaf_two_step_tries_left', { values: { count: left, minutes: LOCK_MINUTES } }) : '';
  });
</script>

{#snippet who()}
  <div class="ts-who">
    <Icon icon={mdiAccountCircleOutline} size="20" aria-hidden />
    <span>{email}</span>
    <button type="button" class="auth-link" onclick={onBack}>{$t('frameleaf_two_step_not_you')}</button>
  </div>
{/snippet}

{#snippet lostPhone()}
  <button type="button" class="auth-link ts-lost" aria-expanded={lost} onclick={() => (lost = !lost)}
    >{$t('frameleaf_two_step_lost')}</button
  >
  {#if lost}
    <p class="auth-info">
      <Icon icon={mdiInformationOutline} size="16" /><span>{$t('frameleaf_two_step_lost_help')}</span>
    </p>
  {/if}
{/snippet}

{#if screen === 'expired'}
  <div class="auth-heading ts-heading">
    <span class="ts-mark is-warn"><Icon icon={mdiTimerSandComplete} size="26" aria-hidden /></span>
    <h1>{$t('frameleaf_two_step_expired_title')}</h1>
    <p>{$t('frameleaf_two_step_expired_body', { values: { minutes: SIGN_IN_MINUTES } })}</p>
  </div>
  <div class="auth-card ts-card">
    {@render who()}
    <button type="button" class="button primary auth-submit" onclick={onBack}
      >{$t('frameleaf_two_step_expired_action')}</button
    >
  </div>
{:else if screen === 'locked'}
  <div class="auth-heading ts-heading">
    <span class="ts-mark is-bad"><Icon icon={mdiLockClock} size="26" aria-hidden /></span>
    <h1>{$t('frameleaf_two_step_locked_title')}</h1>
    <p>
      {$t('frameleaf_two_step_locked_body', {
        values: { minutes: Math.max(1, lockedFor), count: WRONG_CODES_ALLOWED },
      })}
    </p>
  </div>
  <div class="auth-card ts-card">
    {@render who()}
    <p class="auth-info">
      <Icon icon={mdiInformationOutline} size="16" /><span>{$t('frameleaf_two_step_locked_clock')}</span>
    </p>
    <button type="button" class="button auth-submit" disabled={lockedFor > 0} onclick={onBack}
      >{lockedFor > 0
        ? $t('frameleaf_two_step_locked_wait', { values: { minutes: lockedFor } })
        : $t('frameleaf_two_step_locked_ready')}</button
    >
    {@render lostPhone()}
  </div>
{:else if screen === 'last-recovery'}
  <div class="auth-heading ts-heading">
    <span class="ts-mark is-warn"><Icon icon={mdiKeyAlertOutline} size="26" aria-hidden /></span>
    <h1>{$t('frameleaf_two_step_last_title')}</h1>
    <p>{$t('frameleaf_two_step_last_body')}</p>
  </div>
  <div class="auth-card ts-card">
    <button type="button" class="button primary auth-submit" onclick={() => signedIn && onSignedIn(signedIn, true)}
      >{$t('frameleaf_two_step_last_make')}</button
    >
    <button type="button" class="button auth-submit" onclick={() => signedIn && onSignedIn(signedIn)}
      >{$t('frameleaf_two_step_not_now')}</button
    >
    <p class="ts-quiet">{$t('frameleaf_two_step_last_note')}</p>
  </div>
{:else}
  <div class="auth-heading ts-heading">
    <span class="ts-mark"><Icon icon={recovery ? mdiKeyOutline : mdiCellphoneKey} size="26" aria-hidden /></span>
    <h1>{recovery ? $t('frameleaf_two_step_recovery_title') : $t('frameleaf_two_step_code_title')}</h1>
    <p>{recovery ? $t('frameleaf_two_step_recovery_body') : $t('frameleaf_two_step_code_body')}</p>
  </div>
  <form class="auth-card ts-card" onsubmit={submit} novalidate>
    {@render who()}
    {#if wrong > 0}
      <p class="auth-error" role="alert" id="{ids}-error">
        <Icon icon={mdiAlertCircleOutline} size="16" /><span
          >{recovery ? $t('frameleaf_two_step_wrong_recovery') : $t('frameleaf_two_step_wrong')}
          {triesText}</span
        >
      </p>
    {:else if failed}
      <p class="auth-error" role="alert" id="{ids}-error">
        <Icon icon={mdiAlertCircleOutline} size="16" /><span>{failed}</span>
      </p>
    {/if}
    <div class="auth-field">
      <label for="{ids}-code"
        >{recovery ? $t('frameleaf_two_step_recovery_label') : $t('frameleaf_two_step_code_label')}</label
      >
      {#key recovery}
        <!-- svelte-ignore a11y_autofocus (the only field on this step) -->
        <input
          id="{ids}-code"
          name={recovery ? 'recovery-code' : 'one-time-code'}
          class="ts-code"
          class:is-recovery={recovery}
          autofocus
          inputmode={recovery ? 'text' : 'numeric'}
          autocomplete={recovery ? 'off' : 'one-time-code'}
          autocapitalize="none"
          spellcheck={false}
          placeholder={recovery ? 'xxxxx-xxxxx' : '000000'}
          value={code}
          aria-invalid={(wrong > 0 && !code) || undefined}
          aria-describedby={wrong > 0 || failed ? `${ids}-error` : undefined}
          oninput={onInput}
        />
      {/key}
    </div>
    <label class="auth-check ts-trust">
      <input type="checkbox" bind:checked={trust} />
      <span>
        {$t('frameleaf_two_step_trust', { values: { days: TRUST_DAYS } })}
        <small>{$t('frameleaf_two_step_trust_hint')}</small>
      </span>
    </label>
    <button type="submit" class="button primary auth-submit" disabled={!valid || busy}
      >{busy ? $t('frameleaf_two_step_checking') : $t('frameleaf_two_step_continue')}</button
    >
    <div class="ts-switch">
      <button type="button" class="auth-link" onclick={switchKind}
        >{recovery ? $t('frameleaf_two_step_use_app') : $t('frameleaf_two_step_use_recovery')}</button
      >
      <button type="button" class="auth-link" onclick={onBack}>{$t('frameleaf_two_step_back_to_sign_in')}</button>
    </div>
    {@render lostPhone()}
  </form>
{/if}
