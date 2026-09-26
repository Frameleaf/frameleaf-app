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

<div class="mt-2">
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" class="mx-4 mt-4" onsubmit={(event) => event.preventDefault()}>
      <div class="flex flex-col gap-4">
        <SettingField
          inputType={SettingInputFieldType.TEXT}
          label={$t('admin.nightly_tasks_start_time_setting')}
          description={$t('admin.nightly_tasks_start_time_setting_description')}
          bind:value={configToEdit.nightlyTasks.startTime}
          required={true}
          {disabled}
          isEdited={configToEdit.nightlyTasks.startTime !== config.nightlyTasks.startTime}
        />
        <SettingToggle
          title={$t('admin.nightly_tasks_database_cleanup_setting')}
          subtitle={$t('admin.nightly_tasks_database_cleanup_setting_description')}
          bind:checked={configToEdit.nightlyTasks.databaseCleanup}
          {disabled}
        />
        <SettingToggle
          title={$t('admin.nightly_tasks_missing_thumbnails_setting')}
          subtitle={$t('admin.nightly_tasks_missing_thumbnails_setting_description')}
          bind:checked={configToEdit.nightlyTasks.missingThumbnails}
          {disabled}
        />
        <SettingToggle
          title={$t('admin.nightly_tasks_cluster_new_faces_setting')}
          subtitle={$t('admin.nightly_tasks_cluster_faces_setting_description')}
          bind:checked={configToEdit.nightlyTasks.clusterNewFaces}
          {disabled}
        />
        <SettingToggle
          title={$t('admin.nightly_tasks_generate_memories_setting')}
          subtitle={$t('admin.nightly_tasks_generate_memories_setting_description')}
          bind:checked={configToEdit.nightlyTasks.generateMemories}
          {disabled}
        />
        <SettingToggle
          title={$t('admin.nightly_tasks_sync_quota_usage_setting')}
          subtitle={$t('admin.nightly_tasks_sync_quota_usage_setting_description')}
          bind:checked={configToEdit.nightlyTasks.syncQuotaUsage}
          {disabled}
        />
      </div>

      <SettingActions keys={['nightlyTasks']} {disabled} />
    </form>
  </div>
</div>
