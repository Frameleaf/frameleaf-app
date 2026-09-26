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
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { CREDENTIALS, isCredentialConfigured, withCredentialState } from '$lib/frameleaf/credentials';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
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

  // FL-66: a credential change is its own write, never part of the settings draft. Afterwards the
  // draft follows the saved settings so its baseline shows the credential as stored or cleared.
  const settingsDraft = getSystemConfigDraft();

  const replace = async () => {
    const saved = await modalManager.show(CredentialDialog, { name });
    if (saved) {
      void settingsDraft?.refresh();
    }
  };

  const clear = async () => {
    const label = $t(definition.labelKey);
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_credentials_clear_title', { values: { name: label } }),
      prompt: $t('frameleaf_credentials_clear_prompt', { values: { name: label } }),
      confirmText: $t('frameleaf_credentials_clear'),
      danger: true,
    });
    if (!confirmed) {
      return;
    }

    working = true;
    try {
      const response = await deleteConfigCredential({ name });
      const next = withCredentialState(systemConfigManager.value, name, response.configured);
      eventManager.emit('SystemConfigUpdate', next);
      void settingsDraft?.refresh();
      toastManager.primary($t('frameleaf_credentials_cleared', { values: { name: label } }));
    } catch (error) {
      handleError(error, $t('frameleaf_credentials_clear_failed'));
    } finally {
      working = false;
    }
  };
</script>

<!-- A compact settings row (apple-style.css:1014-1045): what it is on the left; state and actions on the right. -->
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
    gap: 8px 12px;
    padding: 14px 0;
    border-top: 1px solid var(--fl-border);
  }
  .credential:first-child {
    border-top: 0;
  }
  .text {
    display: grid;
    flex: 1 1 16rem;
    min-width: 0;
    gap: 0.125rem;
  }
  strong {
    color: var(--fl-text);
    font-size: 14px;
    font-weight: 500;
  }
  p {
    margin: 0;
    color: var(--fl-muted);
    font-size: 12.5px;
    line-height: 1.45;
  }
  small {
    color: var(--fl-muted);
    font-size: 11.5px;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
  }
</style>
