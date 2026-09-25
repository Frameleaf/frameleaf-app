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
});
