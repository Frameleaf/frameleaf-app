import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRememberMePreference,
  getOAuthContinue,
  consumeLogoutPreference,
  preservePreferenceForPasswordChange,
  OAUTH_REQUEST_TTL_MS,
  recordOAuthRequest,
  rememberMePreference,
  restoreOAuthRequest,
  setOAuthContinue,
  setRememberMePreference,
} from './auth-session-preference';

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('auth session preference', () => {
  it('defaults to persistent login and forgets a nonpersistent choice on normal logout', () => {
    expect(rememberMePreference()).toBe(true);
    setRememberMePreference(false);
    expect(rememberMePreference()).toBe(false);
    consumeLogoutPreference();
    expect(rememberMePreference()).toBe(true);
  });

  it('carries a nonpersistent choice through exactly one forced-password logout', () => {
    setRememberMePreference(false);
    preservePreferenceForPasswordChange();
    consumeLogoutPreference();
    expect(rememberMePreference()).toBe(false);
    consumeLogoutPreference();
    expect(rememberMePreference()).toBe(true);
  });

  it('clears a completed OAuth or password login choice', () => {
    setRememberMePreference(false);
    clearRememberMePreference();
    expect(rememberMePreference()).toBe(true);
  });

  it('revalidates a provider continuation and forgets it on a completed login', () => {
    setOAuthContinue('/locked?tab=albums');
    expect(String(getOAuthContinue('/photos'))).toBe(`${location.origin}/locked?tab=albums`);
    clearRememberMePreference();
    expect(String(getOAuthContinue('/photos'))).toBe(`${location.origin}/photos`);
  });

  it('rejects an externally injected continuation on the provider callback', () => {
    setOAuthContinue('https://outside.example.test/steal');
    expect(getOAuthContinue('/photos')).toBe('/photos');
  });

  it('refuses a nonpersistent choice when tab storage is unavailable', () => {
    const setItem = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      expect(setRememberMePreference(false)).toBe(false);
    } finally {
      setItem.mockRestore();
    }
  });

  describe('OAuth callback in another tab (FL-80)', () => {
    const authorize = 'https://id.example/authorize?client_id=frameleaf&state=abc123&redirect_uri=x';
    const callback = 'http://localhost/auth/login?code=code-1&state=abc123';

    it('hands the sign-in choices to the tab that receives the callback, once', () => {
      setRememberMePreference(false);
      setOAuthContinue('/albums');
      recordOAuthRequest(authorize, 1000);

      // the callback arrives in a new tab: its session storage is empty
      sessionStorage.clear();
      restoreOAuthRequest(callback, 2000);

      expect(rememberMePreference()).toBe(false);
      expect(new URL(String(getOAuthContinue('/photos')), 'http://localhost:3000').pathname).toBe('/albums');

      sessionStorage.clear();
      restoreOAuthRequest(callback, 3000);
      expect(rememberMePreference()).toBe(true);
    });

    it('ignores an expired record and a callback without a state', () => {
      setRememberMePreference(false);
      recordOAuthRequest(authorize, 1000);
      sessionStorage.clear();

      restoreOAuthRequest(callback, 1000 + OAUTH_REQUEST_TTL_MS + 1);
      expect(rememberMePreference()).toBe(true);

      restoreOAuthRequest('http://localhost/auth/login?code=code-1', 2000);
      expect(rememberMePreference()).toBe(true);
    });

    it('never lets another origin through as the continue address', () => {
      setOAuthContinue('https://evil.example/');
      recordOAuthRequest(authorize, 1000);
      sessionStorage.clear();
      restoreOAuthRequest(callback, 2000);

      expect(String(getOAuthContinue('/photos'))).not.toContain('evil.example');
    });
  });
});
