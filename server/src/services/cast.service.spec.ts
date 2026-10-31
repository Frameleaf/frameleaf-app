import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { UserMetadataKey } from 'src/enum.js';
import { CastService } from 'src/services/cast.service.js';
import { CAST_MEDIA_TTL_MS, CastMediaKind } from 'src/utils/cast-media.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { factory, newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(CastService.name, () => {
  let sut: CastService;
  let mocks: ServiceMocks;

  const user = UserFactory.create();
  const sessionId = newUuid();
  const assetId = newUuid();
  const otherAssetId = newUuid();
  const auth = factory.auth({ user: { id: user.id }, session: { id: sessionId, hasElevatedPermission: true } });
  const tokenOf = (path: string) => path.replace('/api/cast/', '');

  beforeEach(() => {
    ({ sut, mocks } = newTestService(CastService));
    // the real keyed hash, with a test key
    mocks.crypto.serverKeyedHash.mockImplementation((_directory, purpose, value) =>
      Promise.resolve(createHmac('sha256', 'test-server-key').update(`${purpose}\0${value}`).digest('base64url')),
    );
    mocks.user.get.mockResolvedValue(user as never);
    mocks.user.getMetadata.mockResolvedValue([]);
    mocks.session.get.mockResolvedValue({ id: sessionId, expiresAt: null } as never);
    mocks.access.asset.checkOwnerAccess.mockImplementation((_userId, ids) =>
      Promise.resolve(new Set([...ids].filter((id) => id === assetId))),
    );
    mocks.asset.isCastable.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues a 15-minute URL for one item that works without the session and serves only that item', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-09T12:00:00.000Z') });
    const response = await sut.createMediaUrl(auth, assetId, { kind: CastMediaKind.Video });
    expect(response).toEqual({
      assetId,
      kind: CastMediaKind.Video,
      path: expect.stringMatching(/^\/api\/cast\/[\w-]+\.[\w-]+$/),
      expiresAt: new Date(Date.now() + CAST_MEDIA_TTL_MS).toISOString(),
    });

    const read = await sut.resolveMediaUrl(tokenOf(response.path));
    expect(read).toMatchObject({ assetId, kind: CastMediaKind.Video });
    expect(read.auth.user.id).toBe(user.id);
    // a Locked item is never served, even when the URL came from a PIN-unlocked session
    expect(read.auth.session).toEqual({ id: sessionId, hasElevatedPermission: false });
    expect(read.auth.sharedLink).toBeUndefined();
  });

  it('stops working once expired', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-09T12:00:00.000Z') });
    const { path } = await sut.createMediaUrl(auth, assetId, { kind: CastMediaKind.Preview });
    vi.advanceTimersByTime(CAST_MEDIA_TTL_MS);
    await expect(sut.resolveMediaUrl(tokenOf(path))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a tampered URL, including one pointed at another item', async () => {
    const { path } = await sut.createMediaUrl(auth, assetId, { kind: CastMediaKind.Preview });
    const [payload, signature] = tokenOf(path).split('.', 2);
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, a: otherAssetId })).toString('base64url');
    await expect(sut.resolveMediaUrl(`${forged}.${signature}`)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(sut.resolveMediaUrl(`${payload}.${signature.slice(1)}`)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('denies an item the caller cannot access, and a shared link or session-less caller', async () => {
    await expect(sut.createMediaUrl(auth, otherAssetId, { kind: CastMediaKind.Preview })).rejects.toBeInstanceOf(Error);
    const sharedLink = factory.auth({ user: { id: user.id }, sharedLink: {} });
    await expect(sut.createMediaUrl(sharedLink, assetId, { kind: CastMediaKind.Preview })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      sut.createMediaUrl(factory.auth({ user: { id: user.id } }), assetId, { kind: CastMediaKind.Preview }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies a Locked or hidden item, at issue and again at every read', async () => {
    mocks.asset.isCastable.mockResolvedValue(false);
    await expect(sut.createMediaUrl(auth, assetId, { kind: CastMediaKind.Preview })).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    mocks.asset.isCastable.mockResolvedValue(true);
    const { path } = await sut.createMediaUrl(auth, assetId, { kind: CastMediaKind.Preview });
    mocks.asset.isCastable.mockResolvedValue(false);
    await expect(sut.resolveMediaUrl(tokenOf(path))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('passes the caller hidden people, pets and tags to the castable check', async () => {
    const personId = newUuid();
    mocks.user.getMetadata.mockResolvedValue([
      {
        key: UserMetadataKey.Preferences,
        value: { privacy: { suppression: { tagIds: [], personIds: [personId], petIds: [], scope: 'owned' } } },
      },
    ] as never);
    await sut.createMediaUrl(auth, assetId, { kind: CastMediaKind.Preview });
    expect(mocks.asset.isCastable).toHaveBeenCalledWith(
      assetId,
      expect.objectContaining({ userId: user.id, personIds: [personId] }),
    );
  });

  it('honours the administrator casting switch, at issue and at read', async () => {
    const { path } = await sut.createMediaUrl(auth, assetId, { kind: CastMediaKind.Video });
    mocks.user.getMetadata.mockResolvedValue([
      { key: UserMetadataKey.Preferences, value: { cast: { adminDisabled: true } } },
    ] as never);
    await expect(sut.resolveMediaUrl(tokenOf(path))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(sut.createMediaUrl(auth, assetId, { kind: CastMediaKind.Video })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('stops working when the session is revoked or the access is lost', async () => {
    const { path } = await sut.createMediaUrl(auth, assetId, { kind: CastMediaKind.Original });
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
    await expect(sut.resolveMediaUrl(tokenOf(path))).rejects.toBeInstanceOf(Error);

    mocks.session.get.mockResolvedValue(undefined);
    await expect(sut.resolveMediaUrl(tokenOf(path))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
