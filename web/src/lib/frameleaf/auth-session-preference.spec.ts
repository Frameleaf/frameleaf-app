import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRememberMePreference,
  getForcedPasswordContinue,
  getOAuthContinue,
  consumeLogoutPreference,
  preservePreferenceForPasswordChange,
  preserveOAuthContinueForPasswordChange,
  rememberMePreference,
  setOAuthContinue,
  setRememberMePreference,
} from './auth-session-preference';

afterEach(() => sessionStorage.clear());

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

  it('revalidates a provider continuation and keeps it through a forced-password relogin', () => {
    setOAuthContinue('/locked?tab=albums');
    expect(String(getOAuthContinue('/photos'))).toBe(`${location.origin}/locked?tab=albums`);
    preserveOAuthContinueForPasswordChange();
    preservePreferenceForPasswordChange();
    consumeLogoutPreference();
    expect(String(getForcedPasswordContinue('/photos'))).toBe(`${location.origin}/locked?tab=albums`);
    clearRememberMePreference();
    expect(getForcedPasswordContinue('/photos')).toBe('/photos');
  });

  it('preserves an OAuth continuation through forced-password logout with the default persistent choice', () => {
    setOAuthContinue('/albums');
    preserveOAuthContinueForPasswordChange();
    preservePreferenceForPasswordChange();
    consumeLogoutPreference();
    expect(String(getForcedPasswordContinue('/photos'))).toBe(`${location.origin}/albums`);
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
});
