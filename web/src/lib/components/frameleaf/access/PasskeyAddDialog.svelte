<script lang="ts">
  /**
   * FL-859: Add a passkey, in three steps (the approved FL-767 prototype, `Passkeys.jsx` `AddPasskey`):
   * 1 the password, unless it was checked in the last 10 minutes; 2 the browser's own window, described
   * while it is open (already saved here, or didn't work, with Try again; cancelling there closes this
   * quietly); 3 a name, suggested from the browser that made it ("Chrome on Mac").
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    PASSKEY_NAME_LENGTH,
    PASSWORD_PROOF_MINUTES,
    ceremonyProblem,
    cleanName,
    serverCode,
  } from '$lib/frameleaf/passkeys';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    getPasskeyRegistrationOptions,
    registerPasskey,
    updatePasskey,
    type PasskeyCredentialDto,
    type PasskeyResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiCheckCircleOutline } from '@mdi/js';
  import {
    WebAuthnAbortService,
    startRegistration,
    type PublicKeyCredentialCreationOptionsJSON,
  } from '@simplewebauthn/browser';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import './passkeys.css';

  let { onClose }: { onClose: (added?: PasskeyResponseDto) => void } = $props();

  type Step = 'password' | 'browser' | 'exists' | 'failed' | 'name';
  let open = $state(true);
  let step = $state<Step | null>(null);
  let password = $state('');
  let passwordError = $state('');
  let working = $state(false);
  /** The server is saving the passkey the browser made: closing now would hide a passkey that exists. */
  let saving = $state(false);
  let added = $state<PasskeyResponseDto>();
  let name = $state('');
  let alive = true;

  const address = location.host;
  const number = $derived(step === 'password' ? 1 : step === 'name' ? 3 : 2);
  const title = $derived(
    number === 1
      ? $t('frameleaf_passkey_add_title')
      : number === 2
        ? $t('frameleaf_passkey_add_browser_title')
        : $t('frameleaf_passkey_add_name_title'),
  );

  $effect(() => {
    if (!open) {
      password = '';
      onClose(added);
    }
  });

  onDestroy(() => {
    alive = false;
    WebAuthnAbortService.cancelCeremony();
  });

  /** Steps 2 and 3: the browser makes the passkey, the server saves it. */
  const ceremony = async (withPassword?: string) => {
    working = true;
    passwordError = '';
    let answer;
    try {
      answer = await getPasskeyRegistrationOptions({
        passkeyRegistrationOptionsDto: withPassword === undefined ? {} : { password: withPassword },
      });
    } catch (error) {
      working = false;
      if (!alive) {
        return;
      }
      if (serverCode(error) === 'passkey_password_required') {
        step = 'password';
        return;
      }
      if (step === 'password') {
        passwordError = getServerErrorMessage(error) ?? $t('frameleaf_passkey_add_failed');
        return;
      }
      step = 'failed';
      return;
    }
    password = '';
    if (!alive) {
      return;
    }
    if (!answer.passkeysAvailable || !answer.options) {
      working = false;
      step = 'failed';
      return;
    }
    step = 'browser';
    let credential;
    try {
      credential = await startRegistration({
        optionsJSON: answer.options as unknown as PublicKeyCredentialCreationOptionsJSON,
      });
    } catch (error) {
      working = false;
      if (!alive) {
        return;
      }
      const problem = ceremonyProblem(error);
      if (problem === 'cancelled') {
        // Cancel in the browser's window: nothing is saved, and nothing to say
        open = false;
        return;
      }
      step = problem === 'exists' ? 'exists' : 'failed';
      return;
    }
    try {
      saving = true;
      added = await registerPasskey({ passkeyRegisterDto: { credential: credential as PasskeyCredentialDto } });
      if (alive) {
        name = added.name;
        step = 'name';
      }
    } catch {
      if (alive) {
        step = 'failed';
      }
    } finally {
      working = false;
      saving = false;
    }
  };

  onMount(() => void ceremony());

  const submitPassword = (event: SubmitEvent) => {
    event.preventDefault();
    if (password && !working) {
      void ceremony(password);
    }
  };

  const save = async (event?: SubmitEvent) => {
    event?.preventDefault();
    const chosen = name.trim();
    if (!added || !chosen) {
      return;
    }
    if (chosen !== added.name) {
      working = true;
      try {
        added = await updatePasskey({ id: added.id, passkeyUpdateDto: { name: chosen } });
      } catch {
        // the passkey is saved under its first name; it can be renamed from the list
      } finally {
        working = false;
      }
    }
    open = false;
  };
</script>

<Dialog
  {title}
  closeLabel={$t('close')}
  size="medium"
  bind:open
  onRequestClose={() => {
    if (!saving) {
      open = false;
    }
  }}
>
  <div class="pk-dialog">
    {#if step}
      <span class="pk-step">{$t('frameleaf_passkey_add_step', { values: { number } })}</span>
    {/if}
    {#if step === 'password'}
      <form class="pk-dialog" onsubmit={submitPassword}>
        <p>{$t('frameleaf_passkey_add_intro')}</p>
        <label class="pk-field">
          {$t('frameleaf_passkey_add_password')}
          <small>{$t('frameleaf_passkey_add_password_hint', { values: { minutes: PASSWORD_PROOF_MINUTES } })}</small>
          <!-- svelte-ignore a11y_autofocus -->
          <input
            type="password"
            autocomplete="current-password"
            autofocus
            disabled={working}
            aria-invalid={!!passwordError || undefined}
            bind:value={password}
          />
        </label>
        {#if passwordError}
          <p class="pk-error" role="alert">
            <Icon icon={mdiAlertCircleOutline} size="18" /><span>{passwordError}</span>
          </p>
        {/if}
      </form>
    {:else if step === 'browser'}
      <p>{$t('frameleaf_passkey_add_browser_intro')}</p>
      <ol class="pk-browser" aria-label={$t('frameleaf_passkey_add_browser_label')}>
        <li>
          <strong>{$t('frameleaf_passkey_add_browser_create', { values: { address } })}</strong>
          <span>{$t('frameleaf_passkey_add_browser_create_body')}</span>
        </li>
        <li>
          <strong>{$t('frameleaf_passkey_add_browser_where')}</strong>
          <span>{$t('frameleaf_passkey_add_browser_where_body')}</span>
        </li>
        <li>
          <strong>{$t('frameleaf_passkey_add_browser_confirm')}</strong>
          <span>{$t('frameleaf_passkey_add_browser_confirm_body')}</span>
        </li>
      </ol>
      <p class="pk-waiting" role="status">
        <span class="pk-spinner" aria-hidden="true"></span>{$t('frameleaf_passkey_add_waiting')}
      </p>
      <p class="pk-quiet">{$t('frameleaf_passkey_add_cancel_hint')}</p>
    {:else if step === 'exists' || step === 'failed'}
      <p class="pk-error" role="alert">
        <Icon icon={mdiAlertCircleOutline} size="18" />
        <span>
          <strong>{step === 'exists' ? $t('frameleaf_passkey_add_exists') : $t('frameleaf_passkey_add_failed')}</strong>
          <br />
          {step === 'exists' ? $t('frameleaf_passkey_add_exists_body') : $t('frameleaf_passkey_add_failed_body')}
        </span>
      </p>
    {:else if step === 'name'}
      <form class="pk-dialog" onsubmit={save}>
        <p class="pk-made">
          <Icon icon={mdiCheckCircleOutline} size="20" />{added?.provider
            ? $t('frameleaf_passkey_add_made_in', { values: { provider: added.provider } })
            : $t('frameleaf_passkey_add_made')}
        </p>
        <label class="pk-field">
          {$t('frameleaf_passkey_name')}
          <small>{$t('frameleaf_passkey_name_hint')}</small>
          <!-- svelte-ignore a11y_autofocus -->
          <input
            autofocus
            maxlength={PASSKEY_NAME_LENGTH}
            value={name}
            oninput={(event) => (name = cleanName(event.currentTarget.value))}
          />
        </label>
      </form>
    {:else}
      <p class="pk-waiting" role="status">
        <span class="pk-spinner" aria-hidden="true"></span>{$t('frameleaf_passkey_add_starting')}
      </p>
    {/if}
  </div>

  {#snippet actions()}
    {#if step === 'password'}
      <Button disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={!password || working} onclick={() => void ceremony(password)}
        >{$t('frameleaf_passkey_continue')}</Button
      >
    {:else if step === 'exists' || step === 'failed'}
      <Button onclick={() => (open = false)}>{$t('close')}</Button>
      <Button variant="primary" disabled={working} onclick={() => void ceremony()}
        >{$t('frameleaf_passkey_try_again')}</Button
      >
    {:else if step === 'name'}
      <Button variant="primary" disabled={!name.trim() || working} onclick={() => void save()}>{$t('save')}</Button>
    {:else}
      <Button disabled={saving} onclick={() => (open = false)}>{$t('cancel')}</Button>
    {/if}
  {/snippet}
</Dialog>
