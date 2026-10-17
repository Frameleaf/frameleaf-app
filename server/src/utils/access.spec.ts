import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AlbumUserRole, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { checkAccess, isGranted, requireAccess, requireEntityAccess } from 'src/utils/access.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newAccessRepositoryMock } from 'test/repositories/access.repository.mock.js';

describe('access Set contracts', () => {
  let mocks: ReturnType<typeof newAccessRepositoryMock>;
  let access: AccessRepository;

  beforeEach(() => {
    mocks = newAccessRepositoryMock();
    access = mocks as unknown as AccessRepository;
  });

  it.each([
    [[], [], true],
    [[Permission.AssetRead], [], false],
    [[Permission.AssetRead, Permission.AssetRead], [Permission.AssetRead], true],
    [[Permission.AssetRead], [Permission.AssetView], false],
    [[Permission.AssetRead, Permission.AssetDelete], [Permission.AssetRead], false],
    [[Permission.AssetRead], [Permission.All], true],
  ] as const)('checks requested permissions %j against %j', (requested, current, expected) => {
    expect(isGranted({ requested: [...requested], current: [...current] })).toBe(expected);
  });

  it.each([
    [[], [], true],
    [['a', 'a'], ['a'], true],
    [['a', 'b'], ['b', 'a'], true],
    [['a', 'b'], ['a'], false],
    [['a'], ['b'], false],
    [['a'], ['a', 'unexpected'], false],
  ])('requires exact requested IDs %j and returned IDs %j', async (ids, allowed, expected) => {
    mocks.asset.checkOwnerAccess.mockResolvedValue(new Set(allowed));
    const request = { auth: authStub.user1, permission: Permission.AssetUpdate, ids };
    if (expected) {
      await expect(requireAccess(access, request)).resolves.toBeUndefined();
      await expect(requireEntityAccess(access, request, 'Person')).resolves.toBeUndefined();
    } else {
      await expect(requireAccess(access, request)).rejects.toThrow(BadRequestException);
      await expect(requireEntityAccess(access, request, 'Person')).rejects.toThrow(
        new NotFoundException('Person not found'),
      );
    }
  });

  it('returns a fresh empty result without repository calls for an empty request', async () => {
    const ids = new Set<string>();
    const result = await checkAccess(access, { auth: authStub.user1, permission: Permission.AssetRead, ids });
    expect(result).toEqual(ids);
    expect(result).not.toBe(ids);
    expect(mocks.asset.checkOwnerAccess).not.toHaveBeenCalled();
    expect(mocks.asset.checkAlbumAccess).not.toHaveBeenCalled();
    expect(mocks.asset.checkItemShareAccess).not.toHaveBeenCalled();
  });

  it.each([Permission.AssetRead, Permission.AssetView, Permission.AssetDownload])(
    'preserves grant order, input sets, privacy and remaining IDs for %s',
    async (permission) => {
      const auth = { ...authStub.adminWithElevatedPermission, hideNsfwAssets: true };
      const ids = new Set(['a', 'b', 'c', 'denied']);
      const owned = new Set(['b']);
      const album = new Set(['c', 'b']);
      const shared = new Set(['a', 'c']);
      mocks.asset.checkOwnerAccess.mockResolvedValue(owned);
      mocks.asset.checkAlbumAccess.mockResolvedValue(album);
      mocks.asset.checkItemShareAccess.mockResolvedValue(shared);

      const result = await checkAccess(access, { auth, permission, ids });

      expect([...result]).toEqual(['b', 'c', 'a']);
      expect(mocks.asset.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, ids, true, true);
      expect(mocks.asset.checkAlbumAccess).toHaveBeenCalledWith(auth.user.id, new Set(['a', 'c', 'denied']), true);
      expect(mocks.asset.checkItemShareAccess).toHaveBeenCalledWith(auth.user.id, new Set(['a', 'denied']), true);
      expect([...ids]).toEqual(['a', 'b', 'c', 'denied']);
      expect([...owned]).toEqual(['b']);
      expect([...album]).toEqual(['c', 'b']);
      expect([...shared]).toEqual(['a', 'c']);
      expect(result).not.toBe(owned);
    },
  );

  it('deduplicates array requests and keeps privacy bypass explicit', async () => {
    const auth = { ...authStub.user1, hideNsfwAssets: true };
    await checkAccess(access, { auth, permission: Permission.AssetRead, ids: ['a', 'a'], ignorePrivacy: true });
    expect(mocks.asset.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set(['a']), undefined);
    expect(mocks.asset.checkAlbumAccess).toHaveBeenCalledWith(auth.user.id, new Set(['a']));
    expect(mocks.asset.checkItemShareAccess).toHaveBeenCalledWith(auth.user.id, new Set(['a']));
    expect(auth.hideNsfwAssets).toBe(true);
  });

  it.each([
    [Permission.AlbumRead, AlbumUserRole.Viewer],
    [Permission.AlbumDownload, AlbumUserRole.Viewer],
    [Permission.AlbumAssetCreate, AlbumUserRole.Editor],
    [Permission.AlbumAssetDelete, AlbumUserRole.Editor],
    [Permission.AlbumUpdate, AlbumUserRole.Editor],
    [Permission.AlbumShare, AlbumUserRole.Editor],
  ])('preserves shared album role and remaining IDs for %s', async (permission, role) => {
    mocks.album.checkOwnerAccess.mockResolvedValue(new Set(['b']));
    mocks.album.checkSharedAlbumAccess.mockResolvedValue(new Set(['a', 'b']));
    const result = await checkAccess(access, { auth: authStub.user1, permission, ids: ['a', 'b', 'denied'] });
    expect([...result]).toEqual(['b', 'a']);
    expect(mocks.album.checkSharedAlbumAccess).toHaveBeenCalledWith(
      authStub.user1.user.id,
      new Set(['a', 'denied']),
      role,
    );
  });

  it('preserves activity owner and album-owner grant order', async () => {
    mocks.activity.checkOwnerAccess.mockResolvedValue(new Set(['b']));
    mocks.activity.checkAlbumOwnerAccess.mockResolvedValue(new Set(['a', 'b']));
    const result = await checkAccess(access, {
      auth: authStub.user1,
      permission: Permission.ActivityDelete,
      ids: ['a', 'b', 'denied'],
    });
    expect([...result]).toEqual(['b', 'a']);
    expect(mocks.activity.checkAlbumOwnerAccess).toHaveBeenCalledWith(authStub.user1.user.id, new Set(['a', 'denied']));
  });

  it('preserves group membership and invitation grant order', async () => {
    mocks.clusterGroup.checkOwnerAccess.mockResolvedValue(new Set(['b']));
    mocks.clusterGroup.checkInviteAccess.mockResolvedValue(new Set(['a', 'b']));
    const result = await checkAccess(access, {
      auth: authStub.user1,
      permission: Permission.ClusterGroupRead,
      ids: ['a', 'b', 'denied'],
    });
    expect([...result]).toEqual(['b', 'a']);
    expect(mocks.clusterGroup.checkInviteAccess).toHaveBeenCalledWith(authStub.user1.user.id, new Set(['a', 'denied']));
  });

  it('checks group-request ownership and membership against all requested IDs', async () => {
    mocks.clusterGroupRequest.checkOwnerAccess.mockResolvedValue(new Set(['b']));
    mocks.clusterGroupRequest.checkGroupAccess.mockResolvedValue(new Set(['a', 'b']));
    const ids = new Set(['a', 'b', 'denied']);
    const result = await checkAccess(access, {
      auth: authStub.user1,
      permission: Permission.ClusterGroupRequestDelete,
      ids,
    });
    expect([...result]).toEqual(['b', 'a']);
    expect(mocks.clusterGroupRequest.checkGroupAccess).toHaveBeenCalledWith(authStub.user1.user.id, ids);
  });

  it.each([Permission.AssetRead, Permission.AssetView, Permission.AssetDownload])(
    'keeps shared-link privacy and denies unrelated grant paths for %s',
    async (permission) => {
      const auth = { ...AuthFactory.from().sharedLink({ allowDownload: true }).build(), hideNsfwAssets: true };
      const ids = new Set(['a', 'b']);
      mocks.asset.checkSharedLinkAccess.mockResolvedValue(new Set(['b']));
      const result = await checkAccess(access, { auth, permission, ids });
      expect([...result]).toEqual(['b']);
      expect(mocks.asset.checkSharedLinkAccess).toHaveBeenCalledWith(auth.sharedLink!.id, ids, true);
      expect(mocks.asset.checkOwnerAccess).not.toHaveBeenCalled();
      expect(mocks.asset.checkAlbumAccess).not.toHaveBeenCalled();
      expect(mocks.asset.checkItemShareAccess).not.toHaveBeenCalled();
    },
  );

  it('denies shared-link download without download permission', async () => {
    const auth = AuthFactory.from().sharedLink({ allowDownload: false }).build();
    await expect(checkAccess(access, { auth, permission: Permission.AssetDownload, ids: ['a'] })).resolves.toEqual(
      new Set(),
    );
    expect(mocks.asset.checkSharedLinkAccess).not.toHaveBeenCalled();
  });
});
