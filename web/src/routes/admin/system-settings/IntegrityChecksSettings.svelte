<script lang="ts">
  import SettingGroup from '$lib/components/frameleaf/settings/SettingGroup.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
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
</script>

<div>
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" onsubmit={(event) => event.preventDefault()}>
      <div class="flex flex-col gap-4">
        <SettingGroup
          key="integrity-checks-missing-files"
          title={$t('admin.integrity_checks_missing_files')}
          subtitle={$t('admin.integrity_checks_missing_files_description')}
        >
          <div class="flex flex-col gap-4">
            <SettingToggle
              title={$t('admin.integrity_checks_missing_files_enable_description')}
              {disabled}
              bind:checked={configToEdit.integrityChecks.missingFiles.enabled}
            />

            <SettingField
              inputType={SettingInputFieldType.TEXT}
              label={$t('admin.cron_expression')}
              bind:value={configToEdit.integrityChecks.missingFiles.cronExpression}
              required={true}
              {disabled}
              isEdited={configToEdit.integrityChecks.missingFiles.cronExpression !==
                config.integrityChecks.missingFiles.cronExpression}
            >
              {#snippet descriptionSnippet()}
                <p class="text-sm dark:text-immich-dark-fg">
                  <FormatMessage key="admin.cron_expression_description">
                    {#snippet children({ message })}
                      <Link
                        href="https://crontab.guru/#{configToEdit.backup.database.cronExpression.replaceAll(' ', '_')}"
                      >
                        {message}
                        <br />
                      </Link>
                    {/snippet}
                  </FormatMessage>
                </p>
              {/snippet}
            </SettingField>
          </div>
        </SettingGroup>

        <SettingGroup
          key="integrity-checks-untracked-files"
          title={$t('admin.integrity_checks_untracked_files')}
          subtitle={$t('admin.integrity_checks_untracked_files_description')}
        >
          <div class="flex flex-col gap-4">
            <SettingToggle
              title={$t('admin.integrity_checks_untracked_files_enable_description')}
              {disabled}
              bind:checked={configToEdit.integrityChecks.untrackedFiles.enabled}
            />

            <SettingField
              inputType={SettingInputFieldType.TEXT}
              label={$t('admin.cron_expression')}
              bind:value={configToEdit.integrityChecks.untrackedFiles.cronExpression}
              required={true}
              {disabled}
              isEdited={configToEdit.integrityChecks.untrackedFiles.cronExpression !==
                config.integrityChecks.untrackedFiles.cronExpression}
            >
              {#snippet descriptionSnippet()}
                <p class="text-sm dark:text-immich-dark-fg">
                  <FormatMessage key="admin.cron_expression_description">
                    {#snippet children({ message })}
                      <Link
                        href="https://crontab.guru/#{configToEdit.backup.database.cronExpression.replaceAll(' ', '_')}"
                      >
                        {message}
                        <br />
                      </Link>
                    {/snippet}
                  </FormatMessage>
                </p>
              {/snippet}
            </SettingField>
          </div>
        </SettingGroup>

        <SettingGroup
          key="integrity-checks-checksum-files"
          title={$t('admin.integrity_checks_checksum_files')}
          subtitle={$t('admin.integrity_checks_checksum_files_description')}
        >
          <div class="flex flex-col gap-4">
            <SettingToggle
              title={$t('admin.integrity_checks_checksum_files_enable_description')}
              {disabled}
              bind:checked={configToEdit.integrityChecks.checksumFiles.enabled}
            />

            <SettingField
              inputType={SettingInputFieldType.TEXT}
              label={$t('admin.cron_expression')}
              bind:value={configToEdit.integrityChecks.checksumFiles.cronExpression}
              required={true}
              {disabled}
              isEdited={configToEdit.integrityChecks.checksumFiles.cronExpression !==
                config.integrityChecks.checksumFiles.cronExpression}
            >
              {#snippet descriptionSnippet()}
                <p class="text-sm dark:text-immich-dark-fg">
                  <FormatMessage key="admin.cron_expression_description">
                    {#snippet children({ message })}
                      <Link
                        href="https://crontab.guru/#{configToEdit.backup.database.cronExpression.replaceAll(' ', '_')}"
                      >
                        {message}
                        <br />
                      </Link>
                    {/snippet}
                  </FormatMessage>
                </p>
              {/snippet}
            </SettingField>

            <SettingField
              inputType={SettingInputFieldType.NUMBER}
              label={$t('admin.integrity_checks_checksum_files_time_limit')}
              description={$t('admin.integrity_checks_checksum_files_time_limit_description')}
              bind:value={configToEdit.integrityChecks.checksumFiles.timeLimit}
              {disabled}
              isEdited={configToEdit.integrityChecks.checksumFiles.timeLimit !==
                config.integrityChecks.checksumFiles.timeLimit}
            />

            <SettingField
              inputType={SettingInputFieldType.NUMBER}
              label={$t('admin.integrity_checks_checksum_files_percentage_limit')}
              description={$t('admin.integrity_checks_checksum_files_percentage_limit_description')}
              bind:value={configToEdit.integrityChecks.checksumFiles.percentageLimit}
              step="0.01"
              min={0.01}
              max={1}
              {disabled}
              isEdited={configToEdit.integrityChecks.checksumFiles.percentageLimit !==
                config.integrityChecks.checksumFiles.percentageLimit}
            />
          </div>
        </SettingGroup>

        <SettingActions keys={['integrityChecks']} {disabled} />
      </div>
    </form>
  </div>
</div>
