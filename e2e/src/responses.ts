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
  unauthorized: (message: any = null) => ({
    message: message ?? expect.anything(),
    displayError: {
      version: 1,
      code: 'http_unauthorized',
      args: {},
      fallback: { locale: 'en', message: 'Authentication is required for this request.' },
    },
  }),
  forbidden: (message: any = null) => ({
    message: message ?? expect.anything(),
    displayError: {
      version: 1,
      code: 'http_forbidden',
      args: {},
      fallback: { locale: 'en', message: 'This request is not permitted.' },
    },
  }),
  conflict: (message: any = null) => ({
    message: message ?? expect.anything(),
    displayError: {
      version: 1,
      code: 'http_conflict',
      args: {},
      fallback: { locale: 'en', message: 'This request conflicts with the current state.' },
    },
  }),
};
