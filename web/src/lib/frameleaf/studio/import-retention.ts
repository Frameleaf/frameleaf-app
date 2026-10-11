import type {
  StudioCancelResult,
  StudioEditorScope,
  StudioProjectImportRef,
  StudioProjectImportUpload,
  StudioPublicationReceipt,
  StudioReceiptPage,
} from './host-contract';

export interface RetentionApi {
  register(projectId: string, importId: string, publicationId: string): Promise<StudioPublicationReceipt>;
  upload(projectId: string, upload: StudioProjectImportUpload): Promise<StudioProjectImportRef>;
  discover(projectId: string, cursor?: string): Promise<StudioReceiptPage>;
  cancel(projectId: string, importId: string, publicationId: string): Promise<StudioCancelResult>;
}

/** A receipt acknowledges durable registration, never the retention of unsubmitted bytes. */
export async function submitRetainedImport(
  api: RetentionApi,
  scope: StudioEditorScope,
  isCurrent: () => boolean,
  upload: StudioProjectImportUpload & { publicationId: string },
): Promise<StudioProjectImportRef> {
  if (!isCurrent()) throw new Error('origin_retired');
  const receipt = await api.register(scope.projectId, upload.id, upload.publicationId);
  if (!isCurrent()) throw new Error('origin_retired');
  if (receipt.publicationId !== upload.publicationId || receipt.importId !== upload.id) {
    throw new Error('receipt_binding_changed');
  }
  if (receipt.state === 'aborted') throw new Error('publication_aborted');
  // Even a published receipt needs the immutable byte/provenance check on an explicit retry.
  // A late committed response belongs to this origin; retirement must not turn it into rollback.
  return api.upload(scope.projectId, { ...upload, scope });
}

export async function reconcileRetainedImports(
  api: RetentionApi,
  scope: StudioEditorScope,
  isCurrent: () => boolean,
  cursor?: string,
): Promise<StudioReceiptPage> {
  if (!isCurrent()) throw new Error('origin_retired');
  const page = await api.discover(scope.projectId, cursor);
  if (!isCurrent()) throw new Error('origin_retired');
  if (page.items.length > 100) throw new Error('invalid_receipt_page');
  return page;
}

// Callbacks and request queues are session-only; the server owns every durable receipt.
const retirementCallbacks = new Set<() => void>();
export const onStudioImportSessionRetired = (callback: () => void) => {
  retirementCallbacks.add(callback);
  return () => {
    retirementCallbacks.delete(callback);
  };
};
export const retireStudioImportSessions = () => {
  const callbacks = [...retirementCallbacks];
  retirementCallbacks.clear();
  for (const callback of callbacks) {
    try {
      callback();
    } catch {
      /* A teardown failure must not stop session retirement. */
    }
  }
};
