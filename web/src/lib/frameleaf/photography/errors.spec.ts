import { codeForStatus, PhotographyError, photographyErrorCodes } from './errors';

describe('photography request errors', () => {
  it('reads the reason from the status alone', () => {
    for (const status of [401, 403, 410]) {
      expect(codeForStatus(status)).toBe('access_ended');
    }
    expect(codeForStatus(409)).toBe('collection_changed');
    expect(codeForStatus(429)).toBe('wait');
    expect(codeForStatus(500)).toBe('request_failed');
  });

  it('carries a code and status, and never an English sentence', () => {
    const error = new PhotographyError('not_ready', 404);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('not_ready');
    expect(error.status).toBe(404);
    expect(photographyErrorCodes).toContain(error.message);
  });
});
