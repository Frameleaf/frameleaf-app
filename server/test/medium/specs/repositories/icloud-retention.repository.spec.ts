import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import { ICloudConnection, ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { DB } from 'src/schema/index.js';
import * as claimAccessPaths from 'src/schema/migrations/1791101770001-ICloudClaimAccessPaths.js';
import { seedCanonicalAsset, seedCanonicalUser } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

describe('iCloud retained edit and staging admission (PostgreSQL)', () => {
  let db: Kysely<DB>;
  let repository: ICloudSyncRepository;
  let connection: ICloudConnection;
  beforeAll(async () => {
    db = await getKyselyDB();

    repository = new ICloudSyncRepository(db);
  });
  afterAll(async () => {
    await db?.destroy();
  });
  beforeEach(async () => {
    vi.unstubAllEnvs();
    await sql`TRUNCATE public.icloud_connection CASCADE`.execute(db);
    connection = (await repository.create(
      (await seedCanonicalUser(db)).id,
      'Photos',
      ICloudConfigSchema.parse({ concurrency: 4 }),
    ))!;
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
      await seedCanonicalAsset(db, { id: assetId, ownerId: connection.ownerId });
    }
    await sql`INSERT INTO public.icloud_resource(id,"connectionId","ownerId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,fingerprint,source,"expectedSize",status,"assetId","reservedBytes","stagingPath")
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
    await sql`DELETE FROM asset WHERE id=(SELECT "assetId" FROM public.icloud_resource WHERE "connectionId"=${connection.id}::uuid AND fingerprint='old-0')`.execute(
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
    vi.stubEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES', '1');
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
    connection = (await repository.create(
      (await seedCanonicalUser(db)).id,
      'Other photos',
      ICloudConfigSchema.parse({}),
    ))!;
    await repository.update(connection.id, connection.ownerId, { state: 'connected' });
    await resource('new', { role: 'original' });
    vi.stubEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES', '95');
    expect(await repository.claim(connection.id, 1000)).toBeUndefined();
    expect(await repository.get(connection.id)).toMatchObject({
      state: 'error',
      lastError: 'staging_retained_capacity',
    });
    expect(await repository.get(oldConnection.id)).toMatchObject({ state: 'connected' });
    expect(await repository.resource(retained.id)).toMatchObject({ reservedBytes: 90 });
  });

  it.each(['local', 'global'])('counts zero-byte active leases against %s concurrency', async (scope) => {
    vi.stubEnv('FRAMELEAF_ICLOUD_MAX_CONCURRENCY', scope === 'local' ? '100' : '1');
    const leases = [];
    for (let index = 0; index < (scope === 'local' ? 4 : 1); index++) {
      leases.push(await resource(`zero-byte-${index}`, { role: 'original', status: 'failed', current: false }));
    }
    for (const lease of leases) {
      await sql`UPDATE public.icloud_resource SET "leaseToken"=${randomUUID()}::uuid,
        "leaseExpiresAt"=now()+interval '1 hour' WHERE id=${lease.id}::uuid`.execute(db);
    }
    if (scope === 'global') {
      connection = (await repository.create(
        randomUUID(),
        'Other photos',
        ICloudConfigSchema.parse({ concurrency: 4 }),
      ))!;
      await repository.update(connection.id, connection.ownerId, { state: 'connected' });
    }
    const candidate = await resource('new', { role: 'original' });
    expect(await repository.claim(connection.id, 1000)).toBeUndefined();
    expect(await repository.resource(candidate.id)).toMatchObject({ reservedBytes: 0, leaseToken: null });
  });

  it.each(['local', 'global'])('keeps expired noncurrent charges in %s capacity accounting', async (scope) => {
    const retained = await resource('expired-retained', {
      role: 'original',
      status: 'failed',
      current: false,
      reserved: 90,
    });
    await sql`UPDATE public.icloud_resource SET "leaseToken"=${randomUUID()}::uuid,
      "leaseExpiresAt"=now()-interval '1 hour' WHERE id=${retained.id}::uuid`.execute(db);
    if (scope === 'global') {
      connection = (await repository.create(randomUUID(), 'Other photos', ICloudConfigSchema.parse({})))!;
      await repository.update(connection.id, connection.ownerId, { state: 'connected' });
      vi.stubEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES', '95');
    }
    await resource('new', { role: 'original' });
    expect(await repository.claim(connection.id, scope === 'local' ? 95 : 1000)).toBeUndefined();
    expect(await repository.get(connection.id)).toMatchObject({
      state: 'error',
      lastError: 'staging_retained_capacity',
    });
    expect(await repository.resource(retained.id)).toMatchObject({ reservedBytes: 90 });
  });

  it('excludes finalized and removed charges and leases from admission totals', async () => {
    for (const status of ['finalized', 'removed']) {
      const ignored = await resource(status, { role: 'original', status, current: false, reserved: 100 });
      await sql`UPDATE public.icloud_resource SET "leaseToken"=${randomUUID()}::uuid,
        "leaseExpiresAt"=now()+interval '1 hour' WHERE id=${ignored.id}::uuid`.execute(db);
    }
    vi.stubEnv('FRAMELEAF_ICLOUD_MAX_CONCURRENCY', '1');
    vi.stubEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES', '10');
    const candidate = await resource('new', { role: 'original' });
    expect(await repository.claim(connection.id, 10)).toMatchObject({ id: candidate.id, reservedBytes: 10 });
  });

  it('rolls back only the claim indexes and preserves resource data', async () => {
    const saved = await resource('preserved', { role: 'original', status: 'failed', reserved: 90 });
    const indexes = () =>
      sql<{ name: string }>`SELECT indexname AS name FROM pg_indexes WHERE schemaname='public'
        AND indexname IN ('icloud_resource_claim_order_idx','icloud_resource_reservation_contributors_idx')
        ORDER BY indexname`
        .execute(db)
        .then(({ rows }) => rows.map(({ name }) => name));
    expect(await indexes()).toEqual([
      'icloud_resource_claim_order_idx',
      'icloud_resource_reservation_contributors_idx',
    ]);
    try {
      await claimAccessPaths.down(db);
      expect(await indexes()).toEqual([]);
      expect(await repository.resource(saved.id)).toMatchObject({ reservedBytes: 90 });
    } finally {
      await claimAccessPaths.up(db);
    }
    expect(await indexes()).toHaveLength(2);
  });
});
