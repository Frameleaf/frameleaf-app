import {
  MachineLearningHardwareAcceleration,
  SmartAlbumBuiltInKind,
  type AdminConfigImageDescriptionDto,
  type AdminConfigNsfwDetectionDto,
} from '@immich/sdk';

/**
 * The Job manager's "Enrichment tasks" (FL-59, CC-42), after the template's `EnrichmentJobDialog`
 * (`JobsManager.jsx:1213-1367`) and its review in `jobs-data.mjs:819-864`. The dialog picks a task
 * and hands one of these actions to the Job manager's review, which runs it on the server.
 */
export type EnrichmentTask = 'descriptions' | 'smart-albums' | 'hardware';
export type EnrichmentTiming = 'now' | 'later';

export type EnrichmentTaskAction =
  | { type: 'description-requeue' }
  | { type: 'description-defer' }
  | { type: 'smart-album'; kind?: SmartAlbumBuiltInKind };

/** The built-in smart-album categories, in the template's order (`SMART_ALBUM_KINDS`). */
export const SMART_ALBUM_KINDS = [
  SmartAlbumBuiltInKind.Travel,
  SmartAlbumBuiltInKind.Documents,
  SmartAlbumBuiltInKind.Screenshots,
  SmartAlbumBuiltInKind.Food,
  SmartAlbumBuiltInKind.Pets,
  SmartAlbumBuiltInKind.Nature,
] as const;

export const enrichmentTaskAction = (
  task: Exclude<EnrichmentTask, 'hardware'>,
  timing: EnrichmentTiming,
  kind: SmartAlbumBuiltInKind | 'all',
): EnrichmentTaskAction => {
  if (task === 'descriptions') {
    return { type: timing === 'now' ? 'description-requeue' : 'description-defer' };
  }
  return kind === 'all' ? { type: 'smart-album' } : { type: 'smart-album', kind };
};

/** The models a hardware preset selects (the template's `descriptionHardwarePreset`, `jobs-data.mjs:1108-1122`). */
const PRESET_MODELS = {
  descriptionModel: 'Qwen/Qwen2.5-VL-3B-Instruct',
  descriptionFallback: 'microsoft/Florence-2-base-ft',
  descriptionDevice: 'AUTO',
  sensitiveModel: 'onnx-community/nsfw_image_detection-ONNX',
  sensitiveDevice: 'AUTO',
} as const;

const acceleratedBackends = new Set<MachineLearningHardwareAcceleration>([
  MachineLearningHardwareAcceleration.Openvino,
  MachineLearningHardwareAcceleration.Cuda,
]);

/**
 * Whether a preset changes the models: an explicit OpenVINO or CUDA preset always does, Auto only
 * once the hardware is known (it keeps the model choices until then).
 */
export const presetSelectsModels = (
  acceleration: MachineLearningHardwareAcceleration,
  detected: MachineLearningHardwareAcceleration | undefined,
) => {
  const resolved = acceleration === MachineLearningHardwareAcceleration.Auto ? detected : acceleration;
  return resolved !== undefined && acceleratedBackends.has(resolved);
};

/**
 * Applies a description hardware preset to the settings draft, so it joins the central settings
 * review instead of saving at once. Returns false when the draft has no machine-learning settings.
 */
export const applyDescriptionHardwarePreset = (
  machineLearning:
    { imageDescription?: AdminConfigImageDescriptionDto; nsfwDetection?: AdminConfigNsfwDetectionDto } | undefined,
  acceleration: MachineLearningHardwareAcceleration,
  detected: MachineLearningHardwareAcceleration | undefined,
): boolean => {
  const description = machineLearning?.imageDescription;
  if (!description) {
    return false;
  }

  description.acceleration = acceleration;
  if (!presetSelectsModels(acceleration, detected)) {
    return true;
  }

  description.modelName = PRESET_MODELS.descriptionModel;
  description.fallbackModelName = PRESET_MODELS.descriptionFallback;
  description.device = PRESET_MODELS.descriptionDevice;
  if (machineLearning.nsfwDetection) {
    machineLearning.nsfwDetection.modelName = PRESET_MODELS.sensitiveModel;
    machineLearning.nsfwDetection.device = PRESET_MODELS.sensitiveDevice;
  }
  return true;
};
