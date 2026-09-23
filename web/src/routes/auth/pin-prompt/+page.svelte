<script lang="ts">
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import PinCells from '$lib/components/frameleaf/PinCells.svelte';
  import AuthPageLayout from '$lib/components/layouts/AuthPageLayout.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { Route } from '$lib/route';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { setupPinCode, unlockAuthSession } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiBackspaceOutline, mdiShieldLockOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  /**
   * The PIN prompt, from the design template's `PinPrompt` (AuthScreens.jsx): six PIN cells checked
   * as soon as they are full, an on-screen keypad, and a create flow (enter, then confirm) for an
   * account without a PIN. Unlocking elevates the real session; creating stores the PIN hashed.
   */
  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let hasPinCode = $state(data.hasPinCode);
  let stage = $state<'enter' | 'confirm'>('enter');
  let first = $state('');
  let pin = $state('');
  let error = $state('');
  let working = $state(false);
  let verified = $state(false);

  const hintId = $props.id();
  const create = $derived(!hasPinCode);
  const heading = $derived(
    create
      ? stage === 'confirm'
        ? $t('frameleaf_pin_confirm_title')
        : $t('frameleaf_pin_create_title')
      : $t('frameleaf_pin_enter_title'),
  );
  const description = $derived(create ? $t('frameleaf_pin_create_subtitle') : $t('frameleaf_pin_enter_subtitle'));

  const fail = (message: string) => {
    error = message;
    pin = '';
  };

  const complete = async (code: string) => {
    if (working) {
      return;
    }
    if (create) {
      if (stage === 'enter') {
        first = code;
        pin = '';
        error = '';
        stage = 'confirm';
        return;
      }
      if (code !== first) {
        stage = 'enter';
        first = '';
        fail($t('frameleaf_pin_mismatch'));
        return;
      }
      working = true;
      try {
        await setupPinCode({ pinCodeSetupDto: { pinCode: code } });
        eventManager.emit('UserPinCodeCreated');
        hasPinCode = true;
        stage = 'enter';
        first = '';
        pin = '';
        error = '';
      } catch (error_) {
        stage = 'enter';
        first = '';
        fail(getServerErrorMessage(error_) ?? $t('frameleaf_pin_wrong'));
      } finally {
        working = false;
      }
      return;
    }
    working = true;
    try {
      await unlockAuthSession({ sessionUnlockDto: { pinCode: code } });
      verified = true;
      eventManager.emit('SessionAccessChanged', { isElevated: true });
      await goto(data.continueUrl);
    } catch {
      // The rejected code never lingers client side; the cells reset for a fresh attempt.
      fail($t('frameleaf_pin_wrong'));
    } finally {
      working = false;
    }
  };

  const press = (key: string) => {
    if (working || verified) {
      return;
    }
    error = '';
    pin = key === 'back' ? pin.slice(0, -1) : (pin + key).slice(0, 6);
    if (pin.length === 6) {
      void complete(pin);
    }
  };

  const restart = () => {
    stage = 'enter';
    first = '';
    pin = '';
    error = '';
  };

  const cancel = () => goto(Route.photos());
</script>

<AuthPageLayout withHeader={false}>
  <div class="pin-card">
    <span class="pin-mark" aria-hidden="true">
      <Icon icon={mdiShieldLockOutline} size="26" />
    </span>
    <div class="pin-heading">
      <h1>{heading}</h1>
      <p>{description}</p>
    </div>

    <PinCells
      bind:value={pin}
      autofocus
      error={!!error}
      disabled={working || verified}
      label={heading}
      describedBy={hintId}
      oncomplete={(code) => void complete(code)}
    />
    <p id={hintId} class="sr-only">{$t('frameleaf_pin_sr_hint')}</p>
    {#if error}
      <p role="alert" class="pin-error">{error}</p>
    {:else}
      <p class="pin-hint">
        {create && stage === 'confirm' ? $t('frameleaf_pin_confirm_hint') : $t('frameleaf_pin_auto_hint')}
      </p>
    {/if}

    <div class="pin-keypad">
      {#each [1, 2, 3, 4, 5, 6, 7, 8, 9] as digit (digit)}
        <button
          type="button"
          aria-label={$t('frameleaf_pin_digit', { values: { digit } })}
          onclick={() => press(String(digit))}
        >
          {digit}
        </button>
      {/each}
      <button type="button" class="soft" onclick={cancel}>{$t('cancel')}</button>
      <button type="button" aria-label={$t('frameleaf_pin_digit', { values: { digit: 0 } })} onclick={() => press('0')}
        >0</button
      >
      <button type="button" class="soft" aria-label={$t('frameleaf_pin_delete_digit')} onclick={() => press('back')}>
        <Icon icon={mdiBackspaceOutline} size="20" aria-hidden="true" />
      </button>
    </div>

    <div class="pin-actions">
      <Button type="button" onclick={cancel}>{$t('cancel')}</Button>
      {#if !create}
        <a class="pin-link" href={Route.userSettings()}>{$t('frameleaf_pin_reset')}</a>
      {:else if stage === 'confirm'}
        <button type="button" class="pin-link" onclick={restart}>{$t('frameleaf_pin_start_over')}</button>
      {/if}
    </div>
  </div>
</AuthPageLayout>

<style>
  .pin-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    width: 100%;
    max-width: 22rem;
    margin: 0 auto;
    color: var(--fl-text);
  }
  .pin-mark {
    display: grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    border-radius: 50%;
    color: var(--fl-accent);
    background: var(--fl-raised);
  }
  .pin-heading {
    text-align: center;
  }
  .pin-heading h1 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
  }
  .pin-heading p,
  .pin-hint,
  .pin-error {
    margin: 0.25rem 0 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .pin-error {
    color: var(--fl-danger);
  }
  .pin-keypad {
    display: grid;
    grid-template-columns: repeat(3, 4rem);
    gap: 0.5rem;
  }
  .pin-keypad button {
    height: 3rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    font: inherit;
    font-size: 1.125rem;
  }
  .pin-keypad button.soft {
    background: transparent;
    font-size: var(--fl-font-small);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .pin-keypad button:hover {
    background: var(--fl-panel);
  }
  .pin-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .pin-link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--fl-muted);
    font: inherit;
    font-size: var(--fl-font-small);
    text-decoration: underline;
  }
</style>
