import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ArchiveTimelineQuerySchema } from 'src/dtos/archive-operation.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetOrder, AssetVisibility } from 'src/enum.js';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import * as migration from 'src/fork-schema/migrations/0000000000120-ArchivePreparation.js';
import { ArchiveOperationRepository } from 'src/repositories/archive-operation.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetService } from 'src/services/asset.service.js';
import { emptySuppressionPreferences } from 'src/utils/hidden-content.js';
import { MediumTestContext, mediumFactory } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const query = ArchiveTimelineQuerySchema.parse({
  scope: { kind: 'library' },
  filters: {
    visibility: 'timeline',
    withStacked: true,
    withPartners: true,
  },
});
describe('prepared owned Timeline archive', () => {
  let db: Kysely<DB>;
  let repo: ArchiveOperationRepository;
  let context: MediumTestContext<typeof AssetService>;
  let auth: AuthDto;
  beforeAll(async () => {
    db = await getKyselyDB();
    repo = new ArchiveOperationRepository(db);
    if (process.env.FRAMELEAF_ARCHIVE_CATALOG)
      await writeFile(process.env.FRAMELEAF_ARCHIVE_CATALOG, JSON.stringify(await getCatalogEvidence(db)));
    context = new MediumTestContext(AssetService, { database: db, real: [], mock: [LoggingRepository] });
    await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
  });
  beforeEach(async () => {
    const { result: user } = await context.newUser();
    const session = await db
      .insertInto('session')
      .values({ userId: user.id, token: Buffer.from(randomUUID()) })
      .returningAll()
      .executeTakeFirstOrThrow();
    auth = { user, session: { id: session.id, hasElevatedPermission: false } };
  });
  afterAll(async () => {
    await db?.destroy();
  });
  const asset = async (ownerId = auth.user.id) => {
    const { result } = await context.newAsset({ ownerId });
    await db
      .insertInto('asset_exif')
      .values({ assetId: result.id })
      .onConflict((oc) => oc.column('assetId').doNothing())
      .execute();
    return result.id;
  };
  const prepare = (requestKey = randomUUID()) => repo.prepare(auth, { query, requestKey }, true);
  const items = async (id: string) => {
    const result = await sql<{
      assetId: string;
    }>`SELECT "assetId" FROM immich_fork.archive_operation_item WHERE "operationId"=${id}::uuid`.execute(db);
    return result.rows.map((row) => row.assetId);
  };

  it('freezes exact owned visible primary membership, excluding foreign, hidden, deleted and missing EXIF assets', async () => {
    const primary = await asset();
    const secondary = await asset();
    const normal = await asset();
    const { result: foreignUser } = await context.newUser();
    await asset(foreignUser.id);
    const hidden = await asset();
    await sql`UPDATE asset SET is_nsfw=true WHERE id=${hidden}::uuid`.execute(db);
    const deleted = await asset();
    await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', deleted).execute();
    const noExif = await asset();
    await db.deleteFrom('asset_exif').where('assetId', '=', noExif).execute();
    const stack = await db
      .insertInto('stack')
      .values({ ownerId: auth.user.id, primaryAssetId: primary })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db.updateTable('asset').set({ stackId: stack.id }).where('id', 'in', [primary, secondary]).execute();
    const id = await prepare();
    const selectedItems = await items(id);
    expect(selectedItems.sort()).toEqual([normal, primary].sort());
    const timeline = new AssetRepository(db);
    const options = {
      visibility: AssetVisibility.Timeline,
      withStacked: true,
      userIds: [auth.user.id],
      hiddenContent: { userId: auth.user.id, includeNsfw: true, ...emptySuppressionPreferences() },
    };
    const buckets = await timeline.getTimeBuckets(options, auth);
    const displayed: string[] = [];
    for (const bucket of buckets) {
      const result = await timeline.getTimeBucket(bucket.timeBucket, options, auth);
      displayed.push(...JSON.parse(result.assets).id);
    }
    expect(displayed.sort()).toEqual(selectedItems.sort());
    expect(await repo.get(auth.user.id, id)).toMatchObject({ count: 2, prepared: true, pending: 2 });
    expect(await repo.pending()).not.toContain(id);
    expect(await repo.processNext(id, true)).toBe(false);
    await expect(repo.command(auth, id, 'retry')).rejects.toThrow('Confirm');
  });

  it('binds identity before confirmation and never re-queries changing membership', async () => {
    const selected = await asset();
    const key = randomUUID();
    const id = await prepare(key);
    await asset();
    expect(await prepare(key)).toBe(id);
    expect(await items(id)).toEqual([selected]);
    await expect(
      repo.prepare(
        auth,
        { requestKey: key, query: { ...query, filters: { ...query.filters, order: AssetOrder.Asc } } },
        true,
      ),
    ).rejects.toThrow('different selection');
    await expect(repo.confirm(auth, id, randomUUID(), true)).rejects.toThrow('Confirmation');
    await Promise.all([prepare(key), repo.confirm(auth, id, key, true), repo.confirm(auth, id, key, true)]);
    await repo.processNext(id, true);
    expect(await repo.get(auth.user.id, id)).toMatchObject({ prepared: false, count: 1, succeeded: 1 });
  });

  it('materializes more than the explicit-ID limit across unloaded months without an ID array', async () => {
    for (let page = 0; page < 11; page++) {
      const rows = Array.from({ length: 1000 }, (_, index) =>
        mediumFactory.assetInsert({
          ownerId: auth.user.id,
          localDateTime: new Date(2020 + page, index % 12, 1),
        }),
      );
      const created = await db.insertInto('asset').values(rows).returning('id').execute();
      await db
        .insertInto('asset_exif')
        .values(created.map(({ id }) => ({ assetId: id })))
        .execute();
    }
    const id = await prepare();
    expect(await repo.get(auth.user.id, id)).toMatchObject({ count: 11_000, pending: 11_000, prepared: true });
    const saved = await sql<{
      count: number;
    }>`SELECT cardinality("assetIds") AS count FROM immich_fork.archive_operation WHERE id=${id}::uuid`.execute(db);
    expect(saved.rows[0].count).toBe(0);
  });
  it('keeps zero-match receipts visible and rejects unsupported widening', async () => {
    const id = await prepare();
    expect(await repo.get(auth.user.id, id)).toMatchObject({ count: 0, pending: 0, prepared: true });
    expect(() => ArchiveTimelineQuerySchema.parse({ ...query, scope: { kind: 'map', bbox: '0,0,1,1' } })).toThrow();
    expect(() =>
      ArchiveTimelineQuerySchema.parse({ ...query, filters: { ...query.filters, userId: randomUUID() } }),
    ).toThrow();
    await repo.command(auth, id, 'cancel');
    const receipt = await repo.get(auth.user.id, id);
    await expect(repo.confirm(auth, id, receipt.requestKey, true)).rejects.toThrow('cancelled');
  });

  it('rejects expired/revoked sessions and expired preparations; publication rechecks later revocation', async () => {
    await asset();
    const key = randomUUID();
    const id = await prepare(key);
    await sql`UPDATE immich_fork.archive_operation SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE id=${id}::uuid`.execute(
      db,
    );
    await expect(repo.confirm(auth, id, key, true)).rejects.toThrow('expired');
    const nextKey = randomUUID();
    const next = await prepare(nextKey);
    await repo.confirm(auth, next, nextKey, true);
    await db.deleteFrom('session').where('id', '=', auth.session!.id).execute();
    await expect(prepare()).rejects.toThrow('Session');
    await expect(repo.confirm(auth, next, nextKey, true)).rejects.toThrow('Session');
    await repo.processNext(next, true);
    expect(await repo.get(auth.user.id, next)).toMatchObject({ revoked: 1, succeeded: 0 });
  });
  it('rolls back the receipt when membership insertion fails', async () => {
    await asset();
    const key = randomUUID();
    await sql`CREATE FUNCTION immich_fork.reject_preparation_test() RETURNS trigger LANGUAGE plpgsql AS
      'BEGIN RAISE EXCEPTION ''test membership failure''; END'`.execute(db);
    await sql`CREATE TRIGGER reject_preparation_test BEFORE INSERT ON immich_fork.archive_operation_item
      FOR EACH ROW EXECUTE FUNCTION immich_fork.reject_preparation_test()`.execute(db);
    try {
      await expect(prepare(key)).rejects.toThrow('test membership failure');
      const saved = await sql`SELECT 1 FROM immich_fork.archive_operation WHERE "requestKey"=${key}::uuid`.execute(db);
      expect(saved.rows).toHaveLength(0);
    } finally {
      await sql`DROP TRIGGER reject_preparation_test ON immich_fork.archive_operation_item`.execute(db);
      await sql`DROP FUNCTION immich_fork.reject_preparation_test()`.execute(db);
    }
  });

  it('requires renewed elevation for an elevated preparation and current unexpired session before confirm', async () => {
    await asset();
    await db
      .updateTable('session')
      .set({ pinExpiresAt: new Date(Date.now() + 60_000) })
      .where('id', '=', auth.session!.id)
      .execute();
    const key = randomUUID();
    const id = await prepare(key);
    await db
      .updateTable('session')
      .set({ pinExpiresAt: new Date(0) })
      .where('id', '=', auth.session!.id)
      .execute();
    await expect(repo.confirm(auth, id, key, true)).rejects.toThrow('Unlock again');
    await db
      .updateTable('session')
      .set({ expiresAt: new Date(0) })
      .where('id', '=', auth.session!.id)
      .execute();
    await expect(repo.confirm(auth, id, key, true)).rejects.toThrow('Session has expired');
    expect(await repo.processNext(id, true)).toBe(false);
  });

  it('rolls back the new migration without making prepared work runnable or altering public media', async () => {
    const selected = await asset();
    const key = randomUUID();
    const confirmed = await prepare(key);
    await repo.confirm(auth, confirmed, key, true);
    const abandoned = await prepare();
    const before = await getCatalogEvidence(db);
    await migration.down(db);
    const after = await getCatalogEvidence(db);
    for (const kind of ['tables', 'columns', 'constraints', 'indexes', 'functions', 'triggers'] as const) {
      expect(after[kind].filter(({ identity }) => identity.startsWith('public.'))).toEqual(
        before[kind].filter(({ identity }) => identity.startsWith('public.')),
      );
    }
    const remaining = await sql<{
      id: string;
      assetIds: string[];
    }>`SELECT id,"assetIds" FROM immich_fork.archive_operation WHERE id IN (${confirmed}::uuid,${abandoned}::uuid)`.execute(
      db,
    );
    expect(remaining.rows).toEqual([{ id: confirmed, assetIds: [selected] }]);
    const original = await db
      .selectFrom('asset')
      .select('visibility')
      .where('id', '=', selected)
      .executeTakeFirstOrThrow();
    expect(original.visibility).toBe(AssetVisibility.Timeline);
    await migration.up(db);
  });
});
