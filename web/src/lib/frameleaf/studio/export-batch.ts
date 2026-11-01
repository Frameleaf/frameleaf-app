import type { StudioExportBatchCreateDto } from '@frameleaf/sdk';

export type DeliverySubmission = { projectId: string; body: StudioExportBatchCreateDto };

/** Keep the reviewed payload and keys after a lost response or partial admission. */
export function deliverySubmission(
  projectId: string,
  body: Omit<StudioExportBatchCreateDto, 'requestKey'>,
  previous: DeliverySubmission | null,
): DeliverySubmission {
  if (previous) {
    const { requestKey: _, ...prior } = previous.body;
    if (previous.projectId !== projectId || JSON.stringify(prior) !== JSON.stringify(body)) {
      throw new Error('studio_export_batch_changed');
    }
    return previous;
  }
  return { projectId, body: { ...body, requestKey: crypto.randomUUID() } };
}
