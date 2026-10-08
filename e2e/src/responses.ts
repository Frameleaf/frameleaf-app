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
  notFound: (message: any = null) => ({
    message: message ?? expect.anything(),
    displayError: {
      version: 1,
      code: 'http_not_found',
      args: {},
      fallback: { locale: 'en', message: 'The requested resource is unavailable.' },
    },
  }),
};
