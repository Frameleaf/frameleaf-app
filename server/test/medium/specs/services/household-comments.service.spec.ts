import { Kysely } from 'kysely';
import { ActivityResponseDto, mapActivity } from 'src/dtos/activity.dto.js';
import { AlbumKind, AlbumUserRole, AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ActivityRepository } from 'src/repositories/activity.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { HouseholdCommentRepository } from 'src/repositories/household-comment.repository.js';
import { HouseholdShareRepository } from 'src/repositories/household-share.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { HouseholdShareService } from 'src/services/household-share.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

/**
 * FL-1012 against real PostgreSQL: remote authors on `activity`, what existing activity responses make of them, and
 * which comments a manifest lists, by the same visibility query as the items.
 */
describe('Household comments (medium)', () => {
  let database: Kysely<DB>;

  beforeAll(async () => {
    database = await getActiveForkKyselyDB();
  });

  const setup = async () => {
    const { ctx } = newMediumService(BaseService, {
      database,
      real: [
        AccessRepository,
        ActivityRepository,
        AlbumRepository,
        AlbumUserRepository,
        AssetRepository,
        UserRepository,
      ],
      mock: [LoggingRepository],
    });
    const shares = new HouseholdShareRepository(database);
    const comments = new HouseholdCommentRepository(database);
    const events = { emit: vi.fn(() => Promise.resolve()) };
    const sut = new HouseholdShareService(
      shares,
      undefined as never,
      undefined as never,
      { signer: () => ({ sign: () => 'token' }) } as never,
      ctx.get(AlbumUserRepository),
      ctx.get(AlbumRepository),
      ctx.get(AccessRepository),
      ctx.get(UserRepository),
      undefined as never,
      { hit: () => Promise.resolve({ count: 1, resetSeconds: 60 }) } as never,
      { setContext: vi.fn(), warn: vi.fn() } as never,
      comments,
      events as never,
    );
    const { user: owner } = await ctx.newUser({ name: 'Anna', email: `anna-${factory.uuid()}@example.com` });
    const { album: space } = await ctx.newAlbum({ ownerId: owner.id, albumName: 'Family', kind: AlbumKind.Space });
    const item = async (dto: Parameters<typeof ctx.newAsset>[0] = {}) => {
      const { asset } = await ctx.newAsset({ ownerId: owner.id, ...dto });
      await ctx.newExif({ assetId: asset.id, description: '' });
      await ctx.newAlbumAsset({ albumId: space.id, assetId: asset.id });
      return asset;
    };
    const { id: linkId } = await database
      .insertInto('household_link')
      .values({
        cloudLinkId: factory.uuid(),
        peerInstanceId: factory.uuid(),
        peerName: 'Ben',
        householdName: 'Ben',
        peerPublicKey: factory.uuid(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const remoteUserId = factory.uuid();
    const authorId = await comments.upsertAuthor(linkId, remoteUserId, 'Ben');
    const offer = async () => {
      const shareId = (await shares.invite({
        albumId: space.id,
        linkId,
        remoteUserId,
        displayName: 'Ben',
        role: 'contributor',
      })) as string;
      await shares.accept(shareId, remoteUserId);
      return shareId;
    };
    const access = { link: { id: linkId } } as never;
    const read = async (shareId: string) => (await sut.manifest(access, shareId, {})).entries;
    return { ctx, sut, shares, comments, owner, space, item, linkId, remoteUserId, authorId, offer, access, read };
  };

  it('a remote comment reads through the activity queries with a valid `user` and no email', async () => {
    const { ctx, comments, owner, space, authorId } = await setup();
    await ctx.get(ActivityRepository).create({ albumId: space.id, userId: owner.id, comment: 'Local' });
    const created = await comments.createRemote({
      albumId: space.id,
      assetId: null,
      remoteAuthorId: authorId,
      isLiked: false,
      comment: 'Remote',
    });

    const rows = await ctx.get(ActivityRepository).search({ albumId: space.id });
    expect(rows.map(({ comment }) => comment)).toEqual(['Local', 'Remote']);
    const remote = rows.find(({ id }) => id === created!.id)!;
    expect(remote.userId).toBeNull();

    const response = mapActivity(remote);
    expect(response.user).toMatchObject({ id: authorId, name: 'Ben', email: '', profileImagePath: '' });
    // the same object a local member gets since FL-1743: every field present, email empty
    const local = mapActivity(rows.find(({ id }) => id !== created!.id)!);
    expect(Object.keys(response.user).toSorted()).toEqual(Object.keys(local.user).toSorted());
    expect(local.user.email).toBe('');
    const issues = (dto: unknown) =>
      ActivityResponseDto.schema
        .safeParse(JSON.parse(JSON.stringify(dto)))
        .error?.issues.map(({ path }) => path.join('.'));
    expect(issues(response)).toEqual(issues(local));
    expect(issues({ ...response, user: { ...response.user, email: 'a@example.com' } })).toBeUndefined();

    await comments.addEvent(space.id, created!.id, false);
    const [event] = await ctx.get(AlbumUserRepository).getSpaceEvents(space.id, { take: 1 });
    expect(event).toMatchObject({ actorId: null, remoteAuthorId: authorId, remoteAuthorName: 'Ben' });

    const byId = await ctx.get(ActivityRepository).getById(created!.id);
    expect(byId?.user).toMatchObject({ id: authorId, name: 'Ben', email: '' });
    await expect(ctx.get(ActivityRepository).getStatistics({ albumId: space.id })).resolves.toEqual({
      comments: 2,
      likes: 0,
    });
  });

  it('every activity row has exactly one kind of author, and a remote author likes a thing once', async () => {
    const { ctx, comments, owner, space, authorId } = await setup();
    const asset = (await ctx.newAsset({ ownerId: owner.id })).asset;
    await ctx.newAlbumAsset({ albumId: space.id, assetId: asset.id });
    const insert = (values: { userId: string | null; remoteAuthorId: string | null }) =>
      database
        .insertInto('activity')
        .values({ albumId: space.id, comment: 'x', ...values })
        .execute();
    await expect(insert({ userId: null, remoteAuthorId: null })).rejects.toThrow('activity_author_check');
    await expect(insert({ userId: owner.id, remoteAuthorId: authorId })).rejects.toThrow('activity_author_check');

    for (const assetId of [asset.id, null]) {
      const like = { albumId: space.id, assetId, remoteAuthorId: authorId, isLiked: true, comment: null };
      await expect(comments.createRemote(like)).resolves.toBeDefined();
      await expect(comments.createRemote(like)).resolves.toBeUndefined();
    }
  });

  it('seeds comments after the items, and lists them with no email', async () => {
    const { ctx, owner, space, item, offer, read } = await setup();
    const asset = await item();
    const local = await ctx
      .get(ActivityRepository)
      .create({ albumId: space.id, assetId: asset.id, userId: owner.id, comment: 'Hello' });
    const entries = await read(await offer());
    const position = (id: string) => entries.findIndex((entry) => entry.id === id);
    expect(position(local.id)).toBeGreaterThan(position(asset.id));
    expect(entries[position(local.id)]).toMatchObject({
      kind: 'comment',
      comment: { comment: 'Hello', author: { household: 'local', id: owner.id, name: 'Anna' } },
    });
    expect(JSON.stringify(entries)).not.toContain(owner.email);
  });

  it('a comment on a Locked, trashed or removed item is stop, by the real visibility query', async () => {
    const { ctx, sut, shares, owner, space, item, offer, read } = await setup();
    const [locked, trashed, removed, kept] = [await item(), await item(), await item(), await item()];
    const say = (assetId: string) =>
      ctx.get(ActivityRepository).create({ albumId: space.id, assetId, userId: owner.id, comment: `about ${assetId}` });
    const [onLocked, onTrashed, onRemoved, onKept] = [
      await say(locked.id),
      await say(trashed.id),
      await say(removed.id),
      await say(kept.id),
    ];
    const shareId = await offer();

    await ctx.get(AssetRepository).update({ id: locked.id, visibility: AssetVisibility.Locked });
    await ctx.get(AssetRepository).update({ id: trashed.id, deletedAt: new Date() });
    await ctx.get(AlbumRepository).removeAssetIds(space.id, [removed.id]);
    await sut.onFeedAssets({ assetIds: [locked.id, trashed.id, removed.id] });

    const page = await shares.getChanges(shareId, 0, 100);
    expect(page.find(({ entityId }) => entityId === onRemoved.id)).toBeDefined();
    const entries = await read(shareId);
    for (const { id } of [onLocked, onTrashed, onRemoved]) {
      expect(entries.find((entry) => entry.id === id)).toMatchObject({ stop: true });
    }
    expect(entries.find((entry) => entry.id === onKept.id)).toHaveProperty('comment');
    expect(JSON.stringify(entries)).not.toContain(`about ${locked.id}`);
  });

  it('T16: a post about a Locked item is refused against the real query, and a retry stays one row', async () => {
    const { ctx, sut, space, item, offer, access, remoteUserId } = await setup();
    const locked = await item({ visibility: AssetVisibility.Locked });
    const visible = await item();
    const shareId = await offer();
    const body = { id: crypto.randomUUID(), userId: remoteUserId, assetId: locked.id, isLiked: false, comment: 'Hi' };
    await expect(sut.postComment(access, shareId, body)).rejects.toMatchObject({ status: 403 });

    const good = { ...body, assetId: visible.id };
    await sut.postComment(access, shareId, good);
    await sut.postComment(access, shareId, good);
    const rows = await ctx.get(ActivityRepository).search({ albumId: space.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: good.id, userId: null, comment: 'Hi' });
  });

  it('removing a comment takes its replies and returns their ids, and touches no asset', async () => {
    const { ctx, comments, owner, space, item, authorId } = await setup();
    const asset = await item();
    const root = await comments.createRemote({
      albumId: space.id,
      assetId: asset.id,
      remoteAuthorId: authorId,
      isLiked: false,
      comment: 'Root',
    });
    const reply = await ctx
      .get(ActivityRepository)
      .create({ albumId: space.id, assetId: asset.id, userId: owner.id, comment: 'Reply' });
    await ctx
      .get(AlbumUserRepository)
      .createCommentThread({ activityId: reply.id, parentActivityId: root!.id, albumId: space.id });

    const removed = await ctx.get(AlbumUserRepository).deleteCommentWithReplies(root!.id);
    expect(removed.toSorted()).toEqual([root!.id, reply.id].toSorted());
    await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toMatchObject({ deletedAt: null });
  });

  it('a mention stores and returns only members of this space', async () => {
    const { ctx, comments, space, authorId } = await setup();
    const { user: member } = await ctx.newUser();
    const { user: stranger } = await ctx.newUser();
    await ctx.newAlbumUser({ albumId: space.id, userId: member.id, role: AlbumUserRole.Viewer });
    const row = await comments.createRemote({
      albumId: space.id,
      assetId: null,
      remoteAuthorId: authorId,
      isLiked: false,
      comment: 'x',
    });
    const text = `@{${member.id}} @{${stranger.id}} @{${factory.uuid()}}`;
    await expect(comments.setMentions(row!.id, space.id, text)).resolves.toEqual([member.id]);
    await expect(comments.setMentions(row!.id, space.id, text)).resolves.toEqual([]);
    await expect(ctx.get(AlbumUserRepository).getMentions([row!.id])).resolves.toEqual([
      { activityId: row!.id, userId: member.id },
    ]);
  });

  it('the send queue: a newer change survives an older reply, and a left share sends nothing', async () => {
    const { ctx, comments, owner, space, linkId } = await setup();
    const { id: shareId } = await database
      .insertInto('household_inbound_share')
      .values({
        linkId,
        remoteShareId: factory.uuid(),
        userId: owner.id,
        albumId: space.id,
        spaceName: 'Family',
        ownerName: 'Anna',
        state: 'accepted',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const local = await ctx.get(ActivityRepository).create({ albumId: space.id, userId: owner.id, comment: 'Mine' });

    await comments.queue(shareId, local.id, 'post', local.id);
    const [first] = await comments.getDue(linkId, 10);
    expect(first).toMatchObject({ pending: 'post', own: true, activityId: local.id, userId: owner.id });
    await comments.queue(shareId, local.id, 'put', local.id);
    await comments.markSent(shareId, local.id, first.revision);
    const [second] = await comments.getDue(linkId, 10);
    expect(second.pending).toBe('put');
    await comments.markSent(shareId, local.id, second.revision);
    await expect(comments.getDue(linkId, 10)).resolves.toEqual([]);

    await comments.queue(shareId, local.id, 'delete');
    await database.updateTable('household_inbound_share').set({ state: 'left' }).where('id', '=', shareId).execute();
    await expect(comments.getDue(linkId, 10)).resolves.toEqual([]);
    await ctx.get(ActivityRepository).delete(local.id);
    await expect(comments.getLink(shareId, local.id)).resolves.toMatchObject({ activityId: null, own: true });
  });
});
