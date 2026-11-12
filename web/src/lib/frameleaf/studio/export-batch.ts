import type { StudioExportBatchCreateDto, StudioExportCreateDto } from '@frameleaf/sdk';
import { newRequestKey } from '$lib/frameleaf/request-key';

/**
 * One "Export more than one shape" request. The batch API takes the reframed shapes only, so Original
 * is queued as an ordinary export beside it (FL-1120); each part keeps its own idempotency key.
 */
export type DeliveryRequest = {
  batch: Omit<StudioExportBatchCreateDto, 'requestKey'> | null;
  original: Omit<StudioExportCreateDto, 'requestKey'> | null;
};
export type DeliverySubmission = {
  projectId: string;
  batch: StudioExportBatchCreateDto | null;
  original: StudioExportCreateDto | null;
};

const withoutKey = <T extends { requestKey?: string }>(value: T | null) => {
  if (!value) {
    return null;
  }
  const { requestKey: _, ...rest } = value;
  return rest;
};

/** Keep the reviewed payload and keys after a lost response or partial admission. */
export function deliverySubmission(
  projectId: string,
  request: DeliveryRequest,
  previous: DeliverySubmission | null,
): DeliverySubmission {
  if (previous) {
    const prior = { batch: withoutKey(previous.batch), original: withoutKey(previous.original) };
    if (previous.projectId !== projectId || JSON.stringify(prior) !== JSON.stringify(request)) {
      throw new Error('studio_export_batch_changed');
    }
    return previous;
  }
  return {
    projectId,
    batch: request.batch && { ...request.batch, requestKey: newRequestKey() },
    original: request.original && { ...request.original, requestKey: newRequestKey() },
  };
}
