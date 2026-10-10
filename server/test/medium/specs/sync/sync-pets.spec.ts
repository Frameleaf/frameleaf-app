import { Kysely } from 'kysely';
import { AssetLockReason, SyncEntityType, SyncRequestType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ItemShareRepository } from 'src/repositories/item-share.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PetRepository } from 'src/repositories/pet.repository.js';
import { SyncRepository } from 'src/repositories/sync.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
const types = [SyncRequestType.PetsV1, SyncRequestType.PetObservationsV1];
const events = (rows: any[]) => rows.filter((row) => row.type !== SyncEntityType.SyncCompleteV1);
const setup = async () => {
  const ctx = new SyncTestContext(db);
  const { auth, user } = await ctx.newSyncAuthUser();
  const pets = new PetRepository(db, LoggingRepository.create());
  const pet = await pets.create({ ownerId: user.id, name: 'Biscuit' });
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const observation = await pets.upsertObservation({
    petId: pet.id,
    assetId: asset.id,
    boundingBoxX1: 1,
    boundingBoxY1: 2,
    boundingBoxX2: 3,
    boundingBoxY2: 4,
  });
  return { ctx, auth, user, pets, pet, asset, observation, repo: ctx.get(SyncRepository).tag };
};
const suppress = (auth: Awaited<ReturnType<typeof setup>>['auth'], petId: string) => ({
  ...auth,
  hiddenContent: {
    userId: auth.user.id,
    petIds: [petId],
    tagIds: [],
    personIds: [],
    scope: 'owned' as const,
    includeNsfw: false,
  },
});

it('creates updates deletes and acknowledges durable identities and observations', async () => {
  const { ctx, auth, pet, observation, pets } = await setup();
  const first = await ctx.syncStream(auth, types);
  expect(events(first).map((row) => row.type)).toEqual([SyncEntityType.PetV1, SyncEntityType.PetObservationV1]);
  expect(events(first)[1].data).toMatchObject({
    id: observation.id,
    sourceChecksum: Buffer.from(observation.sourceChecksum!).toString('base64'),
    staleAt: null,
  });
  await ctx.syncAckAll(auth, first);
  await ctx.assertSyncIsComplete(auth, types);
  await pets.update(auth.user.id, pet.id, { name: 'Rex' });
  const updated = await ctx.syncStream(auth, types);
  expect(events(updated)).toEqual([
    expect.objectContaining({ type: SyncEntityType.PetV1, data: expect.objectContaining({ name: 'Rex' }) }),
  ]);
  await ctx.syncAckAll(auth, updated);
  await pets.deleteObservation(auth.user.id, observation.id);
  const deleted = await ctx.syncStream(auth, types);
  expect(events(deleted)).toEqual([
    expect.objectContaining({ type: SyncEntityType.PetV1, data: expect.objectContaining({ assetCount: 0 }) }),
    expect.objectContaining({
      type: SyncEntityType.PetObservationDeleteV1,
      data: { observationId: observation.id, petId: pet.id, assetId: observation.assetId },
    }),
  ]);
  await ctx.syncAckAll(auth, deleted);
  await pets.delete(auth.user.id, pet.id);
  const removed = await ctx.syncStream(auth, types);
  expect(events(removed)).toEqual([
    expect.objectContaining({ type: SyncEntityType.PetDeleteV1, data: { petId: pet.id } }),
  ]);
  await ctx.syncAckAll(auth, removed);
  await ctx.assertSyncIsComplete(auth, types);
  expect(await db.selectFrom('pet_audit').selectAll().where('petId', '=', pet.id).execute()).toHaveLength(1);
  expect(
    await db.selectFrom('pet_observation_audit').selectAll().where('observationId', '=', observation.id).execute(),
  ).toHaveLength(1);
});

it.each(['suppression', 'deletion'] as const)(
  'revokes a merged observation with its current pet after %s',
  async (reason) => {
    const { ctx, auth, pet, observation, pets } = await setup();
    const first = await ctx.syncStream(auth, types);
    await ctx.syncAckAll(auth, first);
    const target = await pets.create({ ownerId: auth.user.id, name: 'Merged' });
    await pets.mergeInto(auth.user.id, {
      sourceId: pet.id,
      targetId: target.id,
      reassign: [observation.id],
      promote: [],
      discard: [],
    });
    const merged = await ctx.syncStream(auth, types);
    expect(events(merged)).toContainEqual(
      expect.objectContaining({
        type: SyncEntityType.PetObservationV1,
        data: expect.objectContaining({ id: observation.id, petId: target.id }),
      }),
    );
    await ctx.syncAckAll(auth, merged);
    if (reason === 'deletion') await pets.deleteObservation(auth.user.id, observation.id);
    const currentAuth = reason === 'suppression' ? suppress(auth, target.id) : auth;
    const removed = await ctx.syncStream(currentAuth, types);
    const deletes = events(removed).filter((row) => row.type === SyncEntityType.PetObservationDeleteV1);
    expect(deletes).toEqual([
      expect.objectContaining({
        data: { observationId: observation.id, petId: target.id, assetId: observation.assetId },
      }),
    ]);
    expect(events(await ctx.syncStream(currentAuth, types))).toEqual(events(removed));
    await ctx.syncAckAll(currentAuth, removed);
    await ctx.assertSyncIsComplete(currentAuth, types);
  },
);

it('retries a merge between reconciliation and preparation under a fresh generation', async () => {
  const { ctx, auth, pet, observation, pets, repo } = await setup();
  const [queued] = await repo.reconcile(auth, 'petObservation');
  const target = await pets.create({ ownerId: auth.user.id, name: 'Merge during delivery' });
  await pets.mergeInto(auth.user.id, {
    sourceId: pet.id,
    targetId: target.id,
    reassign: [observation.id],
    promote: [],
    discard: [],
  });
  expect(await repo.prepare(auth, 'petObservation', queued.eventId)).toBeUndefined();
  const [fresh] = await repo.reconcile(auth, 'petObservation');
  expect(fresh.eventId).not.toBe(queued.eventId);
  const payload = await repo.prepare(auth, 'petObservation', fresh.eventId);
  expect(payload).toMatchObject({ data: { id: observation.id, petId: target.id } });
  await repo.acknowledge(auth.session!.id, { type: payload!.type, updateId: payload!.eventId });
  const removed = events(await ctx.syncStream(suppress(auth, target.id), types));
  expect(removed).toContainEqual(
    expect.objectContaining({
      type: SyncEntityType.PetObservationDeleteV1,
      data: { observationId: observation.id, petId: target.id, assetId: observation.assetId },
    }),
  );
});

it.each([false, true])(
  'retries revocation and regrants unchanged sources before/after ACK=%s',
  async (acknowledged) => {
    const { ctx, auth, pet } = await setup();
    const first = await ctx.syncStream(auth, types);
    if (acknowledged) await ctx.syncAckAll(auth, first);
    const hidden = suppress(auth, pet.id);
    const revoke = await ctx.syncStream(hidden, types);
    expect(events(revoke).map((row) => row.type)).toEqual([
      SyncEntityType.PetDeleteV1,
      SyncEntityType.PetObservationDeleteV1,
    ]);
    expect(events(await ctx.syncStream(hidden, types))).toEqual(events(revoke));
    await ctx.syncAckAll(hidden, revoke);
    await ctx.assertSyncIsComplete(hidden, types);
    const granted = await ctx.syncStream(auth, types);
    expect(events(granted).map((row) => row.type)).toEqual([SyncEntityType.PetV1, SyncEntityType.PetObservationV1]);
    await Promise.all([ctx.syncAckAll(auth, revoke), ctx.syncAckAll(auth, first)]);
    expect(events(await ctx.syncStream(auth, types))).toEqual(events(granted));
    await ctx.syncAckAll(auth, granted);
    await ctx.assertSyncIsComplete(auth, types);
  },
);

it('never discloses initially suppressed or Locked-only identifiers', async () => {
  const { ctx, auth, pet, asset } = await setup();
  expect(events(await ctx.syncStream(suppress(auth, pet.id), types))).toEqual([]);
  await ctx.get(AssetRepository).lock([asset.id], AssetLockReason.Marked, auth.user.id);
  expect(events(await ctx.syncStream(auth, types))).toEqual([]);
  const elevated = { ...auth, session: { ...auth.session!, hasElevatedPermission: true } };
  expect(events(await ctx.syncStream(elevated, types)).map((row) => row.type)).toEqual([
    SyncEntityType.PetV1,
    SyncEntityType.PetObservationV1,
  ]);
});

it('retains empty identities while filtering foreign ownership from every stream', async () => {
  const { ctx, auth, pets, user, pet, asset } = await setup();
  const empty = await pets.create({ ownerId: user.id, name: 'Empty' });
  expect(events(await ctx.syncStream(auth, [SyncRequestType.PetsV1])).some((row) => row.data.id === empty.id)).toBe(
    true,
  );
  for (const isAdmin of [false, true]) {
    const other = await ctx.newSyncAuthUser();
    await ctx.newPartner({ sharedById: user.id, sharedWithId: other.user.id });
    await ctx.get(ItemShareRepository).add(user.id, [asset.id], [other.user.id]);
    const rows = await ctx.syncStream({ ...other.auth, user: { ...other.auth.user, isAdmin } }, types);
    expect(events(rows)).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain(pet.id);
    expect(JSON.stringify(rows)).not.toContain(asset.id);
  }
});

it('updates derived counts and safe featured IDs without changing the pet source row', async () => {
  const { ctx, auth, pet, asset, pets, user } = await setup();
  const { asset: second } = await ctx.newAsset({ ownerId: user.id });
  await pets.upsertObservation({ petId: pet.id, assetId: second.id });
  await pets.update(user.id, pet.id, { featuredAssetId: asset.id });
  const source = await db.selectFrom('pet').select('updateId').where('id', '=', pet.id).executeTakeFirstOrThrow();
  const hidden = { ...auth, hideNsfwAssets: true };
  const first = await ctx.syncStream(hidden, types);
  expect(events(first)[0].data).toMatchObject({ assetCount: 2, featuredAssetId: asset.id });
  await ctx.syncAckAll(hidden, first);
  await db.updateTable('asset').set({ is_nsfw: true }).where('id', '=', asset.id).execute();
  const changed = await ctx.syncStream(hidden, types);
  expect(events(changed)).toEqual([
    expect.objectContaining({
      type: SyncEntityType.PetV1,
      data: expect.objectContaining({ assetCount: 1, featuredAssetId: null }),
    }),
    expect.objectContaining({ type: SyncEntityType.PetObservationDeleteV1 }),
  ]);
  expect(
    (await db.selectFrom('pet').select('updateId').where('id', '=', pet.id).executeTakeFirstOrThrow()).updateId,
  ).toBe(source.updateId);
  await ctx.syncAckAll(hidden, changed);
  await db.updateTable('asset').set({ is_nsfw: false }).where('id', '=', asset.id).execute();
  expect(events(await ctx.syncStream(hidden, types))[0].data).toMatchObject({
    assetCount: 2,
    featuredAssetId: asset.id,
  });
});

it('updates source checksum and stale-region decisions through durable observation generations', async () => {
  const { ctx, auth, pet, asset, pets, observation } = await setup();
  await ctx.syncAckAll(auth, await ctx.syncStream(auth, types));
  await db
    .updateTable('asset')
    .set({ checksum: Buffer.from('replacement') })
    .where('id', '=', asset.id)
    .execute();
  expect(await pets.flagStaleRegions(asset.id)).toBe(1);
  const stale = await ctx.syncStream(auth, types);
  expect(events(stale)).toEqual([
    expect.objectContaining({
      type: SyncEntityType.PetObservationV1,
      data: expect.objectContaining({
        id: observation.id,
        staleAt: expect.any(String),
        sourceChecksum: Buffer.from(observation.sourceChecksum!).toString('base64'),
      }),
    }),
  ]);
  await ctx.syncAckAll(auth, stale);
  await pets.upsertObservation({ petId: pet.id, assetId: asset.id });
  const repaired = events(await ctx.syncStream(auth, types));
  expect(repaired).toEqual([
    expect.objectContaining({
      type: SyncEntityType.PetObservationV1,
      data: expect.objectContaining({ staleAt: null, sourceChecksum: Buffer.from('replacement').toString('base64') }),
    }),
  ]);
});

it('preserves retryable cascade revokes after physical pet or asset deletion', async () => {
  for (const target of ['pet', 'asset'] as const) {
    const { ctx, auth, pet, asset, pets, observation } = await setup();
    await ctx.syncAckAll(auth, await ctx.syncStream(auth, types));
    if (target === 'pet') await pets.delete(auth.user.id, pet.id);
    else await db.deleteFrom('asset').where('id', '=', asset.id).execute();
    const removed = await ctx.syncStream(auth, types);
    expect(
      events(removed).some(
        (row) => row.type === SyncEntityType.PetObservationDeleteV1 && row.data.observationId === observation.id,
      ),
    ).toBe(true);
    expect(events(await ctx.syncStream(auth, types))).toEqual(events(removed));
    expect(
      await db.selectFrom('pet_observation_audit').selectAll().where('observationId', '=', observation.id).execute(),
    ).toHaveLength(1);
    await ctx.syncAckAll(auth, removed);
    await ctx.assertSyncIsComplete(auth, types);
  }
});

it('does not ACK unseen rows and resumes after partial delivery', async () => {
  const { auth, pet, pets, repo } = await setup();
  await pets.create({ ownerId: auth.user.id, name: 'Second' });
  const pending = await repo.reconcile(auth, 'pet');
  expect(pending).toHaveLength(2);
  await repo.acknowledge(auth.session!.id, { type: SyncEntityType.PetV1, updateId: pending[1].eventId });
  expect(await repo.reconcile(auth, 'pet')).toHaveLength(2);
  const first = await repo.prepare(auth, 'pet', pending[0].eventId);
  await repo.acknowledge(auth.session!.id, { type: first!.type, updateId: first!.eventId });
  const resumed = await repo.reconcile(auth, 'pet');
  expect(resumed.map((row) => row.eventId)).toEqual([pending[1].eventId]);
  // A queued payload becoming suppressed before prepare is never sent or disclosed as a revoke.
  const [queued] = await repo.reconcile(auth, 'petObservation');
  expect(await repo.prepare(suppress(auth, pet.id), 'petObservation', queued.eventId)).toBeUndefined();
  expect(await repo.reconcile(suppress(auth, pet.id), 'petObservation')).toEqual([]);
});
