import { BadRequestException } from '@nestjs/common';
import { AssetVisibility, TimeBucketDateType } from 'src/enum.js';
import { TimelineService } from 'src/services/timeline.service.js';
import { PartnerFactory } from 'test/factories/partner.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getForPartner } from 'test/mappers.js';
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

    it('should include partner shared assets', async () => {
      const json = `[{ id: ['asset-id'] }]`;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: json });
      mocks.partner.getAll.mockResolvedValue([]);

      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          visibility: AssetVisibility.Timeline,
          userId: authStub.admin.user.id,
          withPartners: true,
        }),
      ).resolves.toEqual(json);
      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        'bucket',
        {
          timeBucket: 'bucket',
          visibility: AssetVisibility.Timeline,
          withPartners: true,
          userIds: [authStub.admin.user.id],
        },
        authStub.admin,
      );
    });

    it('should null location columns of partners who hide their locations from the viewer', async () => {
      const hiding = UserFactory.create();
      const sharing = UserFactory.create();
      const me = authStub.admin.user.id;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: '[]' });
      mocks.partner.getAll.mockResolvedValue([
        getForPartner(PartnerFactory.from({ shareLocation: false }).sharedBy(hiding).sharedWith({ id: me }).build()),
        getForPartner(PartnerFactory.from({ shareLocation: true }).sharedBy(sharing).sharedWith({ id: me }).build()),
      ]);

      await sut.getTimeBucket(authStub.admin, {
        timeBucket: 'bucket',
        visibility: AssetVisibility.Timeline,
        userId: me,
        withPartners: true,
      });

      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        'bucket',
        expect.objectContaining({
          // both partners stay in the timeline; only the hiding partner's location columns are nulled
          userIds: [me, hiding.id, sharing.id],
          locationHiddenOwnerIds: [hiding.id],
        }),
        authStub.admin,
      );
    });

    it('should leave partners who hide their locations out of a bounding-box (map) timeline', async () => {
      const hiding = UserFactory.create();
      const sharing = UserFactory.create();
      const me = authStub.admin.user.id;
      mocks.asset.getTimeBucket.mockResolvedValue({ assets: '[]' });
      mocks.partner.getAll.mockResolvedValue([
        getForPartner(PartnerFactory.from({ shareLocation: false }).sharedBy(hiding).sharedWith({ id: me }).build()),
        getForPartner(PartnerFactory.from({ shareLocation: true }).sharedBy(sharing).sharedWith({ id: me }).build()),
      ]);

      await sut.getTimeBucket(authStub.admin, {
        timeBucket: 'bucket',
        visibility: AssetVisibility.Timeline,
        userId: me,
        withPartners: true,
        bbox: { west: -115, south: 50, east: -113, north: 52 },
      });

      expect(mocks.asset.getTimeBucket).toHaveBeenCalledWith(
        'bucket',
        expect.objectContaining({ userIds: [me, sharing.id] }),
        authStub.admin,
      );
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

    it('should throw an error if withParners is true and visibility true or undefined', async () => {
      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          visibility: AssetVisibility.Archive,
          withPartners: true,
          userId: authStub.admin.user.id,
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          visibility: undefined,
          withPartners: true,
          userId: authStub.admin.user.id,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw an error if withParners is true and isFavorite is either true or false', async () => {
      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          isFavorite: true,
          withPartners: true,
          userId: authStub.admin.user.id,
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          isFavorite: false,
          withPartners: true,
          userId: authStub.admin.user.id,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw an error if withParners is true and isTrash is true', async () => {
      await expect(
        sut.getTimeBucket(authStub.admin, {
          timeBucket: 'bucket',
          isTrashed: true,
          withPartners: true,
          userId: authStub.admin.user.id,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw an error if withPartners is true and visibility is locked', async () => {
      await expect(
        sut.getTimeBucket(authStub.adminWithElevatedPermission, {
          timeBucket: 'bucket',
          visibility: AssetVisibility.Locked,
          withPartners: true,
          userId: authStub.adminWithElevatedPermission.user.id,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Locked media in album timelines (FL-32)', () => {
    const elevated = authStub.adminWithElevatedPermission;

    it('reads an album timeline with the elevated viewer as the Locked owner', async () => {
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['album-id']));
      mocks.asset.getTimeBuckets.mockResolvedValue([]);

      await sut.getTimeBuckets(elevated, { albumId: 'album-id' });

      expect(mocks.asset.getTimeBuckets).toHaveBeenCalledWith(
        { albumId: 'album-id', lockedOwnerId: elevated.user.id },
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
});
