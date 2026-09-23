<script lang="ts">
  import SettingGroup from '$lib/components/frameleaf/settings/SettingGroup.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingSelect from '$lib/components/frameleaf/settings/SettingSelect.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Link } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const configToEdit = $derived(settingsDraft.draft);
  const config = $derived(settingsDraft.baseline);

  let cronExpressionOptions = $derived([
    { text: $t('interval.night_at_midnight'), value: '0 0 * * *' },
    { text: $t('interval.night_at_twoam'), value: '0 2 * * *' },
    { text: $t('interval.day_at_onepm'), value: '0 13 * * *' },
    { text: $t('interval.hours', { values: { hours: 6 } }), value: '0 */6 * * *' },
  ]);
</script>

<div>
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" onsubmit={(event) => event.preventDefault()}>
      <div class="flex flex-col gap-4">
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

            <SettingSelect
              options={cronExpressionOptions}
              disabled={disabled || !configToEdit.library.scan.enabled}
              name="expression"
              label={$t('admin.cron_expression_presets')}
              bind:value={configToEdit.library.scan.cronExpression}
            />

            <SettingField
              inputType={SettingInputFieldType.TEXT}
              required={true}
              disabled={disabled || !configToEdit.library.scan.enabled}
              label={$t('admin.cron_expression')}
              bind:value={configToEdit.library.scan.cronExpression}
              isEdited={configToEdit.library.scan.cronExpression !== config.library.scan.cronExpression}
            >
              {#snippet descriptionSnippet()}
                <p class="text-sm dark:text-immich-dark-fg">
                  <FormatMessage key="admin.cron_expression_description">
                    {#snippet children({ message })}
                      <Link
                        href="https://crontab.guru/#{configToEdit.library.scan.cronExpression.replaceAll(' ', '_')}"
                      >
                        {message}
                      </Link>
                    {/snippet}
                  </FormatMessage>
                </p>
              {/snippet}
            </SettingField>
          </div>
        </SettingGroup>

        <SettingActions keys={['library']} {disabled} />
      </div>
    </form>
  </div>
</div>
