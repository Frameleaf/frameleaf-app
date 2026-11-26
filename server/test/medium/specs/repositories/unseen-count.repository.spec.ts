import { Kysely, sql } from 'kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  AlbumKind,
  AlbumUserRole,
  AssetLockReason,
  AssetVisibility,
  SharedSpaceEventType,
  UserMetadataKey,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ActivityRepository } from 'src/repositories/activity.repository.js';
import { AlbumSummaryRepository } from 'src/repositories/album-summary.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { HouseholdCommentRepository } from 'src/repositories/household-comment.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumService } from 'src/services/album.service.js';
import { SharedSpaceService } from 'src/services/shared-space.service.js';
import { UserService } from 'src/services/user.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

/** FL-1748: the account switcher's count, against real PostgreSQL and the real per-space reads. */
let database: Kysely<DB>;

const options = () => ({
  database,
  real: [
    AccessRepository,
    ActivityRepository,
    AlbumRepository,
    AlbumSummaryRepository,
    AlbumUserRepository,
    AssetRepository,
    ClassificationRepository,
    MapRepository,
    PartnerRepository,
    PersonRepository,
    SmartAlbumRepository,
    TagRepository,
    UserRepository,
  ],
  mock: [EventRepository, LoggingRepository, WebsocketRepository],
});

const authOf = (id: string): AuthDto => factory.auth({ user: { id } });

const setup = () => {
  const spaces = newMediumService(SharedSpaceService, options());
  const albums = newMediumService(AlbumService, options());
  spaces.ctx.getMock(EventRepository).emit.mockResolvedValue();
  albums.ctx.getMock(EventRepository).emit.mockResolvedValue();
  const { ctx } = spaces;
  const users = newMediumService(UserService, options());
  const count = (auth: AuthDto) => users.sut.getUnseenCount(auth).then((response) => response.count);

  const newSpace = async (ownerId: string, memberIds: string[]) => {
    const space = await albums.sut.create(authOf(ownerId), {
      albumName: 'Family',
      kind: AlbumKind.Space,
      albumUsers: memberIds.map((userId) => ({ userId, role: AlbumUserRole.Editor })),
    });
    for (const userId of memberIds) {
      await spaces.sut.accept(authOf(userId), space.id);
    }
    return space;
  };
  const addItem = async (spaceId: string, ownerId: string) => {
    const { asset } = await ctx.newAsset({ ownerId });
    await ctx.newAlbumAsset({ albumId: spaceId, assetId: asset.id });
    return asset;
  };
  /** Everything so far happened an hour ago, so a visit "now" is after it whatever the two clocks say. */
  const age = async (spaceId: string) => {
    await sql`update album_asset set "createdAt" = "createdAt" - interval '1 hour' where "albumId" = ${spaceId}::uuid`.execute(
      database,
    );
    await sql`update shared_space_event set "createdAt" = "createdAt" - interval '1 hour' where "albumId" = ${spaceId}::uuid`.execute(
      database,
    );
  };
  /** Open the space through the real route, then pull the marker back so what follows is after it. */
  const visit = async (spaceId: string, userId: string) => {
    await age(spaceId);
    await spaces.sut.markVisited(authOf(userId), spaceId);
    await sql`update shared_space_visit set "lastSeenAt" = now() - interval '30 minutes'
      where "albumId" = ${spaceId}::uuid and "userId" = ${userId}::uuid`.execute(database);
  };
  /** What the space's own routes show this member as new: items, plus comments in the feed. */
  const perSpace = async (auth: AuthDto, spaceId: string) => {
    const [fresh, feed] = await Promise.all([
      spaces.sut.getNew(auth, spaceId),
      spaces.sut.getActivity(auth, spaceId, {}),
    ]);
    const since = feed.lastVisitedAt ? new Date(feed.lastVisitedAt).getTime() : -Infinity;
    const comments = feed.events.filter(
      ({ type, actor, createdAt }) =>
        (type === SharedSpaceEventType.Comment || type === SharedSpaceEventType.Reply) &&
        actor?.id !== auth.user.id &&
        new Date(createdAt).getTime() > since,
    );
    return fresh.assetCount + comments.length;
  };
  const remoteComment = async (spaceId: string, assetId: string | null) => {
    const comments = new HouseholdCommentRepository(database as never);
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
    const remoteAuthorId = await comments.upsertAuthor(linkId, factory.uuid(), 'Ben');
    const created = await comments.createRemote({
      albumId: spaceId,
      assetId,
      remoteAuthorId,
      isLiked: false,
      comment: 'From the other household',
    });
    await comments.addEvent(spaceId, created!.id, false);
  };

  return { sut: spaces.sut, ctx, count, newSpace, addItem, visit, perSpace, remoteComment };
};

beforeAll(async () => {
  database = await getActiveForkKyselyDB();
});

describe('AlbumUserRepository.getUnseenCount (FL-1748)', () => {
  it('equals the sum of what each space shows as new', async () => {
    const { sut, ctx, count, newSpace, addItem, visit, perSpace, remoteComment } = setup();
    const { user: me } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const first = await newSpace(other.id, [me.id]);
    const second = await newSpace(me.id, [other.id]);

    const seen = await addItem(first.id, other.id);
    await sut.createComment(authOf(other.id), first.id, { comment: 'Before my visit', assetId: seen.id });
    await visit(first.id, me.id);
    await addItem(first.id, other.id);
    const parent = await sut.createComment(authOf(other.id), first.id, { comment: 'After my visit' });
    await sut.createComment(authOf(other.id), first.id, { comment: 'A reply', parentId: parent.id });

    await addItem(second.id, other.id);
    await addItem(second.id, other.id);
    await remoteComment(second.id, null);

    const auth = authOf(me.id);
    const [a, b] = [await perSpace(auth, first.id), await perSpace(auth, second.id)];
    expect(a).toBe(3);
    expect(b).toBe(3);
    await expect(count(auth)).resolves.toBe(a + b);
  });

  it('clears a space when it is opened, and only that space', async () => {
    const { sut, ctx, count, newSpace, addItem, visit } = setup();
    const { user: me } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const opened = await newSpace(other.id, [me.id]);
    const untouched = await newSpace(other.id, [me.id]);
    await addItem(opened.id, other.id);
    await sut.createComment(authOf(other.id), opened.id, { comment: 'Hello' });
    await addItem(untouched.id, other.id);
    await expect(count(authOf(me.id))).resolves.toBe(3);

    await visit(opened.id, me.id);
    await expect(count(authOf(me.id))).resolves.toBe(1);

    await addItem(opened.id, other.id);
    await expect(count(authOf(me.id))).resolves.toBe(2);
  });

  it("counts another member's and a remote author's additions, never my own", async () => {
    const { sut, ctx, count, newSpace, addItem, remoteComment } = setup();
    const { user: me } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const space = await newSpace(me.id, [other.id]);

    const mine = await addItem(space.id, me.id);
    await sut.createComment(authOf(me.id), space.id, { comment: 'Mine', assetId: mine.id });
    await expect(count(authOf(me.id))).resolves.toBe(0);

    await addItem(space.id, other.id);
    await sut.createComment(authOf(other.id), space.id, { comment: 'Theirs', assetId: mine.id });
    await expect(count(authOf(me.id))).resolves.toBe(2);

    // activity.userId is null here: a plain `userId != me` would drop it
    await remoteComment(space.id, mine.id);
    await expect(count(authOf(me.id))).resolves.toBe(3);
  });

  it.each(['locked', 'hidden', 'trashed', 'sensitive', 'ownerRule'] as const)(
    'counts neither a %s item nor a comment on it',
    async (state) => {
      const { sut, ctx, count, newSpace, addItem, perSpace } = setup();
      const { user: me } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const space = await newSpace(other.id, [me.id]);
      const asset = await addItem(space.id, other.id);
      await sut.createComment(authOf(other.id), space.id, { comment: 'About it', assetId: asset.id });
      await expect(count(authOf(me.id))).resolves.toBe(2);

      switch (state) {
        case 'locked': {
          await database
            .insertInto('asset_lock')
            .values({ assetId: asset.id, reason: AssetLockReason.Marked, lockedBy: null })
            .execute();
          break;
        }
        case 'hidden': {
          await database
            .updateTable('asset')
            .set({ visibility: AssetVisibility.Hidden })
            .where('id', '=', asset.id)
            .execute();
          break;
        }
        case 'trashed': {
          await database.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', asset.id).execute();
          break;
        }
        case 'sensitive': {
          await sql`update public.asset set is_nsfw = true where id = ${asset.id}::uuid`.execute(database);
          break;
        }
        case 'ownerRule': {
          const { tag } = await ctx.newTag({ userId: other.id, value: `private-${factory.uuid()}` });
          await ctx.newTagAsset({ tagIds: [tag.id!], assetIds: [asset.id] });
          await database
            .insertInto('user_metadata')
            .values({
              userId: other.id,
              key: UserMetadataKey.Preferences,
              value: { privacy: { suppression: { tagIds: [tag.id], personIds: [], petIds: [], scope: 'owned' } } },
            } as never)
            .execute();
          break;
        }
      }

      await expect(count(authOf(me.id))).resolves.toBe(0);
      await expect(perSpace(authOf(me.id), space.id)).resolves.toBe(0);
    },
  );

  it("does not count a comment on the viewer's own item that their own Locked rule hides", async () => {
    const { sut, ctx, count, newSpace, addItem } = setup();
    const { user: me } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const space = await newSpace(me.id, [other.id]);
    const mine = await addItem(space.id, me.id);
    const { tag } = await ctx.newTag({ userId: me.id, value: `mine-${factory.uuid()}` });
    await ctx.newTagAsset({ tagIds: [tag.id!], assetIds: [mine.id] });
    await sut.createComment(authOf(other.id), space.id, { comment: 'About yours', assetId: mine.id });
    await expect(count(authOf(me.id))).resolves.toBe(1);

    // the same number whether or not this session is unlocked: the filter comes from suppressedContent
    const suppressedContent = {
      userId: me.id,
      includeNsfw: false,
      tagIds: [tag.id!],
      personIds: [],
      petIds: [],
      scope: 'owned' as const,
    };
    const elevated: AuthDto = {
      ...authOf(me.id),
      suppressedContent,
      session: { id: factory.uuid(), hasElevatedPermission: true },
    };
    await expect(count(elevated)).resolves.toBe(0);
  });

  it('ignores a pending invitation, a space I am not in, and a plain shared album', async () => {
    const { ctx, count, newSpace, addItem } = setup();
    const { user: me } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { user: stranger } = await ctx.newUser();

    const notMine = await newSpace(other.id, [stranger.id]);
    await addItem(notMine.id, other.id);

    const albums = newMediumService(AlbumService, options());
    albums.ctx.getMock(EventRepository).emit.mockResolvedValue();
    const pending = await albums.sut.create(authOf(other.id), {
      albumName: 'Invited',
      kind: AlbumKind.Space,
      albumUsers: [{ userId: me.id, role: AlbumUserRole.Viewer }],
    });
    await addItem(pending.id, other.id);

    const { album } = await ctx.newAlbum({ ownerId: other.id, albumName: 'Plain album' });
    await ctx.newAlbumUser({ albumId: album.id, userId: me.id, role: AlbumUserRole.Viewer });
    await addItem(album.id, other.id);

    await expect(count(authOf(me.id))).resolves.toBe(0);
  });

  it("counts a received household copy as somebody else's, but not an item the recipient already held", async () => {
    const { ctx, count, addItem, perSpace, visit, remoteComment } = setup();
    const { user: recipient } = await ctx.newUser();
    const albums = newMediumService(AlbumService, options());
    albums.ctx.getMock(EventRepository).emit.mockResolvedValue();
    const received = await albums.sut.create(authOf(recipient.id), { albumName: 'From Ben', kind: AlbumKind.Space });
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
    const origin = (localId: string, isCopy: boolean) =>
      database
        .insertInto('household_origin')
        .values({ linkId, remoteId: factory.uuid(), kind: 'asset', userId: recipient.id, localId, isCopy })
        .execute();

    // the sync creates each copy as the recipient's own asset
    const copy = await addItem(received.id, recipient.id);
    await origin(copy.id, true);
    const alreadyHeld = await addItem(received.id, recipient.id);
    await origin(alreadyHeld.id, false);
    await addItem(received.id, recipient.id); // their own upload
    await expect(perSpace(authOf(recipient.id), received.id)).resolves.toBe(1);
    await expect(count(authOf(recipient.id))).resolves.toBe(1);

    await remoteComment(received.id, copy.id);
    await expect(perSpace(authOf(recipient.id), received.id)).resolves.toBe(2);
    await expect(count(authOf(recipient.id))).resolves.toBe(2);

    await visit(received.id, recipient.id);
    await expect(count(authOf(recipient.id))).resolves.toBe(0);
  });
});
