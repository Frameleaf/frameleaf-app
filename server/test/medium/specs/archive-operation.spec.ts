import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetVisibility } from 'src/enum.js';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import * as migration from 'src/fork-schema/migrations/0000000000110-ArchiveOperations.js';
import { ArchiveOperationRepository } from 'src/repositories/archive-operation.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetService } from 'src/services/asset.service.js';
import { MediumTestContext } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

describe('durable selected-asset archive', () => {
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
    const { result: user } = await context.newUser();
    const session = await db
      .insertInto('session')
      .values({ userId: user.id, token: Buffer.from(randomUUID()) })
      .returningAll()
      .executeTakeFirstOrThrow();
    auth = { user, session: { id: session.id, hasElevatedPermission: false } };
    await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  const asset = async (overrides = {}) => {
    const { result } = await context.newAsset({ ownerId: auth.user.id, ...overrides });
    return result.id;
  };
  const submit = (ids: string[], requestKey = randomUUID()) =>
    repo.create(auth, { ids, requestKey, scope: 'selected-owned-assets' });
  const visibility = async (id: string) => {
    const row = await db.selectFrom('asset').select('visibility').where('id', '=', id).executeTakeFirstOrThrow();
    return row.visibility;
  };

  it('freezes and deduplicates IDs, binds request identity and serializes duplicate deliveries', async () => {
    const id = await asset();
    const key = randomUUID();
    const operation = await submit([id, id], key);
    expect(await submit([id], key)).toBe(operation);
    await expect(submit([await asset()], key)).rejects.toThrow('different selection');
    await Promise.all([repo.processNext(operation, false), repo.processNext(operation, false)]);
    expect(await repo.get(auth.user.id, operation)).toMatchObject({ count: 1, succeeded: 1, pending: 0 });
    expect(await visibility(id)).toBe(AssetVisibility.Archive);
  });

  it('keeps partial cancellation durable across repository reload and retries only unfinished items', async () => {
    const ids = [await asset(), await asset()];
    const operation = await submit(ids);
    await repo.processNext(operation, false);
    await repo.command(auth, operation, 'cancel');
    expect(await repo.processNext(operation, false)).toBe(false);
    const reloaded = new ArchiveOperationRepository(db);
    expect(await reloaded.get(auth.user.id, operation)).toMatchObject({ succeeded: 1, pending: 1, cancelled: true });
    await reloaded.command(auth, operation, 'retry');
    while (await reloaded.processNext(operation, false)) {
      /* drain this recorded selection */
    }
    expect(await reloaded.get(auth.user.id, operation)).toMatchObject({ succeeded: 2, pending: 0 });
  });

  it('undo after partial cancellation skips never-published items and drains', async () => {
    const selected = [await asset(), await asset()];
    const operation = await submit(selected);
    await repo.processNext(operation, false);
    await repo.command(auth, operation, 'cancel');
    expect(await repo.get(auth.user.id, operation)).toMatchObject({ succeeded: 1, pending: 1 });
    await repo.command(auth, operation, 'undo');
    while (await repo.processNext(operation, false)) {
      /* restore only the published item */
    }
    expect(await repo.get(auth.user.id, operation)).toMatchObject({
      undone: 1,
      skipped: 1,
      conflict: 0,
      pending: 0,
      succeeded: 0,
    });
    expect(await repo.pending()).not.toContain(operation);
    expect(await Promise.all(selected.map((id) => visibility(id)))).toEqual([
      AssetVisibility.Timeline,
      AssetVisibility.Timeline,
    ]);
  });

  it('rechecks mixed ownership, sensitive content and revoked sessions', async () => {
    const { result: other } = await context.newUser();
    const foreign = await asset({ ownerId: other.id });
    const sensitive = await asset();
    await sql`UPDATE asset SET is_nsfw=true WHERE id=${sensitive}::uuid`.execute(db);
    const operation = await submit([foreign, sensitive]);
    while (await repo.processNext(operation, true)) {
      /* drain */
    }
    expect(await repo.get(auth.user.id, operation)).toMatchObject({ revoked: 2, succeeded: 0 });
    expect(await visibility(foreign)).toBe(AssetVisibility.Timeline);
    const session = await db
      .insertInto('session')
      .values({ userId: auth.user.id, token: Buffer.from(randomUUID()) })
      .returningAll()
      .executeTakeFirstOrThrow();
    const revokedAuth = { ...auth, session: { id: session.id, hasElevatedPermission: false } };
    const selected = await asset();
    const revoked = await repo.create(revokedAuth, {
      ids: [selected],
      requestKey: randomUUID(),
      scope: 'selected-owned-assets',
    });
    await db.deleteFrom('session').where('id', '=', session.id).execute();
    await repo.processNext(revoked, false);
    expect(await repo.get(auth.user.id, revoked)).toMatchObject({ revoked: 1 });
    expect(await visibility(selected)).toBe(AssetVisibility.Timeline);
    await expect(repo.get(other.id, revoked)).rejects.toThrow();
  });

  it('undo restores only its own unchanged publication and cannot erase intervening edits', async () => {
    const unchanged = await asset();
    const edited = await asset();
    const operation = await submit([unchanged, edited]);
    while (await repo.processNext(operation, false)) {
      /* drain */
    }
    await db.updateTable('asset').set({ isFavorite: true }).where('id', '=', edited).execute();
    await repo.command(auth, operation, 'undo');
    while (await repo.processNext(operation, false)) {
      /* drain */
    }
    expect(await repo.get(auth.user.id, operation)).toMatchObject({ undone: 1, conflict: 1 });
    expect(await visibility(unchanged)).toBe(AssetVisibility.Timeline);
    expect(await visibility(edited)).toBe(AssetVisibility.Archive);
  });
  it('observes revocation committed while publication is waiting for the session row', async () => {
    const session = await db
      .insertInto('session')
      .values({ userId: auth.user.id, token: Buffer.from(randomUUID()) })
      .returningAll()
      .executeTakeFirstOrThrow();
    const selected = await asset();
    const operation = await repo.create(
      { ...auth, session: { id: session.id, hasElevatedPermission: false } },
      { ids: [selected], requestKey: randomUUID(), scope: 'selected-owned-assets' },
    );
    const { promise: lockReady, resolve: locked } = Promise.withResolvers<void>();
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const revocation = db.transaction().execute(async (tx) => {
      await tx
        .updateTable('session')
        .set({ expiresAt: new Date(0) })
        .where('id', '=', session.id)
        .execute();
      locked();
      await held;
    });
    await lockReady;
    const publishing = repo.processNext(operation, false);
    try {
      await vi.waitFor(async () => {
        const waiting = await sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%session%'`.execute(
          db,
        );
        expect(waiting.rows[0].count).toBeGreaterThan(0);
      });
    } finally {
      release();
    }
    await revocation;
    await publishing;
    expect(await repo.get(auth.user.id, operation)).toMatchObject({ revoked: 1, succeeded: 0 });
    expect(await visibility(selected)).toBe(AssetVisibility.Timeline);
  });

  it('rolls back publication on item-write failure and retries the durable error without double application', async () => {
    const selected = await asset();
    const operation = await submit([selected]);
    await sql`CREATE FUNCTION public.fail_archive_receipt() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$`.execute(db);
    await sql`CREATE TRIGGER fail_archive_receipt BEFORE UPDATE ON immich_fork.archive_operation_item
      FOR EACH ROW WHEN (NEW.status='succeeded') EXECUTE FUNCTION public.fail_archive_receipt()`.execute(db);
    try {
      await repo.processNext(operation, false);
    } finally {
      await sql`DROP TRIGGER fail_archive_receipt ON immich_fork.archive_operation_item`.execute(db);
      await sql`DROP FUNCTION public.fail_archive_receipt()`.execute(db);
    }
    expect(await visibility(selected)).toBe(AssetVisibility.Timeline);
    expect(await repo.get(auth.user.id, operation)).toMatchObject({ error: 1, succeeded: 0 });
    await repo.command(auth, operation, 'retry');
    await repo.processNext(operation, false);
    expect(await repo.get(auth.user.id, operation)).toMatchObject({ error: 0, succeeded: 1 });
  });
  it('rolls the new schema down and up without changing any public schema object or original asset', async () => {
    const original = await asset();
    const before = await getCatalogEvidence(db);
    await migration.down(db);
    const after = await getCatalogEvidence(db);
    for (const kind of ['tables', 'columns', 'constraints', 'indexes', 'functions', 'triggers'] as const) {
      expect(after[kind].filter(({ identity }) => identity.startsWith('public.'))).toEqual(
        before[kind].filter(({ identity }) => identity.startsWith('public.')),
      );
    }
    expect(after.tables.some(({ identity }) => identity.startsWith('immich_fork.archive_operation'))).toBe(false);
    expect(await visibility(original)).toBe(AssetVisibility.Timeline);
    await migration.up(db);
    expect(await submit([original])).toBeTruthy();
  });
});
