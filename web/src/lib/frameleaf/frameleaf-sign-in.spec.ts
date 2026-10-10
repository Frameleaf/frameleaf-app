import { beforeEach, describe, expect, it } from 'vitest';
import {
  bounceReturn,
  bounceUrl,
  recordFrameleafRequest,
  takeFrameleafCallback,
  takeFrameleafCallbackRequest,
} from '$lib/frameleaf/frameleaf-sign-in';

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

describe('the home-address sign-in bounce (FL-167)', () => {
  const at = (href: string) => new URL(href) as unknown as Location;

  it('keeps the home address to return to with the request, once', () => {
    const bounce = { returnTo: 'https://192-168-1-10.l.frameleaf.net:2443', nonce: 'n'.repeat(32) };
    recordFrameleafRequest('https://id.test/auth?state=b', 'sign-in', Date.now(), bounce);
    expect(takeFrameleafCallbackRequest('https://r.l.frameleaf.net/auth/login?code=1&state=b')).toEqual({
      purpose: 'sign-in',
      bounce,
    });
    expect(takeFrameleafCallbackRequest('https://r.l.frameleaf.net/auth/login?code=1&state=b')).toBeNull();
  });

  it('sends the home address and a nonce along, and takes back only an https origin', () => {
    const url = bounceUrl(
      'https://r.l.frameleaf.net',
      at('https://192-168-1-10.l.frameleaf.net:2443/auth/login'),
      false,
    );
    const nonce = new URL(url).searchParams.get('frameleafNonce')!;
    expect(sessionStorage.getItem('frameleaf.auth.handoffNonce')).toBe(nonce);
    expect(bounceReturn(at(url))).toEqual({ returnTo: 'https://192-168-1-10.l.frameleaf.net:2443', nonce });
    for (const value of ['http://192.168.1.10:2283', 'javascript:alert(1)', 'nonsense', 'https://r.l.frameleaf.net']) {
      expect(
        bounceReturn(
          at(
            `https://r.l.frameleaf.net/auth/login?frameleafReturn=${encodeURIComponent(value)}&frameleafNonce=${nonce}`,
          ),
        ),
      ).toBeNull();
    }
    // no nonce, no bounce
    expect(bounceReturn(at(url.replace(/&frameleafNonce=[^&]+/, '')))).toBeNull();
  });
});
