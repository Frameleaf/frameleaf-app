import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import * as migration from 'src/fork-schema/migrations/0000000000090-ICloudSync.js';
import { ICloudConnection, ICloudLibrary, ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

const field = (value: unknown) => ({ value });

describe(ICloudSyncRepository.name, () => {
  let db: Kysely<DB>;
  let repository: ICloudSyncRepository;
  let connection: ICloudConnection;
  const library: ICloudLibrary = { area: 'private', zoneID: { zoneName: 'PrimarySync' } };
  const master = {
    recordName: 'master',
    recordType: 'CPLMaster',
    fields: {
      filenameEnc: { value: 'moved-and-renamed.JPG', type: 'STRING' },
      itemType: field('public.jpeg'),
      resOriginalRes: field({
        size: 100,
        fileChecksum: 'opaque-not-content-hash',
        downloadURL: 'https://secret.invalid/?token=secret',
      }),
    },
  };
  const asset = { recordName: 'asset', recordType: 'CPLAsset', fields: { masterRef: field({ recordName: 'master' }) } };

  beforeAll(async () => {
    db = await getKyselyDB();
    // getKyselyDB clones CI's migrated template; this suite uses its own focused schema.
    await sql`DROP SCHEMA IF EXISTS immich_fork CASCADE`.execute(db);
    await sql`DROP SCHEMA public CASCADE`.execute(db);
    await sql`CREATE SCHEMA public`.execute(db);
    await sql`CREATE SCHEMA immich_fork`.execute(db);
    await sql`CREATE TABLE immich_fork.state (id integer PRIMARY KEY,phase text)`.execute(db);
    await sql`INSERT INTO immich_fork.state VALUES (1,'active')`.execute(db);
    await sql`CREATE TABLE immich_fork.migration_audit (name text,status text)`.execute(db);
    // the library side `counts` reads to tell a disappeared source from a deleted asset
    await sql`CREATE TABLE asset (id uuid PRIMARY KEY,"ownerId" uuid,"deletedAt" timestamptz)`.execute(db);
    await migration.up(db);
    repository = new ICloudSyncRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    await sql`TRUNCATE immich_fork.icloud_connection CASCADE`.execute(db);
    connection = (await repository.create(randomUUID(), 'Photos', ICloudConfigSchema.parse({})))!;
    await repository.update(connection.id, connection.ownerId, { state: 'connected' });
    connection.state = 'connected';
  });

  it('stores opaque materialization names as strings across keyset resume and empty pages', async () => {
    const records = Array.from({ length: 101 }, (_, index) => ({
      ...asset,
      recordName: `ABC-${String(index).padStart(3, '0')}`,
    }));
    await repository.savePage(connection.id, 'assets:library', 'library', [master, ...records], null, true);
    expect(await repository.materialize(connection, 'library', library)).toBe(false);
    expect(await repository.checkpoint(connection.id, 'materialize:library')).toMatchObject({
      cursor: 'ABC-099',
      complete: false,
    });
    expect(await repository.materialize(connection, 'library', library)).toBe(true);
    expect(await repository.checkpoint(connection.id, 'materialize:library')).toMatchObject({
      cursor: 'ABC-100',
      complete: true,
    });
    expect(await repository.materialize(connection, 'library', library)).toBe(true);
    const count = await sql<{ count: number }>`SELECT count(*)::int AS count FROM immich_fork.icloud_resource`.execute(
      db,
    );
    expect(count.rows[0].count).toBe(101);
    expect(await repository.materialize(connection, 'empty', library)).toBe(true);
    expect(await repository.checkpoint(connection.id, 'materialize:empty')).toMatchObject({
      cursor: '',
      complete: true,
    });
  });
  it.each(
    ['IMMICH_ICLOUD_MAX_CONCURRENCY', 'IMMICH_ICLOUD_MAX_STAGING_BYTES'].flatMap((name) =>
      ['garbage', 'NaN', 'Infinity', '-1', '0', '1.5', '9007199254740992', ''].map((value) => ({ name, value })),
    ),
  )('refuses new admission with invalid $name=$value', async ({ name, value }) => {
    await repository.savePage(connection.id, 'assets:library', 'library', [asset, master], null, true);
    await repository.materialize(connection, 'library', library);
    vi.stubEnv(name, value);
    expect(await repository.claim(connection.id, 1000)).toBeUndefined();
    const rows = await sql<{
      status: string;
      reservedBytes: number;
      leaseToken: string | null;
    }>`SELECT status,"reservedBytes"::float8 AS "reservedBytes","leaseToken" FROM immich_fork.icloud_resource`.execute(
      db,
    );
    expect(rows.rows[0]).toMatchObject({ status: 'pending', reservedBytes: 0, leaseToken: null });
  });
  it('allows committed cleanup even when administrator limit settings are malformed', async () => {
    await repository.savePage(connection.id, 'assets:library', 'library', [asset, master], null, true);
    await repository.materialize(connection, 'library', library);
    await sql`UPDATE immich_fork.icloud_resource SET status='committed'`.execute(db);
    vi.stubEnv('IMMICH_ICLOUD_MAX_CONCURRENCY', 'NaN');
    vi.stubEnv('IMMICH_ICLOUD_MAX_STAGING_BYTES', 'NaN');
    expect(await repository.claim(connection.id, 1000)).toMatchObject({ status: 'committed' });
  });
  it('roundtrips typed JSON, keeps split-page master joins and opaque checkpoints, and materializes idempotently', async () => {
    expect(connection.config.concurrency).toBe(1);
    await repository.savePage(connection.id, 'assets:library', 'library', [asset], 'cursor-page-2', false);
    expect(await repository.checkpoint(connection.id, 'assets:library')).toMatchObject({
      cursor: 'cursor-page-2',
      complete: false,
    });
    await repository.savePage(connection.id, 'assets:library', 'library', [master], null, true);
    expect(await repository.materialize(connection, 'library', library)).toBe(true);
    expect(await repository.materialize(connection, 'library', library)).toBe(true);
    const { rows } = await sql<{
      source: Record<string, unknown>;
      library: ICloudLibrary;
    }>`SELECT source,library FROM immich_fork.icloud_resource`.execute(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toMatchObject({ originalFileName: 'moved-and-renamed.JPG', current: true });
    expect(rows[0].library).toEqual(library);
    expect(JSON.stringify(rows)).not.toContain('secret');
    expect(await repository.get(connection.id, randomUUID())).toBeUndefined();
  });

  it('commits page, scalar cursor and rotated session in one transaction and rolls back together', async () => {
    await repository.withSession(connection.id, connection.ownerId, async (_connection, transaction) => {
      await repository.savePage(
        connection.id,
        'assets:library',
        'library',
        [asset, master],
        'CPLAsset-next-page',
        false,
        transaction,
      );
      expect(await repository.checkpoint(connection.id, 'assets:library', transaction)).toMatchObject({
        cursor: 'CPLAsset-next-page',
      });
      await repository.materialize(connection, 'library', library, transaction);
      return { value: undefined, encryptedSession: 'rotated-ciphertext' };
    });
    expect(await repository.get(connection.id)).toMatchObject({ encryptedSession: 'rotated-ciphertext' });
    await expect(
      repository.withSession(connection.id, connection.ownerId, async (_connection, transaction) => {
        await repository.savePage(connection.id, 'failed-page', 'library', [], 'must-rollback', true, transaction);
        throw new Error('transport_failed');
      }),
    ).rejects.toThrow('transport_failed');
    expect(await repository.checkpoint(connection.id, 'failed-page')).toBeUndefined();
    expect(await repository.materialize(connection, 'empty', library)).toBe(true);
    expect(await repository.checkpoint(connection.id, 'materialize:empty')).toMatchObject({
      cursor: '',
      complete: true,
    });
  });

  it('selection changes revoke pending leases and cleanup cannot run for a stale lease', async () => {
    await repository.savePage(connection.id, 'assets:library', 'library', [asset, master], null, true);
    await repository.materialize(connection, 'library', library);
    const resource = (await repository.claim(connection.id, 1000))!;
    await repository.update(connection.id, connection.ownerId, {
      config: ICloudConfigSchema.parse({ libraries: ['another-library'] }),
    });
    expect(await repository.progress(resource, { status: 'validated' })).toBe(false);
    expect(await repository.claim(connection.id, 1000)).toBeUndefined();
    const cleanup = vi.fn();
    expect(await repository.finalize(resource, cleanup)).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('leases once across concurrent workers, preserves committed work and keeps trashed/removed tombstones', async () => {
    await repository.savePage(connection.id, 'assets:library', 'library', [asset, master], null, true);
    await repository.materialize(connection, 'library', library);
    const leases = await Promise.all([repository.claim(connection.id, 1000), repository.claim(connection.id, 1000)]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    const resource = leases.find(Boolean)!;
    await repository.progress(resource, { status: 'committed', verification: { outcome: 'repaired-missing' } });
    await repository.disconnect(connection.id, connection.ownerId);
    expect(await repository.claim(connection.id, 1000)).toBeUndefined();
    expect(await repository.resource(resource.id)).toMatchObject({
      status: 'committed',
      leaseToken: resource.leaseToken,
    });
    await repository.finish(resource, 'removed');
    await repository.resetInventory(connection.id);
    expect(await repository.resource(resource.id)).toMatchObject({ status: 'removed' });
  });

  it('does not apply membership absence on a partial snapshot and preserves local album provenance on source changes', async () => {
    const first = randomUUID(),
      second = randomUUID();
    await repository.saveMembershipPage(connection.id, 'library', 'album', [asset], first, true);
    await repository.saveMembershipPage(connection.id, 'library', 'album', [], second, false);
    const present = () =>
      sql<{ sourcePresent: boolean }>`SELECT "sourcePresent" FROM immich_fork.icloud_membership`
        .execute(db)
        .then(({ rows }) => rows[0].sourcePresent);
    expect(await present()).toBe(true);
    await repository.saveMembershipPage(connection.id, 'library', 'album', [], second, true);
    expect(await present()).toBe(false);
    const sourceAlbum = {
      recordName: 'album',
      recordType: 'CPLAlbum',
      fields: { albumNameEnc: { value: 'Original name', type: 'STRING' } },
    };
    await repository.saveAlbums(connection.id, 'library', [sourceAlbum]);
    await sql`UPDATE immich_fork.icloud_album SET source=source || '{"_sync":{"name":"manual baseline"}}'::jsonb`.execute(
      db,
    );
    await repository.saveAlbums(connection.id, 'library', [
      { ...sourceAlbum, fields: { albumNameEnc: { value: 'Apple rename', type: 'STRING' } } },
    ]);
    const { rows } = await sql<{
      source: Record<string, unknown>;
    }>`SELECT source FROM immich_fork.icloud_album`.execute(db);
    expect(rows[0].source._sync).toEqual({ name: 'manual baseline' });
  });

  it('keyset-materializes a bounded batch from a 500,000-asset source inventory', async () => {
    await repository.savePage(connection.id, 'assets:library', 'library', [master], null, true);
    await sql`INSERT INTO immich_fork.icloud_record ("connectionId","libraryKey","recordId","recordType","masterId",fields)
      SELECT ${connection.id}::uuid,'library',lpad(n::text,6,'0'),'CPLAsset','master',
      '{"masterRef":{"value":{"recordName":"master"}}}'::jsonb FROM generate_series(1,500000) n`.execute(db);
    expect(await repository.materialize(connection, 'library', library)).toBe(false);
    expect(await repository.counts(connection.id)).toMatchObject({ logicalAssets: 100, resources: 100 });
    expect(await repository.checkpoint(connection.id, 'materialize:library')).toMatchObject({
      cursor: '000100',
      complete: false,
    });
    expect(await repository.materialize(connection, 'library', library)).toBe(false);
    expect(await repository.counts(connection.id)).toMatchObject({ logicalAssets: 200, resources: 200 });
  }, 60_000);
  it('refreshes only the affected library without consuming cursor recovery attempts', async () => {
    await repository.startRun(connection);
    await repository.savePage(connection.id, 'assets:library', 'library', [asset, master], null, true);
    await repository.materialize(connection, 'library', library);
    const resource = (await repository.claim(connection.id, 1000))!;
    await repository.savePage(connection.id, 'changes:other', 'other', [], { token: 'keep' }, true);
    await repository.savePage(connection.id, 'albums:library', 'library', [], null, true);
    await repository.refreshResource(resource);
    expect(await repository.checkpoint(connection.id, 'assets:library')).toBeUndefined();
    expect(await repository.checkpoint(connection.id, 'materialize:library')).toBeUndefined();
    expect(await repository.checkpoint(connection.id, 'changes:other')).toMatchObject({ cursor: { token: 'keep' } });
    expect(await repository.checkpoint(connection.id, 'albums:library')).toBeDefined();
    expect(await repository.get(connection.id)).toMatchObject({ state: 'connected', lastError: 'resource_changed' });
    const { rows } = await sql<{ counts: Record<string, number> }>`SELECT counts FROM immich_fork.icloud_run`.execute(
      db,
    );
    expect(rows[0].counts.cursorResets).toBeUndefined();
  });
  it.each(['retry', 'rescan'])(
    'explicit %s resets both budgets and relation review while preserving committed outbox',
    async (action) => {
      await repository.startRun(connection);
      await repository.savePage(connection.id, 'assets:library', 'library', [asset, master], null, true);
      await repository.materialize(connection, 'library', library);
      const resource = (await repository.claim(connection.id, 1000))!;
      const jobs = [{ name: 'asset-generate-thumbnails', data: { id: randomUUID() } }];
      await sql`UPDATE immich_fork.icloud_run SET counts='{"cursorResets":3,"transportAttempts":8}'::jsonb`.execute(db);
      await sql`UPDATE immich_fork.icloud_resource SET status='committed',attempts=7,"pendingJobs"=${jobs}::jsonb,
      source=source || '{"_sync":{"relations":{"status":"needs-review","signature":"old"}}}'::jsonb`.execute(db);
      await repository.finish(resource, 'committed', 'icloud_transfer_failed');
      expect(await repository.get(connection.id)).toMatchObject({
        state: 'error',
        lastError: 'icloud_finalization_failed',
      });
      expect(await repository.resource(resource.id)).toMatchObject({
        status: 'committed',
        attempts: 8,
        pendingJobs: jobs,
      });
      if (action === 'retry') {
        await repository.retryFailures(connection.id);
      } else {
        await repository.resetInventory(connection.id);
      }
      const saved = (await repository.resource(resource.id))!;
      expect(saved).toMatchObject({ status: 'committed', attempts: 0, pendingJobs: jobs });
      expect(saved.source).toHaveProperty('_sync.relations.status', 'needs-review');
      expect(saved.source).not.toHaveProperty('_sync.relations.signature');
      const { rows } = await sql<{ counts: Record<string, number> }>`SELECT counts FROM immich_fork.icloud_run`.execute(
        db,
      );
      expect(rows[0].counts).toEqual({});
    },
  );
});
