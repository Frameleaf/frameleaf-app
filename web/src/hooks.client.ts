import { isHttpError, type ApiHttpError } from '@frameleaf/sdk';
import type { HandleClientError } from '@sveltejs/kit/hooks';

const DEFAULT_MESSAGE = 'Something went wrong. Try again in a moment.';

const reasonOf = (data: unknown) => {
  const reason = (data as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' ? reason : undefined;
};

const parseHTTPError = (httpError: ApiHttpError) => {
  const statusCode = httpError?.status || httpError?.data?.statusCode || 500;
  const message = httpError?.data?.message || (httpError?.data && String(httpError.data)) || httpError?.message;

  console.log({
    status: statusCode,
    response: httpError?.data || 'No data',
  });

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
  console.error(`[hooks.client.ts]:handleError ${result.message}`, error);
  return { ...result, status: result.code };
};
