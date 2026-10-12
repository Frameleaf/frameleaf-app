import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import { AssetType, ChecksumAlgorithm } from 'src/enum.js';
import { ICloudAuditRepository } from 'src/repositories/icloud-audit.repository.js';
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
import { ICloudResource, ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { ICloudTransportRepository } from 'src/repositories/icloud-transport.repository.js';
import { ICloudWeeklyRepository } from 'src/repositories/icloud-weekly.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { appleFingerprintHash } from 'src/utils/icloud-identity.js';
import { privateCopyIdentity, privateCopyScope } from 'src/utils/icloud-private-copy.js';
import { canonicalJson } from 'src/utils/studio-project.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

const NAME = '32A01DD9-75DF-41B2-8773-80C153D73A5A';

describe('validation input release boundaries', () => {
  let db: Kysely<DB>;
  const connections = new Set<string>();
  const directories = new Set<string>();

  beforeAll(async () => {
    db = await getKyselyDB();
    const {
      rows: [database],
    } = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
    if (!/^frameleaf_[a-z0-9_]+$/.test(database.name)) throw new Error('fixture_database_not_private_clone');
    await sql`SET statement_timeout='7s'`.execute(db);
    await sql`SET lock_timeout='6s'`.execute(db);
    await sql`SET idle_in_transaction_session_timeout='10s'`.execute(db);
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
    // Every repository operation has settled before test-only cleanup.
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
    const sync = new ICloudSyncRepository(
      db,
      new ICloudScheduledStagingRepository(db, new ICloudTransportRepository()),
    );
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
    return {
      input,
      staging,
      worker,
      connection,
      directory,
      root,
      fresh,
      transport,
      sync: new ICloudSyncRepository(db, staging),
      bytes,
      source,
    };
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

  type Fixture = Awaited<ReturnType<typeof settledPlan>>;
  type Evidence = 'undisposed' | 'malformed';

  async function retainedInput(f: Fixture, evidence: Evidence) {
    const { settled, token, payload } = await settleInput(f);
    await f.staging.finishPrivateWork(f.input, token);
    if (evidence === 'malformed') {
      await sql`UPDATE public.icloud_resource SET verification=verification||
        '{"auditValidationInputs":{"version":99}}'::jsonb WHERE id=${payload.resourceId}::uuid`.execute(db);
    }
    return { settled, payload };
  }

  async function retire(f: Fixture) {
    expect(await f.worker.settleUnavailable(f.input.authority, f.input.ownerId, 'cancelled')).toBe(true);
    expect(await f.sync.resource(f.input.resource.id)).toMatchObject({
      status: 'failed',
      leaseToken: null,
      leaseExpiresAt: null,
    });
  }

  async function row(f: Fixture, resourceId = f.input.resource.id) {
    const resource = await f.sync.resource(resourceId);
    if (!resource) throw new Error('fixture_resource_missing');
    return resource;
  }

  async function expectRetained(f: Fixture, before: ICloudResource, inputPath?: string) {
    expect(await row(f, before.id)).toMatchObject({
      status: before.status,
      reservedBytes: before.reservedBytes,
      verification: before.verification,
      stagingPath: before.stagingPath,
      leaseToken: before.leaseToken,
      leaseExpiresAt: before.leaseExpiresAt,
      attempts: before.attempts,
    });
    expect(await readFile(f.fresh.payload.path)).toEqual(f.bytes);
    if (inputPath) expect(await readFile(inputPath)).toEqual(f.bytes);
    const {
      rows: [sum],
    } = await sql<{ nonnegative: boolean }>`SELECT bool_and("reservedBytes">=0) AS nonnegative
      FROM public.icloud_resource WHERE "connectionId"=${f.connection.id}::uuid`.execute(db);
    expect(sum.nonnegative).toBe(true);
  }

  async function recoveryCopy(f: Fixture) {
    const directory = join(f.directory, '.icloud-recovery');
    await mkdir(directory, { mode: 0o700 });
    const promotedPath = join(directory, 'recovery');
    // Only destination metadata is arranged; the production producer reserves and seals custody.
    await sql`UPDATE public.icloud_resource SET "promotedPath"=${promotedPath},
      "expectedTarget"='{"outcome":"imported"}'::jsonb WHERE id=${f.input.resource.id}::uuid`.execute(db);
    expect(
      await db.transaction().execute(async (tx) => {
        await lockICloudItemClaims(tx, f.input.ownerId, [f.fresh.payload.binding.sourceAssetId]);
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('icloud-staging-reservations',0))`.execute(tx);
        return f.staging.planPrivateCopy(tx, f.input, promotedPath);
      }),
    ).toBe(true);
    const token = await f.staging.beginPrivateWork(f.input);
    const copy = (await f.staging.privateCopy(f.input))!;
    expect(copy).toBeDefined();
    await writeFile(promotedPath, f.bytes, { mode: 0o600, flag: 'wx' });
    const copied = { ...copy.payload, identity: privateCopyIdentity(await stat(promotedPath)), promoted: true };
    expect(
      await f.staging.storePrivateCopy(f.input, copy, {
        ...copy,
        payload: copied,
        seal: await f.transport.encodeSession(privateCopyScope(copied), copied),
      }),
    ).toBe(true);
    await f.staging.finishPrivateWork(f.input, token);
    expect((await row(f)).reservedBytes).toBe(20);
    return promotedPath;
  }

  it('subtracts only the disposed recovery charge from source10 plus recovery10 plus input10', async () => {
    const f = await settledPlan();
    const promotedPath = await recoveryCopy(f);
    // Source-stage input deliberately does not reserve the recovery destination as its validation path.
    const { payload } = await retainedInput(f, 'undisposed');
    expect((await row(f)).reservedBytes).toBe(30);
    await retire(f);
    const before = await row(f);
    expect(await f.staging.disposePrivateCopy(f.input)).toBe(true);
    const after = await row(f);
    expect(after.reservedBytes).toBe(20);
    expect(after.verification?.auditValidationInputs).toEqual(before.verification?.auditValidationInputs);
    expect(after.status).toBe('failed');
    expect(after.verification?.auditPrivateCopy).toMatchObject({ payload: { disposed: true } });
    expect(await readFile(payload.inputPath)).toEqual(f.bytes);
    expect(await readFile(f.fresh.payload.path)).toEqual(f.bytes);
    await expect(stat(promotedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['undisposed', 'malformed'] as const)(
    'disposeRefusedStaging retains the source and full charge for %s input',
    async (evidence) => {
      const f = await settledPlan();
      const { payload } = await retainedInput(f, evidence);
      await retire(f);
      const before = await row(f);
      expect(before.reservedBytes).toBe(20);
      expect(await f.staging.disposeRefusedStaging(f.input)).toBe(false);
      await expectRetained(f, before, payload.inputPath);
    },
  );

  it.each(['undisposed', 'malformed'] as const)(
    'releaseRefusedBytes cannot zero a failed resource with %s input',
    async (evidence) => {
      const f = await settledPlan();
      const { payload } = await retainedInput(f, evidence);
      await retire(f);
      const before = await row(f);
      expect(before.reservedBytes).toBe(20);
      await f.staging.releaseRefusedBytes(f.input);
      await expectRetained(f, before, payload.inputPath);
    },
  );

  async function committedMatch(f: Fixture) {
    // Arrange cleanup eligibility only, not publication or provider verification authority.
    // The input envelope and work receipt remain those produced by actual repository methods.
    const resource = await row(f);
    const receipt = {
      kind: 'audit-match-staging',
      resourceId: resource.id,
      requestId: f.input.authority.auditRequestId,
      ownerId: f.input.ownerId,
      stagingPath: f.fresh.payload.path,
      sha256: f.fresh.payload.sha256,
      sizeInBytes: f.bytes.length,
    };
    await sql`UPDATE public.icloud_identity_audit SET result='match'
      WHERE id=${f.input.authority.auditRequestId}::uuid`.execute(db);
    await sql`UPDATE public.icloud_resource SET status='committed',
      verification=verification||${JSON.stringify(receipt)}::text::jsonb
      WHERE id=${resource.id}::uuid`.execute(db);
    const current = await row(f);
    expect(current).toMatchObject({ status: 'committed', pendingJobs: [], assetId: null, promotedPath: null });
    expect(current.verification).toMatchObject(receipt);
    return current;
  }

  it.each(['undisposed', 'malformed'] as const)(
    'audit housekeeping refuses the physical callback and zero for %s input',
    async (evidence) => {
      const f = await settledPlan();
      const { payload } = await retainedInput(f, evidence);
      const before = await committedMatch(f);
      const cleanup = vi.fn(async () => unlink(f.fresh.payload.path));
      await new ICloudAuditRepository(db, f.staging).housekeeping(cleanup);
      expect(cleanup).not.toHaveBeenCalled();
      await expectRetained(f, before, payload.inputPath);
      expect(await row(f)).toMatchObject({ lastError: 'scheduled_validation_input_retained_unproven' });
    },
  );

  it('audit housekeeping still cleans eligible legacy work with authenticated settlement and no input', async () => {
    const f = await settledPlan();
    await committedMatch(f);
    const cleanup = vi.fn(async () => unlink(f.fresh.payload.path));
    await new ICloudAuditRepository(db, f.staging).housekeeping(cleanup);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(await row(f)).toMatchObject({ status: 'finalized', reservedBytes: 0 });
    await expect(stat(f.fresh.payload.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['source-disposal', 'byte-release'] as const)(
    'terminal %s succeeds after authenticated input disposal',
    async (method) => {
      const f = await settledPlan();
      const { settled, token } = await settleInput(f);
      expect(await f.staging.disposeValidationInput(f.input, settled)).toBe(true);
      await f.staging.finishPrivateWork(f.input, token);
      await retire(f);
      if (method === 'source-disposal') {
        expect(await f.staging.disposeRefusedStaging(f.input)).toBe(true);
        await expect(stat(f.fresh.payload.path)).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        // This helper grants no physical cleanup authority; only its authenticated byte gate is tested.
        await f.staging.releaseRefusedBytes(f.input);
        expect(await readFile(f.fresh.payload.path)).toEqual(f.bytes);
      }
      expect(await row(f)).toMatchObject({ status: 'removed', reservedBytes: 0 });
    },
  );
  const genericEvidence = [
    'scheduled-absent',
    'scheduled-undisposed',
    'scheduled-malformed',
    'ordinary-foreign-envelope',
    'ordinary-malformed',
  ] as const;
  type GenericEvidence = (typeof genericEvidence)[number];

  async function genericFixture(kind: GenericEvidence) {
    const f = await settledPlan();
    const held = kind === 'scheduled-absent' ? undefined : await retainedInput(f, 'undisposed');
    if (kind.startsWith('ordinary')) {
      // Retire the scheduled lease through its actual producer before ordinary admission, so the
      // connection's unchanged concurrency1 budget cannot mask a missing envelope guard.
      await retire(f);
      await sql`UPDATE public.icloud_resource SET status='pending',"leaseToken"=NULL,"leaseExpiresAt"=NULL,
        "reservedBytes"=0,"stagingPath"=NULL,"nextAttemptAt"=NULL WHERE id=${f.source.id}::uuid`.execute(db);
      const ordinary = await f.sync.claim(f.connection.id, f.connection.config.stagingBytes);
      expect(ordinary?.id).toBe(f.source.id);
      if (!ordinary) throw new Error('fixture_ordinary_admission_missing');
      // Foreign authenticated evidence is intentionally inconsistent on this ordinary row. Presence
      // must retain it conservatively; it never grants authority to use the donor generation.
      const value = kind === 'ordinary-malformed' ? { version: 99 } : held!.settled;
      await sql`UPDATE public.icloud_resource SET verification=jsonb_build_object(
        'auditValidationInputs',${JSON.stringify(value)}::text::jsonb) WHERE id=${ordinary.id}::uuid`.execute(db);
      return { f, resource: await row(f, ordinary.id), inputPath: held!.payload.inputPath };
    }
    if (kind === 'scheduled-malformed') {
      await sql`UPDATE public.icloud_resource SET verification=verification||
        '{"auditValidationInputs":{"version":99}}'::jsonb WHERE id=${f.input.resource.id}::uuid`.execute(db);
    }
    return { f, resource: await row(f), inputPath: held?.payload.inputPath };
  }

  it.each(genericEvidence)(
    'ordinary sync claim repair retains %s charge when no staging path or lease remains',
    async (kind) => {
      const { f, resource, inputPath } = await genericFixture(kind);
      if (!kind.startsWith('ordinary')) await retire(f);
      // Exercise the leaked-reservation repair predicate, not admission or a live lease refusal.
      await sql`UPDATE public.icloud_resource SET status='failed',"leaseToken"=NULL,
        "leaseExpiresAt"=NULL,"stagingPath"=NULL WHERE id=${resource.id}::uuid`.execute(db);
      const before = await row(f, resource.id);
      expect(await f.sync.claim(f.connection.id, f.connection.config.stagingBytes)).toBeUndefined();
      expect(await row(f, resource.id)).toEqual(before);
      await expectRetained(f, before, inputPath);
    },
  );

  it.each(genericEvidence)('ordinary sync claim selection cannot renew %s as an ordinary candidate', async (kind) => {
    const { f, resource, inputPath } = await genericFixture(kind);
    if (!kind.startsWith('ordinary')) await retire(f);
    // Committed cleanup admission bypasses byte/concurrency refusal: exclusion must be the reason.
    await sql`UPDATE public.icloud_resource SET status='committed',"leaseToken"=NULL,
        "leaseExpiresAt"=NULL,"nextAttemptAt"=NULL WHERE id=${resource.id}::uuid`.execute(db);
    const before = await row(f, resource.id);
    expect(await f.sync.claim(f.connection.id, f.connection.config.stagingBytes)).toBeUndefined();
    expect(await row(f, resource.id)).toEqual(before);
    await expectRetained(f, before, inputPath);
  });

  it.each(genericEvidence)('ordinary sync finalize refuses cleanup and zero for %s', async (kind) => {
    const { f, resource, inputPath } = await genericFixture(kind);
    await sql`UPDATE public.icloud_resource SET status='committed',"pendingJobs"='[]'::jsonb
        WHERE id=${resource.id}::uuid`.execute(db);
    const before = await row(f, resource.id);
    expect(before.leaseToken).not.toBeNull();
    const cleanup = vi.fn(async () => unlink(f.fresh.payload.path));
    expect(await f.sync.finalize(before, cleanup)).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    expect(await row(f, resource.id)).toEqual(before);
    await expectRetained(f, before, inputPath);
  });

  it.each(genericEvidence)(
    'ordinary sync finish independently refuses status, cleanup and charge release for %s',
    async (kind) => {
      const { f, resource, inputPath } = await genericFixture(kind);
      expect(resource.leaseToken).not.toBeNull();
      const cleanup = vi.fn(async () => unlink(f.fresh.payload.path));
      // Ensure terminal cleanup would be eligible if only the lease/status checks existed.
      await sql`UPDATE public.icloud_resource SET "stagingPath"=${f.fresh.payload.path}
        WHERE id=${resource.id}::uuid`.execute(db);
      const before = await row(f, resource.id);
      await f.sync.finish(before, 'failed', 'fixture_terminal', cleanup);
      expect(cleanup).not.toHaveBeenCalled();
      expect(await row(f, resource.id)).toEqual(before);
      await expectRetained(f, before, inputPath);
    },
  );

  it.each(genericEvidence)(
    'ordinary sync waitForClaim independently retains status, lease and charge for %s',
    async (kind) => {
      const { f, resource, inputPath } = await genericFixture(kind);
      expect(resource.leaseToken).not.toBeNull();
      const before = await row(f, resource.id);
      await f.sync.waitForClaim(before, new Date(Date.now() + 60_000));
      expect(await row(f, resource.id)).toEqual(before);
      await expectRetained(f, before, inputPath);
    },
  );

  async function removableConnection(f: Fixture) {
    await retire(f);
    // Terminal operation/connection state is cleanup eligibility, never synthetic admission authority.
    await sql`UPDATE public.media_operation SET status='cancelled',"claimToken"=NULL,"claimExpiresAt"=NULL
      WHERE id=${f.input.authority.operationId}::uuid`.execute(db);
    await f.sync.update(f.connection.id, f.input.ownerId, { state: 'disconnected', encryptedSession: null });
  }

  it.each(['undisposed', 'malformed'] as const)(
    'connection remove refuses its callback and cascade with %s input',
    async (evidence) => {
      const f = await settledPlan();
      const { payload } = await retainedInput(f, evidence);
      await removableConnection(f);
      const before = await row(f);
      const cleanup = vi.fn(async () => unlink(f.fresh.payload.path));
      expect(await f.sync.remove(f.connection.id, f.input.ownerId, cleanup)).toBe('in-flight');
      expect(cleanup).not.toHaveBeenCalled();
      expect(
        (
          await sql<{ id: string }>`SELECT id FROM public.icloud_connection WHERE id=${f.connection.id}::uuid`.execute(
            db,
          )
        ).rows,
      ).toEqual([{ id: f.connection.id }]);
      expect(await row(f)).toEqual(before);
      await expectRetained(f, before, payload.inputPath);
    },
  );

  it('connection remove still cascades an eligible settled absent-input legacy connection', async () => {
    const f = await settledPlan();
    await removableConnection(f);
    const cleanup = vi.fn(async () => unlink(f.fresh.payload.path));
    expect(await f.sync.remove(f.connection.id, f.input.ownerId, cleanup)).toBe('removed');
    expect(cleanup).toHaveBeenCalledOnce();
    expect(
      (await sql<{ id: string }>`SELECT id FROM public.icloud_connection WHERE id=${f.connection.id}::uuid`.execute(db))
        .rows,
    ).toEqual([]);
    expect(await f.sync.resource(f.input.resource.id)).toBeUndefined();
    await expect(stat(f.fresh.payload.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  async function ordinaryWithoutInput() {
    const f = await settledPlan();
    await retire(f);
    await sql`UPDATE public.icloud_resource SET status='pending',"leaseToken"=NULL,"leaseExpiresAt"=NULL,
      "reservedBytes"=0,"stagingPath"=NULL,"nextAttemptAt"=NULL WHERE id=${f.source.id}::uuid`.execute(db);
    const resource = await f.sync.claim(f.connection.id, f.connection.config.stagingBytes);
    expect(resource?.id).toBe(f.source.id);
    if (!resource) throw new Error('fixture_ordinary_admission_missing');
    expect(resource.reservedBytes).toBe(10);
    expect(resource.auditRequestId).toBeNull();
    expect(Object.hasOwn(resource.verification ?? {}, 'auditValidationInputs')).toBe(false);
    return { f, resource };
  }

  it('ordinary sync still repairs absent-input leaked reservations', async () => {
    const { f, resource } = await ordinaryWithoutInput();
    await sql`UPDATE public.icloud_resource SET status='failed',"leaseToken"=NULL,"leaseExpiresAt"=NULL,
      "stagingPath"=NULL WHERE id=${resource.id}::uuid`.execute(db);
    expect(await f.sync.claim(f.connection.id, f.connection.config.stagingBytes)).toBeUndefined();
    expect(await row(f, resource.id)).toMatchObject({ status: 'failed', reservedBytes: 0 });
  });

  it('ordinary sync still finalizes an absent-input committed resource through its cleanup callback', async () => {
    const { f, resource } = await ordinaryWithoutInput();
    await sql`UPDATE public.icloud_resource SET status='committed',"pendingJobs"='[]'::jsonb
      WHERE id=${resource.id}::uuid`.execute(db);
    const cleanup = vi.fn(async () => {});
    expect(await f.sync.finalize(await row(f, resource.id), cleanup)).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(await row(f, resource.id)).toMatchObject({ status: 'finalized', reservedBytes: 0, leaseToken: null });
  });

  it('ordinary sync still finishes absent-input terminal work and invokes cleanup', async () => {
    const { f, resource } = await ordinaryWithoutInput();
    await sql`UPDATE public.icloud_resource SET "stagingPath"=${f.fresh.payload.path}
      WHERE id=${resource.id}::uuid`.execute(db);
    const cleanup = vi.fn(async () => unlink(f.fresh.payload.path));
    await f.sync.finish(await row(f, resource.id), 'failed', 'fixture_terminal', cleanup);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(await row(f, resource.id)).toMatchObject({ status: 'failed', reservedBytes: 0, leaseToken: null });
  });

  it('ordinary sync still defers absent-input work without charging another attempt', async () => {
    const { f, resource } = await ordinaryWithoutInput();
    const until = new Date(Date.now() + 60_000);
    await f.sync.waitForClaim(resource, until);
    expect(await row(f, resource.id)).toMatchObject({
      status: 'pending',
      lastError: 'icloud_claimed',
      leaseToken: null,
      reservedBytes: 0,
      attempts: resource.attempts,
      nextAttemptAt: until,
    });
  });
});
