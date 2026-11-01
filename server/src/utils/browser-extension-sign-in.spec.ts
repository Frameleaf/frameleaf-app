import { createHash } from 'node:crypto';
import { checkRedirectUri, returnAddress, verifierMatches } from 'src/utils/browser-extension-sign-in.js';

const id = 'abcdefghijklmnopabcdefghijklmnop';

describe('Save to Frameleaf sign-in addresses (FL-655)', () => {
  it.each([
    `https://${id}.chromiumapp.org/`,
    `https://${id}.chromiumapp.org/signed-in`,
    `https://${id}.chromiumapp.org/a/b`,
  ])('accepts the browser sign-in window’s own address %s', (value) => {
    expect(checkRedirectUri(value)).toEqual({ redirectUri: value, origin: `https://${id}.chromiumapp.org` });
  });

  it.each([
    '',
    'chromiumapp.org',
    `https://${id}.chromiumapp.org`,
    `https://${id.toUpperCase()}.chromiumapp.org/`,
    `https://${id}.chromiumapp.org/../x`,
    `https://${id}.chromiumapp.org/%2e%2e/x`,
    `https://${id}.chromiumapp.org/#frag`,
    `https://${id}.chromiumapp.org/?`,
    `https://x.${id}.chromiumapp.org/`,
    `https://${id}.chromiumapp.org.example/`,
    `https://${id}.chromiumapp.com/`,
    `chrome-extension://${id}/`,
    `javascript:alert(1)//${id}.chromiumapp.org/`,
    'https://localhost/',
  ])('refuses %s', (value) => {
    expect(checkRedirectUri(value)).toBeNull();
  });

  it('checks an S256 challenge', () => {
    const verifier = 'v'.repeat(43) + '-._~';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(verifierMatches(verifier, challenge)).toBe(true);
    expect(verifierMatches(verifier + 'x', challenge)).toBe(false);
    expect(verifierMatches('short', challenge)).toBe(false);
    expect(verifierMatches(verifier, verifier)).toBe(false);
  });

  it('puts the result in the return address', () => {
    expect(returnAddress(`https://${id}.chromiumapp.org/`, { code: 'a b', state: 's' })).toBe(
      `https://${id}.chromiumapp.org/?code=a+b&state=s`,
    );
  });
});
