import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AssetType, LibraryScope } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetAnnotationRepository } from 'src/repositories/asset-annotation.repository.js';
import { AssetAnnotationService } from 'src/services/asset-annotation.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { automock, getMocks } from 'test/utils.js';

const items = [{ id: 'a1', kind: 'rect' as const, geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, note: 'Cut' }];
const updatedAt = new Date('2026-10-29T10:00:00.000Z');

describe('Boards annotations', () => {
  const annotations = automock(AssetAnnotationRepository, { args: [{}] });
  const mocks = getMocks();
  const service = new AssetAnnotationService(annotations, mocks.access as unknown as AccessRepository);
  const owner = authStub.user1;
  const picture = (overrides: object = {}) => ({
    id: 'asset',
    ownerId: owner.user.id,
    type: AssetType.Image,
    libraryScope: LibraryScope.Design,
    sourceRevision: 'rev-1',
    ...overrides,
  });

  beforeEach(() => {
    annotations.resetAllMocks();
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset']));
    mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set());
    mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set());
    mocks.access.asset.checkItemShareAccess.mockResolvedValue(new Set());
    annotations.getAsset.mockResolvedValue(picture());
    annotations.get.mockResolvedValue({ sourceRevision: 'rev-1', items, updatedAt });
    annotations.replace.mockImplementation((_id, next) =>
      Promise.resolve(next.length > 0 ? { sourceRevision: 'rev-1', items: next, updatedAt } : undefined),
    );
  });

  describe('reading', () => {
    it('returns the owner’s document with edit rights', async () => {
      await expect(service.get(owner, 'asset')).resolves.toEqual({
        version: 1,
        sourceRevision: 'rev-1',
        sourceChanged: false,
        canEdit: true,
        items,
        updatedAt: updatedAt.toISOString(),
      });
    });

    it('lets an album member the picture is shared with read it, without edit rights', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set(['asset']));
      const result = await service.get(authStub.admin, 'asset');
      expect(result.items).toEqual(items);
      expect(result.canEdit).toBe(false);
    });

    it('lets a shared link read it, without edit rights', async () => {
      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set(['asset']));
      const result = await service.get(authStub.adminSharedLink, 'asset');
      expect(result.items).toEqual(items);
      expect(result.canEdit).toBe(false);
    });

    it('checks the picture’s privacy before reading anything', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(service.get(authStub.admin, 'asset')).rejects.toThrow();
      expect(annotations.getAsset).not.toHaveBeenCalled();
      expect(annotations.get).not.toHaveBeenCalled();
    });

    it('shows none for a picture that is only in Photos, or a video', async () => {
      for (const asset of [picture({ libraryScope: LibraryScope.Personal }), picture({ type: AssetType.Video })]) {
        annotations.getAsset.mockResolvedValue(asset);
        const result = await service.get(owner, 'asset');
        expect(result).toMatchObject({ items: [], canEdit: false, updatedAt: null, sourceRevision: 'rev-1' });
      }
      expect(annotations.get).not.toHaveBeenCalled();
    });

    it('says when the picture changed after the annotations were drawn', async () => {
      annotations.getAsset.mockResolvedValue(picture({ libraryScope: LibraryScope.Both, sourceRevision: 'rev-2' }));
      await expect(service.get(owner, 'asset')).resolves.toMatchObject({
        sourceRevision: 'rev-1',
        sourceChanged: true,
      });
    });

    it('is not found once the picture has gone', async () => {
      annotations.getAsset.mockResolvedValue(undefined);
      await expect(service.get(owner, 'asset')).rejects.toThrow(NotFoundException);
    });
  });

  describe('saving', () => {
    it('replaces the whole document and nothing else', async () => {
      const result = await service.replace(owner, 'asset', { version: 1, sourceRevision: 'rev-1', items });
      expect(annotations.replace).toHaveBeenCalledWith('asset', items, 'rev-1');
      expect(result).toMatchObject({ items, canEdit: true, sourceChanged: false });
      // the annotation repository is the only writer: no asset update, edit or job is involved
      expect(mocks.asset.update).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('removes the document when the list is emptied', async () => {
      await expect(
        service.replace(owner, 'asset', { version: 1, sourceRevision: 'rev-1', items: [] }),
      ).resolves.toMatchObject({
        items: [],
        updatedAt: null,
      });
      expect(annotations.replace).toHaveBeenCalledWith('asset', [], 'rev-1');
    });

    it('never lets a shared link write, even with the owner’s identity', async () => {
      const auth = { ...owner, sharedLink: authStub.adminSharedLink.sharedLink };
      await expect(service.replace(auth, 'asset', { version: 1, sourceRevision: 'rev-1', items })).rejects.toThrow(
        ForbiddenException,
      );
      expect(annotations.replace).not.toHaveBeenCalled();
    });

    it('never lets anyone but the owner write', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set(['asset']));
      await expect(
        service.replace(authStub.admin, 'asset', { version: 1, sourceRevision: 'rev-1', items }),
      ).rejects.toThrow();
      annotations.getAsset.mockResolvedValue(picture({ ownerId: 'someone-else' }));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset']));
      await expect(service.replace(owner, 'asset', { version: 1, sourceRevision: 'rev-1', items })).rejects.toThrow(
        ForbiddenException,
      );
      expect(annotations.replace).not.toHaveBeenCalled();
    });

    it('refuses a picture outside Boards and videos', async () => {
      for (const asset of [picture({ libraryScope: LibraryScope.Personal }), picture({ type: AssetType.Video })]) {
        annotations.getAsset.mockResolvedValue(asset);
        await expect(service.replace(owner, 'asset', { version: 1, sourceRevision: 'rev-1', items })).rejects.toThrow(
          BadRequestException,
        );
      }
      expect(annotations.replace).not.toHaveBeenCalled();
    });

    it('refuses positions read before the picture changed, saving nothing', async () => {
      annotations.replace.mockResolvedValue('conflict');
      await expect(service.replace(owner, 'asset', { version: 1, sourceRevision: 'rev-0', items })).rejects.toThrow(
        ConflictException,
      );
      expect(annotations.replace).toHaveBeenCalledWith('asset', items, 'rev-0');
    });

    it('is not found when the picture goes while saving', async () => {
      annotations.replace.mockResolvedValue(undefined);
      await expect(service.replace(owner, 'asset', { version: 1, sourceRevision: 'rev-1', items })).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
