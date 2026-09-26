<script lang="ts">
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const configToEdit = $derived(settingsDraft.draft);
  const config = $derived(settingsDraft.baseline);
</script>

<div>
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" onsubmit={(event) => event.preventDefault()}>
      <div class="flex flex-col gap-4">
        <SettingToggle
          title={$t('admin.trash_enabled_description')}
          {disabled}
          bind:checked={configToEdit.trash.enabled}
        />

        <hr />

        <SettingField
          inputType={SettingInputFieldType.NUMBER}
          label={$t('admin.trash_number_of_days')}
          description={$t('admin.trash_number_of_days_description')}
          bind:value={configToEdit.trash.days}
          required={true}
          disabled={disabled || !configToEdit.trash.enabled}
          isEdited={configToEdit.trash.days !== config.trash.days}
        />

        <SettingActions keys={['trash']} {disabled} />
      </div>
    </form>
  </div>
</div>
