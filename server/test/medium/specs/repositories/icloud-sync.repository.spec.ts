import { CompiledQuery, Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { ICloudConnection, ICloudLibrary, ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { canonicalDatabaseUrl, seedCanonicalUser } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

const field = (value: unknown) => ({ value });
type PlanNode = { 'Node Type': string; 'Actual Rows': number; Plans?: PlanNode[] };
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap((child) => nodes(child))];

describe(ICloudSyncRepository.name, () => {
  let db: Kysely<DB>;
  let repository: ICloudSyncRepository;
  let connection: ICloudConnection;
  const captured: CompiledQuery[] = [];
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
    const { rows } = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
    await db.destroy();
    db = new Kysely<DB>({
      ...getKyselyConfig({
        connectionType: 'url',
        url: canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, rows[0].name),
      }),
      log: (event) => {
        if (event.level === 'query') {
          captured.push(event.query);
        }
      },
    });

    // the library side `counts` reads to tell a disappeared source from a deleted asset

    // FL-296: finalize records the source identity

    repository = new ICloudSyncRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    await sql`TRUNCATE public.icloud_connection CASCADE`.execute(db);
    connection = (await repository.create((await seedCanonicalUser(db)).id, 'Photos', ICloudConfigSchema.parse({})))!;
    await repository.update(connection.id, connection.ownerId, { state: 'connected' });
    connection.state = 'connected';
  });

  const legacyConflict = async () => {
    await repository.update(connection.id, connection.ownerId, { encryptedSession: 'fixture-only' });
    await repository.savePage(connection.id, 'assets:library', 'library', [asset, master], null, true);
    await repository.materialize(connection, 'library', library);
    const {
      rows: [resource],
    } = await sql<{ id: string }>`SELECT id FROM public.icloud_resource
      WHERE "connectionId"=${connection.id}::uuid LIMIT 1`.execute(db);
    const target = {
      assetId: randomUUID(),
      updateId: null,
      originalPath: null,
      checksumHex: null,
      checksumAlgorithm: null,
      isExternal: false,
      libraryId: null,
      physicalOriginalFileId: null,
      outcome: 'imported',
    };
    await sql`UPDATE public.icloud_resource SET status='needs-review',"lastError"='reserved_import_content_match',
      "stagingPath"='/fixture/stage',"promotedPath"='/fixture/promoted',"expectedTarget"=${target}::jsonb,
      sha1=${Buffer.alloc(20, 1)},sha256=${Buffer.alloc(32, 2)},verification='{"retainedReceipt":"fixture"}'::jsonb
      WHERE id=${resource.id}::uuid`.execute(db);
    await sql`INSERT INTO public.media_operation ("ownerId",kind,destination,label,status,"finishedAt",snapshot,settings)
      VALUES (${connection.ownerId}::uuid,${MediaOperationKind.ICloudSync},${MediaOperationDestination.Local},'Photos',
      ${MediaOperationStatus.Completed},now(),${{ connectionId: connection.id, trigger: 'schedule' }}::jsonb,'{}')`.execute(
      db,
    );
    return (await repository.resource(resource.id))!;
  };

  it('admits a legacy reserved hash conflict once through the existing durable schedule without erasing bindings', async () => {
    const before = await legacyConflict();
    expect(await repository.dueConnections()).toContainEqual({ id: connection.id, ownerId: connection.ownerId });
    const results = await Promise.all([
      repository.queueOperation(connection.id, connection.ownerId, { trigger: 'schedule' }),
      repository.queueOperation(connection.id, connection.ownerId, { trigger: 'schedule' }),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['created', 'existing']);
    expect(await repository.resource(before.id)).toMatchObject({
      status: 'pending',
      expectedTarget: before.expectedTarget,
      promotedPath: before.promotedPath,
      stagingPath: before.stagingPath,
      sha1: before.sha1,
      sha256: before.sha256,
      verification: before.verification,
      source: before.source,
      attempts: before.attempts,
    });
    expect(await repository.dueConnections()).not.toContainEqual({ id: connection.id, ownerId: connection.ownerId });
  });

  it.each(['superseded', 'backoff', 'paused-audit'])(
    'keeps legacy conflict admission deferred for %s',
    async (condition) => {
      const before = await legacyConflict();
      if (condition === 'superseded') {
        await sql`UPDATE public.icloud_resource SET source=${{ ...before.source, current: false }}::jsonb
          WHERE id=${before.id}::uuid`.execute(db);
      } else if (condition === 'backoff') {
        await repository.update(connection.id, connection.ownerId, { nextRunAt: new Date(Date.now() + 60_000) });
      } else {
        await sql`INSERT INTO public.media_operation ("ownerId",kind,destination,label,status,snapshot,settings)
          VALUES (${connection.ownerId}::uuid,${MediaOperationKind.ICloudSync},${MediaOperationDestination.Local},'Verify originals',
          ${MediaOperationStatus.Paused},${{ connectionId: connection.id, task: 'identity-audit-weekly' }}::jsonb,'{}')`.execute(
          db,
        );
      }
      expect(await repository.dueConnections()).not.toContainEqual({ id: connection.id, ownerId: connection.ownerId });
      expect(
        (await repository.queueOperation(connection.id, connection.ownerId, { trigger: 'schedule' })).outcome,
      ).toBe(condition === 'paused-audit' ? 'existing' : 'not-due');
      expect(await repository.resource(before.id)).toMatchObject({
        status: 'needs-review',
        expectedTarget: before.expectedTarget,
        promotedPath: before.promotedPath,
        stagingPath: before.stagingPath,
        verification: before.verification,
      });
    },
  );

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
    const count = await sql<{ count: number }>`SELECT count(*)::int AS count FROM public.icloud_resource`.execute(db);
    expect(count.rows[0].count).toBe(101);
    expect(await repository.materialize(connection, 'empty', library)).toBe(true);
    expect(await repository.checkpoint(connection.id, 'materialize:empty')).toMatchObject({
      cursor: '',
      complete: true,
    });
  });
  it.each(
    ['FRAMELEAF_ICLOUD_MAX_CONCURRENCY', 'FRAMELEAF_ICLOUD_MAX_STAGING_BYTES'].flatMap((name) =>
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
    }>`SELECT status,"reservedBytes"::float8 AS "reservedBytes","leaseToken" FROM public.icloud_resource`.execute(db);
    expect(rows.rows[0]).toMatchObject({ status: 'pending', reservedBytes: 0, leaseToken: null });
  });
  it('allows committed cleanup even when administrator limit settings are malformed', async () => {
    await repository.savePage(connection.id, 'assets:library', 'library', [asset, master], null, true);
    await repository.materialize(connection, 'library', library);
    await sql`UPDATE public.icloud_resource SET status='committed'`.execute(db);
    vi.stubEnv('FRAMELEAF_ICLOUD_MAX_CONCURRENCY', 'NaN');
    vi.stubEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES', 'NaN');
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
    }>`SELECT source,library FROM public.icloud_resource`.execute(db);
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
      sql<{ sourcePresent: boolean }>`SELECT "sourcePresent" FROM public.icloud_membership`
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
    await sql`UPDATE public.icloud_album SET source=source || '{"_sync":{"name":"manual baseline"}}'::jsonb`.execute(
      db,
    );
    await repository.saveAlbums(connection.id, 'library', [
      { ...sourceAlbum, fields: { albumNameEnc: { value: 'Apple rename', type: 'STRING' } } },
    ]);
    const { rows } = await sql<{
      source: Record<string, unknown>;
    }>`SELECT source FROM public.icloud_album`.execute(db);
    expect(rows[0].source._sync).toEqual({ name: 'manual baseline' });
  });

  it('keyset-materializes a bounded batch from a 500,000-asset source inventory', async () => {
    await repository.savePage(connection.id, 'assets:library', 'library', [master], null, true);
    await db.transaction().execute(async (transaction) => {
      await sql`INSERT INTO public.icloud_record ("connectionId","libraryKey","recordId","recordType","masterId",fields)
        SELECT ${connection.id}::uuid,'library',lpad(n::text,6,'0'),'CPLAsset','master',
        '{"masterRef":{"value":{"recordName":"master"}}}'::jsonb FROM generate_series(1,500000) n`.execute(transaction);
      // A batch must stay bounded when the planner chooses a hash/merge join too.
      await sql`SET LOCAL enable_nestloop = off`.execute(transaction);
      captured.length = 0;
      expect(await repository.materialize(connection, 'library', library, transaction)).toBe(false);
      const query = captured.find(({ sql }) => sql.includes('AS "recordName"'))!;
      const explained = await transaction.executeQuery<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
        CompiledQuery.raw(`EXPLAIN (ANALYZE, FORMAT JSON) ${query.sql}`, [...query.parameters]),
      );
      const joins = nodes(explained.rows[0]['QUERY PLAN'][0].Plan).filter((node) => node['Node Type'].endsWith('Join'));
      expect(joins.length).toBeGreaterThan(0);
      for (const join of joins) {
        expect(join['Actual Rows']).toBeLessThanOrEqual(100);
      }
    });
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
    const { rows } = await sql<{ counts: Record<string, number> }>`SELECT counts FROM public.icloud_run`.execute(db);
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
      await sql`UPDATE public.icloud_run SET counts='{"cursorResets":3,"transportAttempts":8}'::jsonb`.execute(db);
      await sql`UPDATE public.icloud_resource SET status='committed',attempts=7,"pendingJobs"=${jobs}::jsonb,
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
      const { rows } = await sql<{ counts: Record<string, number> }>`SELECT counts FROM public.icloud_run`.execute(db);
      expect(rows[0].counts).toEqual({});
    },
  );
});
