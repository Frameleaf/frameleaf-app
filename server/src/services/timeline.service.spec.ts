import { BadRequestException } from '@nestjs/common';
import { AssetLockReason, AssetVisibility, TimeBucketDateType } from 'src/enum.js';
import { TimelineService } from 'src/services/timeline.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(TimelineService.name, () => {
  let sut: TimelineService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(TimelineService));
    mocks.partner.getAll.mockResolvedValue([]);
  });

  describe('getTimeBuckets', () => {
    it("should return buckets if userId and albumId aren't set", async () => {
      mocks.asset.getTimeBuckets.mockResolvedValue([{ timeBucket: 'bucket', count: 1 }]);

      await expect(sut.getTimeBuckets(authStub.admin, {})).resolves.toEqual(
        expect.arrayContaining([{ timeBucket: 'bucket', count: 1 }]),
      );
      expect(mocks.asset.getTimeBuckets).toHaveBeenCalledWith(
        {
          userIds: [authStub.admin.user.id],
        },
        authStub.admin,
      );
    });

    it('should exclude NSFW assets when privacy hiding is active', async () => {
      const auth = { ...authStub.admin, hideNsfwAssets: true };
      mocks.asset.getTimeBuckets.mockResolvedValue([{ timeBucket: 'bucket', count: 1 }]);

      await sut.getTimeBuckets(auth, {});

      expect(mocks.asset.getTimeBuckets).toHaveBeenCalledWith(
        {
          excludeNsfw: true,
          userIds: [auth.user.id],
        },
        auth,
      );
    });

    it('should pass bbox options to repository when all bbox fields are provided', async () => {
      mocks.asset.getTimeBuckets.mockResolvedValue([{ timeBucket: 'bucket', count: 1 }]);

      await sut.getTimeBuckets(authStub.admin, {
        bbox: {
          west: -70,
          south: -30,
          east: 120,
          north: 55,
        },
      });

      expect(mocks.asset.getTimeBuckets).toHaveBeenCalledWith(
        {
          userIds: [authStub.admin.user.id],
          bbox: { west: -70, south: -30, east: 120, north: 55 },
        },
        authStub.admin,
      );
    });

    it('should pass the bucket date type to the repository', async () => {
      mocks.asset.getTimeBuckets.mockResolvedValue([{ timeBucket: 'bucket', count: 1 }]);

      await sut.getTimeBuckets(authStub.admin, { dateType: TimeBucketDateType.Added });

      expect(mocks.asset.getTimeBuckets).toHaveBeenCalledWith(
        {
          dateType: TimeBucketDateType.Added,
          userIds: [authStub.admin.user.id],
        },
        authStub.admin,
      );
    });
  });

  describe('pet filter', () => {
    const petId = '00000000-0000-4000-8000-00000000000a';

    it('should pass a pet id to the bucket query, which scopes it to the caller', async () => {
      mocks.asset.getTimeBuckets.mockResolvedValue([{ timeBucket: 'bucket', count: 1 }]);

      await sut.getTimeBuckets(authStub.admin, { petId });

      expect(mocks.asset.getTimeBuckets).toHaveBeenCalledWith(
        {
          petId,
          userIds: [authStub.admin.user.id],
        },
        authStub.admin,
      );
    });

    it('should reject a pet filter through a shared link', async () => {
      mocks.access.album.checkSharedLinkAccess.mockResolvedValue(new Set(['album-id']));

      await expect(
        sut.getTimeBucket(authStub.adminSharedLink, { timeBucket: 'bucket', albumId: 'album-id', petId }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.asset.getTimeBucket).not.toHaveBeenCalled();
    });
  });

  describe('getTimelineOrdered (FL-30, S-15)', () => {
    it('runs the time buckets’ checks and options, and pages the flat order', async () => {
      const json = `{ "id": ["asset-id"] }`;
      mocks.asset.getTimelineOrdered.mockResolvedValue({ assets: json });

      await expect(
        sut.getTimelineOrdered(authStub.admin, {
          sort: 'rating',
          skip: 500,
          take: 500,
          visibility: AssetVisibility.Archive,
          userId: authStub.admin.user.id,
        }),
      ).resolves.toEqual(json);
      expect(mocks.asset.getTimelineOrdered).toHaveBeenCalledWith(
        expect.objectContaining({ visibility: AssetVisibility.Archive, userIds: [authStub.admin.user.id] }),
        authStub.admin,
        { sort: 'rating', skip: 500, take: 500 },
      );
    });

    it('validates cursor tuples and retains timestamp precision and bucket privacy options', async () => {
      const cursor = [5, '2026-10-01T12:00:00.123456+00:00', '00000000-0000-4000-8000-000000000001'];
      mocks.asset.getTimelineOrdered.mockResolvedValue({ assets: '{}' });
      const auth = { ...authStub.admin, hideNsfwAssets: true };
      await sut.getTimelineOrdered(auth, { sort: 'rating', skip: 1000, take: 500, before: JSON.stringify(cursor) });
      expect(mocks.asset.getTimelineOrdered).toHaveBeenCalledWith(
        expect.objectContaining({ excludeNsfw: true, userIds: [auth.user.id] }),
        auth,
        { sort: 'rating', skip: 1000, take: 500, cursor: { key: 5, date: cursor[1], id: cursor[2] }, reverse: true },
      );
      for (const after of [
        '[]',
        'null',
        'bad-json',
        JSON.stringify(['file.jpg', cursor[1], cursor[2]]),
        JSON.stringify([6, cursor[1], cursor[2]]),
        JSON.stringify([5, 'not-a-date', cursor[2]]),
        JSON.stringify([5, cursor[1], 'not-an-id']),
      ]) {
        await expect(sut.getTimelineOrdered(auth, { sort: 'rating', skip: 0, take: 1, after })).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
      await expect(
        sut.getTimelineOrdered(auth, {
          sort: 'rating',
          skip: 0,
          take: 1,
          after: JSON.stringify(cursor),
          before: JSON.stringify(cursor),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.asset.getTimelineOrdered).toHaveBeenCalledTimes(1);
    });

    it('refuses the Locked view without an elevated session, as the buckets do', async () => {
      await expect(
        sut.getTimelineOrdered(authStub.admin, {
          sort: 'filename',
          skip: 0,
          take: 10,
          visibility: AssetVisibility.Locked,
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(mocks.asset.getTimelineOrdered).not.toHaveBeenCalled();
    });
  });

  describe('getTimeBucket', () => {
    it('should return the assets for a album time bucket if user has album.read', async () => {
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['album-id']));
      const json = `[{ id: ['asset-id'] }]`;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });

      await expect(sut.getTimeBucket(authStub.admin, { timeBucket: 'bucket', albumId: 'album-id' })).resolves.toEqual(
        json,
      );

      expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalledWith(authStub.admin.user.id, new Set(['album-id']));
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        'bucket',
        {
          timeBucket: 'bucket',
          albumId: 'album-id',
        },
        authStub.admin,
      );
    });

    it('should return the assets for a archive time bucket if user has archive.read', async () => {
      const json = `[{ id: ['asset-id'] }]`;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });

      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          visibility: AssetVisibility.Archive,
          userId: authStub.admin.user.id,
        }),
      ).resolves.toEqual(json);
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        'bucket',
        expect.objectContaining({
          timeBucket: 'bucket',
          visibility: AssetVisibility.Archive,
          userIds: [authStub.admin.user.id],
        }),
        authStub.admin,
      );
    });

    it("never reads a partner's timeline: what they share arrives as the viewer's own copies (FL-326)", async () => {
      mocks.partner.getAll.mockResolvedValue([]);

      await expect(
        sut.getTimeBucket(authStub.admin, { timeBucket: 'bucket', userId: authStub.user1.user.id }),
      ).rejects.toThrow(BadRequestException);
      expect(mocks.asset.getTimeBucket).not.toHaveBeenCalled();
    });

    it("should not look up partners for the viewer's own timeline", async () => {
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: '[]' });

      await sut.getTimeBucket(authStub.admin, {
        timeBucket: 'bucket',
        visibility: AssetVisibility.Timeline,
        userId: authStub.admin.user.id,
      });

      expect(mocks.partner.getAll).not.toHaveBeenCalled();
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        'bucket',
        expect.not.objectContaining({ locationHiddenOwnerIds: expect.anything() }),
        authStub.admin,
      );
    });

    it('should check permissions to read tag', async () => {
      const json = `[{ id: ['asset-id'] }]`;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set(['tag-123']));

      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          userId: authStub.admin.user.id,
          tagId: 'tag-123',
        }),
      ).resolves.toEqual(json);
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        'bucket',
        {
          tagId: 'tag-123',
          timeBucket: 'bucket',
          userIds: [authStub.admin.user.id],
        },
        authStub.admin,
      );
    });

    it('should return the assets for a library time bucket if user has library.read', async () => {
      const json = `[{ id: ['asset-id'] }]`;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });

      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          userId: authStub.admin.user.id,
        }),
      ).resolves.toEqual(json);
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        'bucket',
        expect.objectContaining({
          timeBucket: 'bucket',
          userIds: [authStub.admin.user.id],
        }),
        authStub.admin,
      );
    });
  });

  describe('Locked media in album timelines (FL-32)', () => {
    const elevated = authStub.adminWithElevatedPermission;

    it('reads an album timeline with the elevated viewer as the Locked owner', async () => {
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['album-id']));
      mocks.asset.getTimeBuckets.mockResolvedValue([]);

      await sut.getTimeBuckets(elevated, { albumId: 'album-id' });

      expect(mocks.asset.getTimeBuckets).toHaveBeenCalledWith(
        { albumId: 'album-id', lockedOwnerId: elevated.user.id, revealLockedOwnerId: elevated.user.id },
        elevated,
      );
    });

    it('reads an album timeline without a Locked owner for an ordinary session', async () => {
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['album-id']));
      mocks.asset.getTimeBuckets.mockResolvedValue([]);

      await sut.getTimeBuckets(authStub.admin, { albumId: 'album-id' });

      expect(mocks.asset.getTimeBuckets).toHaveBeenCalledWith({ albumId: 'album-id' }, authStub.admin);
      expect(mocks.asset.getTimeBuckets.mock.calls[0][0].lockedOwnerId).toBeUndefined();
    });

    it('never names a Locked owner for a shared link viewing an album', async () => {
      const auth = { ...authStub.adminSharedLink, session: elevated.session };
      mocks.access.album.checkSharedLinkAccess.mockResolvedValue(new Set(['album-id']));
      mocks.asset.getTimeBuckets.mockResolvedValue([]);

      await sut.getTimeBuckets(auth, { albumId: 'album-id' });

      expect(mocks.asset.getTimeBuckets.mock.calls[0][0].lockedOwnerId).toBeUndefined();
    });

    it('keeps the main timeline free of Locked media even when elevated', async () => {
      mocks.asset.getTimeBuckets.mockResolvedValue([]);

      await sut.getTimeBuckets(elevated, {});

      expect(mocks.asset.getTimeBuckets.mock.calls[0][0].lockedOwnerId).toBeUndefined();
    });

    it('scopes an explicit Locked request on an album to the caller, so other members stay private', async () => {
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['album-id']));
      mocks.asset.getTimeBuckets.mockResolvedValue([]);

      await sut.getTimeBuckets(elevated, { albumId: 'album-id', visibility: AssetVisibility.Locked });

      expect(mocks.asset.getTimeBuckets).toHaveBeenCalledWith(
        {
          albumId: 'album-id',
          visibility: AssetVisibility.Locked,
          userIds: [elevated.user.id],
          lockedOwnerId: elevated.user.id,
          revealLockedOwnerId: elevated.user.id,
        },
        elevated,
      );
    });

    it('still refuses an explicit Locked request for another user', async () => {
      await expect(
        sut.getTimeBuckets(elevated, { userId: 'someone-else', visibility: AssetVisibility.Locked }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('the Locked view filtered by why items are locked (FL-34)', () => {
    const elevated = authStub.adminWithElevatedPermission;

    it('narrows the Locked view to one reason, for the caller only', async () => {
      mocks.asset.getTimeBuckets.mockResolvedValue([]);

      await sut.getTimeBuckets(elevated, { visibility: AssetVisibility.Locked, lockReason: AssetLockReason.Detected });

      expect(mocks.asset.getTimeBuckets).toHaveBeenCalledWith(
        expect.objectContaining({
          visibility: AssetVisibility.Locked,
          lockReasons: [AssetLockReason.Detected],
          userIds: [elevated.user.id],
        }),
        elevated,
      );
    });

    it('refuses a reason outside the Locked view', async () => {
      await expect(sut.getTimeBuckets(elevated, { lockReason: AssetLockReason.Marked })).rejects.toThrow(
        BadRequestException,
      );
      expect(mocks.asset.getTimeBuckets).not.toHaveBeenCalled();
    });

    it("reveals the owner's own sensitive locks in their timeline once unlocked", async () => {
      mocks.asset.getTimeBuckets.mockResolvedValue([]);

      await sut.getTimeBuckets(elevated, { visibility: AssetVisibility.Timeline });
      expect(mocks.asset.getTimeBuckets.mock.calls[0][0].revealLockedOwnerId).toBe(elevated.user.id);

      await sut.getTimeBuckets(authStub.admin, { visibility: AssetVisibility.Timeline });
      expect(mocks.asset.getTimeBuckets.mock.calls[1][0].revealLockedOwnerId).toBeUndefined();
    });

    it('reveals them in every ordinary view once unlocked: an album, the archive, a person (FL-195)', async () => {
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['album-id']));
      mocks.asset.getTimeBuckets.mockResolvedValue([]);

      await sut.getTimeBuckets(elevated, { albumId: 'album-id', visibility: AssetVisibility.Timeline });
      await sut.getTimeBuckets(elevated, { visibility: AssetVisibility.Archive });

      expect(mocks.asset.getTimeBuckets.mock.calls[0][0].revealLockedOwnerId).toBe(elevated.user.id);
      expect(mocks.asset.getTimeBuckets.mock.calls[1][0].revealLockedOwnerId).toBe(elevated.user.id);
    });

    it('never reveals through a shared link, even when its creator is unlocked elsewhere (FL-195)', async () => {
      mocks.access.album.checkSharedLinkAccess.mockResolvedValue(new Set(['album-id']));
      mocks.asset.getTimeBuckets.mockResolvedValue([]);

      await sut.getTimeBuckets(
        { ...authStub.adminSharedLink, session: { id: 'session', hasElevatedPermission: true } } as never,
        { albumId: 'album-id' },
      );

      expect(mocks.asset.getTimeBuckets.mock.calls[0][0].revealLockedOwnerId).toBeUndefined();
    });

    it('needs the unlocked session for the Locked view, whatever the reason', async () => {
      await expect(
        sut.getTimeBuckets(authStub.admin, {
          visibility: AssetVisibility.Locked,
          lockReason: AssetLockReason.ImmichLockedFolder,
        }),
      ).rejects.toThrow();
      expect(mocks.asset.getTimeBuckets).not.toHaveBeenCalled();
    });
  });

  describe('getTimelineHighlights (FL-33)', () => {
    it('uses the same options as the time buckets', async () => {
      const auth = { ...authStub.admin, hideNsfwAssets: true };
      mocks.asset.getTimelineHighlights.mockResolvedValue([]);
      mocks.asset.getTimeBuckets.mockResolvedValue([]);

      await sut.getTimelineHighlights(auth, { grouping: 'month', isFavorite: true });
      await sut.getTimeBuckets(auth, { isFavorite: true });

      const [highlightOptions] = mocks.asset.getTimelineHighlights.mock.calls[0];
      const [bucketOptions] = mocks.asset.getTimeBuckets.mock.calls[0];
      expect(highlightOptions).toEqual(bucketOptions);
      expect(mocks.asset.getTimelineHighlights.mock.calls[0][2]).toEqual({
        grouping: 'month',
        highlightCount: 4,
        withPlaces: true,
      });
    });

    it('gives year cards no highlights', async () => {
      mocks.asset.getTimelineHighlights.mockResolvedValue([]);
      await sut.getTimelineHighlights(authStub.admin, { grouping: 'year', highlightCount: 6 });
      expect(mocks.asset.getTimelineHighlights.mock.calls[0][2]).toEqual(
        expect.objectContaining({ grouping: 'year', highlightCount: 0 }),
      );
    });

    it('requires an elevated session for Locked highlights', async () => {
      await expect(
        sut.getTimelineHighlights(authStub.admin, { grouping: 'month', visibility: AssetVisibility.Locked }),
      ).rejects.toThrow('Elevated permission');
      expect(mocks.asset.getTimelineHighlights).not.toHaveBeenCalled();
    });

    it("never scopes Locked highlights to another user's library", async () => {
      const auth = { ...authStub.admin, session: { id: 'session', hasElevatedPermission: true } } as any;
      await expect(
        sut.getTimelineHighlights(auth, {
          grouping: 'month',
          visibility: AssetVisibility.Locked,
          userId: '00000000-0000-4000-8000-000000000000',
        }),
      ).rejects.toThrow("You may not access another user's locked timeline");
    });
  });
});
