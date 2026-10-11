<script lang="ts">
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { t } from 'svelte-i18n';
  import { reveal } from '$lib/frameleaf/motion';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const configToEdit = $derived(settingsDraft.draft);
</script>

<div>
  <div in:reveal>
    <form autocomplete="off" onsubmit={(event) => event.preventDefault()}>
      <div class="flex flex-col gap-4">
        <SettingToggle
          title={$t('admin.metadata_faces_import_setting')}
          subtitle={$t('admin.metadata_faces_import_setting_description')}
          bind:checked={configToEdit.metadata.faces.import}
          {disabled}
        />
      </div>

      <SettingActions keys={['metadata']} {disabled} />
    </form>
  </div>
</div>
