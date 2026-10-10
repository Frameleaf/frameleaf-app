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
const isUnauthorized = (error: unknown) =>
  isHttpError(error)
    ? error.status === 401
    : error instanceof Error && error.name === 'ApiError' && (error as { statusCode?: number }).statusCode === 401;

export const setUnauthorizedHandler = (handler: UnauthorizedHandler | undefined) => {
  unauthorizedHandler = handler;
};

const statusOf = (error: unknown) =>
  isHttpError(error) ? error.status : (error as { statusCode?: number } | undefined)?.statusCode;

/**
 * What the server's answer means, in the customer's words (BRAND.md: never a server message or a
 * status code). Anything else is covered by the caller's own message.
 */
const customerReason = (error: unknown) => {
  const status = statusOf(error);
  if (status === undefined) {
    return;
  }
  const $t = get(t);
  if (status === 401 || status === 403) {
    return $t('frameleaf_error_forbidden_title');
  }
  if (status === 404) {
    return $t('frameleaf_error_reason_not_found');
  }
  if (status === 413) {
    return $t('frameleaf_error_reason_too_large');
  }
  if (status === 429 || status >= 500) {
    return $t('frameleaf_error_reason_try_later');
  }
};

const notifyError = (error: unknown, localizedMessage: string, notify: boolean) => {
  try {
    // FC-62: Frameleaf Cloud paused new work of this kind; its own message is shown whole
    const paused = pausedRefusalMessage(error);
    const reason = paused ?? customerReason(error);
    const errorMessage = reason ? `${localizedMessage}\n${reason}` : localizedMessage;

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
