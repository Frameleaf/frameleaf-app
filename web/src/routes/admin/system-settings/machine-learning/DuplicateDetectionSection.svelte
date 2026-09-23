<script lang="ts">
  import SettingGroup from '$lib/components/frameleaf/settings/SettingGroup.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
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
  key="duplicate-detection"
  title={$t('admin.machine_learning_duplicate_detection')}
  subtitle={$t('admin.machine_learning_duplicate_detection_setting_description')}
>
  <div class="flex flex-col gap-4">
    <SettingToggle
      title={$t('admin.machine_learning_duplicate_detection_enabled')}
      subtitle={$t('admin.machine_learning_duplicate_detection_enabled_description')}
      bind:checked={workingConfig.duplicateDetection.enabled}
      disabled={disabled || !workingConfig.enabled || !workingConfig.clip.enabled}
    />

    <SettingToggle
      title={$t('admin.machine_learning_duplicate_detection_prefer_original_format')}
      subtitle={$t('admin.machine_learning_duplicate_detection_prefer_original_format_description')}
      bind:checked={workingConfig.duplicateDetection.preferOriginalFormat}
      disabled={disabled || !featureFlagsManager.value.duplicateDetection}
    />

    <hr />

    <SettingField
      inputType={SettingInputFieldType.NUMBER}
      label={$t('admin.machine_learning_max_detection_distance')}
      bind:value={workingConfig.duplicateDetection.maxDistance}
      step="0.0005"
      min={0.001}
      max={0.1}
      description={$t('admin.machine_learning_max_detection_distance_description')}
      disabled={disabled || !featureFlagsManager.value.duplicateDetection}
      isEdited={workingConfig.duplicateDetection.maxDistance !== savedConfig.duplicateDetection.maxDistance}
    />

    <hr />

    <SettingToggle
      title={$t('admin.enhanced_video_duplicate_detection_enabled')}
      subtitle={$t('admin.enhanced_video_duplicate_detection_enabled_description')}
      bind:checked={workingConfig.duplicateDetection.enhancedVideo.enabled}
      disabled={disabled || !featureFlagsManager.value.duplicateDetection}
    />

    <SettingField
      inputType={SettingInputFieldType.NUMBER}
      label={$t('admin.enhanced_video_duplicate_detection_frame_count')}
      bind:value={workingConfig.duplicateDetection.enhancedVideo.frameCount}
      step="1"
      min={2}
      max={8}
      description={$t('admin.enhanced_video_duplicate_detection_frame_count_description')}
      disabled={disabled || !featureFlagsManager.value.duplicateDetection}
      isEdited={workingConfig.duplicateDetection.enhancedVideo.frameCount !==
        savedConfig.duplicateDetection.enhancedVideo.frameCount}
    />

    <SettingField
      inputType={SettingInputFieldType.NUMBER}
      label={$t('admin.enhanced_video_duplicate_detection_min_matching_frames')}
      bind:value={workingConfig.duplicateDetection.enhancedVideo.minMatchingFrames}
      step="1"
      min={1}
      max={workingConfig.duplicateDetection.enhancedVideo.frameCount}
      description={$t('admin.enhanced_video_duplicate_detection_min_matching_frames_description')}
      disabled={disabled || !featureFlagsManager.value.duplicateDetection}
      isEdited={workingConfig.duplicateDetection.enhancedVideo.minMatchingFrames !==
        savedConfig.duplicateDetection.enhancedVideo.minMatchingFrames}
    />

    <SettingField
      inputType={SettingInputFieldType.NUMBER}
      label={$t('admin.enhanced_video_duplicate_detection_max_distance')}
      bind:value={workingConfig.duplicateDetection.enhancedVideo.maxDistance}
      step="0.0005"
      min={0.001}
      max={0.1}
      description={$t('admin.enhanced_video_duplicate_detection_max_distance_description')}
      disabled={disabled || !featureFlagsManager.value.duplicateDetection}
      isEdited={workingConfig.duplicateDetection.enhancedVideo.maxDistance !==
        savedConfig.duplicateDetection.enhancedVideo.maxDistance}
    />
  </div>
</SettingGroup>
