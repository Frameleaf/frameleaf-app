import { Kysely, sql } from 'kysely';
import { AlbumKind, AlbumUserRole, SyncEntityType, SyncRequestType } from 'src/enum.js';
import { SyncRepository } from 'src/repositories/sync.repository.js';
import { DB } from 'src/schema/index.js';
import { fromAck } from 'src/utils/sync.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
const lanes = [
  ['tag', SyncRequestType.TagsV1, SyncEntityType.TagV1],
  ['assetTag', SyncRequestType.AssetTagsV1, SyncEntityType.AssetTagV1],
  ['pet', SyncRequestType.PetsV1, SyncEntityType.PetV1],
  ['petObservation', SyncRequestType.PetObservationsV1, SyncEntityType.PetObservationV1],
  ['spaceMember', SyncRequestType.SharedSpaceMembersV1, SyncEntityType.SharedSpaceMemberV1],
] as const;
const dates = [
  '2020-01-01T00:00:00.000000Z',
  '2021-01-01T00:00:00.000001Z',
  '2021-01-01T00:00:00.000002Z',
  '2021-01-01T00:00:00.000002Z',
];
// tag_asset has no createdAt; its source v7 update ID records association chronology.
const associationSources = [
  '017e0000-0000-7000-8000-000000000001',
  '018e0000-0000-7000-8000-000000000001',
  '018f0000-0000-7000-8000-000000000001',
  '018f0000-0000-7000-8000-000000000001',
];

it.each(lanes)(
  'bootstraps %s newest first and resumes by delivered order, not event UUID',
  async (kind, request, type) => {
    const ctx = new SyncTestContext(db);
    const { auth, user, session } = await ctx.newSyncAuthUser();
    const repo = ctx.get(SyncRepository).tag;
    const keys: string[] = [];
    switch (kind) {
      case 'tag': {
        for (const [i, date] of dates.entries()) {
          const { tag } = await ctx.newTag({
            userId: user.id,
            value: `newest-${i}`,
            createdAt: date,
          });
          keys.push(tag.id);
        }
        break;
      }
      case 'assetTag': {
        const { tag } = await ctx.newTag({ userId: user.id, value: 'newest-associations' });
        for (const source of associationSources) {
          const { asset } = await ctx.newAsset({ ownerId: user.id });
          await db.insertInto('tag_asset').values({ tagId: tag.id, assetId: asset.id, updateId: source }).execute();
          keys.push(`${tag.id}:${asset.id}`);
        }
        break;
      }
      case 'pet': {
        for (const [i, date] of dates.entries()) {
          const pet = await db
            .insertInto('pet')
            .values({ ownerId: user.id, name: `Newest ${i}`, createdAt: sql`${date}::timestamptz` })
            .returning('id')
            .executeTakeFirstOrThrow();
          keys.push(pet.id);
        }
        break;
      }
      case 'petObservation': {
        const pet = await db
          .insertInto('pet')
          .values({ ownerId: user.id, name: 'Observations' })
          .returning('id')
          .executeTakeFirstOrThrow();
        for (const date of dates) {
          const { asset } = await ctx.newAsset({ ownerId: user.id });
          const observation = await db
            .insertInto('pet_observation')
            .values({ petId: pet.id, assetId: asset.id, createdAt: sql`${date}::timestamptz` })
            .returning('id')
            .executeTakeFirstOrThrow();
          keys.push(observation.id);
        }
        break;
      }
      case 'spaceMember': {
        const { album } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Space });
        for (const [i, date] of dates.entries()) {
          const member = i === 0 ? user : (await ctx.newUser()).user;
          if (i !== 0) await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Viewer });
          await db
            .updateTable('album_user')
            .set({ createdAt: sql`${date}::timestamptz` })
            .where('albumId', '=', album.id)
            .where('userId', '=', member.id)
            .execute();
          keys.push(`${album.id}:${member.id}`);
        }
        break;
      }
    }
    // Exact source-time ties break by UUID/compound key descending, not incidental query order.
    const expected = [...keys.slice(2).toSorted().toReversed(), keys[1], keys[0]];
    await repo.reconcile(auth, kind);
    // Deliberately reverse opaque delivery UUIDs: newest source has greatest event ID.
    // Sorting eventId ASC, or acknowledging an eventId prefix, is observably wrong.
    for (const [index, key] of expected.entries()) {
      await db
        .updateTable('session_tag_sync_state')
        .set({ eventId: `02000000-0000-7000-8000-${String(4 - index).padStart(12, '0')}` })
        .where('sessionId', '=', session.id)
        .where('kind', '=', kind)
        .where('key', '=', key)
        .execute();
    }
    const pending = await repo.reconcile(auth, kind);
    expect(pending.map(({ key }) => key)).toEqual(expected);
    const freshEventIds = pending.map(({ eventId }) => eventId);
    // An exact but not-delivered event can neither acknowledge itself nor skip newer rows.
    await repo.acknowledge(session.id, { type, updateId: freshEventIds[3] });
    expect((await repo.reconcile(auth, kind)).map(({ key }) => key)).toEqual(expected);
    const first = await repo.prepare(auth, kind, freshEventIds[0]);
    const second = await repo.prepare(auth, kind, freshEventIds[1]);
    expect(first?.type).toBe(type);
    expect(second?.type).toBe(type);
    // A disconnect before ACK retries the exact delivered sequence ahead of unsent rows.
    expect((await repo.reconcile(auth, kind)).map(({ eventId }) => eventId)).toEqual(freshEventIds);
    await repo.acknowledge(session.id, { type, updateId: second!.eventId });
    const resumed = await repo.reconcile(auth, kind);
    expect(resumed.map(({ key }) => key)).toEqual(expected.slice(2));
    expect(resumed.map(({ eventId }) => eventId)).toEqual(freshEventIds.slice(2));
    const states = await db
      .selectFrom('session_tag_sync_state')
      .selectAll()
      .where('sessionId', '=', session.id)
      .where('kind', '=', kind)
      .execute();
    expect(
      states
        .filter(({ acknowledged }) => acknowledged)
        .map(({ key }) => key)
        .sort(),
    ).toEqual(expected.slice(0, 2).sort());
    // Exercise the real service/wire and its last-per-type ACK, not only repository preparation.
    const wire = (await ctx.syncStream(auth, [request])).filter(({ type: entity }) => entity === type);
    expect(wire).toHaveLength(2);
    expect(wire.map(({ ack }) => fromAck(ack).updateId)).toEqual(freshEventIds.slice(2));
    await ctx.syncAckAll(auth, wire);
    await ctx.assertSyncIsComplete(auth, [request]);
  },
);
