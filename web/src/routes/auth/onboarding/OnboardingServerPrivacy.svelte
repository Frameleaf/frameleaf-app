<script lang="ts">
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { handleSystemConfigSave } from '$lib/services/system-config.service';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  const configToEdit = $state(systemConfigManager.cloneValue());

  onDestroy(async () => {
    await handleSystemConfigSave({ map: configToEdit.map });
  });
</script>

<div class="flex flex-col gap-4">
  <p>
    {$t('onboarding_privacy_description')}
  </p>

  <SettingToggle
    title={$t('admin.map_settings')}
    subtitle={$t('admin.map_implications')}
    bind:checked={configToEdit.map.enabled}
  />
  <SettingToggle
    title={$t('admin.version_check_settings')}
    subtitle={$t('admin.version_check_disabled_by_privacy_policy')}
    checked={false}
    disabled
  />
</div>
