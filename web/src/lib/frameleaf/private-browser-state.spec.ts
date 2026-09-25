import { describe, expect, it } from 'vitest';
import { clearPrivateBrowserState, isPrivateBrowserKey } from './private-browser-state';

describe('clearPrivateBrowserState (FL-80)', () => {
  it('removes the account private keys and keeps sign-in choices, display preferences and other keys', () => {
    localStorage.setItem('frameleaf:commands:v1', '["recent"]');
    localStorage.setItem('frameleaf:job-manager-history:v1', '[]');
    localStorage.setItem('frameleaf.enrichment.lastPlan.user-1', '{}');
    localStorage.setItem('frameleaf-thumbnail-size', '200');
    localStorage.setItem('locale', 'en');
    sessionStorage.setItem('frameleaf:system-settings-draft:v1:user-1', '{}');
    sessionStorage.setItem('frameleaf.auth.rememberMe', 'false');

    clearPrivateBrowserState();

    expect(localStorage.getItem('frameleaf:commands:v1')).toBeNull();
    expect(localStorage.getItem('frameleaf:job-manager-history:v1')).toBeNull();
    expect(localStorage.getItem('frameleaf.enrichment.lastPlan.user-1')).toBeNull();
    expect(sessionStorage.getItem('frameleaf:system-settings-draft:v1:user-1')).toBeNull();
    expect(localStorage.getItem('frameleaf-thumbnail-size')).toBe('200');
    expect(localStorage.getItem('locale')).toBe('en');
    expect(sessionStorage.getItem('frameleaf.auth.rememberMe')).toBe('false');
  });

  it('treats a new frameleaf key as private by default', () => {
    expect(isPrivateBrowserKey('frameleaf:some-new-feature:v1')).toBe(true);
    expect(isPrivateBrowserKey('frameleaf.rail.closedSections')).toBe(false);
    expect(isPrivateBrowserKey('immich-ui-theme')).toBe(false);
  });

  it('removes expired sign-in records and keeps a live one', () => {
    const now = Date.now();
    localStorage.setItem(
      'frameleaf.auth.oauthRequest.expired',
      JSON.stringify({ rememberMe: true, continueUrl: null, expiresAt: now - 1 }),
    );
    localStorage.setItem('frameleaf.auth.oauthRequest.damaged', 'not json');
    localStorage.setItem(
      'frameleaf.auth.oauthRequest.future',
      JSON.stringify({ rememberMe: true, continueUrl: null, expiresAt: now + 60 * 60 * 1000 }),
    );
    localStorage.setItem(
      'frameleaf.auth.oauthRequest.live',
      JSON.stringify({ rememberMe: false, continueUrl: null, expiresAt: now + 60_000 }),
    );

    clearPrivateBrowserState();

    expect(localStorage.getItem('frameleaf.auth.oauthRequest.expired')).toBeNull();
    expect(localStorage.getItem('frameleaf.auth.oauthRequest.damaged')).toBeNull();
    expect(localStorage.getItem('frameleaf.auth.oauthRequest.future')).toBeNull();
    expect(localStorage.getItem('frameleaf.auth.oauthRequest.live')).not.toBeNull();
    localStorage.removeItem('frameleaf.auth.oauthRequest.live');
  });
});
