<script lang="ts">
  /**
   * Server & updates → Configuration transfer (FL-71), the template's `ConfigurationTransfer.jsx`:
   * export, copy or import the saved settings. The actions are the existing settings actions (which
   * never carry a credential, FL-67); an imported file lands in the settings draft for review.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { getSystemConfigActions } from '$lib/services/system-config.service';
  import { t } from 'svelte-i18n';

  const settingsDraft = getSystemConfigDraft();
  const actions = $derived(
    settingsDraft
      ? getSystemConfigActions($t, featureFlagsManager.value, settingsDraft.baseline, {
          onImport: (text) => settingsDraft.importFile(text),
        })
      : undefined,
  );
</script>

{#if actions}
  <div class="transfer">
    <h3>{$t('frameleaf_cc_config_transfer_heading')}</h3>
    <p>{$t('frameleaf_cc_config_transfer_help')}</p>
    <div class="actions">
      <Button onclick={() => actions.Download.onAction(actions.Download)}>{$t('frameleaf_cc_config_export')}</Button>
      <Button onclick={() => actions.CopyToClipboard.onAction(actions.CopyToClipboard)}
        >{$t('frameleaf_cc_config_copy')}</Button
      >
      {#if actions.Upload.$if?.() ?? true}
        <Button onclick={() => actions.Upload.onAction(actions.Upload)}>{$t('frameleaf_cc_config_import')}</Button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .transfer h3 {
    margin: 0;
    font-size: var(--fl-font-size);
    font-weight: 550;
  }
  .transfer p {
    margin: 0.5rem 0 1rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
