import type { Translations } from 'svelte-i18n';

/**
 * Failure handling shared by every inline edit in the Frameleaf information panel (FL-36).
 *
 * The panel never mutates anything locally: description, date and timezone, location,
 * tags and rating all go through the production change endpoints. What this module owns is
 * what happens when one of those calls fails, so every editor reacts the same way instead of
 * each one inventing its own toast.
 *
 * Four outcomes matter to the person editing:
 *
 * - `invalid`   the value was rejected (400/422). Retrying the same value cannot help; the
 *               editor keeps the text so it can be corrected.
 * - `stale`     the asset moved out from under the panel (404/409/410) — trashed, deleted or
 *               changed by another session. The editor offers a reload, not a retry, because
 *               replaying the write would clobber whatever is there now.
 * - `forbidden` the signed-in user may not change this asset (401/403). Neither retry nor
 *               reload helps; the control is left alone and the reason is stated.
 * - `network`   the request never reached a verdict (offline, timeout, 429, 5xx). Safe to
 *               retry with the same value.
 *
 * Anything else is `unknown` and is treated as retryable, because the write may not have
 * been applied and the person can see the result either way.
 *
 * Pure so the classification can be tested without rendering the viewer.
 */
export type InlineEditFailure = 'invalid' | 'stale' | 'forbidden' | 'network' | 'unknown';

/** What the editor should offer after a failure. */
export type InlineEditRecovery = 'retry' | 'reload' | 'none';

/**
 * The HTTP status of a rejected SDK call. Read structurally rather than through
 * `isHttpError`, whose `instanceof` check fails for an error that crossed a module boundary
 * — and a panel that could not tell a 403 from a timeout would offer the wrong recovery.
 */
const statusOf = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const candidate = error as { status?: unknown; data?: string | { statusCode?: unknown } };
  const data = typeof candidate.data === 'object' ? candidate.data : undefined;
  for (const value of [candidate.status, data?.statusCode]) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
};

/** True for the browser's own "the request never left" errors. */
const isTransport = (error: unknown): boolean => {
  if (error instanceof TypeError) {
    return true;
  }
  const name = error instanceof Error ? error.name : undefined;
  return name === 'NetworkError' || name === 'TimeoutError';
};

export function classifyInlineEditError(error: unknown): InlineEditFailure {
  const status = statusOf(error);

  if (status === undefined) {
    return isTransport(error) ? 'network' : 'unknown';
  }

  if (status === 400 || status === 422) {
    return 'invalid';
  }
  if (status === 401 || status === 403) {
    return 'forbidden';
  }
  if ([404, 409, 410].includes(status)) {
    return 'stale';
  }
  // 408 and 429 are "come back later"; a 0 status is a request that never got a response.
  if (status === 0 || status === 408 || status === 429 || status >= 500) {
    return 'network';
  }
  return 'unknown';
}

export const inlineEditRecovery = (failure: InlineEditFailure): InlineEditRecovery => {
  switch (failure) {
    case 'invalid':
    case 'forbidden': {
      return 'none';
    }
    case 'stale': {
      return 'reload';
    }
    default: {
      return 'retry';
    }
  }
};

/** The translated explanation shown beside the control that failed. */
export const inlineEditMessageKey = (failure: InlineEditFailure): Translations => `frameleaf_info_error_${failure}`;

export type InlineEditOutcome<T> =
  { ok: true; value: T } | { ok: false; failure: InlineEditFailure; recovery: InlineEditRecovery; error: unknown };

/**
 * Run one inline edit and classify its failure. The caller keeps the returned outcome so it
 * can render the message and the matching recovery control; nothing is logged or toasted
 * here, because the panel shows failures in place rather than as transient notifications.
 */
export async function runInlineEdit<T>(action: () => Promise<T>): Promise<InlineEditOutcome<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    const failure = classifyInlineEditError(error);
    return { ok: false, failure, recovery: inlineEditRecovery(failure), error };
  }
}
