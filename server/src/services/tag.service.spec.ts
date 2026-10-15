import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import { AssetVisibility, JobName, JobStatus, Permission, UserMetadataKey } from 'src/enum.js';
import { TagService, followMergedTags } from 'src/services/tag.service.js';
import { getPreferences } from 'src/utils/preferences.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { tagResponseStub, tagStub } from 'test/fixtures/tag.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(TagService.name, () => {
  let sut: TagService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(TagService));

    mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set(['tag-1']));
    mocks.tag.getSubtreeAssetIds.mockResolvedValue([]);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getAll', () => {
    it('should return all tags for a user', async () => {
      mocks.tag.getAll.mockResolvedValue([tagStub.tag]);
      await expect(sut.getAll(authStub.admin)).resolves.toEqual([tagResponseStub.tag1]);
      // not unlocked: a tag only on locked items is left out (owner decision, September 27, 2026)
      expect(mocks.tag.getAll).toHaveBeenCalledWith(authStub.admin.user.id, { hideLocked: true });
    });

    it('should list tags only on locked items for an unlocked session', async () => {
      mocks.tag.getAll.mockResolvedValue([tagStub.tag]);
      await sut.getAll({ ...authStub.admin, session: { id: 'session-1', hasElevatedPermission: true } });
      expect(mocks.tag.getAll).toHaveBeenCalledWith(authStub.admin.user.id, {
        hideLocked: false,
        revealLockedOwnerId: authStub.admin.user.id,
      });
    });

    it('should request non-NSFW tags while hide mode is active', async () => {
      mocks.tag.getAll.mockResolvedValue([tagStub.tag]);
      await expect(sut.getAll({ ...authStub.admin, hideNsfwAssets: true })).resolves.toEqual([tagResponseStub.tag1]);
      expect(mocks.tag.getAll).toHaveBeenCalledWith(authStub.admin.user.id, { excludeNsfw: true, hideLocked: true });
    });
  });

  describe('getStatistics (FL-46)', () => {
    it("should count the owner's Timeline items per tag, with and without subtags", async () => {
      mocks.search.searchTagStatistics.mockResolvedValue([
        {
          tagId: 'tag-1',
          count: 1,
          total: 3,
          coverAssetIds: ['asset-3', 'asset-2', 'asset-1'],
          startDate: new Date('2024-06-01'),
          endDate: new Date('2026-03-09'),
        },
        {
          tagId: 'tag-2',
          count: 2,
          total: 2,
          coverAssetIds: ['asset-2', 'asset-1'],
          startDate: new Date('2024-06-01'),
          endDate: new Date('2024-06-01'),
        },
      ]);

      // the cover keeps the order the query gave it, and the dates read like an album's
      await expect(sut.getStatistics(authStub.admin)).resolves.toEqual([
        {
          id: 'tag-1',
          count: 1,
          total: 3,
          coverAssetIds: ['asset-3', 'asset-2', 'asset-1'],
          startDate: '2024-06-01T00:00:00.000Z',
          endDate: '2026-03-09T00:00:00.000Z',
        },
        {
          id: 'tag-2',
          count: 2,
          total: 2,
          coverAssetIds: ['asset-2', 'asset-1'],
          startDate: '2024-06-01T00:00:00.000Z',
          endDate: '2024-06-01T00:00:00.000Z',
        },
      ]);
      expect(mocks.search.searchTagStatistics).toHaveBeenCalledWith(
        {
          visibility: AssetVisibility.Timeline,
          lockedOwnerId: undefined,
          hideLockedMotion: true,
          userIds: [authStub.admin.user.id],
          viewingUserId: authStub.admin.user.id,
        },
        { viewerId: authStub.admin.user.id, suppressedTagIds: [] },
      );
    });

    it('should keep Timeline visibility (never Locked) even for an unlocked session', async () => {
      mocks.search.searchTagStatistics.mockResolvedValue([]);
      const elevated = { ...authStub.admin, session: { id: 'session-1', hasElevatedPermission: true } };

      await sut.getStatistics(elevated as typeof authStub.admin);

      expect(mocks.search.searchTagStatistics).toHaveBeenCalledWith(
        expect.objectContaining({ visibility: AssetVisibility.Timeline, lockedOwnerId: authStub.admin.user.id }),
        expect.anything(),
      );
    });

    it('should leave hidden items and suppressed tags out while the session is locked', async () => {
      mocks.search.searchTagStatistics.mockResolvedValue([]);
      const hiddenContent = {
        userId: authStub.admin.user.id,
        includeNsfw: false,
        tagIds: ['tag-private'],
        personIds: [],
        petIds: [],
        scope: 'owned' as const,
      };

      await sut.getStatistics({ ...authStub.admin, hiddenContent });

      expect(mocks.search.searchTagStatistics).toHaveBeenCalledWith(expect.objectContaining({ hiddenContent }), {
        viewerId: authStub.admin.user.id,
        suppressedTagIds: ['tag-private'],
      });
    });
  });

  describe('get', () => {
    it('should throw an error for an invalid id', async () => {
      await expect(sut.get(authStub.admin, 'tag-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.tag.get).toHaveBeenCalledWith('tag-1');
    });

    it('should return a tag for a user', async () => {
      mocks.tag.get.mockResolvedValue(tagStub.tag);
      await expect(sut.get(authStub.admin, 'tag-1')).resolves.toEqual(tagResponseStub.tag1);
      expect(mocks.tag.get).toHaveBeenCalledWith('tag-1');
    });
  });

  describe('create', () => {
    it('should throw an error for no parent tag access', async () => {
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(sut.create(authStub.admin, { name: 'tag', parentId: 'tag-parent' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.tag.create).not.toHaveBeenCalled();
    });

    it('should create a tag with a parent', async () => {
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set(['tag-parent']));
      mocks.tag.create.mockResolvedValue(tagStub.tagCreate);
      mocks.tag.get.mockResolvedValueOnce(tagStub.parentUpsert);
      mocks.tag.get.mockResolvedValueOnce(tagStub.childUpsert);
      await expect(sut.create(authStub.admin, { name: 'tagA', parentId: 'tag-parent' })).resolves.toBeDefined();
      expect(mocks.tag.create).toHaveBeenCalledWith(expect.objectContaining({ value: 'Parent/tagA' }));
    });

    it('should handle invalid parent ids', async () => {
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set(['tag-parent']));
      await expect(sut.create(authStub.admin, { name: 'tagA', parentId: 'tag-parent' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.tag.create).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('answers an existing name with that tag, unchanged, never an error (owner decision, September 27, 2026)', async () => {
      mocks.tag.getByValue.mockResolvedValue(tagStub.tag);
      await expect(sut.create(authStub.admin, { name: 'tag-1', color: '#123456' })).resolves.toEqual(
        tagResponseStub.tag1,
      );
      expect(mocks.tag.getByValue).toHaveBeenCalledWith(authStub.admin.user.id, 'tag-1');
      expect(mocks.tag.create).not.toHaveBeenCalled();
      expect(mocks.tag.update).not.toHaveBeenCalled();
    });

    it('answers with the tag another request created meanwhile', async () => {
      mocks.tag.getByValue.mockResolvedValueOnce(void 0).mockResolvedValueOnce(tagStub.tag);
      mocks.tag.create.mockRejectedValue(
        Object.assign(new Error('duplicate'), { constraint_name: 'tag_userId_value_uq' }),
      );
      await expect(sut.create(authStub.admin, { name: 'tag-1' })).resolves.toEqual(tagResponseStub.tag1);
    });

    it('should create a new tag', async () => {
      mocks.tag.create.mockResolvedValue(tagStub.tagCreate);
      await expect(sut.create(authStub.admin, { name: 'tag-1' })).resolves.toEqual(tagResponseStub.tag1);
      expect(mocks.tag.create).toHaveBeenCalledWith({
        userId: authStub.admin.user.id,
        value: 'tag-1',
      });
    });

    it('should create a new tag with optional color', async () => {
      mocks.tag.create.mockResolvedValue(tagStub.colorCreate);
      mocks.tag.getByValue.mockResolvedValue(void 0);

      await expect(sut.create(authStub.admin, { name: 'tag-1', color: '#000000' })).resolves.toEqual(
        tagResponseStub.color1,
      );

      expect(mocks.tag.create).toHaveBeenCalledWith({
        userId: authStub.admin.user.id,
        value: 'tag-1',
        color: '#000000',
      });
    });
  });

  describe('update', () => {
    it('should throw an error for no update permission', async () => {
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(sut.update(authStub.admin, 'tag-1', { name: 'tag', color: '#000000' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.tag.update).not.toHaveBeenCalled();
    });

    it('should throw an error if updated tag name has a slash', async () => {
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set(['tag-parent']));
      await expect(sut.update(authStub.admin, 'tag-1', { name: 'tag/test2', color: '#000000' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.tag.update).not.toHaveBeenCalled();
    });

    it('should update a tag', async () => {
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set(['tag-1']));
      mocks.tag.update.mockResolvedValue(tagStub.colorCreate);
      await expect(sut.update(authStub.admin, 'tag-1', { name: 'tag', color: '#000000' })).resolves.toEqual(
        tagResponseStub.color1,
      );
      expect(mocks.tag.update).toHaveBeenCalledWith('tag-1', { name: 'tag', color: '#000000' });
    });

    it('should move a tag to the top level', async () => {
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set(['tag-1']));
      mocks.tag.update.mockResolvedValue(tagStub.colorCreate);
      await sut.update(authStub.admin, 'tag-1', { parentId: null });
      expect(mocks.tag.update).toHaveBeenCalledWith('tag-1', { parentId: null });
    });

    it('should require read access to the new parent', async () => {
      mocks.access.tag.checkOwnerAccess.mockResolvedValueOnce(new Set(['tag-1']));
      mocks.access.tag.checkOwnerAccess.mockResolvedValueOnce(new Set());
      await expect(sut.update(authStub.admin, 'tag-1', { parentId: 'tag-other' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.tag.update).not.toHaveBeenCalled();
    });
  });

  it('propagates renamed subtree tags through the existing asset edit path', async () => {
    mocks.tag.update.mockResolvedValue(tagStub.colorCreate);
    mocks.tag.getSubtreeAssetIds.mockResolvedValue(['photo', 'child-photo']);
    mocks.asset.getForUpdateTags.mockResolvedValue({ tags: [{ value: 'Renamed/Child' }] } as never);
    mocks.partnerOrigin.getIdsWithFollowers.mockResolvedValue(['photo', 'child-photo']);

    await sut.update(authStub.admin, 'tag-1', { name: 'Renamed' });

    expect(mocks.tag.getSubtreeAssetIds).toHaveBeenCalledWith('tag-1');
    expect(mocks.partnerOrigin.markOverridden).toHaveBeenCalledWith(
      'asset',
      ['photo', 'child-photo'],
      ['tags'],
      authStub.admin.user.id,
    );
    expect(mocks.job.queueAll).toHaveBeenCalledWith(
      ['photo', 'child-photo'].map((sourceId) => ({
        name: JobName.PartnerPropagate,
        data: { kind: 'asset', sourceId, fields: ['tags'] },
      })),
    );
    expect(mocks.asset.upsertExif).toHaveBeenCalledTimes(2);
  });

  describe('upsert', () => {
    it('should upsert a new tag', async () => {
      mocks.tag.upsertValue.mockResolvedValue(tagStub.parentUpsert);
      await expect(sut.upsert(authStub.admin, { tags: ['Parent'] })).resolves.toBeDefined();
      expect(mocks.tag.upsertValue).toHaveBeenCalledWith({
        value: 'Parent',
        userId: 'admin_id',
        parentId: undefined,
      });
    });

    it('should upsert a nested tag', async () => {
      mocks.tag.upsertValue.mockResolvedValueOnce(tagStub.parentUpsert);
      mocks.tag.upsertValue.mockResolvedValueOnce(tagStub.childUpsert);
      await expect(sut.upsert(authStub.admin, { tags: ['Parent/Child'] })).resolves.toBeDefined();
      expect(mocks.tag.upsertValue).toHaveBeenNthCalledWith(1, {
        value: 'Parent',
        userId: 'admin_id',
        parentId: undefined,
      });
      expect(mocks.tag.upsertValue).toHaveBeenNthCalledWith(2, {
        value: 'Parent/Child',
        userId: 'admin_id',
        parentId: 'tag-parent',
      });
    });

    it('should upsert a tag and ignore leading and trailing slashes', async () => {
      mocks.tag.upsertValue.mockResolvedValueOnce(tagStub.parentUpsert);
      mocks.tag.upsertValue.mockResolvedValueOnce(tagStub.childUpsert);
      await expect(sut.upsert(authStub.admin, { tags: ['/Parent/Child/'] })).resolves.toBeDefined();
      expect(mocks.tag.upsertValue).toHaveBeenNthCalledWith(1, {
        value: 'Parent',
        userId: 'admin_id',
        parentId: undefined,
      });
      expect(mocks.tag.upsertValue).toHaveBeenNthCalledWith(2, {
        value: 'Parent/Child',
        userId: 'admin_id',
        parentId: 'tag-parent',
      });
    });
  });

  describe('remove', () => {
    it('should throw an error for an invalid id', async () => {
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(sut.remove(authStub.admin, 'tag-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.tag.delete).not.toHaveBeenCalled();
    });

    it('should remove a tag', async () => {
      mocks.tag.get.mockResolvedValue(tagStub.tag);
      mocks.tag.delete.mockResolvedValue();

      await sut.remove(authStub.admin, 'tag-1');
      expect(mocks.tag.delete).toHaveBeenCalledWith('tag-1');
    });
  });

  describe('merge', () => {
    const merged = { ...tagStub.tag, id: 'tag-2', value: 'Tag2' };
    const preferences = (value: object) => [{ key: UserMetadataKey.Preferences as const, value }];

    beforeEach(() => {
      // each tag is checked on its own, and the check answers exactly the ids it allows
      mocks.access.tag.checkOwnerAccess.mockImplementation((_, ids) => Promise.resolve(new Set(ids)));
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.asset.getForUpdateTags.mockResolvedValue({ tags: [{ value: 'Tag2' }] });
      mocks.tag.merge.mockResolvedValue({
        tag: merged,
        merged: [{ id: 'tag-1', targetId: 'tag-2' }],
        taggedAssetIds: ['asset-1'],
        assetIds: ['asset-1', 'asset-2'],
      });
    });

    it('should answer 404 for a tag the caller may not delete, or a target they may not change', async () => {
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(sut.merge(authStub.admin, 'tag-1', { targetId: 'tag-2' })).rejects.toBeInstanceOf(NotFoundException);

      mocks.access.tag.checkOwnerAccess.mockImplementation((_, ids) =>
        Promise.resolve(new Set([...ids].filter((id) => id === 'tag-1'))),
      );
      await expect(sut.merge(authStub.admin, 'tag-1', { targetId: 'tag-2' })).rejects.toBeInstanceOf(NotFoundException);

      expect(mocks.database.withUserPreferencesLock).not.toHaveBeenCalled();
      expect(mocks.tag.merge).not.toHaveBeenCalled();
    });

    it('should ask an API key for the permission to update tags as well', async () => {
      const key = (permissions: Permission[]) => ({ ...authStub.admin, apiKey: { id: 'key-1', permissions } });

      await expect(sut.merge(key([Permission.TagDelete]), 'tag-1', { targetId: 'tag-2' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mocks.tag.merge).not.toHaveBeenCalled();

      await expect(
        sut.merge(key([Permission.TagDelete, Permission.TagUpdate]), 'tag-1', { targetId: 'tag-2' }),
      ).resolves.toEqual(expect.objectContaining({ id: 'tag-2' }));
      await expect(sut.merge(key([Permission.All]), 'tag-1', { targetId: 'tag-2' })).resolves.toBeDefined();
    });

    it('should merge under the preferences lock and answer the tag that stays', async () => {
      await expect(sut.merge(authStub.admin, 'tag-1', { targetId: 'tag-2' })).resolves.toEqual({
        ...tagResponseStub.tag1,
        id: 'tag-2',
        name: 'Tag2',
        value: 'Tag2',
      });

      expect(mocks.database.withUserPreferencesLock).toHaveBeenCalledWith(authStub.admin.user.id, expect.any(Function));
      // the transaction the lock hands out (none in this test) goes to the repository
      expect(mocks.tag.merge).toHaveBeenCalledWith(undefined, 'tag-1', 'tag-2');
      expect(mocks.user.upsertMetadata).not.toHaveBeenCalled();
      expect(mocks.session.requestSyncResetForUser).not.toHaveBeenCalled();
    });

    it('should pass on a refusal from the repository and touch nothing else', async () => {
      mocks.tag.merge.mockRejectedValue(new BadRequestException('A tag cannot be merged into itself'));

      await expect(sut.merge(authStub.admin, 'tag-1', { targetId: 'tag-1' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.user.upsertMetadata).not.toHaveBeenCalled();
      expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('should bring every item involved up to date as tagging and untagging do', async () => {
      await sut.merge(authStub.admin, 'tag-1', { targetId: 'tag-2' });

      for (const assetId of ['asset-1', 'asset-2']) {
        expect(mocks.asset.upsertExif).toHaveBeenCalledWith({
          exif: { assetId, lockedProperties: ['tags'], tags: ['Tag2'] },
          lockedPropertiesBehavior: 'append',
        });
      }
      // gained the tag: "tagged"; only lost one, or carries one under a new path: its sidecar alone
      expect(mocks.event.emit.mock.calls).toEqual([
        ['AssetTag', { assetId: 'asset-1', userId: authStub.admin.user.id }],
        ['AssetUntag', { assetId: 'asset-2' }],
      ]);
      expect(mocks.partnerOrigin.markOverridden).toHaveBeenCalledWith(
        'asset',
        ['asset-1', 'asset-2'],
        ['tags'],
        authStub.admin.user.id,
      );
    });

    it('should move a Locked rule in the same transaction and have every session sync again', async () => {
      mocks.user.getMetadata.mockResolvedValue(
        preferences({ privacy: { suppression: { tagIds: ['tag-1', 'tag-9'] } }, memories: { enabled: false } }),
      );
      mocks.session.requestSyncResetForUser.mockResolvedValue();

      await sut.merge(authStub.admin, 'tag-1', { targetId: 'tag-2' });

      expect(mocks.user.getMetadata).toHaveBeenCalledWith(authStub.admin.user.id, undefined);
      expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(
        authStub.admin.user.id,
        {
          key: UserMetadataKey.Preferences,
          value: { privacy: { suppression: { tagIds: ['tag-2', 'tag-9'] } }, memories: { enabled: false } },
        },
        undefined,
      );
      expect(mocks.session.requestSyncResetForUser).toHaveBeenCalledWith(authStub.admin.user.id);
    });

    it('should follow a saved search without a sync reset: the Locked rules did not change', async () => {
      mocks.user.getMetadata.mockResolvedValue(
        preferences({ savedSearches: [{ name: 'Old', query: { tagIds: ['tag-1'] } }] }),
      );

      await sut.merge(authStub.admin, 'tag-1', { targetId: 'tag-2' });

      expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(
        authStub.admin.user.id,
        {
          key: UserMetadataKey.Preferences,
          value: { savedSearches: [{ name: 'Old', query: { tagIds: ['tag-2'] } }] },
        },
        undefined,
      );
      expect(mocks.session.requestSyncResetForUser).not.toHaveBeenCalled();
    });
  });

  describe('followMergedTags', () => {
    const merged = [
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', targetId: 'bbbbbbbb-0000-4000-8000-000000000001' },
      { id: 'aaaaaaaa-0000-4000-8000-000000000002', targetId: 'bbbbbbbb-0000-4000-8000-000000000002' },
    ];
    const [first, second] = merged;
    const other = 'cccccccc-0000-4000-8000-000000000001';
    const withPreferences = (value: object) => getPreferences([{ key: UserMetadataKey.Preferences, value }]);

    it('should answer nothing when no rule or search names a merged tag', () => {
      const preferences = withPreferences({
        privacy: { suppression: { tagIds: [other, first.targetId] } },
        savedSearches: [{ name: 'Other', query: { tagIds: [other], note: `not ${first.id} itself` } }],
      });
      expect(followMergedTags(preferences, merged)).toBeUndefined();
      expect(followMergedTags(withPreferences({}), merged)).toBeUndefined();
    });

    it('should replace each merged tag once in the Locked rules, keeping people, pets and scope', () => {
      const preferences = withPreferences({
        privacy: {
          suppression: {
            tagIds: [first.id, other, first.targetId, second.id],
            personIds: [first.id],
            petIds: ['pet-1'],
            scope: 'visible',
          },
        },
      });
      expect(followMergedTags(preferences, merged)?.privacy.suppression).toEqual({
        tagIds: [first.targetId, other, second.targetId],
        // only tags are followed where tags are listed; an id elsewhere is never a tag
        personIds: [first.id],
        petIds: ['pet-1'],
        scope: 'visible',
      });
    });

    it('should replace a merged tag anywhere in a saved search, whatever the case of the id', () => {
      const preferences = withPreferences({
        savedSearches: [
          { name: 'Flat', query: { tagIds: [first.id.toUpperCase(), first.targetId], city: 'Banff', rating: 5 } },
          {
            name: 'Nested',
            query: { any: [{ tagIds: [second.id] }, { not: { tagId: first.id } }], withStacked: true },
          },
          { name: 'Kept', query: { tagIds: [other, other] } },
        ],
      });
      const followed = followMergedTags(preferences, merged);
      expect(followed?.savedSearches).toEqual([
        { name: 'Flat', query: { tagIds: [first.targetId], city: 'Banff', rating: 5 } },
        {
          name: 'Nested',
          query: { any: [{ tagIds: [second.targetId] }, { not: { tagId: first.targetId } }], withStacked: true },
        },
        // a list that names no merged tag is left exactly as the client saved it
        { name: 'Kept', query: { tagIds: [other, other] } },
      ]);
      expect(followed?.privacy).toEqual(preferences.privacy);
    });
  });

  describe('bulkTagAssets', () => {
    it('should handle invalid requests', async () => {
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.tag.upsertAssetIds.mockResolvedValue([]);
      await expect(sut.bulkTagAssets(authStub.admin, { tagIds: ['tag-1'], assetIds: ['asset-1'] })).resolves.toEqual({
        count: 0,
      });
      expect(mocks.tag.upsertAssetIds).toHaveBeenCalledWith([]);
    });

    it('should upsert records', async () => {
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set(['tag-1', 'tag-2']));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1', 'asset-2', 'asset-3']));
      mocks.asset.getForUpdateTags.mockResolvedValue({ tags: [{ value: 'tag-1' }, { value: 'tag-2' }] });
      mocks.tag.upsertAssetIds.mockResolvedValue([
        { tagId: 'tag-1', assetId: 'asset-1', updateId: 'update-id' },
        { tagId: 'tag-1', assetId: 'asset-2', updateId: 'update-id' },
        { tagId: 'tag-1', assetId: 'asset-3', updateId: 'update-id' },
        { tagId: 'tag-2', assetId: 'asset-1', updateId: 'update-id' },
        { tagId: 'tag-2', assetId: 'asset-2', updateId: 'update-id' },
        { tagId: 'tag-2', assetId: 'asset-3', updateId: 'update-id' },
      ]);
      await expect(
        sut.bulkTagAssets(authStub.admin, { tagIds: ['tag-1', 'tag-2'], assetIds: ['asset-1', 'asset-2', 'asset-3'] }),
      ).resolves.toEqual({
        count: 6,
      });
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: { assetId: 'asset-1', lockedProperties: ['tags'], tags: ['tag-1', 'tag-2'] },
          lockedPropertiesBehavior: 'append',
        }),
      );
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: { assetId: 'asset-2', lockedProperties: ['tags'], tags: ['tag-1', 'tag-2'] },
          lockedPropertiesBehavior: 'append',
        }),
      );
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: { assetId: 'asset-3', lockedProperties: ['tags'], tags: ['tag-1', 'tag-2'] },
          lockedPropertiesBehavior: 'append',
        }),
      );
      expect(mocks.tag.upsertAssetIds).toHaveBeenCalledWith([
        { tagId: 'tag-1', assetId: 'asset-1' },
        { tagId: 'tag-1', assetId: 'asset-2' },
        { tagId: 'tag-1', assetId: 'asset-3' },
        { tagId: 'tag-2', assetId: 'asset-1' },
        { tagId: 'tag-2', assetId: 'asset-2' },
        { tagId: 'tag-2', assetId: 'asset-3' },
      ]);
    });
  });

  describe('addAssets', () => {
    it('should handle invalid ids', async () => {
      mocks.tag.getAssetIds.mockResolvedValue(new Set());
      await expect(sut.addAssets(authStub.admin, 'tag-1', { ids: ['asset-1'] })).resolves.toEqual([
        { id: 'asset-1', success: false, error: 'no_permission' },
      ]);
      expect(mocks.tag.getAssetIds).toHaveBeenCalledWith('tag-1', ['asset-1']);
      expect(mocks.tag.addAssetIds).not.toHaveBeenCalled();
    });

    it('should accept accept ids that are new and reject the rest', async () => {
      mocks.tag.get.mockResolvedValue(tagStub.tag);
      mocks.tag.getAssetIds.mockResolvedValue(new Set(['asset-1']));
      mocks.tag.addAssetIds.mockResolvedValue();
      mocks.asset.getForUpdateTags.mockResolvedValue({ tags: [{ value: 'tag-1' }] });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-2']));

      await expect(
        sut.addAssets(authStub.admin, 'tag-1', {
          ids: ['asset-1', 'asset-2'],
        }),
      ).resolves.toEqual([
        { id: 'asset-1', success: false, error: BulkIdErrorReason.DUPLICATE },
        { id: 'asset-2', success: true },
      ]);

      expect(mocks.asset.upsertExif).not.toHaveBeenCalledWith(
        expect.objectContaining({
          exif: { assetId: 'asset-1', lockedProperties: ['tags'], tags: ['tag-1'] },
          lockedPropertiesBehavior: 'append',
        }),
      );
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: { assetId: 'asset-2', lockedProperties: ['tags'], tags: ['tag-1'] },
          lockedPropertiesBehavior: 'append',
        }),
      );
      expect(mocks.tag.getAssetIds).toHaveBeenCalledWith('tag-1', ['asset-1', 'asset-2']);
      expect(mocks.tag.addAssetIds).toHaveBeenCalledWith('tag-1', ['asset-2']);
    });
  });

  describe('removeAssets', () => {
    it('should throw an error for an invalid id', async () => {
      mocks.tag.getAssetIds.mockResolvedValue(new Set());
      mocks.tag.removeAssetIds.mockResolvedValue();
      mocks.asset.getForUpdateTags.mockResolvedValue({ tags: [] });

      await expect(sut.removeAssets(authStub.admin, 'tag-1', { ids: ['asset-1'] })).resolves.toEqual([
        { id: 'asset-1', success: false, error: 'not_found' },
      ]);
    });

    it('should accept accept ids that are tagged and reject the rest', async () => {
      mocks.tag.get.mockResolvedValue(tagStub.tag);
      mocks.tag.getAssetIds.mockResolvedValue(new Set(['asset-1']));
      mocks.tag.removeAssetIds.mockResolvedValue();
      mocks.asset.getForUpdateTags.mockResolvedValue({ tags: [] });

      await expect(
        sut.removeAssets(authStub.admin, 'tag-1', {
          ids: ['asset-1', 'asset-2'],
        }),
      ).resolves.toEqual([
        { id: 'asset-1', success: true },
        { id: 'asset-2', success: false, error: BulkIdErrorReason.NOT_FOUND },
      ]);

      expect(mocks.tag.getAssetIds).toHaveBeenCalledWith('tag-1', ['asset-1', 'asset-2']);
      expect(mocks.tag.removeAssetIds).toHaveBeenCalledWith('tag-1', ['asset-1']);
    });
  });

  describe('a tag suppressed while the session is locked (owner decision, September 22, 2026)', () => {
    const lockedAuth = {
      ...authStub.admin,
      hideNsfwAssets: true,
      hiddenContent: {
        userId: authStub.admin.user.id,
        includeNsfw: false,
        tagIds: ['tag-1'],
        personIds: [],
        petIds: [],
        scope: 'owned' as const,
      },
    };

    it('hands the suppression filter to the access check and answers 404 like a missing tag', async () => {
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set());

      const suppressed = await sut.get(lockedAuth, 'tag-1').catch((error: unknown) => error);
      const missing = await sut.get(authStub.admin, 'tag-404').catch((error: unknown) => error);

      expect(mocks.access.tag.checkOwnerAccess).toHaveBeenCalledWith(
        authStub.admin.user.id,
        new Set(['tag-1']),
        lockedAuth.hiddenContent,
        true,
      );
      expect(suppressed).toBeInstanceOf(NotFoundException);
      expect(missing).toBeInstanceOf(NotFoundException);
      expect((suppressed as NotFoundException).getResponse()).toEqual((missing as NotFoundException).getResponse());
      expect(mocks.tag.get).not.toHaveBeenCalled();
    });

    it('answers a rename or delete with 404 and changes nothing', async () => {
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.update(lockedAuth, 'tag-1', { color: '#000000' })).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.remove(lockedAuth, 'tag-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.tag.update).not.toHaveBeenCalled();
      expect(mocks.tag.delete).not.toHaveBeenCalled();
    });

    it('checks applying a tag as the owner only, so a reused hidden tag can be applied (September 27, 2026)', async () => {
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set(['tag-1']));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.tag.getAssetIds.mockResolvedValue(new Set());

      await sut.addAssets(lockedAuth, 'tag-1', { ids: ['asset-1'] });
      expect(mocks.access.tag.checkOwnerAccess).toHaveBeenCalledWith(authStub.admin.user.id, new Set(['tag-1']));
    });

    it('hands the suppression filter to the tag list', async () => {
      mocks.tag.getAll.mockResolvedValue([]);

      await sut.getAll(lockedAuth);

      expect(mocks.tag.getAll).toHaveBeenCalledWith(authStub.admin.user.id, {
        hiddenContent: lockedAuth.hiddenContent,
        hideLocked: true,
      });
    });
  });

  describe('handleTagCleanup', () => {
    it('should delete empty tags', async () => {
      mocks.tag.deleteEmptyTags.mockResolvedValue();

      await expect(sut.handleTagCleanup()).resolves.toBe(JobStatus.Success);

      expect(mocks.tag.deleteEmptyTags).toHaveBeenCalled();
    });
  });
});
