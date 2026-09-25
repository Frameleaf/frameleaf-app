import { beforeEach, describe, expect, it } from 'vitest';
import { recordFrameleafRequest, takeFrameleafCallback } from '$lib/frameleaf/frameleaf-sign-in';

describe('Frameleaf sign-in requests (FL-158)', () => {
  beforeEach(() => localStorage.clear());

  it('recognises its own callback once, by state', () => {
    expect(recordFrameleafRequest('https://id.test/auth?state=abc', 'link')).toBe(true);
    expect(takeFrameleafCallback('https://photos.test/link?code=1&state=abc')).toBe('link');
    expect(takeFrameleafCallback('https://photos.test/link?code=1&state=abc')).toBeNull();
  });

  it('ignores the other provider’s callbacks and expired requests', () => {
    expect(takeFrameleafCallback('https://photos.test/auth/login?code=1&state=other')).toBeNull();
    recordFrameleafRequest('https://id.test/auth?state=old', 'sign-in', Date.now() - 16 * 60 * 1000);
    expect(takeFrameleafCallback('https://photos.test/auth/login?code=1&state=old')).toBeNull();
    expect(recordFrameleafRequest('https://id.test/auth', 'sign-in')).toBe(false);
  });
});
