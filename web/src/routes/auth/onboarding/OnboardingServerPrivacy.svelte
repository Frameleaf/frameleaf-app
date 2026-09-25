<script lang="ts">
  /**
   * Onboarding → Server privacy (FL-80 ON-1, O-8): the prototype's switch rows
   * (`AuthScreens.jsx:959-981`). The map switch is saved to the server settings when the step
   * closes, as before, and so is "Check for new versions" (`newVersionCheck.enabled`, on by default
   * on the first visit as in the prototype's `system-data.mjs:585`, otherwise the saved value): the server then asks only Frameleaf's own GitHub
   * releases (FL-80 O-8; owner decision on FL-146, 2026-09-25). Casting is a per-account choice under
   * "Your privacy".
   */
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { handleSystemConfigSave } from '$lib/services/system-config.service';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  const { firstVisit = false }: { firstVisit?: boolean } = $props();

  const configToEdit = $state(systemConfigManager.cloneValue());
  // The prototype's onboarding default is on (the check only asks Frameleaf's releases), but only
  // while the admin has made no choice: on this step's first visit, with the server default (off)
  // still saved. Otherwise the switch shows the saved value.
  if (firstVisit && !configToEdit.newVersionCheck.enabled) {
    configToEdit.newVersionCheck.enabled = true;
  }

  onDestroy(async () => {
    await handleSystemConfigSave({ map: configToEdit.map, newVersionCheck: configToEdit.newVersionCheck });
  });
</script>

<p>{$t('onboarding_privacy_description')}</p>
<div class="ob-switches">
  <SettingToggle
    title={$t('frameleaf_onboarding_version_check_title')}
    subtitle={$t('frameleaf_onboarding_version_check_body')}
    bind:checked={configToEdit.newVersionCheck.enabled}
  />
  <SettingToggle
    title={$t('frameleaf_onboarding_map_title')}
    subtitle={$t('admin.map_implications')}
    bind:checked={configToEdit.map.enabled}
  />
</div>
