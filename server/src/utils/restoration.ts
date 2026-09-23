import {
  RESTORATION_MAX_LONG_EDGE,
  RESTORATION_WORKLOAD_BY_MODE,
  RestorationMode,
  RestorationModelCapability,
  RestorationModelState,
} from 'src/dtos/restoration-inference.dto.js';
import { MlAdmissionRefusal, MlWorkload } from 'src/enum.js';
import type { RestorationSelection } from 'src/repositories/machine-learning.repository.js';
import {
  MlDestinationRefusedError,
  MlSelectionDeps,
  isCloudDestination,
  routedMlDestinationId,
  selectMlDestination,
} from 'src/utils/ml-destination.js';

/**
 * Restoration selection and sizing (FL-114).
 *
 * A restoration always runs on a destination somebody chose: the person's explicit choice in
 * the restoration flow, or failing that the administrator's route for the mode's workload. It
 * is admitted with the same rule as every other workload (`selectMlDestination`), so it is
 * refused, never moved, when that destination is disabled, unhealthy, over budget, not
 * serving the workload (a worker only serves it while a qualified model is available) or a
 * cloud destination without recorded consent. A cloud destination additionally needs the
 * person's acknowledgement for this request that the media leaves the network; that check
 * happens before the destination is contacted at all.
 *
 * Source access: restoration runs as a background job. Jobs read Locked, hidden and sensitive
 * assets' files without an elevated session (owner decision, September 22, 2026); nothing here
 * applies a visibility filter or asks for one. What the person can see is unchanged.
 */

export const restorationWorkload = (mode: RestorationMode): MlWorkload => RESTORATION_WORKLOAD_BY_MODE[mode];

export type RestorationSelectionRequest = {
  mode: RestorationMode;
  /** The destination the person chose, or null to use the administrator's route. */
  destinationId: string | null;
  /** The person confirmed, for this request, that the media may leave the network. */
  acknowledgeCloudUpload: boolean;
  jobId?: string | null;
  jobName?: string | null;
};

export const selectRestorationDestination = async (
  deps: MlSelectionDeps,
  request: RestorationSelectionRequest,
): Promise<RestorationSelection> => {
  const workload = restorationWorkload(request.mode);
  const destinationId = request.destinationId ?? (await routedMlDestinationId(deps.mlDestinationRepository, workload));

  const destination = await deps.mlDestinationRepository.getById(destinationId);
  if (destination && isCloudDestination(destination.kind) && !request.acknowledgeCloudUpload) {
    throw new MlDestinationRefusedError(
      MlAdmissionRefusal.ConsentMissing,
      workload,
      destination.id,
      `${destination.name} sends the media off this network; confirm the upload for this restoration first`,
    );
  }

  const selection = await selectMlDestination(deps, {
    workload,
    destinationId,
    jobId: request.jobId ?? null,
    jobName: request.jobName ?? null,
  });
  // Carried with the selection so `MachineLearningRepository.restore` can refuse a cloud
  // destination that was not confirmed for this request, whoever admitted it.
  return { ...selection, cloudUploadAcknowledged: request.acknowledgeCloudUpload };
};

const evenFloor = (value: number) => {
  const whole = Math.floor(value + 1e-9);
  return Math.max(2, whole - (whole % 2));
};

/**
 * Output size: `scale` times the source, long edge capped (3840 by default), aspect kept and
 * both sides floored to even numbers.
 *
 * KEEP IN SYNC WITH `target_geometry` in `machine-learning/immich_ml/video_restoration/media.py`.
 */
export const restorationTargetGeometry = (
  width: number,
  height: number,
  scale: 1 | 2,
  maxLongEdge = RESTORATION_MAX_LONG_EDGE,
): { width: number; height: number } => {
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;
  const ratio = Math.min(1, maxLongEdge / Math.max(scaledWidth, scaledHeight));
  return { width: evenFloor(scaledWidth * ratio), height: evenFloor(scaledHeight * ratio) };
};

export type RestorationModelChoice =
  | { available: true; model: RestorationModelCapability }
  | { available: false; reasons: string[] };

/**
 * The model a destination would use for `mode`, mirroring the worker's own choice (the first
 * available model in manifest order), or every reason none is available. With a fingerprint,
 * only that exact model counts.
 */
export const chooseRestorationModel = (
  models: RestorationModelCapability[],
  mode: RestorationMode,
  fingerprint: string | null = null,
): RestorationModelChoice => {
  const forMode = models.filter((model) => model.mode === mode);
  if (forMode.length === 0) {
    return { available: false, reasons: [`no ${mode} model is configured`] };
  }
  const matches = (model: RestorationModelCapability) =>
    model.state === RestorationModelState.Available && (fingerprint === null || model.fingerprint === fingerprint);
  const available = forMode.filter((model) => matches(model));
  if (available.length > 0) {
    return { available: true, model: available[0] };
  }

  const reasons = forMode.map((model) => {
    if (model.state === RestorationModelState.Available) {
      return `${model.id} is not the model the preview was made with`;
    }
    const detail = model.reasons.length > 0 ? ` (${model.reasons.join('; ')})` : '';
    return `${model.id}: ${model.state}${detail}`;
  });
  return { available: false, reasons };
};

/**
 * Estimated runtime from throughput measured during qualification, never from constants. Uses
 * the smallest measured input at least as large as the source on the given GPU (or any GPU when
 * none is named); returns null when nothing measured covers the source, which the caller
 * shows as "no estimate" rather than a guess.
 */
export const estimateRestorationSeconds = (
  model: RestorationModelCapability,
  source: { width: number; height: number; frames: number },
  gpu: string | null = null,
): number | null => {
  const pixels = source.width * source.height;
  const covering = model.measured
    .filter((measurement) => gpu === null || measurement.gpu === gpu)
    .filter((measurement) => measurement.inputWidth * measurement.inputHeight >= pixels)
    .filter((measurement) => measurement.framesPerSecond > 0)
    .sort((a, b) => a.inputWidth * a.inputHeight - b.inputWidth * b.inputHeight);
  if (covering.length === 0) {
    return null;
  }
  return source.frames / covering[0].framesPerSecond;
};
