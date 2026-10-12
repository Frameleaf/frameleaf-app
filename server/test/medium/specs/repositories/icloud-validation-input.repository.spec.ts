import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import { AssetType, ChecksumAlgorithm } from 'src/enum.js';
import { ICloudIdentityAdoptionRepository } from 'src/repositories/icloud-identity-adoption.repository.js';
import { ICloudIdentityRepository } from 'src/repositories/icloud-identity.repository.js';
import { lockICloudItemClaims } from 'src/repositories/icloud-item-claim-lock.js';
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
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import {
  ICloudScheduledStagingService,
  ScheduledFreshValidation,
} from 'src/services/icloud-scheduled-staging.service.js';
import { ICloudStagingService } from 'src/services/icloud-staging.service.js';
import { MediaIntegrityResult, MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { appleFingerprintHash } from 'src/utils/icloud-identity.js';
import {
  ValidationInputEnvelope,
  privateCopyIdentity,
  privateCopyScope,
  privateWorkScope,
  validPrivateWork,
  validationInputScope,
  validationInputsScope,
} from 'src/utils/icloud-private-copy.js';
import { canonicalJson } from 'src/utils/studio-project.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

const NAME = '32A01DD9-75DF-41B2-8773-80C153D73A5A';

// Source-only packet: these active causal tests require separately admitted private PostgreSQL execution.
describe('scheduled validation input durable accounting baseline', () => {
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
    // Test-only cleanup follows awaited validation settlement and shutdown in each test's finally.
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
    const sync = new ICloudSyncRepository(db);
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

  it.each([
    ['connection', 524_289, 2 * 1024 ** 2],
    ['global', 10, 19],
    ['sufficient', 10, 20],
  ] as const)(
    'accounts for the actual input before decoder submission: %s budget',
    async (_budget, size, globalLimit) => {
      const f = await arrangeScheduledInput(size);
      vi.stubEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES', String(globalLimit));
      const decoderResult = Promise.withResolvers<MediaIntegrityResult>();
      const decoderDone = Promise.withResolvers<void>();
      let decoderPath: string | undefined;
      const integrity = {
        validateWithSettlement({ path }: { path: string }) {
          decoderPath = path;
          return { result: decoderResult.promise, settled: decoderDone.promise, cancel: () => {} };
        },
      } as unknown as MediaIntegrityService;
      const sut = new ICloudScheduledStagingService(
        f.staging,
        { root: () => Promise.resolve(f.root) } as ICloudStagingService,
        f.transport,
        integrity,
      );
      let validation: ScheduledFreshValidation | undefined;
      try {
        expect(await sut.download(f.input)).toEqual(f.fresh);
        // Baseline only: preparation errors must fail setup, never masquerade as quota refusal.
        validation = await sut.validate(f.input);
        if (!decoderPath) throw new Error('fixture_decoder_submission_missing');
        const resource = await f.sync.resource(f.input.resource.id);
        expect(resource).toBeDefined();
        const durable = Number(resource!.reservedBytes);
        const {
          rows: [totals],
        } = await sql<{ global: number; connection: number }>`SELECT
          coalesce(sum("reservedBytes"),0)::float8 AS global,
          coalesce(sum("reservedBytes") FILTER (WHERE "connectionId"=${f.connection.id}::uuid),0)::float8 AS connection
          FROM public.icloud_resource WHERE status NOT IN ('finalized','removed')`.execute(db);
        expect(totals.global).toBe(durable);
        expect(totals.connection).toBe(durable);
        expect(await readFile(f.fresh.payload.path)).toEqual(f.bytes);
        // Actual copied bytes and SQL ledger are observed while decoder result/settlement are held.
        expect(await readFile(decoderPath)).toEqual(f.bytes);
        const physical = (await stat(f.fresh.payload.path)).size + (await stat(decoderPath)).size;
        if (_budget === 'sufficient') {
          expect(physical).toBe(20);
          expect(durable).toBe(physical);
        } else {
          expect(durable).toBe(size);
          expect(physical).toBeLessThanOrEqual(Math.min(f.connection.config.stagingBytes, globalLimit));
        }
      } finally {
        decoderResult.resolve({ status: 'transient', reason: 'decoder_unavailable' });
        decoderDone.resolve();
        await validation?.result;
        await validation?.settled;
        await sut.onShutdown();
      }
    },
    60_000,
  );

  // New reservation/CAS cases are source-authored only until Root executes this exact candidate in SQL.
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

  it.each([
    ['connection', 524_289, 2 * 1024 ** 2],
    ['global', 10, 19],
  ] as const)(
    'refuses an extra reservation under the %s quota before any input creation',
    async (_budget, size, limit) => {
      const f = await settledPlan(size);
      vi.stubEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES', String(limit));
      expect(await f.staging.planValidationInput(f.input, f.plan)).toBeUndefined();
      expect(Number((await f.sync.resource(f.input.resource.id))?.reservedBytes)).toBe(size);
      expect(await f.staging.validationInputs(f.input)).toBeUndefined();
      expect(await readdir(f.directory)).toEqual(['complete']);
    },
  );

  it('reserves ten full bytes once and refuses changed bindings, competing nonce and stale predecessor', async () => {
    const f = await settledPlan();
    vi.stubEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES', '20');
    const first = await f.staging.planValidationInput(f.input, f.plan);
    expect(first?.payload.highWater).toBe('1');
    expect(first?.payload.current.payload.reservedInputBytes).toBe(10);
    expect(await f.staging.validationInputs(f.input)).toEqual(first);
    expect(await f.staging.planValidationInput(f.input, f.plan)).toEqual(first);
    expect(await f.staging.planValidationInput(f.input, { ...f.plan, expected: first! })).toEqual(first);
    for (const changed of [
      { ...f.plan, pathNonce: randomUUID() },
      { ...f.plan, validationPath: join(f.directory, 'foreign') },
      { ...f.plan, sourceIdentity: { ...f.plan.sourceIdentity, ino: f.plan.sourceIdentity.ino + 1 } },
      { ...f.plan, fresh: { ...f.fresh, seal: 'wrong-purpose' } },
      { ...f.plan, stage: 'recovery-destination' as const, validationPath: join(f.directory, 'recovery') },
    ]) {
      expect(await f.staging.planValidationInput(f.input, changed)).toBeUndefined();
    }
    expect(Number((await f.sync.resource(f.input.resource.id))?.reservedBytes)).toBe(20);
    expect(await readdir(f.directory)).toEqual(['complete']);
  });

  it('charges source plus a production-created recovery receipt plus the destination input', async () => {
    const f = await settledPlan();
    const promotedPath = join(f.directory, 'recovery');
    // Target metadata is test arrangement; the existing copy producer alone creates its reservation.
    await sql`UPDATE public.icloud_resource SET "promotedPath"=${promotedPath},"expectedTarget"='{"outcome":"imported"}'::jsonb
      WHERE id=${f.input.resource.id}::uuid`.execute(db);
    expect(
      await db.transaction().execute(async (trx) => {
        await lockICloudItemClaims(trx, f.input.ownerId, [f.fresh.payload.binding.sourceAssetId]);
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('icloud-staging-reservations',0))`.execute(trx);
        return f.staging.planPrivateCopy(trx, f.input, promotedPath);
      }),
    ).toBe(true);
    const token = await f.staging.beginPrivateWork(f.input);
    const copy = (await f.staging.privateCopy(f.input))!;
    expect(copy).toBeDefined();
    await writeFile(promotedPath, await readFile(f.fresh.payload.path), { mode: 0o600, flag: 'wx' });
    const copied = { ...copy.payload, identity: privateCopyIdentity(await stat(promotedPath)), promoted: true };
    expect(
      await f.staging.storePrivateCopy(f.input, copy, {
        ...copy,
        payload: copied,
        seal: await f.transport.encodeSession(privateCopyScope(copied), copied),
      }),
    ).toBe(true);
    await f.staging.finishPrivateWork(f.input, token);
    expect(Number((await f.sync.resource(f.input.resource.id))?.reservedBytes)).toBe(20);
    const plan = {
      ...f.plan,
      stage: 'recovery-destination' as const,
      validationPath: promotedPath,
      sourceIdentity: copied.identity,
    };
    vi.stubEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES', '29');
    expect(await f.staging.planValidationInput(f.input, plan)).toBeUndefined();
    vi.stubEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES', '30');
    const reserved = await f.staging.planValidationInput(f.input, plan);
    expect(reserved?.payload.current.payload.copyGeneration).toBe(copy.payload.generation);
    expect(await f.staging.planValidationInput(f.input, plan)).toEqual(reserved);
    expect(Number((await f.sync.resource(f.input.resource.id))?.reservedBytes)).toBe(30);
    expect(await readFile(promotedPath)).toEqual(f.bytes);
    expect((await readdir(f.directory)).sort()).toEqual(['complete', 'recovery']);
  });

  it('retains a compacted exact decimal mark, replays its successor and preserves it across lease renewal', async () => {
    const f = await settledPlan();
    const first = (await f.staging.planValidationInput(f.input, f.plan))!;
    expect(first).toBeDefined();
    // Historical receipt seed only: Task 3 owns production disposal qualification.
    // Use actual owned identities and remove the fixture file before seeding disposed history.
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
    const disposedRecord = {
      payload: disposedPayload,
      seal: await f.transport.encodeSession(validationInputScope(disposedPayload), disposedPayload),
    };
    const historyPayload: ValidationInputEnvelope['payload'] = {
      ...first.payload,
      highWater: disposedPayload.sequence,
      current: disposedRecord,
      previousDisposed: null,
    };
    const history = {
      payload: historyPayload,
      seal: await f.transport.encodeSession(validationInputsScope(historyPayload), historyPayload),
    };
    await sql`UPDATE public.icloud_resource SET "reservedBytes"=10,
      verification=verification||jsonb_build_object('auditValidationInputs',${JSON.stringify(history)}::text::jsonb,'unrelatedWitness',true),
      "leaseExpiresAt"=clock_timestamp()-interval '1 second' WHERE id=${f.input.resource.id}::uuid`.execute(db);
    const renewed = await f.worker.allocate(f.input.authority, f.input.ownerId);
    expect(renewed?.leaseToken).toBeDefined();
    expect(renewed?.leaseToken).not.toBe(f.input.resource.leaseToken);
    expect(await f.staging.validationInputs(f.input)).toEqual(history);
    const input = { ...f.input, resource: { id: f.input.resource.id, leaseToken: renewed!.leaseToken! } };
    const successorPlan = { ...f.plan, expected: history, pathNonce: randomUUID() };
    // An authentically settled prior-lease work receipt permits reservation, never unknown old work.
    const successor = await f.staging.planValidationInput(input, successorPlan);
    expect(successor?.payload.highWater).toBe('18446744073709551616');
    expect(successor?.payload.previousDisposed).toEqual(history.payload.current);
    expect(await f.staging.planValidationInput(input, successorPlan)).toEqual(successor);
    expect(await f.staging.planValidationInput(input, { ...successorPlan, expected: successor! })).toEqual(successor);
    expect(await f.staging.planValidationInput(input, { ...successorPlan, expected: first })).toBeUndefined();
    expect(
      await f.staging.planValidationInput(input, { ...successorPlan, pathNonce: f.plan.pathNonce }),
    ).toBeUndefined();
    expect(await f.staging.planValidationInput(f.input, successorPlan)).toBeUndefined();
    const resource = (await f.sync.resource(f.input.resource.id))!;
    expect(Number(resource.reservedBytes)).toBe(20);
    expect(resource.verification?.unrelatedWitness).toBe(true);
    expect(await readdir(f.directory)).toEqual(['complete']);
  });

  it('refuses corrupted envelope and old purpose seals without changing durable evidence', async () => {
    const f = await settledPlan();
    const first = (await f.staging.planValidationInput(f.input, f.plan))!;
    for (const corrupted of [
      { ...first, seal: f.fresh.seal },
      { ...first, payload: { ...first.payload, current: { ...first.payload.current, seal: f.fresh.seal } } },
      { ...first, payload: { ...first.payload, highWater: '0' } },
    ]) {
      await sql`UPDATE public.icloud_resource SET verification=verification||jsonb_build_object('auditValidationInputs',${JSON.stringify(corrupted)}::text::jsonb)
        WHERE id=${f.input.resource.id}::uuid`.execute(db);
      await expect(f.staging.validationInputs(f.input)).rejects.toThrow();
      expect(await f.staging.planValidationInput(f.input, { ...f.plan, expected: first })).toBeUndefined();
      expect(Number((await f.sync.resource(f.input.resource.id))?.reservedBytes)).toBe(20);
    }
  });

  it('retains absent, pending, malformed legacy work and admits only authenticated settled work', async () => {
    const f = await arrangeScheduledInput();
    const plan: ValidationInputPlan = {
      expected: null,
      pathNonce: randomUUID(),
      stage: 'source',
      fresh: f.fresh,
      validationPath: f.fresh.payload.path,
      sourceIdentity: privateCopyIdentity(await stat(f.fresh.payload.path)),
      stagingDirectory: f.directory,
    };
    expect(await f.staging.planValidationInput(f.input, plan)).toBeUndefined();
    const token = await f.staging.beginPrivateWork(f.input);
    expect(await f.staging.planValidationInput(f.input, plan)).toBeUndefined();
    expect(await readFile(f.fresh.payload.path)).toEqual(f.bytes);
    await f.staging.finishPrivateWork(f.input, token);
    const before = (await f.sync.resource(f.input.resource.id))!.verification;
    await sql`UPDATE public.icloud_resource SET verification=verification||'{"auditOwnedWork":{"unknown":true}}'::jsonb
      WHERE id=${f.input.resource.id}::uuid`.execute(db);
    expect(await f.staging.planValidationInput(f.input, plan)).toBeUndefined();
    await sql`UPDATE public.icloud_resource SET verification=${JSON.stringify(before)}::text::jsonb
      WHERE id=${f.input.resource.id}::uuid`.execute(db);
    expect(await f.staging.planValidationInput(f.input, plan)).toBeDefined();
  });

  it('refuses changed old work lease/copy generation and inconsistent aggregates without charging', async () => {
    const f = await settledPlan();
    const before = (await f.sync.resource(f.input.resource.id))!.verification!;
    const work = before.auditOwnedWork;
    if (!validPrivateWork(work)) throw new Error('fixture_work_receipt_missing');
    for (const payload of [
      { ...work.payload, resourceLeaseToken: randomUUID() },
      { ...work.payload, operationClaimToken: randomUUID() },
      { ...work.payload, copyGeneration: randomUUID() },
    ]) {
      const altered = { payload, seal: await f.transport.encodeSession(privateWorkScope(payload), payload) };
      await sql`UPDATE public.icloud_resource SET verification=verification||jsonb_build_object('auditOwnedWork',${JSON.stringify(altered)}::text::jsonb)
        WHERE id=${f.input.resource.id}::uuid`.execute(db);
      expect(await f.staging.planValidationInput(f.input, f.plan)).toBeUndefined();
      expect(Number((await f.sync.resource(f.input.resource.id))?.reservedBytes)).toBe(10);
    }
    await sql`UPDATE public.icloud_resource SET verification=${JSON.stringify(before)}::text::jsonb,"reservedBytes"=9
      WHERE id=${f.input.resource.id}::uuid`.execute(db);
    expect(await f.staging.planValidationInput(f.input, f.plan)).toBeUndefined();
    expect(Number((await f.sync.resource(f.input.resource.id))?.reservedBytes)).toBe(9);
    expect(await readdir(f.directory)).toEqual(['complete']);
  });

  it('CASes owned preparing/running/settled identities without refunds, including after grant revocation', async () => {
    const f = await settledPlan();
    const reserved = (await f.staging.planValidationInput(f.input, f.plan))!;
    expect(reserved).toBeDefined();
    const token = await f.staging.beginPrivateWork(f.input);
    const payload = reserved.payload.current.payload;
    await mkdir(payload.directoryPath, { mode: 0o700 });
    await writeFile(payload.inputPath, Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
    const preparingPayload = {
      ...payload,
      state: 'preparing' as const,
      pending: [token],
      directoryIdentity: privateCopyIdentity(await stat(payload.directoryPath)),
      inputIdentity: privateCopyIdentity(await stat(payload.inputPath)),
    };
    expect(
      await f.staging.storeValidationInput(f.input, reserved, {
        ...preparingPayload,
        inputIdentity: { ...preparingPayload.inputIdentity, uid: preparingPayload.inputIdentity.uid + 1 },
      }),
    ).toBeUndefined();
    const preparing = (await f.staging.storeValidationInput(f.input, reserved, preparingPayload))!;
    expect(preparing).toBeDefined();
    expect(await f.staging.storeValidationInput(f.input, reserved, preparingPayload)).toBeUndefined();
    expect(
      await f.staging.storeValidationInput(f.input, preparing, { ...preparingPayload, ownerId: randomUUID() }),
    ).toBeUndefined();
    await writeFile(payload.inputPath, f.bytes);
    const runningPayload = {
      ...preparingPayload,
      state: 'running' as const,
      inputIdentity: privateCopyIdentity(await stat(payload.inputPath)),
    };
    expect(
      await f.staging.storeValidationInput(f.input, preparing, {
        ...runningPayload,
        inputIdentity: { ...runningPayload.inputIdentity, ino: runningPayload.inputIdentity.ino + 1 },
      }),
    ).toBeUndefined();
    const running = (await f.staging.storeValidationInput(f.input, preparing, runningPayload))!;
    expect(running).toBeDefined();
    expect(
      await f.staging.storeValidationInput(f.input, running, { ...runningPayload, state: 'disposed', pending: [] }),
    ).toBeUndefined();
    await sql`UPDATE public.icloud_weekly_grant SET enabled=false WHERE "connectionId"=${f.connection.id}::uuid`.execute(
      db,
    );
    expect(await f.staging.storeValidationInput(f.input, running, runningPayload)).toBeUndefined();
    const settled = await f.staging.storeValidationInput(f.input, running, {
      ...runningPayload,
      state: 'settled',
      pending: [],
    });
    expect(settled?.payload.current.payload.state).toBe('settled');
    expect(await f.staging.validationInputs(f.input)).toEqual(settled);
    expect(Number((await f.sync.resource(f.input.resource.id))?.reservedBytes)).toBe(20);
    expect(await readFile(payload.inputPath)).toEqual(f.bytes);
    await f.staging.finishPrivateWork(f.input, token);
  });

  it('refuses unknown input envelopes and lease renewal over retained input without resetting evidence', async () => {
    const f = await settledPlan();
    const first = await f.staging.planValidationInput(f.input, f.plan);
    expect(first).toBeDefined();
    await sql`UPDATE public.icloud_resource SET "leaseExpiresAt"=clock_timestamp()-interval '1 second'
      WHERE id=${f.input.resource.id}::uuid`.execute(db);
    expect(await f.worker.allocate(f.input.authority, f.input.ownerId)).toBeUndefined();
    expect(await f.staging.validationInputs(f.input)).toEqual(first);
    await sql`UPDATE public.icloud_resource SET verification=verification||'{"auditValidationInputs":{"version":99}}'::jsonb
      WHERE id=${f.input.resource.id}::uuid`.execute(db);
    await expect(f.staging.validationInputs(f.input)).rejects.toThrow('validation_inputs_invalid');
    expect(await f.worker.allocate(f.input.authority, f.input.ownerId)).toBeUndefined();
    expect(Number((await f.sync.resource(f.input.resource.id))?.reservedBytes)).toBe(20);
  });
});
