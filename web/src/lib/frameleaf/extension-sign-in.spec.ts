import { describe, expect, it } from 'vitest';
import {
  extensionSignInRequest,
  isReturnFor,
  keepExtensionContinue,
  takeExtensionContinue,
} from '$lib/frameleaf/extension-sign-in';

const REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';
const query = (overrides: Record<string, string> = {}) =>
  new URLSearchParams({
    redirect_uri: REDIRECT,
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    state: 'state-0123456789abcdef',
    client: 'edge',
    installation: 'installation-one-0123',
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
      installationId: 'installation-one-0123',
    });
  });

  it.each<Record<string, string>>([
    { redirect_uri: 'https://evil.example/' },
    { redirect_uri: `${REDIRECT}?x=1` },
    { code_challenge_method: 'plain' },
    { code_challenge: 'short' },
    { state: 'short' },
    { client: 'firefox' },
    { installation: 'short' },
    { installation: '' },
  ])('refuses %o', (overrides) => {
    expect(extensionSignInRequest(query(overrides))).toBeNull();
  });

  it('only goes back to the extension that asked', () => {
    expect(isReturnFor(`${REDIRECT}?code=c`, REDIRECT)).toBe(true);
    expect(isReturnFor('https://ponmlkjihgfedcbaponmlkjihgfedcba.chromiumapp.org/?code=c', REDIRECT)).toBe(false);
    expect(isReturnFor('not a url', REDIRECT)).toBe(false);
  });
});

describe('Not you? through a provider’s sign-out (FL-655)', () => {
  it('keeps the Allow page to come back to, once', () => {
    keepExtensionContinue('/auth/allow-extension?client=chrome');
    expect(takeExtensionContinue()).toBe('/auth/allow-extension?client=chrome');
    expect(takeExtensionContinue()).toBeNull();
  });
  it('keeps nothing else', () => {
    keepExtensionContinue('/photos');
    keepExtensionContinue('https://evil.example/auth/allow-extension');
    expect(takeExtensionContinue()).toBeNull();
  });
});
