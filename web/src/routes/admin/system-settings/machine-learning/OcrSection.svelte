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
  key="ocr"
  title={$t('admin.machine_learning_ocr')}
  subtitle={$t('admin.machine_learning_ocr_description')}
>
  <div class="flex flex-col gap-4">
    <SettingToggle
      title={$t('admin.machine_learning_ocr_enabled')}
      subtitle={$t('admin.machine_learning_ocr_enabled_description')}
      bind:checked={workingConfig.ocr.enabled}
      disabled={disabled || !workingConfig.enabled}
    />

    <hr />

    <SettingSelect
      label={$t('admin.machine_learning_ocr_model')}
      desc={$t('admin.machine_learning_ocr_model_description')}
      name="ocr-model"
      bind:value={workingConfig.ocr.modelName}
      options={[
        { text: 'PP-OCRv5_server (Chinese, Japanese and English)', value: 'PP-OCRv5_server' },
        { text: 'PP-OCRv5_mobile (Chinese, Japanese and English)', value: 'PP-OCRv5_mobile' },
        { text: 'PP-OCRv5_mobile (English-only)', value: 'EN__PP-OCRv5_mobile' },
        { text: 'PP-OCRv5_mobile (Greek and English)', value: 'EL__PP-OCRv5_mobile' },
        { text: 'PP-OCRv5_mobile (Korean and English)', value: 'KOREAN__PP-OCRv5_mobile' },
        { text: 'PP-OCRv5_mobile (Latin script languages)', value: 'LATIN__PP-OCRv5_mobile' },
        { text: 'PP-OCRv5_mobile (Russian, Belarusian, Ukrainian and English)', value: 'ESLAV__PP-OCRv5_mobile' },
        { text: 'PP-OCRv5_mobile (Thai and English)', value: 'TH__PP-OCRv5_mobile' },
      ]}
      disabled={disabled || !workingConfig.enabled || !workingConfig.ocr.enabled}
      isEdited={workingConfig.ocr.modelName !== savedConfig.ocr.modelName}
    />

    <SettingField
      inputType={SettingInputFieldType.NUMBER}
      label={$t('admin.machine_learning_ocr_min_detection_score')}
      description={$t('admin.machine_learning_ocr_min_detection_score_description')}
      bind:value={workingConfig.ocr.minDetectionScore}
      step="0.1"
      min={0.1}
      max={1}
      disabled={disabled || !workingConfig.enabled || !workingConfig.ocr.enabled}
      isEdited={workingConfig.ocr.minDetectionScore !== savedConfig.ocr.minDetectionScore}
    />

    <SettingField
      inputType={SettingInputFieldType.NUMBER}
      label={$t('admin.machine_learning_ocr_min_recognition_score')}
      description={$t('admin.machine_learning_ocr_min_score_recognition_description')}
      bind:value={workingConfig.ocr.minRecognitionScore}
      step="0.1"
      min={0.1}
      max={1}
      disabled={disabled || !workingConfig.enabled || !workingConfig.ocr.enabled}
      isEdited={workingConfig.ocr.minRecognitionScore !== savedConfig.ocr.minRecognitionScore}
    />

    <SettingField
      inputType={SettingInputFieldType.NUMBER}
      label={$t('admin.machine_learning_ocr_max_resolution')}
      description={$t('admin.machine_learning_ocr_max_resolution_description')}
      bind:value={workingConfig.ocr.maxResolution}
      min={1}
      disabled={disabled || !workingConfig.enabled || !workingConfig.ocr.enabled}
      isEdited={workingConfig.ocr.maxResolution !== savedConfig.ocr.maxResolution}
    />

    <!-- FL-63: off by default; suggestions stay editable and tied to the text they were read from -->
    <SettingToggle
      title={$t('admin.machine_learning_ocr_document_fields')}
      subtitle={$t('admin.machine_learning_ocr_document_fields_description')}
      bind:checked={workingConfig.ocr.documentFields}
      disabled={disabled || !workingConfig.enabled || !workingConfig.ocr.enabled}
      isEdited={!!workingConfig.ocr.documentFields !== !!savedConfig.ocr.documentFields}
    />
  </div>
</SettingGroup>
