/**
 * Presentation rules for a destination's restoration models (FL-114).
 *
 * The worker decides whether a model is available from its pinned revision, verified weights,
 * qualification evidence, license review and GPU; the server relays that report unchanged. This
 * module only turns those facts into labels and tones. It never marks a model usable itself.
 */
import {
  AssetRestorationMode,
  MlWorkload,
  RestorationModelState,
  type MlDestinationResponseDto,
  type RestorationGpuDto,
  type RestorationMeasuredThroughputDto,
  type RestorationModelCapabilityDto,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';

export const RESTORATION_WORKLOADS: readonly MlWorkload[] = [
  MlWorkload.RestorationFaithful,
  MlWorkload.RestorationCreative,
];

/** Whether an administrator allowed restoration work on this destination at all. */
export const allowsRestoration = (destination: Pick<MlDestinationResponseDto, 'workloads'>): boolean =>
  destination.workloads.some((workload) => RESTORATION_WORKLOADS.includes(workload));

export const restorationModeLabelKey = (mode: AssetRestorationMode): Translations =>
  mode === AssetRestorationMode.Creative
    ? 'admin.frameleaf_restoration_models_mode_creative'
    : 'admin.frameleaf_restoration_models_mode_faithful';

export const restorationModelStateLabelKey = (state: RestorationModelState): Translations => {
  switch (state) {
    case RestorationModelState.Available: {
      return 'admin.frameleaf_restoration_models_state_available';
    }
    case RestorationModelState.Verifying: {
      return 'admin.frameleaf_restoration_models_state_verifying';
    }
    case RestorationModelState.NotPinned: {
      return 'admin.frameleaf_restoration_models_state_not_pinned';
    }
    case RestorationModelState.RuntimeMissing: {
      return 'admin.frameleaf_restoration_models_state_runtime_missing';
    }
    case RestorationModelState.RuntimeDirty: {
      return 'admin.frameleaf_restoration_models_state_runtime_dirty';
    }
    case RestorationModelState.WeightsMissing: {
      return 'admin.frameleaf_restoration_models_state_weights_missing';
    }
    case RestorationModelState.WeightsMismatch: {
      return 'admin.frameleaf_restoration_models_state_weights_mismatch';
    }
    case RestorationModelState.Unqualified: {
      return 'admin.frameleaf_restoration_models_state_unqualified';
    }
    case RestorationModelState.LicenseUnreviewed: {
      return 'admin.frameleaf_restoration_models_state_license_unreviewed';
    }
    case RestorationModelState.NoGpu: {
      return 'admin.frameleaf_restoration_models_state_no_gpu';
    }
    case RestorationModelState.GpuUnqualified: {
      return 'admin.frameleaf_restoration_models_state_gpu_unqualified';
    }
    case RestorationModelState.InsufficientVram: {
      return 'admin.frameleaf_restoration_models_state_insufficient_vram';
    }
  }
};

export const restorationModelStateTone = (state: RestorationModelState): 'teal' | 'blue' | 'warning' => {
  if (state === RestorationModelState.Available) {
    return 'teal';
  }
  return state === RestorationModelState.Verifying ? 'blue' : 'warning';
};

/** Values for the `admin.frameleaf_restoration_models_measured` message. */
export const measurementValues = (measurement: RestorationMeasuredThroughputDto) => ({
  width: measurement.inputWidth,
  height: measurement.inputHeight,
  gpu: measurement.gpu,
  fps: Math.round(measurement.framesPerSecond * 100) / 100,
  memory: Math.round((measurement.peakVramBytes / 1024 ** 3) * 10) / 10,
});

/** FL-110: a worker GPU as the admin reads it — name, memory in GiB (1024³ bytes) and driver. */
export const gpuValues = (gpu: RestorationGpuDto) => ({
  name: gpu.name,
  memory: Math.round((gpu.memoryTotalBytes / 1024 ** 3) * 10) / 10,
  driver: gpu.driverVersion,
});

/** FL-110: the input profile a model is qualified for. */
export const modelProfileValues = (
  model: Pick<RestorationModelCapabilityDto, 'maxInputLongEdge' | 'maxFrames' | 'dynamicRanges'>,
) => ({
  edge: model.maxInputLongEdge,
  frames: model.maxFrames,
  ranges: model.dynamicRanges.map((range) => range.toUpperCase()).join(', '),
});
