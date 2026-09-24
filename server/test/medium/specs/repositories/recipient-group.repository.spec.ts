import { Kysely, sql } from 'kysely';
import { AlbumKind, AlbumUserRole } from 'src/enum.js';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import manifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import * as migration from 'src/fork-schema/migrations/0000000000160-RecipientGroups.js';
import { AlbumUserRepository, RECIPIENT_GROUP_LIMIT } from 'src/repositories/album-user.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-55: named recipient shortcuts, a fork-owned table. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
  await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: ctx.get(AlbumUserRepository) };
};

const isRecipientGroup = (entry: { identity: string }) => entry.identity.startsWith('immich_fork.recipient_group');

it('matches the private catalog and rolls back without modifying the official catalog', async () => {
  const before = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes'] as const) {
    expect(before[kind].filter((entry) => isRecipientGroup(entry))).toEqual(
      manifest[kind].filter((entry) => isRecipientGroup(entry)),
    );
  }
  await migration.down(db);
  await migration.up(db);
  const after = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes', 'functions', 'triggers'] as const) {
    expect(after[kind].filter((entry) => entry.identity.startsWith('public.'))).toEqual(
      before[kind].filter((entry) => entry.identity.startsWith('public.')),
    );
  }
});

it('keeps every group to its owner: others can neither read, change nor delete it', async () => {
  const { ctx, sut } = setup();
  const { user: owner } = await ctx.newUser();
  const { user: stranger } = await ctx.newUser();
  const { user: jamie } = await ctx.newUser();

  const group = await sut.createRecipientGroup(owner.id, 'Family', [jamie.id]);
  expect(group).toEqual(expect.objectContaining({ ownerId: owner.id, name: 'Family', userIds: [jamie.id] }));

  await expect(sut.getRecipientGroups(owner.id)).resolves.toEqual([expect.objectContaining({ id: group.id })]);
  await expect(sut.getRecipientGroups(stranger.id)).resolves.toEqual([]);
  await expect(sut.getRecipientGroup(stranger.id, group.id)).resolves.toBeUndefined();
  await expect(sut.updateRecipientGroup(stranger.id, group.id, { name: 'Taken' })).resolves.toBeUndefined();
  await expect(sut.deleteRecipientGroup(stranger.id, group.id)).resolves.toBe(false);

  const renamed = await sut.updateRecipientGroup(owner.id, group.id, { name: 'Close family' });
  expect(renamed).toEqual(expect.objectContaining({ name: 'Close family', userIds: [jamie.id] }));
  await expect(sut.deleteRecipientGroup(owner.id, group.id)).resolves.toBe(true);
  await expect(sut.getRecipientGroups(owner.id)).resolves.toEqual([]);
});

it('never touches a space membership or invitation when a group changes', async () => {
  const { ctx, sut } = setup();
  const { user: owner } = await ctx.newUser();
  const { user: member } = await ctx.newUser();
  const { user: invited } = await ctx.newUser();
  const { album: space } = await ctx.newAlbum({ ownerId: owner.id, kind: AlbumKind.Space });
  await ctx.newAlbumUser({ albumId: space.id, userId: member.id, role: AlbumUserRole.Viewer });
  await sut.createInvite({ albumId: space.id, userId: invited.id, role: AlbumUserRole.Editor, invitedById: owner.id });
  const snapshot = async () => ({
    members: await ctx.database
      .selectFrom('album_user')
      .select(['userId', 'role'])
      .where('albumId', '=', space.id)
      .orderBy('userId')
      .execute(),
    invites: await sut.getInvitesForAlbum(space.id),
  });
  const before = await snapshot();

  const group = await sut.createRecipientGroup(owner.id, 'Hiking', [member.id, invited.id]);
  await sut.updateRecipientGroup(owner.id, group.id, { userIds: [] });
  await sut.deleteRecipientGroup(owner.id, group.id);

  await expect(snapshot()).resolves.toEqual(before);
});

it('refuses to write while the fork schema is not writable', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  await sql`UPDATE immich_fork.state SET phase='failed' WHERE id=1`.execute(db);
  try {
    await expect(sut.createRecipientGroup(user.id, 'Family', [])).rejects.toThrow(
      'Recipient groups are unavailable during database handoff',
    );
  } finally {
    await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
  }
});

it('drops a deleted account’s own groups and takes it out of everyone else’s (FL-55)', async () => {
  const { ctx, sut } = setup();
  const { user: owner } = await ctx.newUser();
  const { user: leaving } = await ctx.newUser();
  const { user: jamie } = await ctx.newUser();
  const kept = await sut.createRecipientGroup(owner.id, 'Family', [leaving.id, jamie.id]);
  await sut.createRecipientGroup(leaving.id, 'Mine', [owner.id]);

  await sut.forgetRecipient(leaving.id);

  await expect(sut.getRecipientGroups(leaving.id)).resolves.toEqual([]);
  await expect(sut.getRecipientGroup(owner.id, kept.id)).resolves.toEqual(
    expect.objectContaining({ userIds: [jamie.id] }),
  );
});

it('caps how many groups one person keeps, with a clear error (FL-55)', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  await sql`
    INSERT INTO immich_fork.recipient_group ("ownerId", name)
    SELECT ${user.id}::uuid, 'Group ' || n FROM generate_series(1, ${RECIPIENT_GROUP_LIMIT}) AS n
  `.execute(db);

  await expect(sut.createRecipientGroup(user.id, 'One too many', [])).rejects.toThrow(
    `You can keep up to ${RECIPIENT_GROUP_LIMIT} recipient groups`,
  );
  // Somebody else's limit is their own.
  await expect(sut.createRecipientGroup(other.id, 'Family', [])).resolves.toEqual(
    expect.objectContaining({ name: 'Family' }),
  );
});
