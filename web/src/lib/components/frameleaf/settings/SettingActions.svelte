<script lang="ts">
  /**
   * Save, reset and reset-to-default for one slice of the system configuration (FL-71). Same
   * props and behaviour as the legacy SystemConfigButtonRow it replaces; saving goes through
   * `handleSystemConfigSave` so every form on the settings pages shares one write path.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { handleSystemConfigSave } from '$lib/services/system-config.service';
  import type { AdminConfigDto } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { isEqual, pick } from 'lodash-es';
  import { t } from 'svelte-i18n';

  type Props = {
    disabled?: boolean;
    keys: Array<keyof AdminConfigDto>;
    configToEdit: AdminConfigDto;
    onBeforeSave?: () => Promise<boolean>;
  };

  let { disabled, keys, configToEdit = $bindable(), onBeforeSave }: Props = $props();

  const showResetToDefault = $derived(
    !isEqual(pick(systemConfigManager.value, keys), pick(systemConfigManager.defaultValue, keys)),
  );

  const handleReset = () => {
    configToEdit = systemConfigManager.cloneValue();
    toastManager.info($t('admin.reset_settings_to_recent_saved'));
  };

  const handleResetToDefault = () => {
    const defaultConfig = systemConfigManager.cloneDefaultValue();
    configToEdit = { ...configToEdit, ...pick(defaultConfig, keys) };
    toastManager.info($t('admin.reset_settings_to_default'));
  };

  const handleSave = async () => {
    const shouldSave = await onBeforeSave?.();
    if (shouldSave ?? true) {
      await handleSystemConfigSave(pick(configToEdit, keys));
    }
  };
</script>

<div class="actions">
  <div>
    {#if showResetToDefault}
      <Button variant="quiet" onclick={handleResetToDefault}>{$t('reset_to_default')}</Button>
    {/if}
  </div>
  <div class="primary">
    <Button {disabled} onclick={handleReset}>{$t('reset')}</Button>
    <Button variant="primary" type="submit" {disabled} onclick={handleSave}>{$t('save')}</Button>
  </div>
</div>

<style>
  .actions {
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 1.25rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--fl-border);
  }
  .primary {
    display: flex;
    gap: 0.5rem;
    margin-inline-start: auto;
  }
</style>
