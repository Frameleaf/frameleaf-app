import { expect } from 'vitest';

export const errorDto = {
  badRequest: (message: any = null) => ({
    message: message ?? expect.anything(),
  }),
  notFound: (message: any = null) => ({
    message: message ?? expect.anything(),
  }),
};
