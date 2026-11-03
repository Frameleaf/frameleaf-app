import { isHttpError, type ApiHttpError } from '@frameleaf/sdk';
import type { HandleClientError } from '@sveltejs/kit/hooks';
import { dev } from '$app/env';

const DEFAULT_MESSAGE = 'Something went wrong. Try again in a moment.';

const reasonOf = (data: unknown) => {
  const reason = (data as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' ? reason : undefined;
};

const parseHTTPError = (httpError: ApiHttpError) => {
  const statusCode = httpError?.status || httpError?.data?.statusCode || 500;
  const message = httpError?.data?.message || (httpError?.data && String(httpError.data)) || httpError?.message;

  // The full error body (validation detail, ids, correlation ids) is only worth having in development;
  // production builds log the status and message alone so nothing server-side lingers in the console.
  if (dev) {
    console.log({
      status: statusCode,
      response: httpError?.data || 'No data',
    });
  }

  return {
    message: message || DEFAULT_MESSAGE,
    code: statusCode,
    // A machine-readable cause, such as a shared link's `expired`.
    reason: reasonOf(httpError?.data),
    stack: httpError?.stack,
  };
};

const parseError = (error: unknown, status: number, message: string) => {
  if (isHttpError(error)) {
    return parseHTTPError(error);
  }

  return {
    message: (error as Error)?.message || message || DEFAULT_MESSAGE,
    code: status,
  };
};

export const handleError: HandleClientError = ({ error, kind }) => {
  const result = parseError(
    error,
    kind === 'unknown' ? 500 : error.status,
    kind === 'unknown' ? DEFAULT_MESSAGE : error.message,
  );
  if (dev || !isHttpError(error)) {
    console.error(`[hooks.client.ts]:handleError ${result.message}`, error);
  } else {
    // An API error's body stays out of production consoles; the status and message are enough.
    console.error(`[hooks.client.ts]:handleError ${result.code} ${result.message}`);
  }
  return { ...result, status: result.code };
};
