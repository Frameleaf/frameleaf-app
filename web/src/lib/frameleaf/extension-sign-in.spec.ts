import { describe, expect, it } from 'vitest';
import { extensionSignInRequest, isReturnFor } from '$lib/frameleaf/extension-sign-in';

const REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';
const query = (overrides: Record<string, string> = {}) =>
  new URLSearchParams({
    redirect_uri: REDIRECT,
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    state: 'state-0123456789abcdef',
    client: 'edge',
    ...overrides,
  });

describe('the Allow page request (FL-655)', () => {
  it('reads a sign-in from the extension', () => {
    expect(extensionSignInRequest(query())).toEqual({
      redirectUri: REDIRECT,
      codeChallenge: 'a'.repeat(43),
      codeChallengeMethod: 'S256',
      state: 'state-0123456789abcdef',
      client: 'edge',
    });
  });

  it.each<Record<string, string>>([
    { redirect_uri: 'https://evil.example/' },
    { redirect_uri: `${REDIRECT}?x=1` },
    { code_challenge_method: 'plain' },
    { code_challenge: 'short' },
    { state: 'short' },
    { client: 'firefox' },
  ])('refuses %o', (overrides) => {
    expect(extensionSignInRequest(query(overrides))).toBeNull();
  });

  it('only goes back to the extension that asked', () => {
    expect(isReturnFor(`${REDIRECT}?code=c`, REDIRECT)).toBe(true);
    expect(isReturnFor('https://ponmlkjihgfedcbaponmlkjihgfedcba.chromiumapp.org/?code=c', REDIRECT)).toBe(false);
    expect(isReturnFor('not a url', REDIRECT)).toBe(false);
  });
});
