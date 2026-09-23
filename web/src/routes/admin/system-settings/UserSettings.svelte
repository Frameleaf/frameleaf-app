<script lang="ts">
  import { fade } from 'svelte/transition';

  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { t } from 'svelte-i18n';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const config = $derived(systemConfigManager.value);
  let configToEdit = $state(systemConfigManager.cloneValue());
</script>

<div>
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" onsubmit={(e) => e.preventDefault()}>
      <div class="flex flex-col gap-4">
        <SettingField
          inputType={SettingInputFieldType.NUMBER}
          min={1}
          label={$t('admin.user_delete_delay_settings')}
          description={$t('admin.user_delete_delay_settings_description')}
          bind:value={configToEdit.user.deleteDelay}
          isEdited={configToEdit.user.deleteDelay !== config.user.deleteDelay}
        />
      </div>

      <SettingActions bind:configToEdit keys={['user']} {disabled} />
    </form>
  </div>
</div>
