import { isHttpError } from '@frameleaf/sdk';

/** FC-62: the codes Frameleaf Cloud answers (503) while staff pause new work of this kind. */
const PAUSED_CODES: ReadonlySet<unknown> = new Set(['capacity', 'service-paused', 'relay-unavailable']);

/**
 * FC-62: Frameleaf Cloud's own message when staff paused new work of this kind (sign-ups, links, relay,
 * processing jobs, backup grants, top-ups): the server answers 503 with the cloud's `code` and the
 * status message staff wrote. It is shown whole, never as a generic error; null for any other failure.
 */
export const pausedRefusalMessage = (error: unknown): string | null => {
  if (!isHttpError(error) || error.status !== 503) {
    return null;
  }
  const data = error.data as { code?: unknown; message?: unknown } | undefined;
  return PAUSED_CODES.has(data?.code) && typeof data?.message === 'string' && data.message.trim()
    ? data.message.trim()
    : null;
};
