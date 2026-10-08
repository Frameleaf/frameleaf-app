import { isHttpError } from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { pausedRefusalMessage } from '$lib/frameleaf/cloud-paused';
import { revokeSessionView } from '$lib/utils/session-privacy';

/**
 * FL-161: the server refused a session that is not a Frameleaf sign-in because the request came
 * through remote access. The person has to sign in again; the login page offers what works there.
 */
export const isFrameleafSignInRequired = (error: unknown) =>
  isHttpError(error) &&
  error.status === 403 &&
  (error.data as { code?: unknown } | undefined)?.code === 'frameleaf_sign_in_required';

export function getServerErrorMessage(error: unknown) {
  if (!isHttpError(error)) {
    return;
  }

  // errors for endpoints without return types aren't parsed as json
  let data = error.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      // Not a JSON string
    }
  }

  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    const details = data.errors
      .map(({ path, message }) => {
        const field = path
          .map((segment, i) => (typeof segment === 'number' ? `[${segment}]` : i === 0 ? segment : `.${segment}`))
          .join('');
        return field ? `${field}: ${message}` : message;
      })
      .join(', ');
    return `${data.message}: ${details}`;
  }

  return data?.message || error.message;
}

export function standardizeError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The HTTP status of a refused request: the SDK's `HttpError` (`status`), or the `ApiError` that
 * `uploadRequest` rejects with (`statusCode`).
 */
const statusOf = (error: unknown): number | undefined => {
  if (isHttpError(error)) {
    return error.status;
  }
  if (error instanceof Error && error.name === 'ApiError') {
    const status = (error as { statusCode?: unknown }).statusCode;
    return typeof status === 'number' ? status : undefined;
  }
};

/** What the browser says when a request never got an answer (Chrome, Safari, Firefox). */
const NETWORK_FAILURE = /failed to fetch|load failed|networkerror|network request failed/i;

/** The names HTTP gives its own statuses. They describe the protocol, not what happened. */
const STATUS_TEXT = new Set([
  'bad request',
  'unauthorized',
  'forbidden',
  'forbidden resource',
  'not found',
  'method not allowed',
  'not acceptable',
  'request timeout',
  'conflict',
  'gone',
  'payload too large',
  'request entity too large',
  'unsupported media type',
  'unprocessable entity',
  'too many requests',
  'internal server error',
  'bad gateway',
  'service unavailable',
  'gateway timeout',
  'validation failed',
  'unknown error',
]);

/**
 * Words and shapes that belong to the software, not to the person reading: the permission the
 * server checked (`no album.read access`), a route, a runtime error name, a stack frame, a
 * response that is markup or JSON, a bare status, and the words the brand never says to a customer.
 */
const SYSTEM_TEXT = [
  /\bno \w+\.\w+ access\b/i,
  /\bcannot (get|post|put|patch|delete|head) \//i,
  /^\s*[<[{]/,
  /^\s*(error\b|\d{3}\b)/i,
  /\b\w+(Error|Exception)\b/,
  /\bE[A-Z]{4,}\b/,
  /\b(sql\w*|dto|uuid|undefined|null|nan)\b/i,
  /\bat \S+:\d+/,
  /\b(assets?|immich)\b/i,
];

/**
 * Whether the server's own words are worth showing: a refusal that says something specific in
 * plain language ("That email is already in use"). A status name, anything from a failing server
 * (5xx) and anything that reads as system text are not; the reason for the status is said instead.
 */
const isCustomerMessage = (message: string, status: number | undefined) => {
  const text = message.trim();
  if (!text || (status !== undefined && status >= 500)) {
    return false;
  }
  if (STATUS_TEXT.has(text.replace(/[\s!.]+$/, '').toLowerCase())) {
    return false;
  }
  return !SYSTEM_TEXT.some((pattern) => pattern.test(text));
};

const MESSAGE_LIMIT = 140;

/** One toast line: a long message stops at a word, with an ellipsis, rather than mid-word. */
const shorten = (message: string) => {
  const text = message.trim();
  if (text.length <= MESSAGE_LIMIT) {
    return text;
  }
  const cut = text.slice(0, MESSAGE_LIMIT);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > MESSAGE_LIMIT / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.:;]+$/, '')}…`;
};

type FailureReason =
  | 'offline'
  | 'unreachable'
  | 'sign_in'
  | 'not_allowed'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'server';

const REASON_KEYS: Record<FailureReason, string> = {
  offline: 'frameleaf_error_reason_offline',
  unreachable: 'frameleaf_error_reason_unreachable',
  sign_in: 'frameleaf_error_reason_sign_in',
  not_allowed: 'frameleaf_error_reason_not_allowed',
  not_found: 'frameleaf_error_reason_not_found',
  conflict: 'frameleaf_error_reason_conflict',
  too_large: 'frameleaf_error_reason_too_large',
  server: 'frameleaf_error_reason_server',
};

/** Why a request failed, when the status or the browser says so; undefined when nothing does. */
const reasonFor = (error: unknown): FailureReason | undefined => {
  const status = statusOf(error);
  if (status === undefined) {
    if (!(error instanceof Error) || !NETWORK_FAILURE.test(error.message)) {
      return;
    }
    return typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'unreachable';
  }
  if (status >= 500) {
    return 'server';
  }
  switch (status) {
    case 401: {
      return 'sign_in';
    }
    case 403: {
      return 'not_allowed';
    }
    case 404: {
      return 'not_found';
    }
    case 409: {
      return 'conflict';
    }
    case 413: {
      return 'too_large';
    }
  }
};

/**
 * The message for a failure, in the Frameleaf voice (BRAND.md decision 10): never a status name or
 * a system string.
 *
 * 1. The server's own sentence, when it says something specific in plain words.
 * 2. Otherwise what the caller says is still true (`localizedMessage`), followed by the reason the
 *    status or the browser gives: offline, not reachable, signed out, not allowed, gone, changed
 *    meanwhile, too large, or a problem on the server.
 * 3. With no reason to give, the caller's message alone.
 */
const describeFailure = (error: unknown, localizedMessage: string) => {
  const status = statusOf(error);
  const serverMessage = getServerErrorMessage(error);
  if (serverMessage && isCustomerMessage(serverMessage, status)) {
    return shorten(serverMessage);
  }

  const reason = reasonFor(error);
  if (!reason) {
    return localizedMessage;
  }

  const said = localizedMessage.trim();
  const reasonText = get(t)(REASON_KEYS[reason]);
  if (!said) {
    return reasonText;
  }
  return `${said}${/[!.?…。]$/.test(said) ? '' : '.'} ${reasonText}`;
};

/**
 * FL-56: a public share registers what to do when an action is refused because its link was revoked
 * or expired while the page was open. The share page reloads into its unavailable state instead of
 * leaving the viewer on stale content with a raw server toast. The handler is given `showError`, the
 * normal error toast, for when the reload finds the link still valid and the 401 had another cause.
 */
type UnauthorizedHandler = (showError: () => void) => void;
let unauthorizedHandler: UnauthorizedHandler | undefined;

/**
 * A 401 from the SDK, or from `uploadRequest`, whose XMLHttpRequest rejects with its own `ApiError`
 * (`statusCode`), so a link revoked during an upload reaches the handler too.
 */
const isUnauthorized = (error: unknown) => statusOf(error) === 401;

export const setUnauthorizedHandler = (handler: UnauthorizedHandler | undefined) => {
  unauthorizedHandler = handler;
};

const notifyError = (error: unknown, localizedMessage: string, notify: boolean) => {
  try {
    // FC-62: Frameleaf Cloud paused new work of this kind; its own message is shown whole
    const errorMessage = pausedRefusalMessage(error) ?? describeFailure(error, localizedMessage);

    if (notify) {
      toastManager.danger(errorMessage);
    }

    return errorMessage;
  } catch (error) {
    console.error(error);
    return localizedMessage;
  }
};

export function handleError(error: unknown, localizedMessage: string, options?: { notify?: boolean }) {
  const { notify = true } = options ?? {};
  const standardizedError = standardizeError(error);
  if (standardizedError.name === 'AbortError') {
    return;
  }

  console.error(`[handleError]: ${standardizedError}`, error, standardizedError.stack);

  if (isFrameleafSignInRequired(error)) {
    revokeSessionView('/auth/logout');
    return localizedMessage;
  }

  if (unauthorizedHandler && isUnauthorized(error)) {
    unauthorizedHandler(() => notifyError(error, localizedMessage, notify));
    return localizedMessage;
  }

  return notifyError(error, localizedMessage, notify);
}

export async function handleErrorAsync<T>(fn: () => Promise<T>, localizedMessage: string): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error: unknown) {
    handleError(error, localizedMessage);
    return;
  }
}
