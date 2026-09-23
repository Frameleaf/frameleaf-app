<script lang="ts">
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import SettingSelect from '$lib/components/frameleaf/settings/SettingSelect.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { LogLevel } from '@immich/sdk';
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
          title={$t('admin.logging_enable_description')}
          {disabled}
          bind:checked={configToEdit.logging.enabled}
        />
        <SettingSelect
          label={$t('level')}
          desc={$t('admin.logging_level_description')}
          bind:value={configToEdit.logging.level}
          options={[
            { value: LogLevel.Fatal, text: 'Fatal' },
            { value: LogLevel.Error, text: 'Error' },
            { value: LogLevel.Warn, text: 'Warn' },
            { value: LogLevel.Log, text: 'Log' },
            { value: LogLevel.Debug, text: 'Debug' },
            { value: LogLevel.Verbose, text: 'Verbose' },
          ]}
          name="level"
          isEdited={configToEdit.logging.level !== config.logging.level}
          disabled={disabled || !configToEdit.logging.enabled}
        />

        <SettingActions keys={['logging']} {disabled} />
      </div>
    </form>
  </div>
</div>
