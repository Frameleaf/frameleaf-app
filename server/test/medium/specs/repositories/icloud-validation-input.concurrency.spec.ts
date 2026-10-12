import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import { AssetType, ChecksumAlgorithm } from 'src/enum.js';
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
import { MediaRecoveryRepository, VerifiedMedia } from 'src/repositories/media-recovery.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { appleFingerprintHash } from 'src/utils/icloud-identity.js';
import {
  ValidationInputEnvelope,
  privateCopyIdentity,
  validationInputScope,
  validationInputsScope,
} from 'src/utils/icloud-private-copy.js';
import { canonicalJson } from 'src/utils/studio-project.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

const NAME = '32A01DD9-75DF-41B2-8773-80C153D73A5A';

// Independent SQL connections and deferred fences prove committed reservation and disposal behavior.
describe('validation input SQL concurrency', () => {
  let db: Kysely<DB>;
  const connections = new Set<string>();
  const directories = new Set<string>();

  beforeAll(async () => {
    db = await getKyselyDB();
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

  async function arrangeScheduledInput(size = 10) {
    const bytes = Buffer.alloc(size, 0x31);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'fl296-sql-input-')));
    directories.add(root);
    const originalPath = join(root, 'source.jpg');
    await writeFile(originalPath, bytes, { mode: 0o600 });
    const sha256 = createHash('sha256').update(bytes).digest();
    const sha1 = createHash('sha1').update(bytes).digest();
    const apple = appleFingerprintHash();
    apple.update(bytes);
    const master = apple.digest();
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id });
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      originalPath,
      originalFileName: 'source.jpg',
      type: AssetType.Image,
      checksum: sha256,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
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
    const connection = (await sync.create(user.id, 'Photos', ICloudConfigSchema.parse({ stagingBytes: 1024 ** 2 })))!;
    connections.add(connection.id);
    await sync.update(connection.id, user.id, {
      state: 'connected',
      encryptedSession: 'fixture-only',
      config: connection.config,
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
    await sync.materialize(connection, 'library', { area: 'private', zoneID: { zoneName: 'PrimarySync' } });
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
    await weekly.setAuthority(factory.auth({ user, session }), connection.id, {
      enabled: true,
      includeProtected: false,
      requestKey: randomUUID(),
    });
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
    const cohort = await weekly.freezeCohort(user.id, connection.id, true);
    expect(Number(cohort.populationCount)).toBe(1);
    expect(Number(cohort.selectedCount)).toBe(1);
    const operation = await weekly.createNextBatch(cohort.id, operations);
    if (!operation) throw new Error('fixture_weekly_operation_missing');
    const { rows: requests } = await sql<{ id: string }>`SELECT id FROM public.icloud_identity_audit
      WHERE "operationId"=${operation.id}::uuid AND purpose='scheduled-weekly'`.execute(db);
    expect(requests).toHaveLength(1);
    const authority: ScheduledAuditAuthority = {
      purpose: 'scheduled-weekly',
      auditRequestId: requests[0].id,
      operationId: operation.id,
      operationClaimToken: randomUUID(),
    };
    await sql`UPDATE public.media_operation SET status='rendering',"claimToken"=${authority.operationClaimToken}::uuid,
      "claimExpiresAt"=clock_timestamp()+interval '1 hour' WHERE id=${operation.id}::uuid`.execute(db);
    const [claim] = await identities.claim(user.id, [source.sourceAssetId], `icloud-sync:audit:${operation.id}`, 1800);
    if (!claim || claim.holder !== `icloud-sync:audit:${operation.id}`) throw new Error('fixture_audit_claim_missing');
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
    return { input, staging, worker, connection, directory, root, fresh, transport, sync, bytes };
  }

  async function settledPlan(size = 10) {
    const f = await arrangeScheduledInput(size);
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

  it('serializes independent connections competing for the last ten global bytes', async () => {
    const a = await settledPlan();
    const b = await settledPlan();
    vi.stubEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES', '30');
    const fence = await holdFence(GLOBAL);
    const left = contender((connection) => stagingOn(connection, a).planValidationInput(a.input, a.plan));
    const right = contender((connection) => stagingOn(connection, b).planValidationInput(b.input, b.plan));
    try {
      const [leftPid, rightPid] = await Promise.all([left.pid, right.pid]);
      expect(new Set([leftPid, rightPid, fence.pid]).size).toBe(3);
      await waitForFence(leftPid, fence.pid, GLOBAL);
      await waitForFence(rightPid, fence.pid, GLOBAL);
      expect(await exactCharge(a.input.resource.id)).toBe('10');
      expect(await exactCharge(b.input.resource.id)).toBe('10');
      fence.release();
      await fence.done;
      const results = await Promise.all([left.done, right.done]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.filter((result) => result === undefined)).toHaveLength(1);
      const charges = await Promise.all([exactCharge(a.input.resource.id), exactCharge(b.input.resource.id)]);
      expect(charges.sort()).toEqual(['10', '20']);
      const {
        rows: [total],
      } = await sql<{ bytes: string }>`SELECT sum("reservedBytes")::text AS bytes
        FROM public.icloud_resource WHERE status NOT IN ('finalized','removed')`.execute(db);
      expect(total.bytes).toBe('30');
      for (const [index, f] of [a, b].entries()) {
        expect(await f.staging.validationInputs(f.input)).toEqual(results[index]);
      }
    } finally {
      fence.release();
      await Promise.allSettled([fence.done, left.done, right.done]);
    }
  }, 30_000);

  it('retains the connection cap under overlapping same-resource reservations', async () => {
    // Schema minimum is 1 MiB: either full extra copy would exceed this connection's cap.
    const f = await settledPlan(524_289);
    vi.stubEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES', String(2 * 1024 ** 2));
    const fence = await holdFence(GLOBAL);
    const left = contender((connection) => stagingOn(connection, f).planValidationInput(f.input, f.plan));
    const right = contender((connection) =>
      stagingOn(connection, f).planValidationInput(f.input, { ...f.plan, pathNonce: randomUUID() }),
    );
    try {
      const [leftPid, rightPid] = await Promise.all([left.pid, right.pid]);
      expect(new Set([leftPid, rightPid, fence.pid]).size).toBe(3);
      // One transaction holds the item while waiting for global; the other waits for that item.
      const itemKey = iCloudItemClaimLockKey(f.input.ownerId, f.fresh.payload.binding.sourceAssetId);
      await waitForEitherOrder(leftPid, rightPid, fence.pid, itemKey);
      fence.release();
      await fence.done;
      expect(await Promise.all([left.done, right.done])).toEqual([undefined, undefined]);
      expect(await exactCharge(f.input.resource.id)).toBe('524289');
      expect(await f.staging.validationInputs(f.input)).toBeUndefined();
    } finally {
      fence.release();
      await Promise.allSettled([fence.done, left.done, right.done]);
    }
  }, 30_000);

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

  it.each(['reserve', 'allocate', 'recovery'] as const)(
    'takes the item fence before the budget fence in actual %s',
    async (method) => {
      const f = await settledPlan();
      const key = iCloudItemClaimLockKey(f.input.ownerId, f.fresh.payload.binding.sourceAssetId);
      const fence = await holdFence(key);
      const budgetFence = await holdFence(GLOBAL);
      const contenderCall = contender(async (connection) => {
        const staging = stagingOn(connection, f);
        if (method === 'reserve') return staging.planValidationInput(f.input, f.plan);
        if (method === 'allocate') {
          return new ICloudScheduledWorkerRepository(connection, staging).allocate(f.input.authority, f.input.ownerId);
        }
        const verified: VerifiedMedia = {
          status: 'healthy',
          reason: 'verified',
          sha1: Buffer.from(f.fresh.payload.sha1, 'hex'),
          sha256: Buffer.from(f.fresh.payload.sha256, 'hex'),
          sizeInBytes: f.bytes.length,
          identity: f.fresh.payload.identity,
        };
        // Matching digest intentionally refuses recovery after admission; only its actual lock prefix is qualified.
        return new MediaRecoveryRepository(connection, staging).reserve({
          ownerId: f.input.ownerId,
          resourceId: f.input.resource.id,
          leaseToken: f.input.resource.leaseToken,
          includeHidden: false,
          audit: f.input.authority,
          verified,
          outcome: 'imported',
          proposedPath: join(f.directory, '.icloud-recovery', 'prefix-witness'),
        });
      });
      try {
        const pid = await contenderCall.pid;
        expect(pid).not.toBe(fence.pid);
        await waitForPrefix(pid, fence.pid, budgetFence.pid, key);
        const {
          rows: [locks],
        } = await sql<{ budgetLocks: string }>`SELECT count(*)::text AS "budgetLocks"
          FROM pg_locks WHERE pid=${pid} AND locktype='advisory'
          AND classid=((hashtextextended(${GLOBAL},0)>>32)&4294967295)::oid
          AND objid=(hashtextextended(${GLOBAL},0)&4294967295)::oid AND objsubid=1`.execute(db);
        expect(locks.budgetLocks).toBe('0');
        budgetFence.release();
        await budgetFence.done;
        await db.transaction().execute(async (tx) => {
          const {
            rows: [available],
          } = await sql<{ acquired: boolean }>`SELECT
            pg_try_advisory_xact_lock(hashtextextended(${GLOBAL},0)) AS acquired`.execute(tx);
          expect(available.acquired).toBe(true);
        });
        fence.release();
        await fence.done;
        const result = await contenderCall.done;
        if (method === 'reserve') {
          expect(result).toBeDefined();
          expect(await exactCharge(f.input.resource.id)).toBe('20');
        } else {
          // Existing live lease refuses allocation/recovery after the actual item-before-budget prefix.
          expect(result).toBeUndefined();
          expect(await exactCharge(f.input.resource.id)).toBe('10');
        }
      } finally {
        fence.release();
        budgetFence.release();
        await Promise.allSettled([fence.done, budgetFence.done, contenderCall.done]);
      }
    },
    30_000,
  );

  it('rejects the losing generation replacement and preserves an exact successor beyond uint64', async () => {
    const f = await settledPlan();
    const first = await f.staging.planValidationInput(f.input, f.plan);
    if (!first) throw new Error('audit_history_seed_reservation_missing');
    const old = first.payload.current.payload;
    await mkdir(old.directoryPath, { mode: 0o700 });
    await writeFile(old.inputPath, f.bytes, { mode: 0o600, flag: 'wx' });
    const disposedPayload = {
      ...old,
      sequence: '18446744073709551615',
      state: 'disposed' as const,
      directoryIdentity: privateCopyIdentity(await stat(old.directoryPath)),
      inputIdentity: privateCopyIdentity(await stat(old.inputPath)),
    };
    await rm(old.directoryPath, { recursive: true });
    const historyPayload: ValidationInputEnvelope['payload'] = {
      ...first.payload,
      highWater: disposedPayload.sequence,
      previousDisposed: null,
      current: {
        payload: disposedPayload,
        seal: await f.transport.encodeSession(validationInputScope(disposedPayload), disposedPayload),
      },
    };
    const history: ValidationInputEnvelope = {
      payload: historyPayload,
      seal: await f.transport.encodeSession(validationInputsScope(historyPayload), historyPayload),
    };
    // Seed authenticated disposed history only; this is not disposal/refund qualification.
    await sql`UPDATE public.icloud_resource SET "reservedBytes"=10,
      verification=verification||jsonb_build_object('auditValidationInputs',${JSON.stringify(history)}::text::jsonb)
      WHERE id=${f.input.resource.id}::uuid`.execute(db);
    const planA = { ...f.plan, expected: history, pathNonce: randomUUID() };
    const planB = { ...planA, pathNonce: randomUUID() };
    const fence = await holdFence(GLOBAL);
    const left = contender((connection) => stagingOn(connection, f).planValidationInput(f.input, planA));
    const right = contender((connection) => stagingOn(connection, f).planValidationInput(f.input, planB));
    try {
      const [leftPid, rightPid] = await Promise.all([left.pid, right.pid]);
      expect(new Set([leftPid, rightPid, fence.pid]).size).toBe(3);
      await waitForEitherOrder(
        leftPid,
        rightPid,
        fence.pid,
        iCloudItemClaimLockKey(f.input.ownerId, f.fresh.payload.binding.sourceAssetId),
      );
      fence.release();
      await fence.done;
      const results = await Promise.all([left.done, right.done]);
      const winnerIndex = results.findIndex(Boolean);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.filter((result) => result === undefined)).toHaveLength(1);
      const winner = results[winnerIndex]!;
      expect(winner.payload.highWater).toBe('18446744073709551616');
      expect(winner.payload.previousDisposed).toEqual(history.payload.current);
      expect(await exactCharge(f.input.resource.id)).toBe('20');
      expect(await f.staging.validationInputs(f.input)).toEqual(winner);
      const plans = [planA, planB];
      expect(await f.staging.planValidationInput(f.input, plans[winnerIndex])).toEqual(winner);
      expect(await f.staging.planValidationInput(f.input, plans[1 - winnerIndex])).toBeUndefined();
      expect(await f.staging.planValidationInput(f.input, f.plan)).toBeUndefined();
      expect(await exactCharge(f.input.resource.id)).toBe('20');
    } finally {
      fence.release();
      await Promise.allSettled([fence.done, left.done, right.done]);
    }
  }, 30_000);
});
