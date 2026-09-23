<script lang="ts">
  /**
   * Replace one write-only server credential (FL-67), from the credential dialog of the design
   * template's `CommandCenter.jsx`: the credential's help, a single "New value" field and
   * Save credential.
   *
   * The value lives only in this dialog's local state. It is sent once to
   * `PUT /admin/config/credentials/:name`, never enters a settings draft, is never logged, and is
   * dropped when the dialog closes, whether the save succeeded or not. The server answers only
   * whether a value is stored, which updates the shared settings state.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    CREDENTIAL_MAX_LENGTH,
    CREDENTIALS,
    isCredentialValueValid,
    withCredentialState,
  } from '$lib/frameleaf/credentials';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { updateConfigCredential, type ConfigCredential } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';

  let { name, onClose }: { name: ConfigCredential; onClose: (saved?: boolean) => void } = $props();

  const definition = $derived(CREDENTIALS[name]);
  const inputId = $props.id();
  const helpId = `${inputId}-help`;

  let open = $state(true);
  let value = $state('');
  let working = $state(false);
  let error = $state('');
  let saved = false;

  $effect(() => {
    if (open) {
      return;
    }

    // The typed value never outlives the dialog.
    value = '';
    onClose(saved);
  });

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (working || !isCredentialValueValid(value)) {
      return;
    }

    working = true;
    error = '';
    try {
      const response = await updateConfigCredential({ name, configCredentialUpdateDto: { value } });
      value = '';
      saved = true;
      const next = withCredentialState(systemConfigManager.value, name, response.configured);
      eventManager.emit('SystemConfigUpdate', next);
      toastManager.primary($t('frameleaf_credentials_saved'));
      open = false;
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('frameleaf_credentials_save_failed');
    } finally {
      working = false;
    }
  };
</script>

<Dialog title={$t(definition.labelKey)} closeLabel={$t('close')} bind:open>
  <form autocomplete="off" onsubmit={submit}>
    <p id={helpId}>{$t(definition.helpKey)}</p>
    <label for={inputId}>{$t('frameleaf_credentials_new_value')}</label>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      id={inputId}
      type="password"
      autocomplete="new-password"
      spellcheck="false"
      maxlength={CREDENTIAL_MAX_LENGTH}
      aria-describedby={helpId}
      autofocus
      disabled={working}
      bind:value
    />
    <p class="footnote">{$t('frameleaf_credentials_hidden_after_saving')}</p>
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
    <footer>
      <Button disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button type="submit" variant="primary" disabled={working || !isCredentialValueValid(value)}>
        {$t('frameleaf_credentials_save')}
      </Button>
    </footer>
  </form>
</Dialog>

<style>
  form {
    display: grid;
    gap: 0.5rem;
    margin-top: 0.75rem;
    min-width: min(26rem, 100%);
  }
  p {
    margin: 0 0 0.5rem;
    color: var(--fl-text);
  }
  label {
    font-weight: 550;
    color: var(--fl-text);
  }
  input {
    width: 100%;
    padding: 0.5rem 0.75rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font: inherit;
  }
  .footnote {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .error {
    font-size: var(--fl-font-small);
    color: var(--fl-danger);
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
</style>
