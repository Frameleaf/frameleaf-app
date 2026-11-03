import { getDevelopBatchCapabilities } from '@frameleaf/sdk';

/** Only a missing additive route means an old server; authentication/network failures remain visible. */
export async function hasDevelopBatches(): Promise<boolean> {
  try {
    await getDevelopBatchCapabilities();
    return true;
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined;
    if (status === 404 || status === 405) {
      return false;
    }
    throw error;
  }
}

const reasons = new Set([
  'source_unavailable',
  'credential_unavailable',
  'source_changed',
  'current_revision_changed',
  'batch_cancelled',
  'develop_batch_quota',
  'transfer_checksum',
  'import_rejected',
  'render_failed',
  'export_failed',
  'authentication_required',
  'permission_denied',
  'network_error',
]);
export const batchReason = (code: string | null | undefined) => (reasons.has(code ?? '') ? code! : 'unknown');
export const batchErrorCode = (error: unknown): string => {
  if (
    error &&
    typeof error === 'object' &&
    'data' in error &&
    error.data &&
    typeof error.data === 'object' &&
    'code' in error.data &&
    typeof error.data.code === 'string'
  ) {
    return batchReason(error.data.code);
  }
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined;
  return status === 401
    ? 'authentication_required'
    : status === 403
      ? 'permission_denied'
      : status === undefined
        ? 'network_error'
        : 'unknown';
};
