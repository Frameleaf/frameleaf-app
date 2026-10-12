import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import { AssetType, ChecksumAlgorithm } from 'src/enum.js';
import { ICloudIdentityAdoptionRepository } from 'src/repositories/icloud-identity-adoption.repository.js';
import { ICloudIdentityRepository } from 'src/repositories/icloud-identity.repository.js';
import { ScheduledAuditAuthority } from 'src/repositories/icloud-scheduled-authority.js';
import {
  ICloudScheduledStagingRepository,
  ScheduledFreshDownload,
  ScheduledFreshPayload,
  ScheduledStagingInput,
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
        // Exercise real cached-file admission first so quota refusal cannot hide a stale receipt/path.
        expect(await sut.download(f.input)).toEqual(f.fresh);
        try {
          validation = await sut.validate(f.input);
        } catch (error) {
          // Only a genuine quota refusal is admissible; sufficient quota must reach the held decoder.
          if (_budget === 'sufficient') throw error;
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe('scheduled_audit_unavailable');
        }
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
        let physical = (await stat(f.fresh.payload.path)).size;
        if (decoderPath) {
          // Actual copied bytes and SQL ledger are observed while decoder result/settlement are held.
          expect(await readFile(decoderPath)).toEqual(f.bytes);
          physical += (await stat(decoderPath)).size;
        }
        if (_budget === 'sufficient') {
          expect(decoderPath).toBeDefined();
          expect(physical).toBe(20);
          expect(durable).toBe(physical);
        } else {
          expect(durable).toBe(size);
          expect(physical).toBeLessThanOrEqual(Math.min(f.connection.config.stagingBytes, globalLimit));
          expect(decoderPath).toBeUndefined();
          expect((await readdir(f.directory)).filter((name) => name.startsWith('.validation-'))).toEqual([]);
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
});
