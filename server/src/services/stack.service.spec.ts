import { BadRequestException } from '@nestjs/common';
import { AssetVisibility } from 'src/enum.js';
import { StackService } from 'src/services/stack.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { StackFactory } from 'test/factories/stack.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getForStack } from 'test/mappers.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(StackService.name, () => {
  let sut: StackService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(StackService));
    mocks.stack.excludeAutomaticMembers.mockResolvedValue();
    mocks.stack.excludeFromAutomatic.mockResolvedValue();
  });

  it('should be defined', () => {
    expect(sut).toBeDefined();
  });

  describe('search', () => {
    it('should search stacks', async () => {
      const auth = AuthFactory.create();
      const asset = AssetFactory.from().exif().build();
      const stack = StackFactory.from()
        .primaryAsset(asset, (builder) => builder.exif())
        .build();
      mocks.stack.search.mockResolvedValue([getForStack(stack)]);

      await sut.search(auth, { primaryAssetId: asset.id });
      expect(mocks.stack.search).toHaveBeenCalledWith({
        ownerId: auth.user.id,
        primaryAssetId: asset.id,
      });
    });

    it('should hide private NSFW stack assets when requested', async () => {
      const auth = { ...AuthFactory.create(), hideNsfwAssets: true };
      const asset = AssetFactory.from().exif().build();
      const stack = StackFactory.from()
        .primaryAsset(asset, (builder) => builder.exif())
        .build();
      mocks.stack.search.mockResolvedValue([getForStack(stack)]);

      await sut.search(auth, { primaryAssetId: asset.id });
      expect(mocks.stack.search).toHaveBeenCalledWith({
        ownerId: auth.user.id,
        primaryAssetId: asset.id,
        excludeNsfw: true,
      });
    });

    it('should name the caller as the Locked owner only in an elevated session (FL-34)', async () => {
      const auth = AuthFactory.from().session({ hasElevatedPermission: true }).build();
      mocks.stack.search.mockResolvedValue([]);

      await sut.search(auth, {});
      expect(mocks.stack.search).toHaveBeenCalledWith({
        ownerId: auth.user.id,
        primaryAssetId: undefined,
        lockedOwnerId: auth.user.id,
      });
    });

    it('should never map a Locked member the viewer has not unlocked (FL-34)', async () => {
      const auth = AuthFactory.create();
      const primary = AssetFactory.from({ ownerId: auth.user.id }).exif().build();
      const locked = AssetFactory.from({ ownerId: auth.user.id, visibility: AssetVisibility.Locked }).exif().build();
      const stack = StackFactory.from()
        .primaryAsset(primary, (builder) => builder.exif())
        .asset(locked, (builder) => builder.exif())
        .build();
      mocks.stack.search.mockResolvedValue([getForStack(stack)]);

      await expect(sut.search(auth, {})).resolves.toEqual([
        expect.objectContaining({ primaryAssetId: primary.id, assets: [expect.objectContaining({ id: primary.id })] }),
      ]);
    });
  });

  describe('create', () => {
    it('should require asset.update permissions', async () => {
      const auth = AuthFactory.create();
      const [primaryAsset, asset] = [AssetFactory.create(), AssetFactory.create()];

      await expect(sut.create(auth, { assetIds: [primaryAsset.id, asset.id] })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalled();
      expect(mocks.stack.create).not.toHaveBeenCalled();
    });

    it('should create a stack', async () => {
      const auth = AuthFactory.create();
      const [primaryAsset, asset] = [AssetFactory.from().exif().build(), AssetFactory.from().exif().build()];
      const stack = StackFactory.from()
        .primaryAsset(primaryAsset, (builder) => builder.exif())
        .asset(asset, (builder) => builder.exif())
        .build();

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([primaryAsset.id, asset.id]));
      mocks.stack.create.mockResolvedValue({ ...getForStack(stack), lockedAssetIds: [] });

      await expect(sut.create(auth, { assetIds: [primaryAsset.id, asset.id] })).resolves.toEqual({
        id: stack.id,
        primaryAssetId: primaryAsset.id,
        assets: [expect.objectContaining({ id: primaryAsset.id }), expect.objectContaining({ id: asset.id })],
      });

      expect(mocks.event.emit).toHaveBeenCalledWith('StackCreate', {
        stackId: stack.id,
        userId: auth.user.id,
      });
      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalled();
      // nothing became Locked by joining the stack
      expect(mocks.person.getMissingThumbnailsForAssets).not.toHaveBeenCalled();
      expect(mocks.user.getLockedProfileImageSources).not.toHaveBeenCalled();
    });

    it('follows up on photos a Locked stack member locked with it (FL-53)', async () => {
      const auth = AuthFactory.create();
      const [primaryAsset, asset] = [AssetFactory.from().exif().build(), AssetFactory.from().exif().build()];
      const stack = StackFactory.from()
        .primaryAsset(primaryAsset, (builder) => builder.exif())
        .asset(asset, (builder) => builder.exif())
        .build();

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([primaryAsset.id, asset.id]));
      // the primary was Locked, so the other photo became Locked with it
      mocks.stack.create.mockResolvedValue({ ...getForStack(stack), lockedAssetIds: [asset.id] });

      await sut.create(auth, { assetIds: [primaryAsset.id, asset.id] });

      // face thumbnails and profile pictures released by the photo the stack moved into Locked
      expect(mocks.person.getMissingThumbnailsForAssets).toHaveBeenCalledWith([asset.id]);
      expect(mocks.user.getLockedProfileImageSources).toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('should require stack.read permissions', async () => {
      await expect(sut.get(authStub.admin, 'stack-id')).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.access.stack.checkOwnerAccess).toHaveBeenCalled();
      expect(mocks.stack.getById).not.toHaveBeenCalled();
    });

    it('should fail if stack could not be found', async () => {
      mocks.access.stack.checkOwnerAccess.mockResolvedValue(new Set(['stack-id']));
      mocks.stack.getById.mockResolvedValue(void 0);

      await expect(sut.get(authStub.admin, 'stack-id')).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.access.stack.checkOwnerAccess).toHaveBeenCalled();
      expect(mocks.stack.getById).toHaveBeenCalledWith('stack-id');
    });

    it('should get stack', async () => {
      const auth = AuthFactory.create();
      const [primaryAsset, asset] = [AssetFactory.from().exif().build(), AssetFactory.from().exif().build()];
      const stack = StackFactory.from()
        .primaryAsset(primaryAsset, (builder) => builder.exif())
        .asset(asset, (builder) => builder.exif())
        .build();

      mocks.access.stack.checkOwnerAccess.mockResolvedValue(new Set([stack.id]));
      mocks.stack.getById.mockResolvedValue(getForStack(stack));

      await expect(sut.get(auth, stack.id)).resolves.toEqual({
        id: stack.id,
        primaryAssetId: primaryAsset.id,
        assets: [expect.objectContaining({ id: primaryAsset.id }), expect.objectContaining({ id: asset.id })],
      });
      expect(mocks.access.stack.checkOwnerAccess).toHaveBeenCalled();
      expect(mocks.stack.getById).toHaveBeenCalledWith(stack.id);
    });

    it('should hide private NSFW assets from stack detail when requested', async () => {
      const auth = { ...AuthFactory.create(), hideNsfwAssets: true };
      const [primaryAsset, asset] = [AssetFactory.from().exif().build(), AssetFactory.from().exif().build()];
      const stack = StackFactory.from()
        .primaryAsset(primaryAsset, (builder) => builder.exif())
        .asset(asset, (builder) => builder.exif())
        .build();

      mocks.access.stack.checkOwnerAccess.mockResolvedValue(new Set([stack.id]));
      mocks.stack.getById.mockResolvedValue(getForStack(stack));

      await expect(sut.get(auth, stack.id)).resolves.toEqual({
        id: stack.id,
        primaryAssetId: primaryAsset.id,
        assets: [expect.objectContaining({ id: primaryAsset.id }), expect.objectContaining({ id: asset.id })],
      });
      expect(mocks.access.stack.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set([stack.id]), true);
      expect(mocks.stack.getById).toHaveBeenCalledWith(stack.id, { excludeNsfw: true });
    });
  });

  describe('update', () => {
    it('should require stack.update permissions', async () => {
      await expect(sut.update(AuthFactory.create(), 'stack-id', {})).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.stack.getById).not.toHaveBeenCalled();
      expect(mocks.stack.update).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('should fail if stack could not be found', async () => {
      mocks.access.stack.checkOwnerAccess.mockResolvedValue(new Set(['stack-id']));
      mocks.stack.getById.mockResolvedValue(void 0);

      await expect(sut.update(AuthFactory.create(), 'stack-id', {})).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.stack.getById).toHaveBeenCalledWith('stack-id');
      expect(mocks.stack.update).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('should fail if the provided primary asset id is not in the stack', async () => {
      const auth = AuthFactory.create();
      const stack = StackFactory.from()
        .primaryAsset({}, (builder) => builder.exif())
        .asset({}, (builder) => builder.exif())
        .build();

      mocks.access.stack.checkOwnerAccess.mockResolvedValue(new Set([stack.id]));
      mocks.stack.getById.mockResolvedValue(getForStack(stack));

      await expect(sut.update(auth, stack.id, { primaryAssetId: 'unknown-asset' })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.stack.getById).toHaveBeenCalledWith(stack.id);
      expect(mocks.stack.update).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('should update stack', async () => {
      const auth = AuthFactory.create();
      const [primaryAsset, asset] = [AssetFactory.from().exif().build(), AssetFactory.from().exif().build()];
      const stack = StackFactory.from()
        .primaryAsset(primaryAsset, (builder) => builder.exif())
        .asset(asset, (builder) => builder.exif())
        .build();

      mocks.access.stack.checkOwnerAccess.mockResolvedValue(new Set([stack.id]));
      mocks.stack.getById.mockResolvedValue(getForStack(stack));
      mocks.stack.update.mockResolvedValue(getForStack(stack));

      await sut.update(auth, stack.id, { primaryAssetId: asset.id });

      expect(mocks.stack.getById).toHaveBeenCalledWith(stack.id);
      expect(mocks.stack.update).toHaveBeenCalledWith(
        stack.id,
        {
          id: stack.id,
          primaryAssetId: asset.id,
        },
        undefined,
        auth,
        expect.any(Function),
      );
      expect(mocks.event.emit).toHaveBeenCalledWith('StackUpdate', {
        stackId: stack.id,
        userId: auth.user.id,
      });
    });

    it('awaits the durable stream wake and omits the legacy stack event after a sequenced commit', async () => {
      const auth = AuthFactory.create();
      const asset = AssetFactory.from().exif().build();
      const stack = StackFactory.from()
        .primaryAsset(asset, (builder) => builder.exif())
        .build();
      mocks.access.stack.checkOwnerAccess.mockResolvedValue(new Set([stack.id]));
      mocks.stack.getById.mockResolvedValue(getForStack(stack));
      mocks.stack.update.mockImplementation((_id, _update, _privacy, _auth, capture) => {
        capture?.(true);
        return Promise.resolve(getForStack(stack));
      });
      const release = Promise.withResolvers<number>();
      mocks.stack.enqueueLocalEffects.mockReturnValue(release.promise);
      let finished = false;
      const pending = sut.update(auth, stack.id, { primaryAssetId: asset.id }).then((value) => {
        finished = true;
        return value;
      });
      await vi.waitFor(() => expect(mocks.stack.enqueueLocalEffects).toHaveBeenCalledOnce());
      expect(finished).toBe(false);
      expect(mocks.event.emit).not.toHaveBeenCalled();
      release.resolve(1);
      await expect(pending).resolves.toMatchObject({ id: stack.id, primaryAssetId: asset.id });
      expect(finished).toBe(true);
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('should hide private NSFW assets from updated stack responses when requested', async () => {
      const auth = { ...AuthFactory.create(), hideNsfwAssets: true };
      const [primaryAsset, asset] = [AssetFactory.from().exif().build(), AssetFactory.from().exif().build()];
      const stack = StackFactory.from()
        .primaryAsset(primaryAsset, (builder) => builder.exif())
        .asset(asset, (builder) => builder.exif())
        .build();

      mocks.access.stack.checkOwnerAccess.mockResolvedValue(new Set([stack.id]));
      mocks.stack.getById.mockResolvedValue(getForStack(stack));
      mocks.stack.update.mockResolvedValue(getForStack(stack));

      await sut.update(auth, stack.id, { primaryAssetId: asset.id });

      expect(mocks.stack.update).toHaveBeenCalledWith(
        stack.id,
        {
          id: stack.id,
          primaryAssetId: asset.id,
        },
        { excludeNsfw: true },
        auth,
        expect.any(Function),
      );
    });
  });

  describe('delete', () => {
    it('should require stack.delete permissions', async () => {
      await expect(sut.delete(AuthFactory.create(), 'stack-id')).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.stack.delete).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('should delete stack', async () => {
      const auth = AuthFactory.create();

      mocks.access.stack.checkOwnerAccess.mockResolvedValue(new Set(['stack-id']));
      mocks.stack.delete.mockResolvedValue();

      await sut.delete(auth, 'stack-id');

      expect(mocks.stack.delete).toHaveBeenCalledWith('stack-id', auth, expect.any(Function));
      expect(mocks.event.emit).toHaveBeenCalledWith('StackDelete', {
        stackId: 'stack-id',
        userId: auth.user.id,
      });
    });
  });

  describe('deleteAll', () => {
    it('should require stack.delete permissions', async () => {
      await expect(sut.deleteAll(authStub.admin, { ids: ['stack-id'] })).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.stack.deleteAll).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('should delete all stacks', async () => {
      mocks.access.stack.checkOwnerAccess.mockResolvedValue(new Set(['stack-id']));
      mocks.stack.deleteAll.mockResolvedValue();

      await sut.deleteAll(authStub.admin, { ids: ['stack-id'] });

      expect(mocks.stack.deleteAll).toHaveBeenCalledWith(['stack-id'], authStub.admin, expect.any(Function));
      expect(mocks.event.emit).toHaveBeenCalledWith('StackDeleteAll', {
        stackIds: ['stack-id'],
        userId: authStub.admin.user.id,
      });
    });
  });

  describe('removeAsset', () => {
    it('should require stack.update permissions', async () => {
      await expect(sut.removeAsset(authStub.admin, { id: 'stack-id', assetId: 'asset-id' })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.stack.getForAssetRemoval).not.toHaveBeenCalled();
      expect(mocks.asset.update).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('should fail if the asset is not in the stack', async () => {
      mocks.access.stack.checkOwnerAccess.mockResolvedValue(new Set(['stack-id']));
      mocks.stack.getForAssetRemoval.mockResolvedValue({ id: null, primaryAssetId: null });

      await expect(sut.removeAsset(authStub.admin, { id: 'stack-id', assetId: newUuid() })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.asset.update).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('should fail if the assetId is the primaryAssetId', async () => {
      const asset = AssetFactory.create();
      mocks.access.stack.checkOwnerAccess.mockResolvedValue(new Set(['stack-id']));
      mocks.stack.getForAssetRemoval.mockResolvedValue({ id: 'stack-id', primaryAssetId: asset.id });

      await expect(sut.removeAsset(authStub.admin, { id: 'stack-id', assetId: asset.id })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.asset.update).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it("should update the asset to nullify it's stack-id", async () => {
      const [primaryAsset, asset] = [AssetFactory.create(), AssetFactory.create()];
      mocks.access.stack.checkOwnerAccess.mockResolvedValue(new Set(['stack-id']));
      mocks.stack.getForAssetRemoval.mockResolvedValue({ id: 'stack-id', primaryAssetId: primaryAsset.id });
      mocks.stack.removeMember.mockResolvedValue(undefined);

      await sut.removeAsset(authStub.admin, { id: 'stack-id', assetId: asset.id });

      expect(mocks.stack.removeMember).toHaveBeenCalledWith('stack-id', asset.id, authStub.admin, expect.any(Function));
      expect(mocks.event.emit).toHaveBeenCalledWith('StackUpdate', {
        stackId: 'stack-id',
        userId: authStub.admin.user.id,
      });
    });
  });

  describe('automatic burst stacks (FL-953)', () => {
    const t0 = new Date('2026-11-01T10:00:00Z').getTime();
    const frame = (id: string, seconds: number, extra: Record<string, unknown> = {}) => ({
      id,
      takenAt: new Date(t0 + seconds * 1000),
      burstId: null,
      camera: 'Canon|R5|',
      technicalScore: 0.5,
      aestheticScore: 0.5,
      eyesOpen: null,
      scored: true,
      ...extra,
    });

    beforeEach(() => {
      mocks.user.getAutoStackUserIds.mockResolvedValue(['owner']);
      mocks.stack.create.mockResolvedValue({ id: 'stack' } as never);
    });

    it('stacks a 10-frame burst with the best frame on top', async () => {
      const burst = Array.from({ length: 10 }, (_, index) =>
        frame(`f${index}`, index * 0.5, index === 6 ? { technicalScore: 0.9, eyesOpen: 0.95 } : {}),
      );
      mocks.stack.getAutoStackCandidates.mockResolvedValue(burst);
      mocks.stack.getSimilarities.mockResolvedValue(Array.from({ length: 9 }, () => 0.97));

      await sut.handleAutoStack({ userId: 'owner' });

      expect(mocks.stack.create).toHaveBeenCalledTimes(1);
      const [entity, ids] = mocks.stack.create.mock.calls[0];
      expect(entity).toEqual({ ownerId: 'owner', isAutomatic: true, autoVersion: 1 });
      expect(ids[0]).toBe('f6');
      expect(ids).toHaveLength(10);
    });

    it('splits a time chain where the photos stop looking alike, and keeps cameras apart', async () => {
      mocks.stack.getAutoStackCandidates.mockResolvedValue([
        frame('a1', 0),
        frame('a2', 1),
        frame('b1', 1.5, { camera: 'Sony|A7|' }),
        frame('a3', 2),
        frame('a4', 3),
      ]);
      // a1-a2 alike, a2-a3 not, a3-a4 alike
      mocks.stack.getSimilarities.mockResolvedValue([0.95, 0.5, 0.96]);

      await sut.handleAutoStack({ userId: 'owner' });

      expect(mocks.stack.getSimilarities).toHaveBeenCalledWith([
        ['a1', 'a2'],
        ['a2', 'a3'],
        ['a3', 'a4'],
      ]);
      expect(mocks.stack.create.mock.calls.map(([, ids]) => ids)).toEqual([
        ['a1', 'a2'],
        ['a3', 'a4'],
      ]);
    });

    it("trusts the camera's burst id without comparing photos, and waits for every frame's score", async () => {
      mocks.stack.getAutoStackCandidates.mockResolvedValue([
        frame('c1', 0, { burstId: 'burst' }),
        frame('c2', 0.1, { burstId: 'burst' }),
        frame('u1', 100),
        frame('u2', 100.5, { scored: false }),
      ]);
      mocks.stack.getSimilarities.mockResolvedValue([0.99]);

      await sut.handleAutoStack({ userId: 'owner' });

      expect(mocks.stack.create.mock.calls.map(([, ids]) => ids)).toEqual([['c1', 'c2']]);
      expect(mocks.stack.getSimilarities).toHaveBeenCalledWith([['u1', 'u2']]);
    });

    it('does nothing while the owner keeps it off', async () => {
      mocks.user.getAutoStackUserIds.mockResolvedValue([]);

      await expect(sut.handleAutoStack({ userId: 'owner' })).resolves.toBe('skipped');
      expect(mocks.stack.getAutoStackCandidates).not.toHaveBeenCalled();
    });

    it('takes only the automatic stacks apart when the setting is turned off', async () => {
      mocks.stack.getAutomaticStackIds.mockResolvedValue(['auto-1', 'auto-2']);
      mocks.stack.deleteAll.mockResolvedValue();

      await sut.handleAutoStack({ userId: 'owner', unstack: true });

      expect(mocks.stack.getAutomaticStackIds).toHaveBeenCalledWith('owner');
      expect(mocks.stack.deleteAll).toHaveBeenCalledWith(['auto-1', 'auto-2'], undefined, expect.any(Function));
      expect(mocks.stack.excludeAutomaticMembers).not.toHaveBeenCalled();
    });

    it('remembers an automatic stack the owner unstacks, so the next run leaves it', async () => {
      const auth = AuthFactory.create();
      mocks.access.stack.checkOwnerAccess.mockResolvedValue(new Set(['stack-1']));
      mocks.stack.delete.mockResolvedValue();

      await sut.delete(auth, 'stack-1');

      expect(mocks.stack.excludeAutomaticMembers).toHaveBeenCalledWith(['stack-1']);
    });
  });
});
