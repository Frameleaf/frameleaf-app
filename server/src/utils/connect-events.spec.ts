import type { AuthDto } from 'src/dtos/auth.dto.js';
import { connectEventBinding, toConnectEventPayload } from 'src/utils/connect-events.js';

const auth = {
  user: { id: 'owner' },
  oauthApp: {
    grantId: 'grant',
    resource: 'https://library.test/api/connect',
    scopes: ['events:read', 'library:read'],
    policyRevision: 1,
  },
} as AuthDto;

describe('Connect event wire privacy and checkpoint binding', () => {
  it('binds owner, grant, resource, scopes and policy revision, independent of scope order', () => {
    const original = connectEventBinding(auth);
    expect(original).toMatch(/^[a-f0-9]{64}$/);
    expect(
      connectEventBinding({ ...auth, oauthApp: { ...auth.oauthApp!, scopes: auth.oauthApp!.scopes.toReversed() } }),
    ).toBe(original);
    expect(connectEventBinding({ ...auth, user: { ...auth.user, id: 'other' } })).not.toBe(original);
    for (const change of [
      { grantId: 'other' },
      { resource: 'https://other.test/api/connect' },
      { scopes: ['events:read'] },
      { policyRevision: 2 },
    ]) {
      expect(connectEventBinding({ ...auth, oauthApp: { ...auth.oauthApp!, ...change } })).not.toBe(original);
    }
  });

  it('returns only allowlisted event details, never historical labels or paths', () => {
    const row = {
      event: 'asset.ready' as const,
      deliveryId: 'delivery',
      occurredAt: new Date('2026-11-13T00:00:00Z'),
      assetId: 'asset',
      albumId: null,
      format: null,
      name: 'private.jpg',
      path: '/private/file',
      token: 'secret',
    };
    expect(toConnectEventPayload(row)).toEqual({
      event: 'asset.ready',
      deliveryId: 'delivery',
      occurredAt: '2026-11-13T00:00:00.000Z',
      subject: { kind: 'asset', id: 'asset', name: null },
      detail: {},
    });
    expect(toConnectEventPayload({ ...row, event: 'album.asset.added', albumId: 'album' }).detail).toEqual({
      albumId: 'album',
    });
    expect(toConnectEventPayload({ ...row, event: 'studio.export.completed', format: 'video/mp4' }).detail).toEqual({
      format: 'video/mp4',
    });
    expect(
      toConnectEventPayload({ ...row, event: 'studio.export.completed', format: 'https://private/token' }).detail,
    ).toEqual({});
  });
});
