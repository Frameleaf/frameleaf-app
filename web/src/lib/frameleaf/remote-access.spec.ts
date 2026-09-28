import { describe, expect, it } from 'vitest';
import { checkCustomHostname, hostnameMessageKey } from './remote-access';

describe('checkCustomHostname (FL-165)', () => {
  it('accepts a subdomain the administrator owns', () => {
    expect(checkCustomHostname(' Photos.Example.com. ')).toEqual({ valid: true, host: 'photos.example.com' });
  });

  it.each([
    ['', 'empty'],
    ['https://photos.example.com', 'scheme'],
    ['photos.example.com/app', 'scheme'],
    ['example.com', 'subdomain'],
    ['192.168.1.10', 'subdomain'],
    ['bad_label.example.com', 'subdomain'],
    ['photos.frameleaf.net', 'reserved'],
    ['r.abc.frameleaf-direct.net', 'reserved'],
    ['id.frameleaf.cloud', 'reserved'],
  ])('refuses %j (%s)', (value, reason) => {
    expect(checkCustomHostname(value)).toMatchObject({ valid: false, reason });
  });

  it('names a message for every refusal', () => {
    expect(hostnameMessageKey('reserved')).toBe('frameleaf_remote_hostname_invalid_reserved');
  });
});
