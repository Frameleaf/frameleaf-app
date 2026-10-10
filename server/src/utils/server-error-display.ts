/** FL-328: display metadata only; HTTP status and existing domain fields still decide what a client may do. */
const GENERAL_ERRORS: Partial<Record<number, { code: string; message: string }>> = {
  400: { code: 'http_bad_request', message: 'This request could not be accepted.' },
  401: { code: 'http_unauthorized', message: 'Authentication is required for this request.' },
  403: { code: 'http_forbidden', message: 'This request is not permitted.' },
  404: { code: 'http_not_found', message: 'The requested resource is unavailable.' },
  409: { code: 'http_conflict', message: 'This request conflicts with the current state.' },
  413: { code: 'http_payload_too_large', message: 'This request is too large.' },
  422: { code: 'http_unprocessable_entity', message: 'This request could not be processed.' },
  429: { code: 'http_rate_limited', message: 'Too many requests. Try again later.' },
  500: { code: 'http_internal_error', message: 'An internal server error occurred.' },
  502: { code: 'http_bad_gateway', message: 'A required service is unavailable.' },
  503: { code: 'http_unavailable', message: 'This service is unavailable.' },
  504: { code: 'http_gateway_timeout', message: 'A required service did not respond in time.' },
};

// Copy only the scalar arguments already owned by these producers. Never copy a provider's `data` or `args`.
const ARGUMENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  setup_code_invalid: ['attemptsLeft'],
  rate_limited: ['retryAfter'],
  'service-paused': ['retryAfterSeconds'],
};

export const serverErrorDisplay = (status: number, body: Record<string, unknown>, code?: string) => {
  const general = GENERAL_ERRORS[status] ?? { code: 'http_error', message: 'This request could not be completed.' };
  const args: Record<string, number> = {};
  const fields =
    typeof body.code === 'string' && Object.hasOwn(ARGUMENT_FIELDS, body.code) ? ARGUMENT_FIELDS[body.code] : undefined;
  for (const field of fields ?? []) {
    const value = body[field];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      args[field] = value;
    }
  }

  return { version: 1, code: code ?? general.code, args, fallback: { locale: 'en', message: general.message } };
};
