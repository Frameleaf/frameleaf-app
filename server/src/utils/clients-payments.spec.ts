import { describe, expect, it } from 'vitest';
import { checkoutOrigin, isOwnAddress } from 'src/utils/clients-payments.js';

describe('checkout return addresses', () => {
  const site = 'https://photos.example.com';

  it('never returns a payer to an address from another site', () => {
    expect(checkoutOrigin('https://evil.example', site, 'evil.example')).toBe(site);
    expect(checkoutOrigin('https://evil.example', null, 'photos.example.com')).toBeNull();
    expect(isOwnAddress('https://evil.example/photography/gallery/1', site, 'photos.example.com')).toBe(false);
  });

  it('keeps the address the payer came from when it is this server', () => {
    expect(checkoutOrigin(site, site, 'internal')).toBe(site);
    expect(checkoutOrigin('http://nas.local:2283', null, 'nas.local')).toBe('http://nas.local:2283');
    expect(isOwnAddress(`${site}/photography/gallery/1`, site, 'internal')).toBe(true);
  });

  it('refuses other schemes, embedded credentials and an Origin with a path', () => {
    expect(isOwnAddress('javascript:alert(1)', site, 'photos.example.com')).toBe(false);
    expect(isOwnAddress('https://user:pw@photos.example.com', site, 'photos.example.com')).toBe(false);
    expect(checkoutOrigin(`${site}/path`, null, 'photos.example.com')).toBeNull();
  });
});
