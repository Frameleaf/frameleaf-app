import type { Request } from 'express';
import { oauthIssuer } from 'src/utils/oauth-issuer.js';

const request = (values: Record<string, unknown> = {}) =>
  ({ headers: { host: 'LIBRARY.example:443', 'x-forwarded-proto': 'https' }, secure: false, ...values }) as Request;

describe('OAuth issuer transport and canonical origin', () => {
  it('canonicalizes default ports without treating forwarded HTTPS as trusted assistant transport', () => {
    expect(oauthIssuer(request())).toBe('https://library.example');
    expect(oauthIssuer(request(), true)).toBe('http://library.example:443');
  });

  it('uses the middleware TLS decision for assistant discovery and token requests', () => {
    expect(oauthIssuer(request({ frameleafTrustedTls: true }), true)).toBe('https://library.example');
    expect(oauthIssuer(request({ secure: true }), true)).toBe('http://library.example:443');
  });

  it('keeps nondefault ports and rejects malformed hosts', () => {
    expect(oauthIssuer(request({ headers: { host: 'library.example:8443' }, frameleafTrustedTls: true }), true)).toBe(
      'https://library.example:8443',
    );
    expect(oauthIssuer(request({ headers: { host: 'bad.example/path' } }))).toBe('http://localhost');
  });
});
