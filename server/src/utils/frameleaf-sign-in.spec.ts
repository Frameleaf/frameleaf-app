import { describe, expect, it } from 'vitest';
import {
  FRAMELEAF_APP_CALLBACK,
  frameleafCallbackUrl,
  frameleafRedirectUri,
  frameleafVia,
  isHomeAddress,
  logoutTokenAudiences,
} from 'src/utils/frameleaf-sign-in.js';

const secret = 'edge-secret-0123456789';

describe('Sign in with Frameleaf helpers (FL-158)', () => {
  it('trusts X-Frameleaf-Via only with the edge worker secret', () => {
    expect(frameleafVia({ 'x-frameleaf-via': 'relay', 'x-frameleaf-via-auth': secret }, secret)).toBe('relay');
    expect(frameleafVia({ 'x-frameleaf-via': 'relay', 'x-frameleaf-via-auth': 'guess' }, secret)).toBeNull();
    expect(frameleafVia({ 'x-frameleaf-via': 'relay' }, secret)).toBeNull();
    expect(frameleafVia({ 'x-frameleaf-via': 'relay', 'x-frameleaf-via-auth': secret }, null)).toBeNull();
    expect(frameleafVia({ 'x-frameleaf-via': 'moon', 'x-frameleaf-via-auth': secret }, secret)).toBeNull();
  });

  it('treats private ranges and the configured networks as home', () => {
    expect(isHomeAddress('192.168.1.20', [])).toBe(true);
    expect(isHomeAddress('::ffff:10.1.2.3', [])).toBe(true);
    expect(isHomeAddress('fd12::1', [])).toBe(true);
    expect(isHomeAddress('100.64.1.1', [])).toBe(false);
    expect(isHomeAddress('100.64.1.1', ['100.64.0.0/10'])).toBe(true);
    expect(isHomeAddress('203.0.113.9', [])).toBe(false);
    expect(isHomeAddress('', [])).toBe(false);
  });

  it('accepts only the registered callbacks and rewrites the app scheme', () => {
    expect(frameleafRedirectUri('https://photos.example.test/auth/login?x=1')).toBe(
      'https://photos.example.test/auth/login',
    );
    expect(frameleafRedirectUri('app.immich:///oauth-callback')).toBe(FRAMELEAF_APP_CALLBACK);
    expect(frameleafRedirectUri('https://photos.example.test/elsewhere')).toBeNull();
    expect(frameleafRedirectUri('javascript:alert(1)')).toBeNull();
    expect(frameleafCallbackUrl('app.immich:///oauth-callback?code=1')).toBe(`${FRAMELEAF_APP_CALLBACK}?code=1`);
  });

  it('reads a logout token audience without trusting it', () => {
    const token = (payload: unknown) => `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
    expect(logoutTokenAudiences(token({ aud: 'instance-1' }))).toEqual(['instance-1']);
    expect(logoutTokenAudiences(token({ aud: ['a', 2, 'b'] }))).toEqual(['a', 'b']);
    expect(logoutTokenAudiences('garbage')).toEqual([]);
  });
});
