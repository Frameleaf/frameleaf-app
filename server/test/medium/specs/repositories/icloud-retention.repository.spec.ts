import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import * as migration from 'src/fork-schema/migrations/0000000000090-ICloudSync.js';
import { ICloudConnection, ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

describe('iCloud retained edit and staging admission (PostgreSQL)', () => {
  let db: Kysely<DB>;
  let repository: ICloudSyncRepository;
  let connection: ICloudConnection;
  beforeAll(async () => {
    db = await getKyselyDB();
    // getKyselyDB clones CI's migrated template; this suite uses its own focused schema.
    await sql`DROP SCHEMA IF EXISTS immich_fork CASCADE`.execute(db);
    await sql`DROP SCHEMA public CASCADE`.execute(db);
    await sql`CREATE SCHEMA public`.execute(db);
    await sql`CREATE SCHEMA immich_fork`.execute(db);
    await sql`CREATE TABLE immich_fork.state(id integer PRIMARY KEY,phase text)`.execute(db);
    await sql`INSERT INTO immich_fork.state VALUES(1,'active')`.execute(db);
    await sql`CREATE TABLE immich_fork.migration_audit(name text,status text)`.execute(db);
    await sql`CREATE TABLE asset(id uuid PRIMARY KEY,"ownerId" uuid,"deletedAt" timestamptz)`.execute(db);
    await migration.up(db);
    repository = new ICloudSyncRepository(db);
  });
  afterAll(async () => {
    await db?.destroy();
  });
  beforeEach(async () => {
    vi.unstubAllEnvs();
    await sql`TRUNCATE immich_fork.icloud_connection CASCADE`.execute(db);
    connection = (await repository.create(randomUUID(), 'Photos', ICloudConfigSchema.parse({ concurrency: 4 })))!;
    await repository.update(connection.id, connection.ownerId, { state: 'connected' });
  });
  afterEach(() => vi.unstubAllEnvs());
  async function resource(
    fingerprint: string,
    options: {
      role?: string;
      status?: string;
      mapped?: boolean;
      current?: boolean;
      reserved?: number;
      staged?: boolean;
      logical?: string;
    } = {},
  ) {
    const id = randomUUID(),
      assetId = options.mapped ? randomUUID() : null;
    if (assetId) {
      await sql`INSERT INTO asset(id,"ownerId") VALUES(${assetId}::uuid,${connection.ownerId}::uuid)`.execute(db);
    }
    await sql`INSERT INTO immich_fork.icloud_resource(id,"connectionId","ownerId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,fingerprint,source,"expectedSize",status,"assetId","reservedBytes","stagingPath")
      VALUES(${id}::uuid,${connection.id}::uuid,${connection.ownerId}::uuid,'private','{}',${options.logical ?? 'logical'},'record',${options.role ?? 'edited-image'},${options.role ?? 'edited-image'},${fingerprint},${{ current: options.current ?? true }}::jsonb,10,${options.status ?? 'pending'},${assetId}::uuid,${options.reserved ?? 0},${options.staged ? `/private/staging/${id}` : null})`.execute(
      db,
    );
    return { id, assetId };
  }
  async function history(count: number) {
    for (let index = 0; index < count; index++) {
      await resource(`old-${index}`, { mapped: true, current: false, status: 'finalized' });
    }
  }

  it('blocks the twenty-first new edit but still leases original and motion recovery, preserving all old assets', async () => {
    await history(20);
    const newest = await resource('new');
    const original = await resource('original', { role: 'original' });
    expect(await repository.claim(connection.id, 1000)).toMatchObject({ id: original.id });
    expect(await repository.resource(newest.id)).toMatchObject({
      status: 'needs-review',
      lastError: 'retained_edit_limit',
      source: { current: true },
      reservedBytes: 0,
    });
    const motion = await resource('motion', { role: 'motion' });
    expect(await repository.claim(connection.id, 1000)).toMatchObject({ id: motion.id });
    const { rows } = await sql<{
      count: number;
    }>`SELECT count(*)::int count FROM asset WHERE "ownerId"=${connection.ownerId}::uuid`.execute(db);
    expect(rows[0].count).toBe(20);
  });

  it('permits known fingerprints at the ceiling, deduplicates fingerprints, and scopes distinct logical photos', async () => {
    await history(20);
    const known = await resource('old-0', { role: 'edited-video' });
    expect(await repository.claim(connection.id, 1000)).toMatchObject({ id: known.id });
    const separate = await resource('new', { logical: 'other-logical' });
    expect(await repository.claim(connection.id, 1000)).toMatchObject({ id: separate.id });
  });

  it('counts precommit staged versions and reservations without asset mappings across concurrent claims', async () => {
    await history(18);
    await resource('staged', { current: false, status: 'validated', staged: true });
    const first = await resource('first');
    const second = await resource('second');
    const claims = await Promise.all([repository.claim(connection.id, 1000), repository.claim(connection.id, 1000)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({ id: first.id });
    expect(await repository.resource(second.id)).toMatchObject({
      status: 'needs-review',
      lastError: 'retained_edit_limit',
    });
    expect(await repository.resource(first.id)).toMatchObject({ reservedBytes: 10 });
  });

  it('releases historical capacity only after mapped assets are actually gone; tombstones do not consume it', async () => {
    await history(20);
    const newest = await resource('new');
    expect(await repository.claim(connection.id, 1000)).toBeUndefined();
    await sql`UPDATE asset SET "deletedAt"=now() WHERE "ownerId"=${connection.ownerId}::uuid`.execute(db);
    await repository.retryFailures(connection.id);
    expect(await repository.claim(connection.id, 1000)).toBeUndefined();
    await sql`DELETE FROM asset WHERE id=(SELECT "assetId" FROM immich_fork.icloud_resource WHERE "connectionId"=${connection.id}::uuid AND fingerprint='old-0')`.execute(
      db,
    );
    await resource('tombstone', { current: false, status: 'removed' });
    await repository.retryFailures(connection.id);
    expect(await repository.claim(connection.id, 1000)).toMatchObject({ id: newest.id });
  });

  it('keeps retained noncurrent staging accounted and surfaces actionable capacity failure', async () => {
    const old = await resource('old-stage', { current: false, status: 'validated', staged: true, reserved: 90 });
    await resource('original', { role: 'original' });
    expect(await repository.claim(connection.id, 95)).toBeUndefined();
    expect(await repository.get(connection.id)).toMatchObject({
      state: 'error',
      lastError: 'staging_retained_capacity',
      nextRunAt: null,
    });
    expect(await repository.resource(old.id)).toMatchObject({
      reservedBytes: 90,
      stagingPath: `/private/staging/${old.id}`,
    });
  });

  it('reuses an existing reservation above a reduced global budget and leases committed cleanup without byte admission', async () => {
    vi.stubEnv('IMMICH_ICLOUD_MAX_STAGING_BYTES', '1');
    const staged = await resource('staged', { status: 'validated', reserved: 10, staged: true });
    expect(await repository.claim(connection.id, 1)).toMatchObject({ id: staged.id });
    const committed = await resource('committed', { status: 'committed', current: false, reserved: 100, staged: true });
    expect(await repository.claim(connection.id, 1)).toMatchObject({ id: committed.id });
    expect(await repository.get(connection.id)).toMatchObject({ state: 'connected' });
  });
  it('reports global retained capacity without discarding another connection recovery reservation', async () => {
    const oldConnection = connection;
    const retained = await resource('retained', {
      role: 'original',
      status: 'validated',
      current: false,
      reserved: 90,
      staged: true,
    });
    connection = (await repository.create(randomUUID(), 'Other photos', ICloudConfigSchema.parse({})))!;
    await repository.update(connection.id, connection.ownerId, { state: 'connected' });
    await resource('new', { role: 'original' });
    vi.stubEnv('IMMICH_ICLOUD_MAX_STAGING_BYTES', '95');
    expect(await repository.claim(connection.id, 1000)).toBeUndefined();
    expect(await repository.get(connection.id)).toMatchObject({
      state: 'error',
      lastError: 'staging_retained_capacity',
    });
    expect(await repository.get(oldConnection.id)).toMatchObject({ state: 'connected' });
    expect(await repository.resource(retained.id)).toMatchObject({ reservedBytes: 90 });
  });
});
