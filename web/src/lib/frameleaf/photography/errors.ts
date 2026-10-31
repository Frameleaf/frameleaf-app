/**
 * Why a photography request failed, as a code the page turns into a translated sentence
 * (PhotographyStatus.svelte `photographyErrorKey`). The request helpers never throw English text:
 * the error's `message` is the code, for logs only.
 */
export const photographyErrorCodes = [
  'settings_changed',
  'collection_changed',
  'access_ended',
  'wait',
  'logo_unavailable',
  'not_ready',
  'watermark_preview',
  'request_failed',
] as const;
export type PhotographyErrorCode = (typeof photographyErrorCodes)[number];

export class PhotographyError extends Error {
  override readonly name = 'PhotographyError';
  readonly code: PhotographyErrorCode;
  /** The HTTP status, when the server answered. */
  readonly status?: number;

  constructor(code: PhotographyErrorCode, status?: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** The code for an answer the server refused, by its status alone. */
export const codeForStatus = (status: number): PhotographyErrorCode => {
  if ([401, 403, 410].includes(status)) {
    return 'access_ended';
  }
  if (status === 409) {
    return 'collection_changed';
  }
  if (status === 429) {
    return 'wait';
  }
  return 'request_failed';
};
