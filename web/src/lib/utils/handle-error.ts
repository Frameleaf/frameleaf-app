import { isHttpError } from '@immich/sdk';
import { toastManager } from '@immich/ui';

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
 * leaving the viewer on stale content with a raw server toast.
 */
let unauthorizedHandler: (() => void) | undefined;

export const setUnauthorizedHandler = (handler: (() => void) | undefined) => {
  unauthorizedHandler = handler;
};

export function handleError(error: unknown, localizedMessage: string, options?: { notify?: boolean }) {
  const { notify = true } = options ?? {};
  const standardizedError = standardizeError(error);
  if (standardizedError.name === 'AbortError') {
    return;
  }

  if (unauthorizedHandler && isHttpError(error) && error.status === 401) {
    unauthorizedHandler();
    return localizedMessage;
  }

  console.error(`[handleError]: ${standardizedError}`, error, standardizedError.stack);

  try {
    let serverMessage = getServerErrorMessage(error);
    if (serverMessage) {
      serverMessage = `${serverMessage.slice(0, 75)}\n(Frameleaf Server Error)`;
    }

    const errorMessage = serverMessage || localizedMessage;

    if (notify) {
      toastManager.danger(errorMessage);
    }

    return errorMessage;
  } catch (error) {
    console.error(error);
    return localizedMessage;
  }
}

export async function handleErrorAsync<T>(fn: () => Promise<T>, localizedMessage: string): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error: unknown) {
    handleError(error, localizedMessage);
    return;
  }
}
