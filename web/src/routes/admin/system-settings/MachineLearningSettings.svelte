<script lang="ts">
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { getMachineLearningHardware, MachineLearningHardwareAcceleration } from '@immich/sdk';
  import { isEqual } from 'lodash-es';
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import AvailabilityChecksSection from './machine-learning/AvailabilityChecksSection.svelte';
  import DuplicateDetectionSection from './machine-learning/DuplicateDetectionSection.svelte';
  import FacialRecognitionSection from './machine-learning/FacialRecognitionSection.svelte';
  import ImageDescriptionSection from './machine-learning/ImageDescriptionSection.svelte';
  import {
    hardwareAcceleration,
    imageEnrichmentHardwarePresets,
    isImageEnrichmentHardwareAcceleration,
  } from './machine-learning/machine-learning-helpers';
  import MlUrlsSection from './machine-learning/MlUrlsSection.svelte';
  import NsfwDetectionSection from './machine-learning/NsfwDetectionSection.svelte';
  import OcrSection from './machine-learning/OcrSection.svelte';
  import SearchLabelsSection from './machine-learning/SearchLabelsSection.svelte';
  import SmartSearchSection from './machine-learning/SmartSearchSection.svelte';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const configToEdit = $derived(settingsDraft.draft);
  const config = $derived(settingsDraft.baseline);
  // Detected hardware preference, used to seed the "Auto" hardware
  // dropdown and apply matching preset model names.
  let detectedAcceleration = $state<MachineLearningHardwareAcceleration>();

  // Convenience slices into the live config. Zod's `.default(...)` makes
  // these optional in the generated DTO type even though the server
  // always materialises them — non-null assertions mirror the pre-refactor
  // behavior.
  const imageDescription = $derived(configToEdit.machineLearning.imageDescription!);
  const savedImageDescription = $derived(config.machineLearning.imageDescription!);
  const nsfwDetection = $derived(configToEdit.machineLearning.nsfwDetection!);
  const savedNsfwDetection = $derived(config.machineLearning.nsfwDetection!);

  const detectMachineLearningHardware = async () => {
    try {
      // No destinationId: the server probes the first enabled local destination, never a cloud one.
      const hardware = await getMachineLearningHardware({});
      const preferredAcceleration = hardware.preferredAcceleration;

      if (isImageEnrichmentHardwareAcceleration(preferredAcceleration)) {
        detectedAcceleration = preferredAcceleration;
        if (imageDescription.acceleration === hardwareAcceleration.Auto) {
          // Apply the detected preset to the image-description and NSFW
          // slices, matching pre-refactor onMount behavior.
          applyDetectedPreset(preferredAcceleration);
        }
      }
    } catch {
      detectedAcceleration = undefined;
    }
  };

  const applyDetectedPreset = (acceleration: MachineLearningHardwareAcceleration) => {
    if (!isImageEnrichmentHardwareAcceleration(acceleration)) {
      return;
    }
    const preset = imageEnrichmentHardwarePresets[acceleration];
    imageDescription.modelName = preset.imageDescriptionModelName;
    imageDescription.fallbackModelName = preset.imageDescriptionFallbackModelName;
    imageDescription.device = preset.imageDescriptionDevice;
    nsfwDetection.modelName = preset.nsfwDetectionModelName;
    nsfwDetection.device = preset.nsfwDetectionDevice;
  };

  onMount(() => {
    void detectMachineLearningHardware();
  });

  // Track whether the ML config has unsaved edits — used by the "auto"
  // hardware select's `isEdited` flag in ImageDescriptionSection.
  const isMachineLearningConfigEdited = $derived(!isEqual(configToEdit.machineLearning, config.machineLearning));
</script>

<div class="mt-2">
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" class="mx-4 mt-4" onsubmit={(event) => event.preventDefault()}>
      <MlUrlsSection
        bind:workingConfig={configToEdit.machineLearning}
        savedConfig={config.machineLearning}
        {disabled}
      />

      <AvailabilityChecksSection
        workingConfig={configToEdit.machineLearning}
        savedConfig={config.machineLearning}
        {disabled}
      />

      <SmartSearchSection
        workingConfig={configToEdit.machineLearning}
        savedConfig={config.machineLearning}
        {disabled}
      />

      <SearchLabelsSection
        workingConfig={configToEdit.machineLearning}
        savedConfig={config.machineLearning}
        {disabled}
      />

      <DuplicateDetectionSection
        workingConfig={configToEdit.machineLearning}
        savedConfig={config.machineLearning}
        {disabled}
      />

      <FacialRecognitionSection
        workingConfig={configToEdit.machineLearning}
        savedConfig={config.machineLearning}
        {disabled}
      />

      <OcrSection workingConfig={configToEdit.machineLearning} savedConfig={config.machineLearning} {disabled} />

      <ImageDescriptionSection
        workingConfig={configToEdit.machineLearning}
        {imageDescription}
        {savedImageDescription}
        {nsfwDetection}
        {detectedAcceleration}
        {isMachineLearningConfigEdited}
        {disabled}
      />

      <NsfwDetectionSection
        workingConfig={configToEdit.machineLearning}
        {nsfwDetection}
        {savedNsfwDetection}
        {disabled}
      />

      <SettingActions keys={['machineLearning', 'localFeatures']} {disabled} />
    </form>
  </div>
</div>
