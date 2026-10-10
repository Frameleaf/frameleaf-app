import { Kysely, sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  AlbumUserRole,
  AssetLockReason,
  AssetType,
  AssetVisibility,
  Permission,
  SharedLinkType,
  UserMetadataKey,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ItemShareRepository } from 'src/repositories/item-share.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { checkAccess } from 'src/utils/access.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-137 (QA-101): the cross-surface permission and sensitive-media matrix at the access boundary,
 * against PostgreSQL. Every grant path (owner, explicit unlock, album editor/viewer, partner,
 * per-item share, public link, administrator without ownership) is checked against every kind of
 * item (ordinary, archived, trashed, Locked for each reason, Live Photo motion of an ordinary and of
 * a Locked still, and an item under the owner's Locked tag rule), then every grant is revoked.
 *
 * Owner decisions applied: Locked media is its owner's alone and only in an unlocked (elevated)
 * session, whoever else holds a path to it; once unlocked it behaves like any other item for its
 * owner. Owner privacy is never frozen at share time.
 */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const PERMISSIONS = [
  Permission.AssetRead,
  Permission.AssetView,
  Permission.AssetDownload,
  Permission.AssetUpdate,
  Permission.AssetDelete,
  Permission.AssetShare,
] as const;
type AssetPermission = (typeof PERMISSIONS)[number];

const ITEMS = [
  'ordinary',
  'archived',
  'trashed',
  'lockedMarked',
  'lockedDetected',
  'lockedFolder',
  'liveStill',
  'liveMotion',
  'lockedLiveStill',
  'lockedLiveMotion',
  'lockedRule',
] as const;
type Item = (typeof ITEMS)[number];

const ACTORS = [
  'owner',
  'ownerUnlocked',
  'editor',
  'viewer',
  'partner',
  'recipient',
  'link',
  'linkNoDownload',
  'admin',
  'stranger',
] as const;
type Actor = (typeof ACTORS)[number];

const R = Permission.AssetRead;
const V = Permission.AssetView;
const D = Permission.AssetDownload;
const U = Permission.AssetUpdate;
const X = Permission.AssetDelete;
const S = Permission.AssetShare;
const ALL: AssetPermission[] = [R, V, D, U, X, S];
const READ: AssetPermission[] = [R, V, D];
const NONE: AssetPermission[] = [];

/** Items reachable through a path other than ownership (albums, partner, item share, link). */
const VISIBLE_TO_OTHERS = new Set<Item>(['ordinary', 'liveStill', 'liveMotion']);
/** Items only the owner's unlocked session reaches. */
const LOCKED = new Set<Item>(['lockedMarked', 'lockedDetected', 'lockedFolder', 'lockedLiveStill', 'lockedLiveMotion']);

/**
 * An item under the owner's Locked tag rule. Owner decision, September 29, 2026 ("No, keep explicit
 * shares"): a Locked rule withdraws the item from per-item shares (FL-198) and Studio publication
 * (FL-106) only. What the owner explicitly shared (a shared album or space, a partner share, a
 * public link) keeps showing it. `docs/docs/features/locked.md` states the same rule.
 *
 * Also decided that day and asserted elsewhere: partner sync keeps Locked items, marked locked with
 * their details blanked (sync-partner-asset / sync-partner-stack specs), and viewers of a shared item
 * see the owner's tag names, Locked-rule tags included (asset.service spec).
 */
const OWNER_RULE_REACHES: Record<Actor, boolean> = {
  owner: false,
  ownerUnlocked: true,
  editor: true,
  viewer: true,
  partner: false,
  recipient: false,
  link: true,
  linkNoDownload: true,
  admin: false,
  stranger: false,
};

const expected = (actor: Actor, item: Item): AssetPermission[] => {
  if (item === 'lockedRule') {
    return OWNER_RULE_REACHES[actor] ? expected(actor, 'ordinary') : NONE;
  }
  switch (actor) {
    case 'owner': {
      return LOCKED.has(item) ? NONE : ALL;
    }
    case 'ownerUnlocked': {
      return ALL;
    }
    case 'editor':
    case 'viewer':
    case 'recipient':
    case 'link': {
      return VISIBLE_TO_OTHERS.has(item) || item === 'archived' ? READ : NONE;
    }
    case 'linkNoDownload': {
      return VISIBLE_TO_OTHERS.has(item) || item === 'archived' ? [R, V] : NONE;
    }
    case 'partner': {
      // FL-326 (spec §4.8): a partner holds their own copies and never reaches the sharer's rows.
      return NONE;
    }
    case 'admin':
    case 'stranger': {
      return NONE;
    }
  }
};

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, access: ctx.get(AccessRepository) };
};

type Context = ReturnType<typeof setup>['ctx'];

const lock = (assetId: string, reason: AssetLockReason) =>
  db.insertInto('asset_lock').values({ assetId, reason, lockedBy: null }).execute();

const setOwnerLockedTagRule = (userId: string, tagIds: string[]) => {
  const value = { privacy: { suppression: { tagIds, scope: 'visible' } } };
  return db
    .insertInto('user_metadata')
    .values({ userId, key: UserMetadataKey.Preferences, value } as never)
    .onConflict((oc) => oc.columns(['userId', 'key']).doUpdateSet({ value } as never))
    .execute();
};

/** One owner's library with an item of every kind, reachable through every grant path. */
const library = async (ctx: Context) => {
  const { user: owner } = await ctx.newUser();
  const { user: editor } = await ctx.newUser();
  const { user: viewer } = await ctx.newUser();
  const { user: partner } = await ctx.newUser();
  const { user: recipient } = await ctx.newUser();
  const { user: admin } = await ctx.newUser({ isAdmin: true });
  const { user: stranger } = await ctx.newUser();

  const asset = async (dto: Parameters<Context['newAsset']>[0] = {}) =>
    (await ctx.newAsset({ ownerId: owner.id, ...dto })).asset.id;
  const liveMotion = await asset({ type: AssetType.Video, visibility: AssetVisibility.Hidden });
  const lockedLiveMotion = await asset({ type: AssetType.Video, visibility: AssetVisibility.Hidden });
  const items: Record<Item, string> = {
    ordinary: await asset(),
    archived: await asset({ visibility: AssetVisibility.Archive }),
    trashed: await asset({ deletedAt: new Date() }),
    lockedMarked: await asset(),
    lockedDetected: await asset(),
    lockedFolder: await asset(),
    liveStill: await asset({ livePhotoVideoId: liveMotion }),
    liveMotion,
    lockedLiveStill: await asset({ livePhotoVideoId: lockedLiveMotion }),
    lockedLiveMotion,
    lockedRule: await asset(),
  };
  await lock(items.lockedMarked, AssetLockReason.Marked);
  await lock(items.lockedDetected, AssetLockReason.Detected);
  await lock(items.lockedFolder, AssetLockReason.ImmichLockedFolder);
  // Only the still carries the lock row: its motion part is as private as the still (FL-34).
  await lock(items.lockedLiveStill, AssetLockReason.Marked);

  const { tag } = await ctx.newTag({ userId: owner.id, value: 'Private' });
  await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [items.lockedRule] });
  await setOwnerLockedTagRule(owner.id, [tag.id]);

  // Motion parts are never album members or shared on their own; they come with their still.
  const members = ITEMS.filter((item) => item !== 'liveMotion' && item !== 'lockedLiveMotion').map((i) => items[i]);
  const { album } = await ctx.newAlbum({ ownerId: owner.id });
  for (const assetId of members) {
    await ctx.newAlbumAsset({ albumId: album.id, assetId });
  }
  await ctx.newAlbumUser({ albumId: album.id, userId: editor.id, role: AlbumUserRole.Editor });
  await ctx.newAlbumUser({ albumId: album.id, userId: viewer.id, role: AlbumUserRole.Viewer });
  await ctx.newPartner({ sharedById: owner.id, sharedWithId: partner.id });
  // Rows written directly: the service refuses sharing Locked items, but a share made before an item
  // was locked must be held to the same rule.
  await sql`INSERT INTO public.asset_user_share ("assetId", "ownerId", "sharedWithId")
    SELECT unnest(${members}::uuid[]), ${owner.id}::uuid, ${recipient.id}::uuid`.execute(db);

  const links = ctx.get(SharedLinkRepository);
  const newLink = (allowDownload: boolean) =>
    links.create({
      key: randomBytes(16),
      id: factory.uuid(),
      userId: owner.id,
      albumId: album.id,
      allowUpload: false,
      allowDownload,
      type: SharedLinkType.Album,
    });
  const link = await newLink(true);
  const linkNoDownload = await newLink(false);

  const sharedLinkAuth = (sharedLink: typeof link) =>
    factory.auth({ user: owner, sharedLink: { id: sharedLink.id, allowDownload: sharedLink.allowDownload } });

  const auths: Record<Actor, AuthDto> = {
    owner: factory.auth({ user: owner }),
    ownerUnlocked: factory.auth({ user: owner, session: { hasElevatedPermission: true } }),
    editor: factory.auth({ user: editor }),
    viewer: factory.auth({ user: viewer }),
    partner: factory.auth({ user: partner }),
    recipient: factory.auth({ user: recipient }),
    link: sharedLinkAuth(link),
    linkNoDownload: sharedLinkAuth(linkNoDownload),
    admin: factory.auth({ user: { ...admin, isAdmin: true } }),
    stranger: factory.auth({ user: stranger }),
  };
  // The owner's Locked tag rule hides its items from the owner too until the session is unlocked.
  auths.owner.hiddenContent = { userId: owner.id, tagIds: [tag.id], personIds: [], petIds: [] } as never;
  auths.owner.suppressedContent = auths.owner.hiddenContent;
  auths.ownerUnlocked.suppressedContent = auths.owner.hiddenContent;

  return { owner, album, items, auths, links, link, linkNoDownload, recipient, partner, editor, viewer };
};

type Library = Awaited<ReturnType<typeof library>>;

/** Which permissions each actor holds on each item, read through the real access checks. */
const observe = async (access: AccessRepository, { auths, items }: Library, actors: readonly Actor[] = ACTORS) => {
  const ids = new Set(Object.values(items));
  const result: Partial<Record<Actor, Record<Item, AssetPermission[]>>> = {};
  for (const actor of actors) {
    const row = Object.fromEntries(ITEMS.map((item) => [item, [] as AssetPermission[]])) as Record<
      Item,
      AssetPermission[]
    >;
    for (const permission of PERMISSIONS) {
      const allowed = await checkAccess(access, { auth: auths[actor], permission, ids });
      for (const item of ITEMS) {
        if (allowed.has(items[item])) {
          row[item].push(permission);
        }
      }
    }
    result[actor] = row;
  }
  return result;
};

const table = (actors: readonly Actor[], rule: (actor: Actor, item: Item) => AssetPermission[]) =>
  Object.fromEntries(
    actors.map((actor) => [actor, Object.fromEntries(ITEMS.map((item) => [item, rule(actor, item)]))]),
  );

describe('cross-surface access matrix (FL-137 QA-101)', () => {
  it('grants each actor exactly its permissions on every kind of item', async () => {
    const { ctx, access } = setup();
    const lib = await library(ctx);

    const actual = await observe(access, lib);

    expect(actual).toEqual(table(ACTORS, expected));
  });

  it('shows Locked media to its owner once unlocked, and to nobody else, until it is unlocked', async () => {
    const { ctx, access } = setup();
    const lib = await library(ctx);

    await db
      .deleteFrom('asset_lock')
      .where('assetId', 'in', [lib.items.lockedMarked, lib.items.lockedLiveStill])
      .execute();
    await setOwnerLockedTagRule(lib.owner.id, []);
    lib.auths.owner.hiddenContent = undefined;
    lib.auths.owner.suppressedContent = undefined;
    lib.auths.ownerUnlocked.suppressedContent = undefined;

    const unlocked: Set<Item> = new Set(['lockedMarked', 'lockedLiveStill', 'lockedLiveMotion', 'lockedRule']);
    const actual = await observe(access, lib);
    expect(actual).toEqual(
      table(ACTORS, (actor, item) => {
        if (!unlocked.has(item)) {
          return expected(actor, item);
        }
        return expected(
          actor,
          item === 'lockedLiveMotion' ? 'liveMotion' : item === 'lockedLiveStill' ? 'liveStill' : 'ordinary',
        );
      }),
    );
  });

  it("keeps explicit album and link shares under the owner's Locked rule, and withdraws per-item shares (owner decision, 2026-09-29)", async () => {
    const { ctx, access } = setup();
    const lib = await library(ctx);
    const ids = new Set([lib.items.lockedRule]);
    const reaches = async (actor: Actor) =>
      (await checkAccess(access, { auth: lib.auths[actor], permission: Permission.AssetRead, ids })).size > 0;

    for (const actor of ['editor', 'viewer', 'link', 'linkNoDownload', 'ownerUnlocked'] as const) {
      await expect(reaches(actor)).resolves.toBe(true);
    }
    // FL-326: a partner reaches none of the owner's rows, whatever the rule
    for (const actor of ['recipient', 'owner', 'partner'] as const) {
      await expect(reaches(actor)).resolves.toBe(false);
    }

    // Lifting the rule gives the per-item recipient the item back; nothing was frozen at share time.
    await setOwnerLockedTagRule(lib.owner.id, []);
    await expect(reaches('recipient')).resolves.toBe(true);
  });

  it('revokes every grant path at once', async () => {
    const { ctx, access } = setup();
    const lib = await library(ctx);

    await db.deleteFrom('album_user').where('albumId', '=', lib.album.id).execute();
    await db.deleteFrom('partner').where('sharedById', '=', lib.owner.id).execute();
    await new ItemShareRepository(db).remove(lib.owner.id, Object.values(lib.items), [lib.recipient.id]);
    await lib.links.remove(lib.link.id);
    await lib.links.remove(lib.linkNoDownload.id);

    const others = ACTORS.filter((actor) => actor !== 'owner' && actor !== 'ownerUnlocked');
    await expect(observe(access, lib, others)).resolves.toEqual(table(others, () => NONE));
    // The owner keeps everything they had.
    await expect(observe(access, lib, ['owner', 'ownerUnlocked'])).resolves.toEqual(
      table(['owner', 'ownerUnlocked'], expected),
    );
  });

  it('follows a Locked still when its motion part is asked for alone', async () => {
    const { ctx, access } = setup();
    const lib = await library(ctx);
    const motion = new Set([lib.items.lockedLiveMotion]);

    for (const actor of ACTORS) {
      if (actor === 'ownerUnlocked') {
        continue;
      }
      for (const permission of PERMISSIONS) {
        await expect(checkAccess(access, { auth: lib.auths[actor], permission, ids: motion })).resolves.toEqual(
          new Set(),
        );
      }
    }
  });
});
