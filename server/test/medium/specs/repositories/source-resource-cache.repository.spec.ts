import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DB } from 'src/schema/index.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SourceResourceCacheRepository } from 'src/repositories/source-resource-cache.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let sut: SourceResourceCacheRepository;
let root: string;
const snapshot = (): Parameters<SourceResourceCacheRepository['reserve']>[1] => ({
  id: randomUUID(),
  claimFence: 1,
  assetId: randomUUID(),
  resourceId: randomUUID(),
  sourceId: randomUUID(),
  ownerId: randomUUID(),
  deviceId: randomUUID(),
  scopeFingerprint: 'a'.repeat(64),
  authorizationEpoch: 1,
  resourceKey: 'b'.repeat(64),
  version: 'c'.repeat(64),
  sha256: 'd'.repeat(64),
  bytes: 5,
  leaseUntil: new Date(Date.now() + 60_000),
  deadline: new Date(Date.now() + 600_000),
});
const file = () => ({ fileName: `${randomUUID()}.artifact`, bytes: 5, sha256: Buffer.from('d'.repeat(64), 'hex') });
beforeAll(async () => {
  db = await getKyselyDB();
  root = await mkdtemp(join(tmpdir(), 'source-cache-budget-'));
  sut = new SourceResourceCacheRepository(db);
});
afterAll(async () => {
  await db?.destroy();
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await sql`TRUNCATE source_resource_cache CASCADE`.execute(db);
});
const reserve = async (value = snapshot(), budget = 5, cacheRoot = root) => {
  const writer = { id: randomUUID(), ownerId: randomUUID() };
  const disk = await sut.inspectDisk(cacheRoot);
  if (!disk) return { row: undefined, writer };
  const row = await db.transaction().execute((tx) => sut.reserve(tx, value, budget, writer, disk));
  if (row === 'snapshot-changed') throw new Error('Unexpected fixture admission race');
  return { row, writer };
};

it('serializes capacity across sources and retains an unknown writer regardless of age', async () => {
  const results = await Promise.all([reserve(), reserve()]);
  const accepted = results.filter(({ row }) => row);
  expect(accepted).toHaveLength(1);
  const { row, writer } = accepted[0];
  await sql`UPDATE source_resource_cache SET "createdAt"=now()-interval '10 years' WHERE id=${row!.id}::uuid`.execute(
    db,
  );
  expect((await reserve()).row).toBeUndefined();
  expect(await sut.claimRemoval(row!.id)).toBeUndefined();
  expect(await sut.finishWriter(row!.id, { ...writer, id: randomUUID() })).toBe(false);
  expect(await sut.finishWriter(row!.id, writer)).toBe(true);
  expect((await sut.claimRemoval(row!.id))?.state).toBe('deleting');
  expect((await reserve()).row).toBeUndefined();
  expect(await sut.confirmRemoved(row!.id)).toBe(true);
  expect((await reserve()).row?.id).toBeTruthy();
});
it('does not admit a second writer for one claim or unsafe allocation sizes', async () => {
  const value = snapshot();
  expect((await reserve(value, 100)).row?.id).toBeTruthy();
  expect((await reserve(value, 100)).row).toBeUndefined();
  for (const bytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect((await reserve({ ...snapshot(), bytes }, 100)).row).toBeUndefined();
  expect((await reserve(snapshot(), 4)).row).toBeUndefined();
});
it('publishes only measured bytes matching the reserved object and exact writer', async () => {
  const { row, writer } = await reserve();
  const publish = (owner: typeof writer, artifact: ReturnType<typeof file>) =>
    db.transaction().execute((tx) => sut.publishVerified(tx, row!.id, owner, artifact));
  expect(await publish({ ...writer, id: randomUUID() }, file())).toBe(false);
  expect(await publish({ ...writer, ownerId: randomUUID() }, file())).toBe(false);
  expect(await publish(writer, { ...file(), bytes: 4 })).toBe(false);
  expect(await publish(writer, { ...file(), sha256: Buffer.alloc(32) })).toBe(false);
  expect(await publish(writer, { ...file(), fileName: '../private' })).toBe(false);
  expect(await sut.pin(row!.id, { kind: 'http', readerId: randomUUID(), ownerId: randomUUID() })).toBeUndefined();
  const artifact = file();
  expect(await publish(writer, artifact)).toBe(true);
  const stored = await db
    .selectFrom('source_resource_cache')
    .selectAll()
    .where('id', '=', row!.id)
    .executeTakeFirstOrThrow();
  expect(stored).toMatchObject({ state: 'ready', fileName: artifact.fileName });
  expect(stored.writerStoppedAt).not.toBeNull();
});
it('never evicts an unknown reader and frees capacity only after removal is confirmed', async () => {
  const { row, writer } = await reserve();
  expect(await db.transaction().execute((tx) => sut.publishVerified(tx, row!.id, writer, file()))).toBe(true);
  const reader = { kind: 'http' as const, readerId: randomUUID(), ownerId: randomUUID() };
  const lease = await sut.pin(row!.id, reader);
  expect(lease?.id).toBeTruthy();
  await sql`UPDATE source_resource_cache_lease SET "createdAt"=now()-interval '10 years' WHERE id=${lease!.id}::uuid`.execute(
    db,
  );
  expect(await sut.claimRemoval(row!.id)).toBeUndefined();
  expect(await sut.confirmRemoved(row!.id)).toBe(false);
  expect(await sut.release(lease!.id, { ...reader, readerId: randomUUID() })).toBe(false);
  expect(await sut.release(lease!.id, { ...reader, ownerId: randomUUID() })).toBe(false);
  expect(await sut.claimRemoval(row!.id)).toBeUndefined();
  expect(await sut.release(lease!.id, reader)).toBe(true);
  expect((await sut.claimRemoval(row!.id))?.state).toBe('deleting');
  expect(await sut.pin(row!.id, { ...reader, readerId: randomUUID() })).toBeUndefined();
  expect((await reserve()).row).toBeUndefined();
  expect(await sut.confirmRemoved(row!.id)).toBe(true);
  expect((await reserve()).row?.id).toBeTruthy();
});

it('retains cleanup ownership when an asset is deleted while a reader is pinned', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const { row, writer } = await reserve({ ...snapshot(), ownerId: user.id, assetId: asset.id });
  expect(await db.transaction().execute((tx) => sut.publishVerified(tx, row!.id, writer, file()))).toBe(true);
  const reader = { kind: 'http' as const, readerId: randomUUID(), ownerId: randomUUID() };
  const lease = (await sut.pin(row!.id, reader))!;
  await db.deleteFrom('asset').where('id', '=', asset.id).execute();
  expect(
    await db.selectFrom('source_resource_cache').select('assetId').where('id', '=', row!.id).executeTakeFirst(),
  ).toEqual({ assetId: asset.id });
  expect(
    await db.selectFrom('source_resource_cache_lease').select('id').where('id', '=', lease.id).executeTakeFirst(),
  ).toEqual({ id: lease.id });
  expect(await sut.claimRemoval(row!.id)).toBeUndefined();
});

it('bounds metadata entries even when their byte reservations fit the budget', async () => {
  const value = snapshot();
  await sql`INSERT INTO source_resource_cache ("readId", "claimFence", "assetId", "resourceId", "sourceId", "ownerId", "deviceId", "scopeFingerprint", "authorizationEpoch", "resourceKey", version, sha256, bytes, "writerId", "writerOwnerId")
    SELECT uuidv7(), 1, ${value.assetId}::uuid, ${value.resourceId}::uuid, ${value.sourceId}::uuid,
      ${value.ownerId}::uuid, ${value.deviceId}::uuid, ${value.scopeFingerprint}, 1, ${value.resourceKey},
      ${value.version}, ${Buffer.from(value.sha256, 'hex')}, 1, uuidv7(), uuidv7()
    FROM generate_series(1,4096)`.execute(db);
  expect((await reserve({ ...snapshot(), bytes: 1 }, 1_000_000)).row).toBeUndefined();
});

it('does not accumulate metadata after readers positively release a retained object', async () => {
  const { row, writer } = await reserve();
  expect(await db.transaction().execute((tx) => sut.publishVerified(tx, row!.id, writer, file()))).toBe(true);
  for (let index = 0; index < 8; index++) {
    const reader = { kind: 'http' as const, readerId: randomUUID(), ownerId: randomUUID() };
    const lease = (await sut.pin(row!.id, reader))!;
    expect(await sut.release(lease.id, reader)).toBe(true);
  }
  const leases = await db
    .selectFrom('source_resource_cache_lease')
    .select('id')
    .where('cacheId', '=', row!.id)
    .execute();
  expect(leases).toHaveLength(0);
});

it('bounds concurrent active readers without expiring unknown owners', async () => {
  const { row, writer } = await reserve();
  expect(await db.transaction().execute((tx) => sut.publishVerified(tx, row!.id, writer, file()))).toBe(true);
  const pin = () => sut.pin(row!.id, { kind: 'http', readerId: randomUUID(), ownerId: randomUUID() });
  for (let index = 0; index < 63; index++) expect((await pin())?.id).toBeTruthy();
  const leases = await Promise.all([pin(), pin()]);
  expect(leases.filter(Boolean)).toHaveLength(1);
  expect(await sut.claimRemoval(row!.id)).toBeUndefined();
});

it('recovers stopped orphan writers and interrupted deletion but retains unknown readers and writers', async () => {
  const unknown = await reserve(snapshot(), 100);
  const stopped = await reserve(snapshot(), 100);
  const pinned = await reserve(snapshot(), 100);
  expect(await sut.finishWriter(stopped.row!.id, stopped.writer)).toBe(true);
  expect(await db.transaction().execute((tx) => sut.publishVerified(tx, pinned.row!.id, pinned.writer, file()))).toBe(
    true,
  );
  const reader = { kind: 'http' as const, readerId: randomUUID(), ownerId: randomUUID() };
  const lease = (await sut.pin(pinned.row!.id, reader))!;
  await sql`UPDATE source_resource_cache SET "createdAt"=now()-interval '10 years'`.execute(db);
  await sql`UPDATE source_resource_cache_lease SET "createdAt"=now()-interval '10 years'`.execute(db);
  expect(await sut.removalCandidates()).toEqual([{ id: stopped.row!.id }]);
  expect((await sut.claimRemoval(stopped.row!.id))?.state).toBe('deleting');
  expect(await sut.removalCandidates()).toEqual([{ id: stopped.row!.id }]);
  expect(await sut.confirmRemoved(stopped.row!.id)).toBe(true);
  expect(await sut.release(lease.id, reader)).toBe(true);
  expect(await sut.removalCandidates()).toEqual([{ id: pinned.row!.id }]);
  expect(
    await db
      .selectFrom('source_resource_cache')
      .select('writerStoppedAt')
      .where('id', '=', unknown.row!.id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ writerStoppedAt: null });
});

it('recovers a durable reader stop receipt after the owner cannot delete its lease', async () => {
  const { row, writer } = await reserve();
  expect(await db.transaction().execute((tx) => sut.publishVerified(tx, row!.id, writer, file()))).toBe(true);
  const reader = { kind: 'http' as const, readerId: randomUUID(), ownerId: randomUUID() };
  const lease = (await sut.pin(row!.id, reader))!;
  expect(
    await db
      .selectFrom('source_resource_cache_lease')
      .select('readerStoppedAt')
      .where('id', '=', lease.id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ readerStoppedAt: null });
  await sql`CREATE FUNCTION source_reader_test_fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'simulated lease deletion failure'; END$$`.execute(
    db,
  );
  await sql`CREATE TRIGGER source_reader_test_fail_delete BEFORE DELETE ON source_resource_cache_lease FOR EACH ROW EXECUTE FUNCTION source_reader_test_fail_delete()`.execute(
    db,
  );
  try {
    expect(await sut.release(lease.id, { ...reader, ownerId: randomUUID() })).toBe(false);
    expect(await sut.removalCandidates()).toEqual([]);
    await expect(sut.release(lease.id, reader)).rejects.toThrow('simulated lease deletion failure');
    const stopped = await db
      .selectFrom('source_resource_cache_lease')
      .select('readerStoppedAt')
      .where('id', '=', lease.id)
      .executeTakeFirstOrThrow();
    expect(stopped.readerStoppedAt).not.toBeNull();
  } finally {
    await sql`DROP TRIGGER source_reader_test_fail_delete ON source_resource_cache_lease`.execute(db);
    await sql`DROP FUNCTION source_reader_test_fail_delete()`.execute(db);
  }
  const recovered = new SourceResourceCacheRepository(db);
  expect(await recovered.removalCandidates()).toEqual([{ id: row!.id }]);
  expect((await reserve()).row).toBeUndefined();
  expect((await recovered.claimRemoval(row!.id))?.state).toBe('deleting');
  expect((await reserve()).row).toBeUndefined();
  expect(await recovered.confirmRemoved(row!.id)).toBe(true);
  expect((await reserve()).row?.id).toBeTruthy();
});
it('reuses only positively stopped reader slots and keeps replacement leases protected', async () => {
  const { row, writer } = await reserve();
  expect(await db.transaction().execute((tx) => sut.publishVerified(tx, row!.id, writer, file()))).toBe(true);
  const reader = { kind: 'http' as const, readerId: randomUUID(), ownerId: randomUUID() };
  const old = (await sut.pin(row!.id, reader))!;
  for (let index = 1; index < 64; index++)
    expect((await sut.pin(row!.id, { ...reader, readerId: randomUUID() }))?.id).toBeTruthy();
  expect(await sut.pin(row!.id, { ...reader, readerId: randomUUID() })).toBeUndefined();
  await db
    .updateTable('source_resource_cache_lease')
    .set({ readerStoppedAt: new Date() })
    .where('id', '=', old.id)
    .execute();
  const replacement = (await sut.pin(row!.id, reader))!;
  expect(replacement?.id).toBeTruthy();
  expect(replacement.id).not.toBe(old.id);
  expect(await sut.release(old.id, reader)).toBe(false);
  expect(await sut.claimRemoval(row!.id)).toBeUndefined();
  expect(
    await db
      .selectFrom('source_resource_cache_lease')
      .select(['id', 'readerStoppedAt'])
      .where('id', '=', replacement.id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ id: replacement.id, readerStoppedAt: null });
  expect(
    await db.selectFrom('source_resource_cache_lease').select('id').where('cacheId', '=', row!.id).execute(),
  ).toHaveLength(64);
});

it('refuses new reservations while an unaccounted original remains on disk and leaves its bytes untouched', async () => {
  const orphanRoot = await mkdtemp(join(tmpdir(), 'source-cache-orphan-'));
  const orphan = join(orphanRoot, randomUUID());
  const path = join(orphan, `${randomUUID()}.artifact`);
  try {
    await mkdir(orphan);
    await writeFile(path, Buffer.from('unaccounted original'));
    expect((await reserve(snapshot(), 100, orphanRoot)).row).toBeUndefined();
    expect(await readFile(path)).toEqual(Buffer.from('unaccounted original'));
    expect(await db.selectFrom('source_resource_cache').select('id').execute()).toEqual([]);
  } finally {
    await rm(orphanRoot, { recursive: true, force: true });
  }
});

it('counts reserved growth on disk once and refuses bytes beyond an existing object reservation', async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'source-cache-measured-'));
  try {
    const first = (await reserve(snapshot(), 10, cacheRoot)).row!;
    const folder = join(cacheRoot, first.id),
      path = join(folder, `${randomUUID()}.artifact.partial`);
    await mkdir(folder);
    await writeFile(path, 'hello');
    expect((await reserve(snapshot(), 10, cacheRoot)).row?.id).toBeTruthy();
    expect((await reserve(snapshot(), 10, cacheRoot)).row).toBeUndefined();
    await writeFile(path, 'hello!');
    expect((await reserve(snapshot(), 100, cacheRoot)).row).toBeUndefined();
    expect(await readFile(path, 'utf8')).toBe('hello!');
    expect(await db.selectFrom('source_resource_cache').select('id').execute()).toHaveLength(2);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

it.each(['added', 'removed', 'resized'] as const)(
  'refuses a %s reservation snapshot and admits only a fresh disk preflight',
  async (change) => {
    const first = (await reserve(snapshot(), 100)).row!;
    const inspected = (await sut.inspectDisk(root))!;
    if (change === 'added') await reserve(snapshot(), 100);
    else if (change === 'removed') await db.deleteFrom('source_resource_cache').where('id', '=', first.id).execute();
    else await db.updateTable('source_resource_cache').set({ bytes: 6 }).where('id', '=', first.id).execute();
    const next = snapshot(),
      writer = { id: randomUUID(), ownerId: randomUUID() };
    expect(await db.transaction().execute((tx) => sut.reserve(tx, next, 100, writer, inspected))).toBe(
      'snapshot-changed',
    );
    const fresh = (await sut.inspectDisk(root))!;
    const accepted = await db.transaction().execute((tx) => sut.reserve(tx, next, 100, writer, fresh));
    expect(accepted && accepted !== 'snapshot-changed' && accepted.id).toBeTruthy();
  },
);

it('bounds pending reader stop receipts without dropping a lease or invoking filesystem cleanup', async () => {
  const { row, writer } = await reserve();
  expect(await db.transaction().execute((tx) => sut.publishVerified(tx, row!.id, writer, file()))).toBe(true);
  const reader = { kind: 'http' as const, readerId: randomUUID(), ownerId: randomUUID() };
  const lease = (await sut.pin(row!.id, reader))!;
  const key = `frameleaf-source-reader-stopped:${row!.id}`;
  const receipts = Object.fromEntries(Array.from({ length: 64 }, () => [randomUUID(), true]));
  await sql`INSERT INTO system_metadata(key,value) VALUES (${key},${JSON.stringify(receipts)}::text::jsonb)`.execute(
    db,
  );
  const cleanup = vi.fn();
  try {
    await expect(sut.release(lease.id, reader, cleanup)).rejects.toThrow('source_reader_cleanup_busy');
    expect(cleanup).not.toHaveBeenCalled();
    expect(
      await db
        .selectFrom('source_resource_cache_lease')
        .select('readerStoppedAt')
        .where('id', '=', lease.id)
        .executeTakeFirst(),
    ).toEqual({ readerStoppedAt: null });
    expect(
      (await sql<{ value: unknown }>`SELECT value FROM system_metadata WHERE key=${key}`.execute(db)).rows[0].value,
    ).toEqual(receipts);
  } finally {
    await sql`DELETE FROM system_metadata WHERE key=${key}`.execute(db);
  }
});
it('keeps cache accounting when final stop-journal cleanup cannot commit', async () => {
  const { row, writer } = await reserve();
  expect(await sut.finishWriter(row!.id, writer)).toBe(true);
  expect((await sut.claimRemoval(row!.id))?.state).toBe('deleting');
  const key = `frameleaf-source-reader-stopped:${row!.id}`;
  await sql`INSERT INTO system_metadata(key,value) VALUES (${key},${JSON.stringify({ [randomUUID()]: true })}::text::jsonb)`.execute(
    db,
  );
  await sql`CREATE FUNCTION source_reader_journal_test_fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'journal delete failed'; END$$`.execute(
    db,
  );
  await sql`CREATE TRIGGER source_reader_journal_test_fail_delete BEFORE DELETE ON system_metadata FOR EACH ROW EXECUTE FUNCTION source_reader_journal_test_fail_delete()`.execute(
    db,
  );
  try {
    await expect(sut.confirmRemoved(row!.id)).rejects.toThrow('journal delete failed');
    expect(
      await db.selectFrom('source_resource_cache').select('state').where('id', '=', row!.id).executeTakeFirst(),
    ).toEqual({ state: 'deleting' });
    expect((await sql`SELECT key FROM system_metadata WHERE key=${key}`.execute(db)).rows).toHaveLength(1);
  } finally {
    await sql`DROP TRIGGER source_reader_journal_test_fail_delete ON system_metadata`.execute(db);
    await sql`DROP FUNCTION source_reader_journal_test_fail_delete()`.execute(db);
  }
  expect(await sut.confirmRemoved(row!.id)).toBe(true);
  expect((await sql`SELECT key FROM system_metadata WHERE key=${key}`.execute(db)).rows).toEqual([]);
});
