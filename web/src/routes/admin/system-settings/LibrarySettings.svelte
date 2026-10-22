<script lang="ts">
  /**
   * Libraries › Folder checks (FL-365): "Check every folder each night" and "Notice new files right
   * away", each saying what on and off do. No time controls: folder checks run in the overnight
   * schedule (owner decision 2026-10-10), so the stored `scan.cronExpression` is not shown; a custom
   * one set in the configuration file is kept as it is.
   */
  import { goto } from '$app/navigation';
  import SettingGroup from '$lib/components/frameleaf/settings/SettingGroup.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
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
        <SettingGroup
          key="library-scanning"
          title={$t('admin.library_scanning')}
          subtitle={$t('admin.library_scanning_description')}
        >
          <div class="flex flex-col gap-4">
            <SettingToggle
              title={$t('admin.library_scanning_enable_description')}
              {disabled}
              bind:checked={configToEdit.library.scan.enabled}
            />
            <div class="flex flex-wrap items-center justify-between gap-3">
              <p class="text-sm">{$t('frameleaf_libraries_checks_overnight')}</p>
              <Button onclick={() => goto(commandCenterUrl('processing', 'nightly-tasks'))}
                >{$t('frameleaf_libraries_checks_overnight_open')}</Button
              >
            </div>
          </div>
        </SettingGroup>

        <SettingGroup
          key="library-watching"
          title={$t('admin.library_watching_settings')}
          subtitle={$t('admin.library_watching_settings_description')}
        >
          <div class="flex flex-col gap-4">
            <SettingToggle
              title={$t('admin.library_watching_enable_description')}
              {disabled}
              bind:checked={configToEdit.library.watch.enabled}
            />
          </div>
        </SettingGroup>

        <SettingActions keys={['library']} {disabled} />
      </div>
    </form>
  </div>
</div>
