<script lang="ts">
  /**
   * One write-only server credential in a settings section (FL-67), from the `credentials` rows of
   * the design template's `CommandCenter.jsx`: its name and help, "Values are hidden after
   * saving." and Replace credential. Production adds what the template cannot show: whether a
   * value is stored, and Clear, which removes it after a confirmation.
   *
   * The row never holds a value. Whether one is stored comes from the shared settings state
   * (`...Configured`), which both actions update from the server's answer.
   */
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import CredentialDialog from '$lib/components/frameleaf/settings/CredentialDialog.svelte';
  import { CREDENTIALS, isCredentialConfigured, withCredentialState } from '$lib/frameleaf/credentials';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { deleteConfigCredential, type ConfigCredential } from '@immich/sdk';
  import { modalManager, toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';

  let {
    name,
    disabled = false,
    reason,
  }: {
    name: ConfigCredential;
    /** For example while a configuration file manages the settings. */
    disabled?: boolean;
    /** Shown under the row while it is disabled. */
    reason?: string;
  } = $props();

  const definition = $derived(CREDENTIALS[name]);
  const configured = $derived(isCredentialConfigured(systemConfigManager.value, name));
  const stateText = $derived(configured ? $t('frameleaf_credentials_stored') : $t('frameleaf_credentials_not_set'));
  let working = $state(false);

  const replace = () => modalManager.show(CredentialDialog, { name });

  const clear = async () => {
    const label = $t(definition.labelKey);
    const confirmed = await modalManager.showDialog({
      title: $t('frameleaf_credentials_clear_title', { values: { name: label } }),
      prompt: $t('frameleaf_credentials_clear_prompt', { values: { name: label } }),
      confirmText: $t('frameleaf_credentials_clear'),
      confirmColor: 'danger',
    });
    if (!confirmed) {
      return;
    }

    working = true;
    try {
      const response = await deleteConfigCredential({ name });
      const next = withCredentialState(systemConfigManager.value, name, response.configured);
      eventManager.emit('SystemConfigUpdate', next);
      toastManager.primary($t('frameleaf_credentials_cleared', { values: { name: label } }));
    } catch (error) {
      handleError(error, $t('frameleaf_credentials_clear_failed'));
    } finally {
      working = false;
    }
  };
</script>

<div class="credential">
  <div class="text">
    <strong>{$t(definition.labelKey)}</strong>
    <p>{$t(definition.helpKey)}</p>
    <small>{$t('frameleaf_credentials_hidden_after_saving')}</small>
    {#if disabled && reason}
      <small>{reason}</small>
    {/if}
  </div>
  <Badge tone={configured ? 'teal' : 'neutral'} value={stateText} label={stateText} />
  <div class="actions">
    <Button disabled={disabled || working} onclick={replace}>{$t('frameleaf_credentials_replace')}</Button>
    {#if configured}
      <Button disabled={disabled || working} onclick={clear}>{$t('frameleaf_credentials_clear')}</Button>
    {/if}
  </div>
</div>

<style>
  .credential {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    padding: 0.75rem 0;
    border-top: 1px solid var(--fl-border);
    border-bottom: 1px solid var(--fl-border);
    margin-bottom: 1rem;
  }
  .text {
    display: grid;
    flex: 1 1 16rem;
    min-width: 0;
    gap: 0.125rem;
  }
  strong {
    color: var(--fl-text);
  }
  p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .actions {
    display: flex;
    gap: 0.5rem;
  }
</style>
