<script lang="ts">
  import SettingGroup from '$lib/components/frameleaf/settings/SettingGroup.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import type { AdminConfigMachineLearningDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';
  import SettingSelect from '$lib/components/frameleaf/settings/SettingSelect.svelte';

  interface Props {
    workingConfig: AdminConfigMachineLearningDto;
    savedConfig: AdminConfigMachineLearningDto;
    disabled: boolean;
  }

  let { workingConfig, savedConfig, disabled }: Props = $props();
</script>

<SettingGroup
  key="facial-recognition"
  title={$t('admin.machine_learning_facial_recognition')}
  subtitle={$t('admin.machine_learning_facial_recognition_description')}
>
  <div class="flex flex-col gap-4">
    <SettingToggle
      title={$t('admin.machine_learning_facial_recognition_setting')}
      subtitle={$t('admin.machine_learning_facial_recognition_setting_description')}
      bind:checked={workingConfig.facialRecognition.enabled}
      disabled={disabled || !workingConfig.enabled}
    />

    <hr />

    <SettingSelect
      label={$t('admin.machine_learning_facial_recognition_model')}
      desc={$t('admin.machine_learning_facial_recognition_model_description')}
      name="facial-recognition-model"
      bind:value={workingConfig.facialRecognition.modelName}
      options={[
        { value: 'antelopev2', text: 'antelopev2' },
        { value: 'buffalo_l', text: 'buffalo_l' },
        { value: 'buffalo_m', text: 'buffalo_m' },
        { value: 'buffalo_s', text: 'buffalo_s' },
      ]}
      disabled={disabled || !workingConfig.enabled || !workingConfig.facialRecognition.enabled}
      isEdited={workingConfig.facialRecognition.modelName !== savedConfig.facialRecognition.modelName}
    />

    <SettingField
      inputType={SettingInputFieldType.NUMBER}
      label={$t('admin.machine_learning_min_detection_score')}
      description={$t('admin.machine_learning_min_detection_score_description')}
      bind:value={workingConfig.facialRecognition.minScore}
      step="0.01"
      min={0.1}
      max={1}
      disabled={disabled || !workingConfig.enabled || !workingConfig.facialRecognition.enabled}
      isEdited={workingConfig.facialRecognition.minScore !== savedConfig.facialRecognition.minScore}
    />

    <SettingField
      inputType={SettingInputFieldType.NUMBER}
      label={$t('admin.machine_learning_max_recognition_distance')}
      description={$t('admin.machine_learning_max_recognition_distance_description')}
      bind:value={workingConfig.facialRecognition.maxDistance}
      step="0.01"
      min={0.1}
      max={2}
      disabled={disabled || !workingConfig.enabled || !workingConfig.facialRecognition.enabled}
      isEdited={workingConfig.facialRecognition.maxDistance !== savedConfig.facialRecognition.maxDistance}
    />

    <SettingField
      inputType={SettingInputFieldType.NUMBER}
      label={$t('admin.machine_learning_min_recognized_faces')}
      description={$t('admin.machine_learning_min_recognized_faces_description')}
      bind:value={workingConfig.facialRecognition.minFaces}
      step="1"
      min={1}
      disabled={disabled || !workingConfig.enabled || !workingConfig.facialRecognition.enabled}
      isEdited={workingConfig.facialRecognition.minFaces !== savedConfig.facialRecognition.minFaces}
    />
  </div>
</SettingGroup>
