<script lang="ts">
  /**
   * Onboarding → Server privacy (FL-80 ON-1, O-8): the prototype's switch rows
   * (`AuthScreens.jsx:959-981`). The map switch is saved to the server settings when the step
   * closes, as before. Frameleaf never checks for new versions on its own (a fixed privacy policy),
   * so that row stays off and explains why; casting is a per-account choice under "Your privacy".
   */
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

<p>{$t('onboarding_privacy_description')}</p>
<div class="ob-switches">
  <SettingToggle
    title={$t('frameleaf_onboarding_map_title')}
    subtitle={$t('admin.map_implications')}
    bind:checked={configToEdit.map.enabled}
  />
  <SettingToggle
    title={$t('frameleaf_onboarding_version_check_title')}
    subtitle={$t('admin.version_check_disabled_by_privacy_policy')}
    checked={false}
    disabled
  />
</div>
