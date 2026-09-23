<script lang="ts">
  import SettingGroup from '$lib/components/frameleaf/settings/SettingGroup.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import type { AdminConfigMachineLearningDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  interface Props {
    workingConfig: AdminConfigMachineLearningDto;
    savedConfig: AdminConfigMachineLearningDto;
    disabled: boolean;
  }

  let { workingConfig, savedConfig, disabled }: Props = $props();
</script>

<SettingGroup
  key="availability-checks"
  title={$t('admin.machine_learning_availability_checks')}
  subtitle={$t('admin.machine_learning_availability_checks_description')}
>
  <div class="flex flex-col gap-4">
    <SettingToggle
      title={$t('admin.machine_learning_availability_checks_enabled')}
      bind:checked={workingConfig.availabilityChecks.enabled}
      disabled={disabled || !workingConfig.enabled}
    />

    <hr />

    <SettingField
      inputType={SettingInputFieldType.NUMBER}
      label={$t('admin.machine_learning_availability_checks_interval')}
      bind:value={workingConfig.availabilityChecks.interval}
      description={$t('admin.machine_learning_availability_checks_interval_description')}
      disabled={disabled || !workingConfig.enabled || !workingConfig.availabilityChecks.enabled}
      isEdited={workingConfig.availabilityChecks.interval !== savedConfig.availabilityChecks.interval}
    />

    <SettingField
      inputType={SettingInputFieldType.NUMBER}
      label={$t('admin.machine_learning_availability_checks_timeout')}
      bind:value={workingConfig.availabilityChecks.timeout}
      description={$t('admin.machine_learning_availability_checks_timeout_description')}
      disabled={disabled || !workingConfig.enabled || !workingConfig.availabilityChecks.enabled}
      isEdited={workingConfig.availabilityChecks.timeout !== savedConfig.availabilityChecks.timeout}
    />
  </div>
</SettingGroup>
