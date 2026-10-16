import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import { AssetType, ChecksumAlgorithm, PhysicalFileType } from 'src/enum.js';
import { ICloudIdentityAdoptionRepository } from 'src/repositories/icloud-identity-adoption.repository.js';
import { ICloudIdentityRepository } from 'src/repositories/icloud-identity.repository.js';
import { iCloudItemClaimLockKey } from 'src/repositories/icloud-item-claim-lock.js';
import { ScheduledAuditAuthority } from 'src/repositories/icloud-scheduled-authority.js';
import {
  ICloudScheduledStagingRepository,
  ScheduledFreshDownload,
  ScheduledFreshPayload,
  ScheduledStagingInput,
  ValidationInputPlan,
  scheduledFreshBinding,
  scheduledFreshReceiptScope,
} from 'src/repositories/icloud-scheduled-staging.repository.js';
import { ICloudScheduledWorkerRepository } from 'src/repositories/icloud-scheduled-worker.repository.js';
import { ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { ICloudTransportRepository } from 'src/repositories/icloud-transport.repository.js';
import { ICloudWeeklyRepository } from 'src/repositories/icloud-weekly.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { lockFilePath } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { appleFingerprintHash } from 'src/utils/icloud-identity.js';
import { ValidationInputEnvelope, privateCopyIdentity, validationInputScope } from 'src/utils/icloud-private-copy.js';
import { scheduledAuditClaimHolder } from 'src/utils/icloud-weekly.js';
import { canonicalJson } from 'src/utils/studio-project.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

// Independent SQL connections and deferred fences prove committed reservation and disposal behavior.
describe('validation input SQL disposal concurrency', () => {
  let db: Kysely<DB>;
  const connections = new Set<string>();
  const directories = new Set<string>();

  beforeAll(async () => {
    db = await getKyselyDB();
    // getKyselyDB creates a fresh frameleaf_* database; never alter the migrated template.
    const {
      rows: [database],
    } = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
    if (!/^frameleaf_[a-z0-9_]+$/.test(database.name)) throw new Error('audit_database_not_private_clone');
    await sql`SET statement_timeout='7s'`.execute(db);
    await sql`SET lock_timeout='6s'`.execute(db);
    await sql`SET idle_in_transaction_session_timeout='10s'`.execute(db);
    // New observer/contender pool sessions inherit the same finite bounds.
    await sql`ALTER DATABASE ${sql.id(database.name)} SET statement_timeout='7s'`.execute(db);
    await sql`ALTER DATABASE ${sql.id(database.name)} SET lock_timeout='6s'`.execute(db);
    await sql`ALTER DATABASE ${sql.id(database.name)} SET idle_in_transaction_session_timeout='10s'`.execute(db);
    await expectCanonicalTables(db, ['icloud_identity_reuse', 'icloud_weekly_cohort', 'icloud_identity_audit']);
  });
  beforeEach(() => {
    // Only local prerequisite checks read this URL; no provider method is called.
    vi.stubEnv('FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION', 'true');
    vi.stubEnv('FRAMELEAF_ICLOUD_BRIDGE_URL', 'https://validation-fixture.invalid');
    vi.stubEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES', String(1024 ** 2));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (connections.size > 0) {
      await sql`DELETE FROM public.icloud_connection WHERE id=ANY(${[...connections]}::uuid[])`.execute(db);
      connections.clear();
    }
    // Test-only cleanup follows settled transactions and released fences in each test's finally.
    await Promise.all([...directories].map((path) => rm(path, { recursive: true, force: true })));
    directories.clear();
  });
  afterAll(async () => db.destroy());

  async function arrangeScheduledInputs(size = 10, population = 1) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'fl296-sql-disposal-')));
    directories.add(root);
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id });
    // Scoped reversible seals stand in for transport cryptography, never repository admission.
    const seals = new Map<string, { scope: string; payload: string }>();
    const transport = {
      encodeSession(scope: string, payload: unknown) {
        const seal = randomUUID();
        seals.set(seal, { scope, payload: canonicalJson(payload) });
        return Promise.resolve(seal);
      },
      decodeSession(scope: string, seal: string) {
        const record = seals.get(seal);
        if (!record || record.scope !== scope) return Promise.reject(new Error('fixture_seal_scope_invalid'));
        return Promise.resolve(JSON.parse(record.payload));
      },
    } as unknown as ICloudTransportRepository;
    const staging = new ICloudScheduledStagingRepository(db, transport);
    const sync = new ICloudSyncRepository(db, staging);
    const identities = new ICloudIdentityRepository(db);
    const operations = new MediaOperationRepository(db);
    const weekly = new ICloudWeeklyRepository(db);
    const connection = (await sync.create(
      user.id,
      'Photos',
      ICloudConfigSchema.parse({
        stagingBytes: 1024 ** 2,
        concurrency: Math.ceil(population / 100),
      }),
    ))!;
    connections.add(connection.id);
    await sync.update(connection.id, user.id, {
      state: 'connected',
      encryptedSession: 'fixture-only',
      config: connection.config,
    });
    await weekly.setAuthority(factory.auth({ user, session }), connection.id, {
      enabled: true,
      includeProtected: false,
      requestKey: randomUUID(),
    });
    const seeds = [];
    for (let index = 0; index < population; index++) {
      const NAME = randomUUID().toUpperCase();
      const bytes = Buffer.alloc(size, index + 1);
      const originalPath = join(root, `source-${index}.jpg`);
      await writeFile(originalPath, bytes, { mode: 0o600 });
      const sha256 = createHash('sha256').update(bytes).digest();
      const sha1 = createHash('sha1').update(bytes).digest();
      const apple = appleFingerprintHash();
      apple.update(bytes);
      const master = apple.digest();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalPath,
        originalFileName: 'source.jpg',
        type: AssetType.Image,
        checksum: sha256,
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
      });
      const field = (value: unknown) => ({ value });
      await sync.savePage(
        connection.id,
        'assets:library',
        'library',
        [
          {
            recordName: master,
            recordType: 'CPLMaster',
            recordChangeTag: 'master-1',
            fields: {
              filenameEnc: field('source.jpg'),
              itemType: field('public.jpeg'),
              resOriginalRes: field({ size: bytes.length, fileChecksum: master }),
            },
          },
          {
            recordName: NAME,
            recordType: 'CPLAsset',
            recordChangeTag: 'asset-1',
            fields: { masterRef: field({ recordName: master }) },
          },
        ],
        null,
        true,
      );
      // Reopen only this fixture's inventory checkpoint as the actual population grows.
      await sql`DELETE FROM public.icloud_checkpoint WHERE "connectionId"=${connection.id}::uuid
        AND scope='materialize:library'`.execute(db);
      let materialized = false;
      for (let page = 0; page < 2 && !materialized; page++) {
        materialized = await sync.materialize(connection, 'library', {
          area: 'private',
          zoneID: { zoneName: 'PrimarySync' },
        });
      }
      expect(materialized).toBe(true);
      const queued = await sync.queueOperation(connection.id, user.id, { trigger: 'manual' });
      if (queued.outcome !== 'created') throw new Error('fixture_sync_operation_missing');
      const syncToken = randomUUID();
      await sql`UPDATE public.media_operation SET status='rendering',"claimToken"=${syncToken}::uuid,
        "claimExpiresAt"=clock_timestamp()+interval '1 hour' WHERE id=${queued.operation.id}::uuid`.execute(db);
      const source = await sync.claim(connection.id, connection.config.stagingBytes);
      if (!source?.leaseToken) throw new Error('fixture_source_claim_missing');
      // Device identity is input evidence; the reuse receipt itself is produced only by adopt().
      await sql`INSERT INTO public.icloud_source_identity
        ("ownerId","assetId","libraryKey","cplAssetRecordName","cplMasterRecordName",role,sha256,"deliveredBy","cloudIdentifier","matchStrength")
        VALUES (${user.id}::uuid,${asset.id}::uuid,'library',${NAME},${master},'original',${sha256},
          ${`device:${randomUUID()}`},${`${NAME}:001:${master}`},'corroborated')`.execute(db);
      await identities.claimForSync(user.id, NAME, connection.id);
      const adopted = await new ICloudIdentityAdoptionRepository(db).adopt(
        {
          ownerId: user.id,
          connectionId: connection.id,
          config: canonicalJson(connection.config),
          operationId: queued.operation.id,
          operationClaimToken: syncToken,
          resourceId: source.id,
          resourceLeaseToken: source.leaseToken,
        },
        async (candidate) => {
          const before = await stat(candidate.originalPath);
          const observed = await readFile(candidate.originalPath);
          const after = await stat(candidate.originalPath);
          const identity = {
            dev: before.dev,
            ino: before.ino,
            size: before.size,
            mtimeMs: before.mtimeMs,
            ctimeMs: before.ctimeMs,
          };
          const unchanged = (current: typeof before) =>
            Object.entries(identity).every(([key, value]) => current[key as keyof typeof identity] === value);
          if (!unchanged(after) || !observed.equals(bytes)) return 'miss';
          const fingerprint = appleFingerprintHash();
          fingerprint.update(observed);
          return {
            sha1: createHash('sha1').update(observed).digest(),
            sha256: createHash('sha256').update(observed).digest(),
            sizeInBytes: observed.length,
            appleFingerprint: fingerprint.digest(),
            identity,
            current: async () => unchanged(await stat(candidate.originalPath)),
          };
        },
      );
      expect(adopted).toBe('adopted');
      expect(await sync.finalize(source, async () => {})).toBe(true);
      expect(await operations.beginValidation(queued.operation.id, syncToken, true)).toBe(true);
      expect(await operations.complete(queued.operation.id, syncToken, { resultAssetId: null }, undefined, true)).toBe(
        true,
      );
      seeds.push({ source, bytes, sha1, sha256, master });
    }
    const cohort = await weekly.freezeCohort(user.id, connection.id, true);
    expect(Number(cohort.populationCount)).toBe(population);
    expect(Number(cohort.selectedCount)).toBe(Math.ceil(population / 100));
    const operation = await weekly.createNextBatch(cohort.id, operations);
    if (!operation) throw new Error('fixture_weekly_operation_missing');
    const { rows: requests } = await sql<{
      id: string;
      sourceResourceId: string;
    }>`SELECT id,"sourceResourceId" FROM public.icloud_identity_audit
      WHERE "operationId"=${operation.id}::uuid AND purpose='scheduled-weekly'`.execute(db);
    expect(requests).toHaveLength(Math.ceil(population / 100));
    const operationClaimToken = randomUUID();
    await sql`UPDATE public.media_operation SET status='rendering',"claimToken"=${operationClaimToken}::uuid,
      "claimExpiresAt"=clock_timestamp()+interval '1 hour' WHERE id=${operation.id}::uuid`.execute(db);
    const fixtures = [];
    for (const request of requests) {
      const seed = seeds.find((seed) => seed.source.id === request.sourceResourceId);
      if (!seed) throw new Error('fixture_selected_source_missing');
      const { source, bytes, sha1, sha256, master } = seed;
      const authority: ScheduledAuditAuthority = {
        purpose: 'scheduled-weekly',
        auditRequestId: request.id,
        operationId: operation.id,
        operationClaimToken,
      };
      const [claim] = await identities.claim(
        user.id,
        [source.sourceAssetId],
        scheduledAuditClaimHolder(user.id, authority),
        1800,
      );
      if (!claim || claim.holder !== scheduledAuditClaimHolder(user.id, authority))
        throw new Error('fixture_audit_claim_missing');
      const worker = new ICloudScheduledWorkerRepository(db, staging);
      expect(await worker.bindClaim(authority, user.id, claim.id)).toBe(true);
      const resource = await worker.allocate(authority, user.id);
      if (!resource?.leaseToken) throw new Error('fixture_audit_allocation_missing');
      const input: ScheduledStagingInput = {
        authority,
        ownerId: user.id,
        resource: { id: resource.id, leaseToken: resource.leaseToken },
      };
      const directory = join(root, resource.id);
      await mkdir(directory, { mode: 0o700 });
      const path = join(directory, 'complete');
      await writeFile(path, bytes, { mode: 0o600 });
      await sql`UPDATE public.icloud_resource SET "stagingPath"=${path} WHERE id=${resource.id}::uuid`.execute(db);
      const admitted = await staging.read(input);
      if (!admitted) throw new Error('fixture_scheduled_admission_missing');
      const file = await stat(path);
      const payload: ScheduledFreshPayload = {
        version: 1,
        basis: 'audit-fresh-download',
        binding: scheduledFreshBinding(admitted.guarded, resource.id),
        path,
        identity: { dev: file.dev, ino: file.ino, size: file.size, mtimeMs: file.mtimeMs, ctimeMs: file.ctimeMs },
        sha1: sha1.toString('hex'),
        sha256: sha256.toString('hex'),
        appleFingerprint: master,
      };
      const fresh: ScheduledFreshDownload = {
        payload,
        seal: await transport.encodeSession(scheduledFreshReceiptScope(payload), payload),
      };
      expect(await staging.storeFreshDownload(input, fresh)).toBe(true);
      expect(await staging.authenticateReceipt(input, fresh)).toBe(true);
      expect(Number((await sync.resource(resource.id))?.reservedBytes)).toBe(bytes.length);
      fixtures.push({ input, staging, worker, connection, directory, root, fresh, transport, sync, bytes });
    }
    return fixtures;
  }
  async function settledPlan(size = 10) {
    const [f] = await arrangeScheduledInputs(size);
    return withPlan(f);
  }

  async function withPlan(f: Awaited<ReturnType<typeof arrangeScheduledInputs>>[number]) {
    const token = await f.staging.beginPrivateWork(f.input);
    expect(await readFile(f.fresh.payload.path)).toEqual(f.bytes);
    await f.staging.finishPrivateWork(f.input, token);
    const plan: ValidationInputPlan = {
      expected: null,
      pathNonce: randomUUID(),
      stage: 'source',
      fresh: f.fresh,
      validationPath: f.fresh.payload.path,
      sourceIdentity: privateCopyIdentity(await stat(f.fresh.payload.path)),
      stagingDirectory: f.directory,
    };
    return { ...f, plan };
  }

  const GLOBAL = 'icloud-staging-reservations';
  const TIMEOUT = 8000;

  // A timer is an abort bound only; SQL lock tags and blocker PIDs supply every overlap witness.
  async function holdFence(key: string) {
    const ready = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const timer = setTimeout(() => release.reject(new Error('audit_fence_deadline')), TIMEOUT);
    const done = db
      .transaction()
      .execute(async (tx) => {
        await sql`SET LOCAL statement_timeout='7s'`.execute(tx);
        await sql`SET LOCAL idle_in_transaction_session_timeout='10s'`.execute(tx);
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`.execute(tx);
        const {
          rows: [row],
        } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx);
        ready.resolve(row.pid);
        await release.promise;
      })
      .finally(() => clearTimeout(timer));
    void done.catch((error) => ready.reject(error));
    return { pid: await ready.promise, release: () => release.resolve(), done };
  }

  function contender<T>(run: (connection: Kysely<DB>) => Promise<T>) {
    const ready = Promise.withResolvers<number>();
    const done = db.connection().execute(async (connection) => {
      await sql`SET statement_timeout='7s'`.execute(connection);
      await sql`SET lock_timeout='6s'`.execute(connection);
      try {
        const {
          rows: [row],
        } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(connection);
        ready.resolve(row.pid);
        return await run(connection);
      } finally {
        await sql`RESET statement_timeout`.execute(connection);
        await sql`RESET lock_timeout`.execute(connection);
      }
    });
    void done.catch((error) => ready.reject(error));
    return { pid: ready.promise, done };
  }

  async function waitForFence(pid: number, blocker: number, key: string) {
    const deadline = performance.now() + 4000;
    let observed: unknown;
    do {
      const {
        rows: [row],
      } = await sql<{ waiting: boolean; blocked: boolean }>`SELECT
        EXISTS(SELECT 1 FROM pg_locks w JOIN pg_locks h
          ON h.locktype=w.locktype AND h.database IS NOT DISTINCT FROM w.database
          AND h.classid=w.classid AND h.objid=w.objid AND h.objsubid=w.objsubid
          WHERE w.pid=${pid} AND h.pid=${blocker} AND h.granted AND NOT w.granted
            AND w.locktype='advisory'
            AND w.classid=((hashtextextended(${key},0)>>32)&4294967295)::oid
            AND w.objid=(hashtextextended(${key},0)&4294967295)::oid
            AND w.objsubid=1) AS waiting,
        ${blocker}=ANY(pg_blocking_pids(${pid})) AS blocked`.execute(db);
      observed = row;
      if (row.waiting && row.blocked) return;
      await setImmediate();
    } while (performance.now() < deadline);
    throw new Error(`audit_lock_witness_missing:${JSON.stringify({ pid, blocker, key, observed })}`);
  }

  function stagingOn(connection: Kysely<DB>, f: Awaited<ReturnType<typeof settledPlan>>) {
    return new ICloudScheduledStagingRepository(connection, f.transport);
  }

  async function exactCharge(resourceId: string) {
    return (
      await sql<{ bytes: string }>`SELECT "reservedBytes"::text AS bytes
      FROM public.icloud_resource WHERE id=${resourceId}::uuid`.execute(db)
    ).rows[0].bytes;
  }

  async function waitForEitherOrder(left: number, right: number, blocker: number, itemKey: string) {
    const deadline = performance.now() + 4000;
    do {
      const { rows } = await sql<{ pid: number; blockers: number[] }>`SELECT pid, pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity WHERE pid=ANY(${[left, right]}::int[])`.execute(db);
      const first = rows.find((row) => row.blockers.includes(blocker));
      if (first) {
        const second = first.pid === left ? right : left;
        await waitForFence(first.pid, blocker, GLOBAL);
        await waitForFence(second, first.pid, itemKey);
        return;
      }
      await setImmediate();
    } while (performance.now() < deadline);
    throw new Error('audit_competing_item_global_chain_missing');
  }

  async function waitForPrefix(pid: number, itemBlocker: number, budgetBlocker: number, itemKey: string) {
    const deadline = performance.now() + 4000;
    do {
      const {
        rows: [row],
      } = await sql<{ blockers: number[] }>`SELECT pg_blocking_pids(${pid}) AS blockers`.execute(db);
      if (row.blockers.includes(budgetBlocker)) {
        await waitForFence(pid, budgetBlocker, GLOBAL);
        throw new Error('audit_lock_order_inversion:global_budget_wait_observed_while_item_fence_held');
      }
      if (row.blockers.includes(itemBlocker)) {
        await waitForFence(pid, itemBlocker, itemKey);
        return;
      }
      await setImmediate();
    } while (performance.now() < deadline);
    throw new Error('audit_item_prefix_witness_missing');
  }

  async function settleInput(f: Awaited<ReturnType<typeof settledPlan>>, plan = f.plan) {
    const reserved = (await f.staging.planValidationInput(f.input, plan))!;
    expect(reserved).toBeDefined();
    const token = await f.staging.beginPrivateWork(f.input);
    const payload = reserved.payload.current.payload;
    await mkdir(payload.directoryPath, { mode: 0o700 });
    await writeFile(payload.inputPath, Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
    const preparing = (await f.staging.storeValidationInput(f.input, reserved, {
      ...payload,
      state: 'preparing',
      pending: [token],
      directoryIdentity: privateCopyIdentity(await stat(payload.directoryPath)),
      inputIdentity: privateCopyIdentity(await stat(payload.inputPath)),
    }))!;
    expect(preparing).toBeDefined();
    await writeFile(payload.inputPath, f.bytes);
    const running = (await f.staging.storeValidationInput(f.input, preparing, {
      ...preparing.payload.current.payload,
      state: 'running',
      inputIdentity: privateCopyIdentity(await stat(payload.inputPath)),
    }))!;
    expect(running).toBeDefined();
    const settled = (await f.staging.storeValidationInput(f.input, running, {
      ...running.payload.current.payload,
      state: 'settled',
      pending: [],
    }))!;
    expect(settled).toBeDefined();
    return { settled, token, payload: settled.payload.current.payload };
  }

  async function ledger(resourceId: string) {
    const {
      rows: [row],
    } = await sql<{ bytes: string; envelope: ValidationInputEnvelope }>`SELECT
      "reservedBytes"::text AS bytes,verification->'auditValidationInputs' AS envelope
      FROM public.icloud_resource WHERE id=${resourceId}::uuid`.execute(db);
    return row;
  }

  async function waitForTransaction(pid: number, blocker: number) {
    const deadline = performance.now() + 4000;
    do {
      const {
        rows: [row],
      } = await sql<{ waiting: boolean; blocked: boolean }>`SELECT
        EXISTS(SELECT 1 FROM pg_locks w JOIN pg_locks h
          ON h.locktype=w.locktype AND h.transactionid=w.transactionid
          WHERE w.pid=${pid} AND h.pid=${blocker} AND h.granted AND NOT w.granted
            AND w.locktype='transactionid') AS waiting,
        ${blocker}=ANY(pg_blocking_pids(${pid})) AS blocked`.execute(db);
      if (row.waiting && row.blocked) return;
      await setImmediate();
    } while (performance.now() < deadline);
    throw new Error('audit_successor_transaction_blocker_missing');
  }

  async function waitForPathFence(pid: number, blocker: number, path: string) {
    const key = createHash('sha1').update(path).digest().readBigInt64BE(0).toString();
    const deadline = performance.now() + 4000;
    do {
      const {
        rows: [row],
      } = await sql<{ waiting: boolean; blocked: boolean }>`SELECT
        EXISTS(SELECT 1 FROM pg_locks w JOIN pg_locks h
          ON h.locktype=w.locktype AND h.database IS NOT DISTINCT FROM w.database
          AND h.classid=w.classid AND h.objid=w.objid AND h.objsubid=w.objsubid
          WHERE w.pid=${pid} AND h.pid=${blocker} AND h.granted AND NOT w.granted
            AND w.locktype='advisory' AND w.classid=(((${key}::bigint)>>32)&4294967295)::oid
            AND w.objid=((${key}::bigint)&4294967295)::oid AND w.objsubid=1) AS waiting,
        ${blocker}=ANY(pg_blocking_pids(${pid})) AS blocked`.execute(db);
      if (row.waiting && row.blocked) return;
      await setImmediate();
    } while (performance.now() < deadline);
    throw new Error('audit_path_blocker_missing');
  }

  it('admits overlapping identical nonces exactly once and replays the same durable generation', async () => {
    const f = await settledPlan();
    const fence = await holdFence(GLOBAL);
    const left = contender((connection) => stagingOn(connection, f).planValidationInput(f.input, f.plan));
    const right = contender((connection) => stagingOn(connection, f).planValidationInput(f.input, f.plan));
    try {
      const [a, b] = await Promise.all([left.pid, right.pid]);
      expect(new Set([a, b, fence.pid]).size).toBe(3);
      await waitForEitherOrder(
        a,
        b,
        fence.pid,
        iCloudItemClaimLockKey(f.input.ownerId, f.fresh.payload.binding.sourceAssetId),
      );
      expect(await exactCharge(f.input.resource.id)).toBe('10');
      fence.release();
      await fence.done;
      const results = await Promise.all([left.done, right.done]);
      expect(results.filter(Boolean)).toHaveLength(1);
      // The overlapping loser read the old row. It must not invent a second charge; retry is replay.
      const winner = results.find(Boolean)!;
      expect(winner.payload.highWater).toBe('1');
      expect(await f.staging.planValidationInput(f.input, f.plan)).toEqual(winner);
      expect(await ledger(f.input.resource.id)).toEqual({ bytes: '20', envelope: winner });
    } finally {
      fence.release();
      await Promise.allSettled([fence.done, left.done, right.done]);
    }
  }, 30_000);

  it('serializes distinct resources on one connection at its aggregate cap', async () => {
    // Normal 1% selection: 101 actual adopted source receipts produce two selected audit items.
    // No freezeFixture or hand-authored scheduled request/bindings are used.
    const fixtures = await arrangeScheduledInputs(300_000, 101);
    const [a, b] = await Promise.all(fixtures.map((fixture) => withPlan(fixture)));
    expect(fixtures).toHaveLength(2);
    expect(a.connection.id).toBe(b.connection.id);
    expect(a.input.resource.id).not.toBe(b.input.resource.id);
    expect(a.fresh.payload.binding.sourceAssetId).not.toBe(b.fresh.payload.binding.sourceAssetId);
    vi.stubEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES', String(2 * 1024 ** 2));
    const fence = await holdFence(GLOBAL);
    const left = contender((connection) => stagingOn(connection, a).planValidationInput(a.input, a.plan));
    const right = contender((connection) => stagingOn(connection, b).planValidationInput(b.input, b.plan));
    try {
      const [p, q] = await Promise.all([left.pid, right.pid]);
      expect(new Set([p, q, fence.pid]).size).toBe(3);
      await waitForFence(p, fence.pid, GLOBAL);
      await waitForFence(q, fence.pid, GLOBAL);
      expect(await exactCharge(a.input.resource.id)).toBe('300000');
      expect(await exactCharge(b.input.resource.id)).toBe('300000');
      fence.release();
      await fence.done;
      const results = await Promise.all([left.done, right.done]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.filter((result) => result === undefined)).toHaveLength(1);
      expect((await Promise.all([exactCharge(a.input.resource.id), exactCharge(b.input.resource.id)])).sort()).toEqual([
        '300000',
        '600000',
      ]);
      const {
        rows: [total],
      } = await sql<{ bytes: string; nonnegative: boolean }>`SELECT
        sum("reservedBytes")::text AS bytes,bool_and("reservedBytes">=0) AS nonnegative
        FROM public.icloud_resource WHERE "connectionId"=${a.connection.id}::uuid
          AND status NOT IN ('finalized','removed')`.execute(db);
      expect(total).toEqual({ bytes: '900000', nonnegative: true });
      for (const [index, f] of [a, b].entries()) {
        expect(await f.staging.validationInputs(f.input)).toEqual(results[index]);
      }
    } finally {
      fence.release();
      await Promise.allSettled([fence.done, left.done, right.done]);
    }
  }, 180_000);

  it('takes the item fence before the budget fence in actual input disposal', async () => {
    const f = await settledPlan();
    const { settled, payload } = await settleInput(f);
    const key = iCloudItemClaimLockKey(f.input.ownerId, payload.sourceAssetId);
    const item = await holdFence(key);
    let budget: Awaited<ReturnType<typeof holdFence>> | undefined;
    let call: ReturnType<typeof contender<boolean>> | undefined;
    try {
      budget = await holdFence(GLOBAL);
      call = contender((connection) => stagingOn(connection, f).disposeValidationInput(f.input, settled));
      const pid = await call.pid;
      expect(new Set([pid, item.pid, budget.pid]).size).toBe(3);
      await waitForPrefix(pid, item.pid, budget.pid, key);
      const {
        rows: [locks],
      } = await sql<{ count: string }>`SELECT count(*)::text AS count FROM pg_locks
        WHERE pid=${pid} AND locktype='advisory'
        AND classid=((hashtextextended(${GLOBAL},0)>>32)&4294967295)::oid
        AND objid=(hashtextextended(${GLOBAL},0)&4294967295)::oid AND objsubid=1`.execute(db);
      expect(locks.count).toBe('0');
      expect(await ledger(payload.resourceId)).toEqual({ bytes: '20', envelope: settled });
      expect(await readFile(payload.inputPath)).toEqual(f.bytes);
      budget.release();
      await budget.done;
      await db.transaction().execute(async (tx) => {
        const {
          rows: [row],
        } = await sql<{ acquired: boolean }>`SELECT
          pg_try_advisory_xact_lock(hashtextextended(${GLOBAL},0)) AS acquired`.execute(tx);
        expect(row.acquired).toBe(true);
      });
      item.release();
      await item.done;
      expect(await call.done).toBe(true);
      expect(await exactCharge(payload.resourceId)).toBe('10');
    } finally {
      item.release();
      budget?.release();
      await Promise.allSettled([item.done, ...(budget ? [budget.done] : []), ...(call ? [call.done] : [])]);
    }
  }, 30_000);

  it.each(['commit', 'rollback'] as const)(
    'blocks a successor while actual unlink precedes the disposed CAS: %s',
    async (outcome) => {
      const f = await settledPlan();
      const { settled, token, payload } = await settleInput(f);
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const encode = f.transport.encodeSession.bind(f.transport);
      const timer = setTimeout(() => release.reject(new Error('audit_post_unlink_deadline')), TIMEOUT);
      const spy = vi.spyOn(f.transport, 'encodeSession').mockImplementation(async (scope, value) => {
        if (
          scope === validationInputScope({ ...payload, state: 'disposed' }) &&
          (value as { state?: string }).state === 'disposed'
        ) {
          reached.resolve();
          await release.promise;
          if (outcome === 'rollback') throw new Error('audit_forced_post_unlink_rollback');
        }
        return encode(scope, value);
      });
      const disposal = contender((connection) => stagingOn(connection, f).disposeValidationInput(f.input, settled));
      // Attach rejection immediately, before awaiting the barrier; all operations are settled in finally.
      // Preserve direct success/rejection normalization before observing the held transaction.
      // eslint-disable-next-line unicorn/prefer-then-catch
      const disposalResult = disposal.done.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      let successor: ReturnType<typeof contender<ValidationInputEnvelope | undefined>> | undefined;
      try {
        await Promise.race([
          reached.promise,
          disposal.done.then(() => {
            throw new Error('audit_disposal_did_not_reach_post_unlink');
          }),
        ]);
        const disposerPid = await disposal.pid;
        await expect(stat(payload.inputPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readdir(payload.directoryPath)).toEqual([]);
        expect(await ledger(payload.resourceId)).toEqual({ bytes: '20', envelope: settled });
        successor = contender((connection) =>
          stagingOn(connection, f).planValidationInput(f.input, {
            ...f.plan,
            expected: settled,
            pathNonce: randomUUID(),
          }),
        );
        const successorPid = await successor.pid;
        expect(successorPid).not.toBe(disposerPid);
        // Admission waits on the owner's row held by the real disposal transaction.
        await waitForTransaction(successorPid, disposerPid);
        expect(await ledger(payload.resourceId)).toEqual({ bytes: '20', envelope: settled });
        release.resolve();
        const result = await disposalResult;
        if (outcome === 'rollback') {
          expect(result.error).toBeInstanceOf(Error);
          expect((result.error as Error).message).toBe('audit_forced_post_unlink_rollback');
          expect(await ledger(payload.resourceId)).toEqual({ bytes: '20', envelope: settled });
          expect(await readdir(payload.directoryPath)).toEqual([]);
        } else {
          expect(result).toEqual({ value: true, error: undefined });
          const committed = await ledger(payload.resourceId);
          expect(committed.bytes).toBe('10');
          expect(committed.envelope.payload.current.payload.state).toBe('disposed');
          expect(committed.envelope.payload.highWater).toBe(settled.payload.highWater);
        }
        expect(await successor.done).toBeUndefined();
        spy.mockRestore();
        // Rollback retry uses the original authenticated generation and now-missing input, exactly once.
        expect(await f.staging.disposeValidationInput(f.input, settled)).toBe(true);
        expect(await exactCharge(payload.resourceId)).toBe('10');
        expect(await f.staging.disposeValidationInput(f.input, settled)).toBe(true);
        expect(await exactCharge(payload.resourceId)).toBe('10');
        await f.staging.finishPrivateWork(f.input, token);
        const disposed = (await ledger(payload.resourceId)).envelope;
        const next = await f.staging.planValidationInput(f.input, {
          ...f.plan,
          expected: disposed,
          pathNonce: randomUUID(),
        });
        expect(next?.payload.highWater).toBe('2');
        expect(await f.staging.disposeValidationInput(f.input, settled)).toBe(true);
        expect(await ledger(payload.resourceId)).toEqual({ bytes: '20', envelope: next });
      } finally {
        release.resolve();
        clearTimeout(timer);
        await Promise.allSettled([disposal.done, ...(successor ? [successor.done] : [])]);
        spy.mockRestore();
      }
    },
    30_000,
  );
  it.each(['replacement-claim', 'path-reference'] as const)(
    'sees a concurrently committed %s and retains the input and full charge',
    async (kind) => {
      const f = await settledPlan();
      const { settled, payload } = await settleInput(f);
      const ready = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const timer = setTimeout(() => release.reject(new Error('audit_reference_writer_deadline')), TIMEOUT);
      const replacementId = randomUUID();
      const writer = db
        .transaction()
        .execute(async (tx) => {
          await sql`SET LOCAL statement_timeout='7s'`.execute(tx);
          await sql`SET LOCAL lock_timeout='6s'`.execute(tx);
          await sql`SET LOCAL idle_in_transaction_session_timeout='10s'`.execute(tx);
          if (kind === 'replacement-claim') {
            const key = iCloudItemClaimLockKey(f.input.ownerId, payload.sourceAssetId);
            await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`.execute(tx);
            // Fixture mutation under the production whole-item fence, not invented disposal authority.
            await sql`UPDATE public.icloud_claim SET id=${replacementId}::uuid,holder='device:audit-replacement',
            "expiresAt"=clock_timestamp()+interval '1 hour' WHERE id=${payload.itemClaimId}::uuid`.execute(tx);
          } else {
            await lockFilePath(tx, payload.inputPath);
            await tx
              .insertInto('physical_file')
              .values({
                path: payload.inputPath,
                checksum: Buffer.alloc(32),
                sizeInBytes: f.bytes.length,
                type: PhysicalFileType.Original,
                canonicalAssetId: null,
              })
              .execute();
          }
          const {
            rows: [row],
          } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx);
          ready.resolve(row.pid);
          await release.promise;
        })
        .finally(() => clearTimeout(timer));
      void writer.catch((error) => ready.reject(error));
      let disposal: ReturnType<typeof contender<boolean>> | undefined;
      try {
        const writerPid = await ready.promise;
        disposal = contender((connection) => stagingOn(connection, f).disposeValidationInput(f.input, settled));
        const pid = await disposal.pid;
        expect(pid).not.toBe(writerPid);
        if (kind === 'replacement-claim') {
          await waitForFence(pid, writerPid, iCloudItemClaimLockKey(f.input.ownerId, payload.sourceAssetId));
          const { rows } = await sql<{ id: string }>`SELECT id FROM public.icloud_claim
            WHERE "ownerId"=${payload.ownerId}::uuid AND "cplAssetRecordName"=upper(${payload.sourceAssetId})`.execute(
            db,
          );
          expect(rows.map((row) => row.id)).toEqual([payload.itemClaimId]);
        } else {
          await waitForPathFence(pid, writerPid, payload.inputPath);
          expect(
            await db.selectFrom('physical_file').select('id').where('path', '=', payload.inputPath).execute(),
          ).toEqual([]);
        }
        expect(await ledger(payload.resourceId)).toEqual({ bytes: '20', envelope: settled });
        expect(await readFile(payload.inputPath)).toEqual(f.bytes);
        release.resolve();
        await writer;
        expect(await disposal.done).toBe(false);
        expect(await ledger(payload.resourceId)).toEqual({ bytes: '20', envelope: settled });
        expect(await readFile(payload.inputPath)).toEqual(f.bytes);
        if (kind === 'replacement-claim') {
          const { rows } = await sql<{ id: string; live: boolean }>`SELECT id,"expiresAt">clock_timestamp() AS live
            FROM public.icloud_claim WHERE "ownerId"=${payload.ownerId}::uuid
              AND "cplAssetRecordName"=upper(${payload.sourceAssetId})`.execute(db);
          expect(rows).toEqual([{ id: replacementId, live: true }]);
        } else {
          expect(
            await db.selectFrom('physical_file').select('path').where('path', '=', payload.inputPath).execute(),
          ).toEqual([{ path: payload.inputPath }]);
        }
      } finally {
        release.resolve();
        clearTimeout(timer);
        await Promise.allSettled([writer, ...(disposal ? [disposal.done] : [])]);
        if (kind === 'path-reference') {
          await db.deleteFrom('physical_file').where('path', '=', payload.inputPath).execute();
        }
      }
    },
    30_000,
  );
});
