import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import { AlbumKind, AlbumUserRole, PushEventType } from 'src/enum.js';
import { AlbumOriginField } from 'src/repositories/partner-origin.repository.js';
import { AlbumActionsService } from 'src/services/album-actions.service.js';
import { factory, newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(AlbumActionsService.name, () => {
  let sut: AlbumActionsService;
  let mocks: ServiceMocks;
  const auth = factory.auth();
  const [sourceId, targetId] = [newUuid(), newUuid()];
  const otherId = newUuid();

  const album = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    albumName: `Album ${id}`,
    kind: AlbumKind.Album,
    isLocked: false,
    albumThumbnailAssetId: null,
    albumUsers: [{ role: AlbumUserRole.Owner, user: { id: auth.user.id } }],
    sharedLinks: [],
    ...overrides,
  });

  const albums = (...rows: ReturnType<typeof album>[]) => {
    const byId = new Map(rows.map((row) => [row.id, row]));
    mocks.album.getById.mockImplementation((id: string) => Promise.resolve(byId.get(id) as never));
  };

  /** Which assets each album holds, as `getAssetIds` reads them. */
  const memberships = (held: Record<string, string[]>) => {
    mocks.album.getAssetIds.mockImplementation((albumId: string, assetIds: string[]) =>
      Promise.resolve(new Set(assetIds.filter((assetId) => held[albumId]?.includes(assetId)))),
    );
  };

  /** The albums this person owns, or edits, as the access checks see them: only the asked-for ids come back. */
  const access = (owned: string[], edited: string[] = []) => {
    const pick = (allowed: string[]) => (_userId: string, ids: Set<string>) =>
      Promise.resolve(new Set([...ids].filter((id) => allowed.includes(id))));
    mocks.access.album.checkOwnerAccess.mockImplementation(pick(owned));
    mocks.access.album.checkSharedAlbumAccess.mockImplementation(pick(edited));
  };

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AlbumActionsService));
    mocks.smartAlbum.getSmartBackedAlbumKinds.mockResolvedValue(new Map());
    mocks.classification.getRuleAlbumIds.mockResolvedValue(new Set());
    mocks.partnerOrigin.getOriginLabels.mockResolvedValue(new Map());
    mocks.album.getUnlockedItemsInLockedAlbums.mockResolvedValue([]);
    mocks.asset.getLockedAssetIds.mockResolvedValue(new Set());
    mocks.asset.getHiddenContentAssetIds.mockResolvedValue(new Set());
  });

  describe('moveAssets', () => {
    const [assetA, assetB] = [newUuid(), newUuid()];

    beforeEach(() => {
      access([sourceId, targetId]);
      albums(album(sourceId), album(targetId));
    });

    it('moves the photos in one transaction and never trashes or deletes them', async () => {
      memberships({ [sourceId]: [assetA, assetB] });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetA, assetB]));

      await expect(
        sut.moveAssets(auth, sourceId, { targetAlbumId: targetId, assetIds: [assetA, assetB] }),
      ).resolves.toEqual([
        { id: assetA, success: true },
        { id: assetB, success: true },
      ]);

      expect(mocks.album.withMembershipWrite).toHaveBeenCalledTimes(1);
      expect(mocks.album.withMembershipWrite).toHaveBeenCalledWith([sourceId, targetId], expect.any(Function));
      expect(mocks.album.addAssetIds).toHaveBeenCalledWith(targetId, [assetA, assetB]);
      expect(mocks.album.removeAssetIds).toHaveBeenCalledWith(sourceId, [assetA, assetB]);
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(mocks.asset.deleteAll).not.toHaveBeenCalled();
      expect(mocks.trash.restoreAll).not.toHaveBeenCalled();
      // FL-326: both albums record the membership edit, as add and remove do
      expect(mocks.partnerOrigin.withOriginEdit).toHaveBeenCalledWith(
        'album',
        [sourceId, targetId],
        [],
        expect.any(Function),
      );
      expect(mocks.partnerOrigin.markOverridden).toHaveBeenCalledWith(
        'album',
        [sourceId, targetId],
        [AlbumOriginField.Membership],
      );
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumUpdate', expect.objectContaining({ id: targetId }));
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumUpdate', expect.objectContaining({ id: sourceId }));
      expect(mocks.classification.recordAlbumAdditions).toHaveBeenCalledWith(targetId, [assetA, assetB], auth.user.id);
    });

    it('reports a photo not in the album and moves nothing', async () => {
      memberships({ [sourceId]: [] });

      await expect(sut.moveAssets(auth, sourceId, { targetAlbumId: targetId, assetIds: [assetA] })).resolves.toEqual([
        { id: assetA, success: false, error: BulkIdErrorReason.NOT_FOUND },
      ]);
      expect(mocks.album.addAssetIds).not.toHaveBeenCalled();
      expect(mocks.album.removeAssetIds).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalledWith('AlbumUpdate', expect.anything());
    });

    it('leaves a photo where it is when it could not be added to the target by hand', async () => {
      memberships({ [sourceId]: [assetA, assetB] });
      // The owner of the source may remove anything, but only owns assetA, so only that may be added elsewhere.
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetA]));

      await expect(
        sut.moveAssets(auth, sourceId, { targetAlbumId: targetId, assetIds: [assetA, assetB] }),
      ).resolves.toEqual([
        { id: assetA, success: true },
        { id: assetB, success: false, error: BulkIdErrorReason.NO_PERMISSION },
      ]);
      expect(mocks.album.removeAssetIds).toHaveBeenCalledWith(sourceId, [assetA]);
    });

    it('takes a photo already in the target out of this album only', async () => {
      memberships({ [sourceId]: [assetA], [targetId]: [assetA] });

      await expect(sut.moveAssets(auth, sourceId, { targetAlbumId: targetId, assetIds: [assetA] })).resolves.toEqual([
        { id: assetA, success: true },
      ]);
      expect(mocks.album.addAssetIds).toHaveBeenCalledWith(targetId, []);
      expect(mocks.album.removeAssetIds).toHaveBeenCalledWith(sourceId, [assetA]);
      expect(mocks.partnerOrigin.markOverridden).toHaveBeenCalledWith(
        'album',
        [sourceId],
        [AlbumOriginField.Membership],
      );
    });

    it('refuses an editor removing photos they do not own from a shared album', async () => {
      access([targetId], [sourceId]);
      memberships({ [sourceId]: [assetA] });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.moveAssets(auth, sourceId, { targetAlbumId: targetId, assetIds: [assetA] })).resolves.toEqual([
        { id: assetA, success: false, error: BulkIdErrorReason.NO_PERMISSION },
      ]);
      expect(mocks.album.removeAssetIds).not.toHaveBeenCalled();
    });

    it('needs remove access on this album', async () => {
      access([targetId]);

      await expect(
        sut.moveAssets(auth, sourceId, { targetAlbumId: targetId, assetIds: [assetA] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.album.withMembershipWrite).not.toHaveBeenCalled();
    });

    it('needs add access on the target', async () => {
      access([sourceId]);

      await expect(
        sut.moveAssets(auth, sourceId, { targetAlbumId: targetId, assetIds: [assetA] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.album.withMembershipWrite).not.toHaveBeenCalled();
    });

    it('refuses moving into the same album', async () => {
      await expect(sut.moveAssets(auth, sourceId, { targetAlbumId: sourceId, assetIds: [assetA] })).rejects.toThrow(
        'different album',
      );
      expect(mocks.access.album.checkOwnerAccess).not.toHaveBeenCalled();
    });

    it.each([AlbumKind.Collection, AlbumKind.Space])('refuses a %s as the target', async (kind) => {
      albums(album(sourceId), album(targetId, { kind }));

      await expect(sut.moveAssets(auth, sourceId, { targetAlbumId: targetId, assetIds: [assetA] })).rejects.toThrow(
        'not a collection or shared space',
      );
      expect(mocks.album.withMembershipWrite).not.toHaveBeenCalled();
    });

    it('refuses a connected app moving into a Locked album', async () => {
      albums(album(sourceId), album(targetId, { isLocked: true }));

      await expect(
        sut.moveAssets({ ...auth, oauthApp: { id: newUuid() } } as never, sourceId, {
          targetAlbumId: targetId,
          assetIds: [assetA],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('transfer', () => {
    const editor = { role: AlbumUserRole.Editor, user: { id: otherId } };
    const owner = { role: AlbumUserRole.Owner, user: { id: auth.user.id } };

    beforeEach(() => {
      access([sourceId]);
      mocks.albumUser.transferOwnership.mockResolvedValue(true);
    });

    it('hands the album to a member; the old owner stays on as an editor', async () => {
      albums(album(sourceId, { albumUsers: [owner, editor] }));

      await expect(sut.transfer(auth, sourceId, { userId: otherId })).resolves.toBeUndefined();

      expect(mocks.albumUser.transferOwnership).toHaveBeenCalledWith(sourceId, auth.user.id, otherId);
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumUpdate', {
        id: sourceId,
        userIds: [auth.user.id, otherId],
        recipientIds: [],
      });
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'PushNotify',
        expect.objectContaining({ type: PushEventType.AccessChanged, userIds: [otherId] }),
      );
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('AlbumUserUpdateV1', otherId, {
        albumId: sourceId,
        userId: otherId,
        role: AlbumUserRole.Owner,
      });
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('AlbumUserUpdateV1', auth.user.id, {
        albumId: sourceId,
        userId: auth.user.id,
        role: AlbumUserRole.Editor,
      });
    });

    it('hands the album to a partner who is not in it yet', async () => {
      albums(album(sourceId));
      mocks.user.get.mockResolvedValue({ id: otherId } as never);
      mocks.partner.get.mockResolvedValueOnce({ sharedById: auth.user.id, sharedWithId: otherId } as never);

      await sut.transfer(auth, sourceId, { userId: otherId });

      expect(mocks.albumUser.transferOwnership).toHaveBeenCalledWith(sourceId, auth.user.id, otherId);
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumUpdate', {
        id: sourceId,
        userIds: [auth.user.id, otherId],
        recipientIds: [],
      });
    });

    it('refuses someone who is neither in the album nor a partner', async () => {
      albums(album(sourceId));
      mocks.user.get.mockResolvedValue({ id: otherId } as never);

      await expect(sut.transfer(auth, sourceId, { userId: otherId })).rejects.toThrow('Invalid user');
      expect(mocks.albumUser.transferOwnership).not.toHaveBeenCalled();
    });

    it.each([AlbumUserRole.Editor, AlbumUserRole.Viewer])('refuses a %s with 403', async (role) => {
      access([], [sourceId]);
      albums(
        album(sourceId, {
          albumUsers: [
            { role: AlbumUserRole.Owner, user: { id: otherId } },
            { role, user: { id: auth.user.id } },
          ],
        }),
      );

      await expect(sut.transfer(auth, sourceId, { userId: auth.user.id })).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.albumUser.transferOwnership).not.toHaveBeenCalled();
    });

    it('refuses a shared space to someone not in it', async () => {
      albums(album(sourceId, { kind: AlbumKind.Space }));

      await expect(sut.transfer(auth, sourceId, { userId: otherId })).rejects.toThrow('one of its members');
      expect(mocks.partner.get).not.toHaveBeenCalled();
    });

    it('refuses a smart album, a partner copy and a Locked album', async () => {
      albums(album(sourceId, { albumUsers: [owner, editor] }));
      mocks.classification.getRuleAlbumIds.mockResolvedValueOnce(new Set([sourceId]));
      await expect(sut.transfer(auth, sourceId, { userId: otherId })).rejects.toThrow('Smart albums');

      mocks.partnerOrigin.getOriginLabels.mockResolvedValueOnce(
        new Map([[sourceId, { rootOwnerId: newUuid(), rootOwnerName: 'Sam' }]]),
      );
      await expect(sut.transfer(auth, sourceId, { userId: otherId })).rejects.toThrow('partner');

      albums(album(sourceId, { albumUsers: [owner, editor], isLocked: true }));
      await expect(sut.transfer(auth, sourceId, { userId: otherId })).rejects.toThrow('Unlock');
      expect(mocks.albumUser.transferOwnership).not.toHaveBeenCalled();
    });

    it('refuses handing the album to its owner', async () => {
      albums(album(sourceId));

      await expect(sut.transfer(auth, sourceId, { userId: auth.user.id })).rejects.toThrow('already own');
    });

    it('reports a transfer that lost a race and emits nothing', async () => {
      albums(album(sourceId, { albumUsers: [owner, editor] }));
      mocks.albumUser.transferOwnership.mockResolvedValue(false);

      await expect(sut.transfer(auth, sourceId, { userId: otherId })).rejects.toThrow('changed hands');
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });
  });
});
