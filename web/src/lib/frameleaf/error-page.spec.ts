import { describe, expect, it } from 'vitest';
import en from '$i18n/en.json';
import {
  ERROR_COPY,
  errorKind,
  errorStatus,
  isSpaceUnavailableStatus,
  spaceErrorKind,
} from '$lib/frameleaf/error-page';

describe('errorStatus', () => {
  it("prefers the server's own status over SvelteKit's 500 for an unhandled API failure", () => {
    expect(errorStatus(500, { message: 'Not found or no album.read access', code: 400 })).toBe(400);
  });

  it('reads the status of a plain API error', () => {
    expect(errorStatus(undefined, { status: 403 })).toBe(403);
  });

  it('accepts a numeric string code', () => {
    expect(errorStatus(500, { code: '404' })).toBe(404);
  });

  it('falls back to the page status, then to a failure on our side', () => {
    expect(errorStatus(404, { message: 'Not Found' })).toBe(404);
    expect(errorStatus(undefined, new TypeError('Failed to fetch'))).toBe(500);
    expect(errorStatus(null)).toBe(500);
  });

  it('ignores codes that are not HTTP error statuses', () => {
    expect(errorStatus(404, { code: 'ECONNREFUSED' })).toBe(404);
    expect(errorStatus(500, { code: 200 })).toBe(500);
  });
});

describe('errorKind', () => {
  it('explains "not found or no access" as not found, never confirming that something exists', () => {
    expect(errorKind(400)).toBe('not-found');
    expect(errorKind(404)).toBe('not-found');
    expect(errorKind(410)).toBe('not-found');
  });

  it('explains a refusal as no access', () => {
    expect(errorKind(401)).toBe('forbidden');
    expect(errorKind(403)).toBe('forbidden');
  });

  it('explains everything else as a failure on our side', () => {
    expect(errorKind(500)).toBe('server');
    expect(errorKind(502)).toBe('server');
    expect(errorKind(429)).toBe('server');
  });
});

describe('ERROR_COPY', () => {
  it('names strings that exist and never mention another product', () => {
    const strings = en as unknown as Record<string, string>;
    for (const { title, body } of Object.values(ERROR_COPY)) {
      for (const key of [title, body]) {
        expect(strings[key], key).toBeTypeOf('string');
        expect(strings[key]).not.toMatch(/immich|fork/i);
      }
    }
  });
});

describe('shared space errors', () => {
  it('treats "not a space you are in" as unavailable', () => {
    for (const status of [400, 403, 404, 410]) {
      expect(isSpaceUnavailableStatus(status)).toBe(true);
      expect(spaceErrorKind(status)).toBe('unavailable');
    }
  });

  it('treats a server or network failure as a failed load that can be retried', () => {
    expect(isSpaceUnavailableStatus(500)).toBe(false);
    expect(isSpaceUnavailableStatus(undefined)).toBe(false);
    expect(spaceErrorKind(500)).toBe('failed');
    expect(spaceErrorKind(503)).toBe('failed');
  });
});
