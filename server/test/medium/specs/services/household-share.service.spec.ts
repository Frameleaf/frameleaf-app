import { Kysely } from 'kysely';
import { AlbumKind, AlbumUserRole, AssetLockReason, AssetType, AssetVisibility, UserMetadataKey } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { HouseholdShareRepository } from 'src/repositories/household-share.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { HouseholdShareService } from 'src/services/household-share.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

const BUCKET = '2026-01-01';
const takenAt = new Date('2026-01-15T12:00:00.000Z');

/**
 * FL-979, T6 and T7, against real PostgreSQL: what a linked household is told equals what a local viewer member of
 * the space sees with a locked session, read through the timeline query the space page itself uses.
 */
describe('HouseholdShareService (medium)', () => {
  let database: Kysely<DB>;

  beforeAll(async () => {
    database = await getActiveForkKyselyDB();
  });

  const setup = async () => {
    const { ctx } = newMediumService(BaseService, {
      database,
      real: [
        AccessRepository,
        AlbumRepository,
        AlbumUserRepository,
        AssetRepository,
        PersonRepository,
        StackRepository,
        TagRepository,
        UserRepository,
      ],
      mock: [LoggingRepository],
    });
    const repository = new HouseholdShareRepository(database);
    const sut = new HouseholdShareService(
      repository,
      undefined as never,
      undefined as never,
      undefined as never,
      ctx.get(AlbumUserRepository),
      ctx.get(AlbumRepository),
      ctx.get(AccessRepository),
      ctx.get(UserRepository),
      undefined as never,
      undefined as never,
      { setContext: vi.fn(), warn: vi.fn() } as never,
    );
    const { user: owner } = await ctx.newUser();
    const { user: viewer } = await ctx.newUser();
    const { album: space } = await ctx.newAlbum({ ownerId: owner.id, albumName: 'Family', kind: AlbumKind.Space });
    await ctx.newAlbumUser({ albumId: space.id, userId: viewer.id, role: AlbumUserRole.Viewer });
    const item = async (dto: Parameters<typeof ctx.newAsset>[0] = {}, inSpace = true) => {
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        fileCreatedAt: takenAt,
        localDateTime: takenAt,
        ...dto,
      });
      await ctx.newExif({ assetId: asset.id, description: '' });
      if (inSpace) {
        await ctx.newAlbumAsset({ albumId: space.id, assetId: asset.id });
      }
      return asset;
    };
    /** The space's timeline as a viewer member with a locked session reads it. */
    const memberView = async () => {
      const auth = factory.auth({ user: { id: viewer.id } });
      const { assets } = await ctx
        .get(AssetRepository)
        .getTimeBucket(BUCKET, { albumId: space.id, excludeNsfw: true, othersRulesViewerId: viewer.id }, auth);
      return (JSON.parse(assets) as { id: string[] }).id.toSorted();
    };
    const lockRules = (suppression: { personIds?: string[]; tagIds?: string[] }) =>
      ctx.get(UserRepository).upsertMetadata(owner.id, {
        key: UserMetadataKey.Preferences,
        value: { privacy: { suppression: { personIds: [], tagIds: [], petIds: [], ...suppression } } },
      });
    return { ctx, sut, repository, owner, viewer, space, item, memberView, lockRules };
  };

  it('T7: visibility equals the viewer member view across every kind of item', async () => {
    const { ctx, sut, owner, space, item, memberView, lockRules } = await setup();

    const plain = await item();
    const archived = await item({ visibility: AssetVisibility.Archive });
    const trashed = await item({ deletedAt: new Date() });
    const locked = await item({ visibility: AssetVisibility.Locked });

    const { person } = await ctx.newPerson({ ownerId: owner.id, name: 'Secret' });
    const byPerson = await item();
    await ctx.newAssetFace({ assetId: byPerson.id, personGroupId: person.personGroupId });
    const { tag } = await ctx.newTag({ userId: owner.id, value: 'private' });
    const byTag = await item();
    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [byTag.id] });
    await lockRules({ personIds: [person.personGroupId], tagIds: [tag.id] });

    // in an album linked into the space, and not in the space itself: a link adds nothing to a space
    const onlyLinked = await item({}, false);
    const { album: linked } = await ctx.newAlbum({ ownerId: owner.id, albumName: 'Linked' }, [onlyLinked.id]);
    await ctx.get(AlbumUserRepository).createLinkedAlbum({
      albumId: space.id,
      linkedAlbumId: linked.id,
      linkedById: owner.id,
    });

    const hiddenMotion = await item({ type: AssetType.Video, visibility: AssetVisibility.Hidden }, false);
    const live = await item({ livePhotoVideoId: hiddenMotion.id });
    await ctx.get(AssetRepository).lock([hiddenMotion.id], AssetLockReason.Marked, owner.id);

    const stackPrimary = await item();
    const stackMember = await item();
    await ctx.newStack({ ownerId: owner.id }, [stackPrimary.id, stackMember.id]);

    const all = [
      plain,
      archived,
      trashed,
      locked,
      byPerson,
      byTag,
      onlyLinked,
      hiddenMotion,
      live,
      stackPrimary,
      stackMember,
    ].map(({ id }) => id);

    const visible = [...(await sut.visibleAssetIds(space.id, all))].toSorted();
    await expect(memberView()).resolves.toEqual(visible);
    for (const { id } of [trashed, locked, byPerson, byTag, onlyLinked, hiddenMotion]) {
      expect(visible).not.toContain(id);
    }
  });

  it('T7: a live video part follows its still and its own lock', async () => {
    const { ctx, sut, owner, space, item } = await setup();
    const motion = await item({ type: AssetType.Video, visibility: AssetVisibility.Hidden }, false);
    const still = await item({ livePhotoVideoId: motion.id });
    await expect(sut.visibleAssetIds(space.id, [motion.id])).resolves.toEqual(new Set([motion.id]));

    await ctx.get(AssetRepository).lock([still.id], AssetLockReason.Marked, owner.id);
    await expect(sut.visibleAssetIds(space.id, [motion.id])).resolves.toEqual(new Set());
  });

  it('T6: a share resolves only over its own link', async () => {
    const { repository, space, item } = await setup();
    await item();
    const insertLink = (name: string) =>
      database
        .insertInto('household_link')
        .values({
          cloudLinkId: factory.uuid(),
          peerInstanceId: factory.uuid(),
          peerName: name,
          householdName: name,
          peerPublicKey: name,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    const [first, second] = [await insertLink('A'), await insertLink('B')];
    const shareId = await repository.invite({
      albumId: space.id,
      linkId: first.id,
      remoteUserId: factory.uuid(),
      displayName: 'Ben',
      role: 'viewer',
    });
    await expect(repository.getShare(first.id, shareId)).resolves.toMatchObject({ id: shareId });
    await expect(repository.getShare(second.id, shareId)).resolves.toBeUndefined();
  });

  it('moves a changed row to a new seq, keeps a removed item in the feed, and resumes from a cursor', async () => {
    const { repository, space, item, ctx } = await setup();
    const [first, second] = [await item(), await item()];
    const { id: linkId } = await database
      .insertInto('household_link')
      .values({
        cloudLinkId: factory.uuid(),
        peerInstanceId: factory.uuid(),
        peerName: 'A',
        householdName: 'A',
        peerPublicKey: 'A',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const shareId = await repository.invite({
      albumId: space.id,
      linkId,
      remoteUserId: factory.uuid(),
      displayName: 'Ben',
      role: 'viewer',
    });
    const seeded = await repository.getChanges(shareId, 0, 10);
    expect(seeded.map(({ entityId }) => entityId).toSorted()).toEqual([first.id, second.id].toSorted());

    const cursor = seeded.at(-1)!.seq;
    await ctx.get(AlbumRepository).removeAssetIds(space.id, [first.id]);
    await repository.touchAssets([first.id]);
    const moved = await repository.getChanges(shareId, cursor, 10);
    expect(moved.map(({ entityId }) => entityId)).toEqual([first.id]);
    await expect(repository.getChanges(shareId, 0, 10)).resolves.toHaveLength(2);
  });
});
