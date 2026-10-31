import { expect } from 'vitest';

export const errorDto = {
  badRequest: (message: any = null) => ({
    message: message ?? expect.anything(),
    displayError: {
      version: 1,
      code: 'http_bad_request',
      args: {},
      fallback: { locale: 'en', message: 'This request could not be accepted.' },
    },
  }),
  validationError: (errors?: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>) => ({
    message: 'Validation failed',
    errors: errors ? expect.arrayContaining(errors.map((e) => expect.objectContaining(e))) : expect.any(Array),
    displayError: {
      version: 1,
      code: 'request_validation_failed',
      args: {},
      fallback: { locale: 'en', message: 'This request could not be accepted.' },
    },
  }),
};
