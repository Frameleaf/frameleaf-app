<script lang="ts">
  import { fade } from 'svelte/transition';

  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { t } from 'svelte-i18n';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const configToEdit = $derived(settingsDraft.draft);
  const config = $derived(settingsDraft.baseline);
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

      <SettingActions keys={['user']} {disabled} />
    </form>
  </div>
</div>
