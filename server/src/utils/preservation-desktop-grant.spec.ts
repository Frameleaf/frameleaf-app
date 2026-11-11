import { PreservationDesktopGrants, localDesktopCopyHost } from 'src/utils/preservation-desktop-grant.js';

describe(PreservationDesktopGrants.name, () => {
  it('accepts only the literal loopback host from a direct loopback peer', () => {
    expect(localDesktopCopyHost('127.0.0.1:2283', '127.0.0.1')).toBe('127.0.0.1:2283');
    expect(localDesktopCopyHost('127.0.0.1', '::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(localDesktopCopyHost('127.0.0.1:2283', '192.168.1.2')).toBeUndefined();
    expect(localDesktopCopyHost('localhost:2283', '127.0.0.1')).toBeUndefined();
    expect(localDesktopCopyHost('127.0.0.1:65536', '127.0.0.1')).toBeUndefined();
  });

  it('binds a one-use capability to the issuing library, exact package, and owner', () => {
    const grants = new PreservationDesktopGrants();
    const host = '127.0.0.1:2283';
    const token = grants.issue('owner', 'session', 'package', host, 10)!;
    expect(grants.take(token, 'other', host, 11)).toBeUndefined();
    expect(grants.take(token, 'package', '127.0.0.1:2284', 11)).toBeUndefined();
    expect(new PreservationDesktopGrants().take(token, 'package', host, 11)).toBeUndefined();
    expect(grants.take(token, 'package', host, 11)).toEqual({ ownerId: 'owner', sessionId: 'session' });
    expect(grants.take(token, 'package', host, 11)).toBeUndefined();
    expect(
      grants.take(grants.issue('owner', 'session', 'package', host, 10), 'package', host, 300_010),
    ).toBeUndefined();
    const revoked = grants.issue('owner', 'session', 'package', host, 10)!;
    grants.revokeSession('session');
    expect(grants.take(revoked, 'package', host, 11)).toBeUndefined();
  });
});
