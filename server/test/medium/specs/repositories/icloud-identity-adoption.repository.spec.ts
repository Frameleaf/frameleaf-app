import {
  CompiledQuery,
  Kysely,
  type KyselyPlugin,
  type QueryId,
  RawNode,
  SelectQueryNode,
  TableNode,
  sql,
} from 'kysely';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { FileHandle } from 'node:fs/promises';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import {
  AssetLockReason,
  AssetPathType,
  AssetStatus,
  AssetType,
  AssetVisibility,
  ChecksumAlgorithm,
  MediaOperationKind,
  PhysicalFileType,
  UserMetadataKey,
} from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { ICloudAuditRepository, guardAuditAuthority, publishAudit } from 'src/repositories/icloud-audit.repository.js';
import {
  ICloudIdentityAdoptionRepository,
  IdentityAdoptionAuthority,
} from 'src/repositories/icloud-identity-adoption.repository.js';
import { ICLOUD_SYNC_CLAIM_SEC, ICloudIdentityRepository } from 'src/repositories/icloud-identity.repository.js';
import { iCloudItemClaimLockKey } from 'src/repositories/icloud-item-claim-lock.js';
import {
  ScheduledAuditAuthority,
  guardScheduledAudit,
  scheduledAuditFinalFence,
} from 'src/repositories/icloud-scheduled-authority.js';
import { publishScheduledAudit } from 'src/repositories/icloud-scheduled-publication.js';
import {
  ICloudScheduledStagingRepository,
  ScheduledFreshPayload,
} from 'src/repositories/icloud-scheduled-staging.repository.js';
import { ICloudScheduledWorkerRepository } from 'src/repositories/icloud-scheduled-worker.repository.js';
import { type ICloudResource, ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { ICloudWeeklyRepository } from 'src/repositories/icloud-weekly.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRecoveryRepository } from 'src/repositories/media-recovery.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import {
  ICloudIdentityAdoptionService,
  identityAdoptionEnabled,
} from 'src/services/icloud-identity-adoption.service.js';
import { ICloudScheduledStagingService } from 'src/services/icloud-scheduled-staging.service.js';
import { ICloudScheduledWorkerService } from 'src/services/icloud-scheduled-worker.service.js';
import { ICloudStagingService } from 'src/services/icloud-staging.service.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { MediaRecoveryService } from 'src/services/media-recovery.service.js';
import { operationExecution } from 'src/utils/execution-signal.js';
import { appleFingerprintHash, identityRoleOf } from 'src/utils/icloud-identity.js';
import * as privateCopyFiles from 'src/utils/icloud-private-copy.js';
import { decryptICloudSession, encryptICloudSession } from 'src/utils/icloud-sync.js';
import { canonicalJson } from 'src/utils/studio-project.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB, getMocks } from 'test/utils.js';

const NAME = '32A01DD9-75DF-41B2-8773-80C153D73A5A';
const execFile = promisify(execFileCallback);
/** Real PG authority, same-handle file reads, native image decode and actual receipt publication. */
describe('iCloud exact identity adoption', () => {
  let db: Kysely<DB>;
  let sync: ICloudSyncRepository;
  let repository: ICloudIdentityAdoptionRepository;
  let identities: ICloudIdentityRepository;
  let media: MediaRepository;
  let integrity: MediaIntegrityService;
  let service: ICloudIdentityAdoptionService;
  let captureCompiledQuery: ((query: CompiledQuery) => void) | undefined;
  let stagedProofSettled: Promise<void> | undefined;
  const directories = new Set<string>();
  const connections = new Set<string>();
  beforeAll(async () => {
    db = await getKyselyDB(undefined, (event) => {
      if (event.level === 'query') {
        captureCompiledQuery?.(event.query);
      } else {
        // Emit only validated SQLSTATE and timing, never SQL, bindings, or driver error details.
        const code =
          event.error && typeof event.error === 'object' && 'code' in event.error ? event.error.code : undefined;
        console.error('iCloud qualification database query failed', {
          sqlState: typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown',
          durationMs: Number.isFinite(event.queryDurationMillis) ? Math.round(event.queryDurationMillis) : 0,
        });
      }
    });
    sync = new ICloudSyncRepository(db);
    repository = new ICloudIdentityAdoptionRepository(db);
    identities = new ICloudIdentityRepository(db);
  });
  beforeEach(() => {
    vi.stubEnv('FRAMELEAF_ICLOUD_IDENTITY_ADOPTION', 'true');
    vi.stubEnv('FRAMELEAF_ICLOUD_IDENTITY_MATCHING', 'true');
    // Runtime activation prerequisites for source contracts, never evidence of deployment qualification.
    vi.stubEnv('FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION', 'true');
    vi.stubEnv('FRAMELEAF_ICLOUD_BRIDGE_URL', 'https://icloud-contract.invalid');
    const mocks = getMocks();
    media = new MediaRepository(mocks.logger as never);
    integrity = new MediaIntegrityService(new StorageRepository(mocks.logger as never), new CryptoRepository(), media);
    service = new ICloudIdentityAdoptionService(repository, integrity);
  });
  afterEach(async () => {
    // Vitest runs onTestFinished after this hook; timed-out staging must settle before deletion.
    await stagedProofSettled;
    stagedProofSettled = undefined;
    captureCompiledQuery = undefined;
    await service.onShutdown();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (connections.size > 0) {
      await sql`DELETE FROM public.icloud_connection WHERE id=ANY(${[...connections]}::uuid[])`.execute(db);
      connections.clear();
    }
    await Promise.all([...directories].map((path) => rm(path, { recursive: true, force: true })));
    directories.clear();
  });
  afterAll(async () => {
    await db.destroy();
  });

  async function arrange(
    role: 'original' | 'raw' | 'motion' = 'original',
    config: { concurrency?: number; includeHidden?: boolean } = {},
    withWeeklyGrant = true,
  ) {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'identity-adoption-')));
    directories.add(directory);
    const originalFileName = role === 'motion' ? 'source.mov' : 'source.jpg';
    const originalPath = join(directory, originalFileName);
    if (role === 'motion') {
      await execFile('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=16x16:r=2:d=0.5',
        '-an',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        originalPath,
      ]);
    }
    const bytes =
      role === 'motion'
        ? await readFile(originalPath)
        : await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 33, g: 66, b: 99 } } })
            .jpeg()
            .toBuffer();
    await writeFile(originalPath, bytes);
    const sha256 = createHash('sha256').update(bytes).digest();
    const fingerprint = appleFingerprintHash();
    fingerprint.update(bytes);
    const resourceFingerprint = fingerprint.digest();
    const masterHash = appleFingerprintHash();
    masterHash.update(Buffer.from('separate still original'));
    const master = role === 'motion' ? masterHash.digest() : resourceFingerprint;
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      originalPath,
      originalFileName,
      type: role === 'motion' ? AssetType.Video : AssetType.Image,
      visibility: role === 'motion' ? AssetVisibility.Hidden : AssetVisibility.Timeline,
      checksum: sha256,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    const connection = (await sync.create(user.id, 'Photos', ICloudConfigSchema.parse(config)))!;
    connections.add(connection.id);
    await sync.update(connection.id, user.id, { state: 'connected', encryptedSession: 'fixture-session' });
    const field = (value: unknown) => ({ value });
    const descriptor = { size: bytes.length, fileChecksum: resourceFingerprint };
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
            filenameEnc: field(originalFileName),
            itemType: field(role === 'motion' ? 'public.movie' : 'public.jpeg'),
            ...(role === 'original'
              ? { resOriginalRes: field(descriptor) }
              : role === 'motion'
                ? { resOriginalVidComplRes: field(descriptor) }
                : { resOriginalAltRes: field(descriptor), resOriginalAltFileType: field('public.jpeg') }),
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
    const operation = await sync.queueOperation(connection.id, user.id, { trigger: 'manual' });
    if (operation.outcome !== 'created') {
      throw new Error('fixture_operation_missing');
    }
    const token = randomUUID();
    await sql`UPDATE public.media_operation SET status='rendering',"claimToken"=${token}::uuid,
      "claimExpiresAt"=clock_timestamp()+interval '1 hour' WHERE id=${operation.operation.id}::uuid`.execute(db);
    const resource = (await sync.claim(connection.id, connection.config.stagingBytes))!;
    expect(resource).toBeDefined();
    const device = randomUUID();
    const identityId = randomUUID();
    await sql`INSERT INTO public.icloud_source_identity
      (id,"ownerId","assetId","libraryKey","cplAssetRecordName","cplMasterRecordName",role,sha256,"deliveredBy","cloudIdentifier","matchStrength")
      VALUES (${identityId}::uuid,${user.id}::uuid,${asset.id}::uuid,'library',${NAME},${master},${identityRoleOf[role]},
        ${sha256},${`device:${device}`},${`${NAME}:001:${master}`},'corroborated')`.execute(db);
    await identities.claimForSync(user.id, NAME, connection.id);
    const { session } = await ctx.newSession({ userId: user.id });
    const grantAuth = factory.auth({ user, session });
    if (withWeeklyGrant) {
      await new ICloudWeeklyRepository(db).setAuthority(grantAuth, connection.id, {
        enabled: true,
        includeProtected: false,
        requestKey: randomUUID(),
      });
    }
    const authority: IdentityAdoptionAuthority = {
      ownerId: user.id,
      connectionId: connection.id,
      config: canonicalJson(connection.config),
      operationId: operation.operation.id,
      operationClaimToken: token,
      resourceId: resource.id,
      resourceLeaseToken: resource.leaseToken!,
    };
    return {
      user,
      asset,
      connection,
      resource,
      authority,
      originalPath,
      bytes,
      sha256,
      master,
      resourceFingerprint,
      identityId,
      grantAuth,
    };
  }

  async function unpublished(fixture: Awaited<ReturnType<typeof arrange>>) {
    const resource = await sync.resource(fixture.resource.id);
    expect(resource?.assetId).toBeNull();
    const receipts =
      await sql`SELECT id FROM public.icloud_identity_reuse WHERE "sourceResourceId"=${fixture.resource.id}::uuid`.execute(
        db,
      );
    expect(receipts.rows).toHaveLength(0);
  }

  it.each(['original', 'raw', 'motion'] as const)(
    'adopts %s bytes without changing the original, records only actual producer proof, and replays once',
    async (role) => {
      const fixture = await arrange(role);
      expect(await service.adopt(fixture.authority)).toBe('adopted');
      expect(await readFile(fixture.originalPath)).toEqual(fixture.bytes);
      const mapped = await sync.resource(fixture.resource.id);
      expect(mapped).toMatchObject({ status: 'committed', assetId: fixture.asset.id, path: fixture.originalPath });
      expect(mapped?.sha256).toEqual(fixture.sha256);
      expect(await service.adopt(fixture.authority)).toBe('adopted');
      const receipts = await sql<{
        basis: string;
        role: string;
      }>`SELECT basis,role FROM public.icloud_identity_reuse WHERE "sourceResourceId"=${fixture.resource.id}::uuid`.execute(
        db,
      );
      expect(receipts.rows).toEqual([{ basis: 'exact-identity', role: identityRoleOf[role] }]);
      const fingerprints = await sql<{
        appleFingerprint: string;
      }>`SELECT "appleFingerprint" FROM public.icloud_identity_reuse
      WHERE "sourceResourceId"=${fixture.resource.id}::uuid`.execute(db);
      expect(fingerprints.rows[0].appleFingerprint).toBe(fixture.resourceFingerprint);
      if (role === 'motion') {
        expect(fixture.resourceFingerprint).not.toBe(fixture.master);
      }
      const proof = await sql<{
        lastAuditResult: string | null;
        lastVerifiedAt: Date | null;
      }>`SELECT "lastAuditResult","lastVerifiedAt" FROM public.icloud_source_identity WHERE id=${fixture.identityId}::uuid`.execute(
        db,
      );
      expect(proof.rows[0]).toEqual({ lastAuditResult: null, lastVerifiedAt: null });
    },
  );

  it('is default off, preserves matching off, and refuses a post-import exact stamp as adoption proof', async () => {
    const fixture = await arrange();
    vi.stubEnv('FRAMELEAF_ICLOUD_IDENTITY_ADOPTION', '');
    expect(identityAdoptionEnabled()).toBe(false);
    expect(await service.adopt(fixture.authority)).toBe('miss');
    vi.stubEnv('FRAMELEAF_ICLOUD_IDENTITY_ADOPTION', 'true');
    vi.stubEnv('FRAMELEAF_ICLOUD_IDENTITY_MATCHING', 'false');
    expect(await service.adopt(fixture.authority)).toBe('miss');
    vi.stubEnv('FRAMELEAF_ICLOUD_IDENTITY_MATCHING', 'true');
    await sql`UPDATE public.icloud_source_identity SET "deliveredBy"=${`icloud-sync:${fixture.connection.id}`},"matchStrength"='exact' WHERE id=${fixture.identityId}::uuid`.execute(
      db,
    );
    expect(await service.adopt(fixture.authority)).toBe('miss');
    await unpublished(fixture);
  });

  it('adopts independently checked still and motion resources under the same whole-item claim without rewriting the pair', async () => {
    const fixture = await arrange('motion', { concurrency: 2 });
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'green' } })
      .jpeg()
      .toBuffer();
    const originalPath = join(dirname(fixture.originalPath), 'still.jpg');
    await writeFile(originalPath, bytes);
    const sha256 = createHash('sha256').update(bytes).digest();
    const hash = appleFingerprintHash();
    hash.update(bytes);
    const fingerprint = hash.digest();
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { asset } = await ctx.newAsset({
      ownerId: fixture.user.id,
      originalPath,
      originalFileName: 'still.jpg',
      type: AssetType.Image,
      checksum: sha256,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
      livePhotoVideoId: fixture.asset.id,
    });
    const field = (value: unknown) => ({ value });
    await sync.savePage(
      fixture.connection.id,
      'assets:library',
      'library',
      [
        {
          recordName: fixture.master,
          recordType: 'CPLMaster',
          recordChangeTag: 'master-2',
          fields: {
            filenameEnc: { value: 'still.jpg', type: 'STRING' },
            itemType: field('public.jpeg'),
            resOriginalRes: field({ size: bytes.length, fileChecksum: fingerprint }),
            resOriginalVidComplRes: field({ size: fixture.bytes.length, fileChecksum: fixture.resourceFingerprint }),
          },
        },
      ],
      null,
      true,
    );
    await sql`DELETE FROM public.icloud_checkpoint WHERE "connectionId"=${fixture.connection.id}::uuid AND scope='materialize:library'`.execute(
      db,
    );
    await sync.materialize(fixture.connection, 'library', { area: 'private', zoneID: { zoneName: 'PrimarySync' } });
    const resource = (await sync.claim(fixture.connection.id, fixture.connection.config.stagingBytes))!;
    expect(resource).toBeDefined();
    expect(resource.role).toBe('original');
    await sql`INSERT INTO public.icloud_source_identity
      ("ownerId","assetId","libraryKey","cplAssetRecordName","cplMasterRecordName",role,sha256,"deliveredBy","cloudIdentifier")
      VALUES (${fixture.user.id}::uuid,${asset.id}::uuid,'library',${NAME},${fixture.master},'original',${sha256},
        ${`device:${randomUUID()}`},${`${NAME}:001:${fixture.master}`})`.execute(db);
    const claim = await identities.claims(fixture.user.id, [NAME]);
    expect(claim).toHaveLength(1);
    expect(
      await Promise.all([
        service.adopt(fixture.authority),
        service.adopt({ ...fixture.authority, resourceId: resource.id, resourceLeaseToken: resource.leaseToken! }),
      ]),
    ).toEqual(['adopted', 'adopted']);
    const proof = await sql<{
      itemClaimId: string;
      role: string;
    }>`SELECT "itemClaimId",role FROM public.icloud_identity_reuse
      WHERE "connectionId"=${fixture.connection.id}::uuid ORDER BY role`.execute(db);
    expect(proof.rows).toEqual([
      { itemClaimId: claim[0].id, role: 'live-motion' },
      { itemClaimId: claim[0].id, role: 'original' },
    ]);
    expect((await identities.claims(fixture.user.id, [NAME]))[0].id).toBe(claim[0].id);
    expect(
      (await db.selectFrom('asset').select('livePhotoVideoId').where('id', '=', asset.id).executeTakeFirst())
        ?.livePhotoVideoId,
    ).toBe(fixture.asset.id);
    expect(await readFile(originalPath)).toEqual(bytes);
    expect(await readFile(fixture.originalPath)).toEqual(fixture.bytes);
  });

  it.each(['operation', 'resource', 'item'] as const)(
    'denies an expired %s claim and creates no proof',
    async (kind) => {
      const fixture = await arrange();
      switch (kind) {
        case 'operation': {
          await sql`UPDATE public.media_operation SET "claimExpiresAt"=clock_timestamp()-interval '1 second' WHERE id=${fixture.authority.operationId}::uuid`.execute(
            db,
          );

          break;
        }
        case 'resource': {
          await sql`UPDATE public.icloud_resource SET "leaseExpiresAt"=clock_timestamp()-interval '1 second' WHERE id=${fixture.resource.id}::uuid`.execute(
            db,
          );

          break;
        }
        case 'item': {
          await sql`UPDATE public.icloud_claim SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE "ownerId"=${fixture.user.id}::uuid`.execute(
            db,
          );

          break;
        }
        // No default
      }
      expect(await service.adopt(fixture.authority)).toBe('retry');
      await unpublished(fixture);
    },
  );

  it('denies Locked originals even with includeHidden configured', async () => {
    const fixture = await arrange('original', { includeHidden: true });
    await sql`INSERT INTO public.asset_lock ("assetId",reason) VALUES (${fixture.asset.id}::uuid,${AssetLockReason.Marked})`.execute(
      db,
    );
    expect(await service.adopt(fixture.authority)).toBe('miss');
    await unpublished(fixture);
  });

  it('honors current suppression preferences', async () => {
    const fixture = await arrange();
    const tagId = randomUUID();
    await sql`INSERT INTO public.tag (id,value,"userId") VALUES (${tagId}::uuid,'private',${fixture.user.id}::uuid)`.execute(
      db,
    );
    await sql`INSERT INTO public.tag_closure (id_ancestor,id_descendant) VALUES (${tagId}::uuid,${tagId}::uuid)`.execute(
      db,
    );
    await sql`INSERT INTO public.tag_asset ("assetId","tagId") VALUES (${fixture.asset.id}::uuid,${tagId}::uuid)`.execute(
      db,
    );
    const preferences = {
      privacy: { suppression: { tagIds: [tagId], personIds: [], petIds: [], scope: 'owned' as const } },
    };
    await db
      .insertInto('user_metadata')
      .values({ userId: fixture.user.id, key: UserMetadataKey.Preferences, value: preferences })
      .onConflict((oc) => oc.columns(['userId', 'key']).doUpdateSet({ value: preferences }))
      .execute();
    expect(await service.adopt(fixture.authority)).toBe('miss');
    await unpublished(fixture);
  });

  it('protects a hidden motion resource belonging to a Locked still', async () => {
    const fixture = await arrange('motion');
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { asset: still } = await ctx.newAsset({ ownerId: fixture.user.id, livePhotoVideoId: fixture.asset.id });
    await sql`INSERT INTO public.asset_lock ("assetId",reason) VALUES (${still.id}::uuid,${AssetLockReason.Marked})`.execute(
      db,
    );
    expect(await service.adopt(fixture.authority)).toBe('miss');
    await unpublished(fixture);
  });

  it('does not reuse another owner identity or a hash-mapped resource', async () => {
    const fixture = await arrange();
    await sql`UPDATE public.icloud_source_identity SET "ownerId"=${randomUUID()}::uuid WHERE id=${fixture.identityId}::uuid`.execute(
      db,
    );
    expect(await service.adopt(fixture.authority)).toBe('miss');
    await unpublished(fixture);
    await sql`UPDATE public.icloud_source_identity SET "ownerId"=${fixture.user.id}::uuid WHERE id=${fixture.identityId}::uuid`.execute(
      db,
    );
    await sql`UPDATE public.icloud_resource SET "assetId"=${fixture.asset.id}::uuid,sha256=${fixture.sha256} WHERE id=${fixture.resource.id}::uuid`.execute(
      db,
    );
    expect(await service.adopt(fixture.authority)).toBe('miss');
    expect(
      (
        await sql`SELECT id FROM public.icloud_identity_reuse WHERE "sourceResourceId"=${fixture.resource.id}::uuid`.execute(
          db,
        )
      ).rows,
    ).toHaveLength(0);
  });

  it.each(['config', 'source', 'pause', 'fingerprint', 'digest'] as const)(
    'refuses current %s disagreement',
    async (kind) => {
      const fixture = await arrange();
      switch (kind) {
        case 'config': {
          fixture.authority.config = canonicalJson({ ...fixture.connection.config, libraries: ['other'] });

          break;
        }
        case 'source': {
          await sql`UPDATE public.icloud_record SET deleted=true WHERE "connectionId"=${fixture.connection.id}::uuid AND "recordId"=${fixture.master}`.execute(
            db,
          );

          break;
        }
        case 'pause': {
          await sql`UPDATE public.media_operation SET "pauseRequestedAt"=clock_timestamp() WHERE id=${fixture.authority.operationId}::uuid`.execute(
            db,
          );

          break;
        }
        case 'fingerprint': {
          await writeFile(
            fixture.originalPath,
            await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
              .jpeg()
              .toBuffer(),
          );

          break;
        }
        case 'digest': {
          await sql`UPDATE public.icloud_source_identity SET sha256=${Buffer.alloc(32)} WHERE id=${fixture.identityId}::uuid`.execute(
            db,
          );

          break;
        }
        // No default
      }
      expect(await service.adopt(fixture.authority)).not.toBe('adopted');
      await unpublished(fixture);
    },
  );

  it('refuses a replaced pathname while its original handle remains open', async () => {
    const fixture = await arrange();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const decode = media.decodeImage.bind(media);
    vi.spyOn(media, 'decodeImage').mockImplementation(async (...args) => {
      entered.resolve();
      await resume.promise;
      return decode(...args);
    });
    const running = service.adopt(fixture.authority);
    try {
      await entered.promise;
      await rename(fixture.originalPath, `${fixture.originalPath}.old`);
      await writeFile(fixture.originalPath, fixture.bytes);
    } finally {
      resume.resolve();
    }
    expect(await running).toBe('retry');
    await unpublished(fixture);
  });

  it('never follows a final symlink', async () => {
    const fixture = await arrange();
    await rename(fixture.originalPath, `${fixture.originalPath}.old`);
    await symlink(`${fixture.originalPath}.old`, fixture.originalPath);
    expect(await service.adopt(fixture.authority)).toBe('retry');
    await unpublished(fixture);
  });

  it.each([
    'missing',
    'ambiguous',
    'master',
    'role',
    'review',
    'offline',
    'external',
    'trashed',
    'album',
    'library',
  ] as const)('refuses %s evidence without publishing a mapping or receipt', async (kind) => {
    const fixture = await arrange();
    switch (kind) {
      case 'missing': {
        await sql`DELETE FROM public.icloud_source_identity WHERE id=${fixture.identityId}::uuid`.execute(db);

        break;
      }
      case 'ambiguous': {
        const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
        const originalPath = join(dirname(fixture.originalPath), 'ambiguous.jpg');
        await writeFile(originalPath, fixture.bytes);
        // Both supported digest algorithms describe genuine identical originals without
        // violating the owner/checksum uniqueness contract.
        const { asset } = await ctx.newAsset({
          ownerId: fixture.user.id,
          originalPath,
          originalFileName: 'ambiguous.jpg',
          type: AssetType.Image,
          checksum: createHash('sha1').update(fixture.bytes).digest(),
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
        });
        await sql`INSERT INTO public.icloud_source_identity
          ("ownerId","assetId","libraryKey","cplAssetRecordName","cplMasterRecordName",role,sha256,"deliveredBy","cloudIdentifier")
          SELECT "ownerId",${asset.id}::uuid,"libraryKey","cplAssetRecordName","cplMasterRecordName",role,sha256,"deliveredBy","cloudIdentifier"
          FROM public.icloud_source_identity WHERE id=${fixture.identityId}::uuid`.execute(db);

        break;
      }
      case 'master': {
        await sql`UPDATE public.icloud_source_identity SET "cplMasterRecordName"='different' WHERE id=${fixture.identityId}::uuid`.execute(
          db,
        );

        break;
      }
      case 'role': {
        await sql`UPDATE public.icloud_source_identity SET role='raw-alternate' WHERE id=${fixture.identityId}::uuid`.execute(
          db,
        );

        break;
      }
      case 'review': {
        await sql`UPDATE public.icloud_source_identity SET "lastAuditResult"='mismatch' WHERE id=${fixture.identityId}::uuid`.execute(
          db,
        );

        break;
      }
      case 'offline': {
        await db.updateTable('asset').set({ isOffline: true }).where('id', '=', fixture.asset.id).execute();

        break;
      }
      case 'external': {
        await db.updateTable('asset').set({ isExternal: true }).where('id', '=', fixture.asset.id).execute();

        break;
      }
      case 'trashed': {
        await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', fixture.asset.id).execute();

        break;
      }
      case 'album':
      case 'library': {
        const config = {
          ...fixture.connection.config,
          ...(kind === 'album' ? { albums: ['library:missing'] } : { libraries: ['missing'] }),
        };
        await sync.update(fixture.connection.id, fixture.user.id, { config });
        fixture.authority.config = canonicalJson(config);

        break;
      }
      // No default
    }
    expect(await service.adopt(fixture.authority)).not.toBe('adopted');
    await unpublished(fixture);
  });

  it('refuses publication and replay after the actual classification writer wins metadata authority', async () => {
    const fixture = await arrange();
    const privacy = new AssetRepository(db);
    const database = new DatabaseRepository(db, getMocks().logger as never, new ConfigRepository());
    await privacy.updateIsNsfw(fixture.asset.id, false, db);
    const entered = Promise.withResolvers<number>();
    const resume = Promise.withResolvers<void>();
    const classifying = database.withAssetMetadataLock(fixture.asset.id, async (transaction) => {
      const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(transaction);
      entered.resolve(pid.rows[0].pid);
      await resume.promise;
      await privacy.updateIsNsfw(fixture.asset.id, true, transaction);
    });
    const classifierPid = await entered.promise;
    const running = service.adopt(fixture.authority);
    void classifying.catch(() => {});
    void running.catch(() => {});
    try {
      await expect
        .poll(
          async () => {
            const blocked = await sql`SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND ${classifierPid}::int=ANY(pg_blocking_pids(pid))`.execute(db);
            return blocked.rows.length > 0;
          },
          { timeout: 1000 },
        )
        .toBe(true);
    } finally {
      resume.resolve();
      await Promise.allSettled([classifying, running]);
    }
    await classifying;
    expect(await running).toBe('miss');
    await unpublished(fixture);
    expect(await service.adopt(fixture.authority)).toBe('miss');
    await unpublished(fixture);
    expect(await readFile(fixture.originalPath)).toEqual(fixture.bytes);
  });

  it('holds classification authority across the final real file check and refuses subsequently classified replay', async () => {
    const fixture = await arrange();
    const privacy = new AssetRepository(db);
    const database = new DatabaseRepository(db, getMocks().logger as never, new ConfigRepository());
    await privacy.updateIsNsfw(fixture.asset.id, false, db);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const adopt = repository.adopt.bind(repository);
    vi.spyOn(repository, 'adopt').mockImplementation((authority, verify) =>
      adopt(authority, async (candidate) => {
        const evidence = await verify(candidate);
        if (!evidence || evidence === 'miss') {
          return evidence;
        }
        let checks = 0;
        return {
          ...evidence,
          current: async () => {
            const current = await evidence.current();
            if (++checks === 2) {
              entered.resolve();
              await resume.promise;
            }
            return current;
          },
        };
      }),
    );
    const running = service.adopt(fixture.authority);
    let classifying: Promise<void> | undefined;
    try {
      await entered.promise;
      const holder = await sql<{ pid: number }>`SELECT pid FROM pg_locks
        WHERE locktype='advisory' AND granted AND classid=4294967295::oid
          AND objid=(hashtext(${fixture.asset.id})::bigint & 4294967295)::oid AND objsubid=2`.execute(db);
      expect(holder.rows).toHaveLength(1);
      classifying = database.withAssetMetadataLock(fixture.asset.id, async (transaction) => {
        await privacy.updateIsNsfw(fixture.asset.id, true, transaction);
      });
      void classifying.catch(() => {});
      await expect
        .poll(
          async () => {
            const blocked = await sql`SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND ${holder.rows[0].pid}::int=ANY(pg_blocking_pids(pid))`.execute(db);
            return blocked.rows.length > 0;
          },
          { timeout: 1000 },
        )
        .toBe(true);
      const current = await sql<{ isNsfw: boolean }>`SELECT is_nsfw AS "isNsfw" FROM public.asset
        WHERE id=${fixture.asset.id}::uuid`.execute(db);
      expect(current.rows[0].isNsfw).toBe(false);
    } finally {
      resume.resolve();
      await Promise.allSettled([running, ...(classifying ? [classifying] : [])]);
    }
    expect(await running).toBe('adopted');
    await classifying;
    expect(await service.adopt(fixture.authority)).toBe('miss');
    expect(
      (
        await sql`SELECT id FROM public.icloud_identity_reuse WHERE "sourceResourceId"=${fixture.resource.id}::uuid`.execute(
          db,
        )
      ).rows,
    ).toHaveLength(1);
    expect((await sync.resource(fixture.resource.id))?.assetId).toBe(fixture.asset.id);
    expect(await readFile(fixture.originalPath)).toEqual(fixture.bytes);
  });

  it('holds the real managed move path lock through native validation and publication', async () => {
    const fixture = await arrange();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const decode = media.decodeImage.bind(media);
    vi.spyOn(media, 'decodeImage').mockImplementation(async (...args) => {
      entered.resolve();
      await resume.promise;
      return decode(...args);
    });
    const running = service.adopt(fixture.authority);
    await entered.promise;
    const target = `${fixture.originalPath}.moved`;
    const renameFile = vi.fn(async () => {
      await rename(fixture.originalPath, target);
      return true;
    });
    const moving = new AssetRepository(db).moveFile(
      {
        moveId: randomUUID(),
        assetId: fixture.asset.id,
        pathType: AssetPathType.Original,
        from: fixture.originalPath,
        source: fixture.originalPath,
        to: target,
      },
      {
        rename: renameFile,
        undo: async () => {
          await rename(target, fixture.originalPath);
        },
        finish: async () => {},
      },
    );
    void moving.catch(() => {});
    const key = createHash('sha1').update(fixture.originalPath).digest().readBigUInt64BE(0);
    try {
      await expect
        .poll(
          async () => {
            const blocked = await sql`SELECT 1 FROM pg_locks waiting JOIN pg_locks held
          ON held.locktype=waiting.locktype AND held.classid=waiting.classid AND held.objid=waiting.objid
          WHERE waiting.locktype='advisory' AND NOT waiting.granted AND held.granted
            AND waiting.classid=${Number(key >> 32n)}::oid AND waiting.objid=${Number(key & 0xff_ff_ff_ffn)}::oid
            AND held.pid=ANY(pg_blocking_pids(waiting.pid))`.execute(db);
            return blocked.rows.length > 0;
          },
          { timeout: 1000 },
        )
        .toBe(true);
      expect(renameFile).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await Promise.allSettled([running, moving]);
    }
    expect(await running).toBe('adopted');
    expect(await moving).toBe('moved');
    expect(await readFile(target)).toEqual(fixture.bytes);
    expect(
      (await db.selectFrom('asset').select('originalPath').where('id', '=', fixture.asset.id).executeTakeFirst())
        ?.originalPath,
    ).toBe(target);
    // The historical decision does not keep an original alive or recertify its later path.
    expect(await service.adopt(fixture.authority)).toBe('retry');
    expect(
      (
        await sql`SELECT id FROM public.icloud_identity_reuse WHERE "sourceResourceId"=${fixture.resource.id}::uuid`.execute(
          db,
        )
      ).rows,
    ).toHaveLength(1);
  });

  it.each(['operation', 'resource', 'item'] as const)(
    'rejects %s expiry while native decode is suspended, even though its row remains locked',
    async (kind) => {
      const fixture = await arrange();
      switch (kind) {
        case 'operation': {
          await sql`UPDATE public.media_operation SET "claimExpiresAt"=clock_timestamp()+interval '1 second' WHERE id=${fixture.authority.operationId}::uuid`.execute(
            db,
          );

          break;
        }
        case 'resource': {
          await sql`UPDATE public.icloud_resource SET "leaseExpiresAt"=clock_timestamp()+interval '1 second' WHERE id=${fixture.resource.id}::uuid`.execute(
            db,
          );

          break;
        }
        case 'item': {
          await sql`UPDATE public.icloud_claim SET "expiresAt"=clock_timestamp()+interval '1 second' WHERE "ownerId"=${fixture.user.id}::uuid`.execute(
            db,
          );

          break;
        }
        // No default
      }
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const decode = media.decodeImage.bind(media);
      vi.spyOn(media, 'decodeImage').mockImplementation(async (...args) => {
        entered.resolve();
        await resume.promise;
        return decode(...args);
      });
      const running = service.adopt(fixture.authority);
      try {
        await entered.promise;
        // Real PostgreSQL time crosses the admitted deadline while file/claim rows remain held.
        await sql`SELECT pg_sleep(1.1)`.execute(db);
      } finally {
        resume.resolve();
      }
      expect(await running).toBe('retry');
      await unpublished(fixture);
    },
  );

  it('serializes two actual producers into one immutable receipt', async () => {
    const fixture = await arrange();
    expect(await Promise.all([service.adopt(fixture.authority), service.adopt(fixture.authority)])).toEqual([
      'adopted',
      'adopted',
    ]);
    expect(
      (
        await sql`SELECT id FROM public.icloud_identity_reuse WHERE "sourceResourceId"=${fixture.resource.id}::uuid`.execute(
          db,
        )
      ).rows,
    ).toHaveLength(1);
    expect(await readFile(fixture.originalPath)).toEqual(fixture.bytes);
  });

  it('rolls the actual resource mapping back when PostgreSQL refuses receipt publication', async () => {
    const fixture = await arrange();
    const constraint = `test_receipt_${randomUUID().replaceAll('-', '')}`;
    // This owner's new receipt fails a real PG constraint after the real mapping UPDATE.
    // Other owners remain unaffected, and no production verification is substituted.
    await sql`ALTER TABLE public.icloud_identity_reuse ADD CONSTRAINT ${sql.id(constraint)}
      CHECK ("ownerId"<>${sql.lit(fixture.user.id)}::uuid)`.execute(db);
    try {
      expect(await service.adopt(fixture.authority)).toBe('retry');
      await unpublished(fixture);
      expect(await readFile(fixture.originalPath)).toEqual(fixture.bytes);
    } finally {
      await sql`ALTER TABLE public.icloud_identity_reuse DROP CONSTRAINT ${sql.id(constraint)}`.execute(db);
    }
    expect(await service.adopt(fixture.authority)).toBe('adopted');
  });

  it('retains a noncooperative decoder copy after deadline refusal and releases SQL locks without publishing', async () => {
    vi.stubEnv('FRAMELEAF_MEDIA_VALIDATION_TIMEOUT_MS', '10000');
    integrity = new MediaIntegrityService(
      new StorageRepository(getMocks().logger as never),
      new CryptoRepository(),
      media,
    );
    service = new ICloudIdentityAdoptionService(repository, integrity);
    const fixture = await arrange();
    const entered = Promise.withResolvers<string>();
    const resume = Promise.withResolvers<void>();
    const decode = media.decodeImage.bind(media);
    vi.spyOn(media, 'decodeImage').mockImplementation(async (...args) => {
      entered.resolve(String(args[0]));
      await resume.promise;
      return decode(...args);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const running = service.adopt(fixture.authority);
    const copy = await entered.promise;
    try {
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await running).toBe('retry');
      await unpublished(fixture);
      await expect(access(copy)).resolves.toBeUndefined();
      // A real competing transaction can now lock the asset; the deadline did not hold DB locks.
      await db.transaction().execute(async (tx) => {
        await sql`SET LOCAL lock_timeout='500ms'`.execute(tx);
        await tx.selectFrom('asset').select('id').where('id', '=', fixture.asset.id).forUpdate().execute();
      });
    } finally {
      vi.useRealTimers();
      resume.resolve();
    }
    await service.onShutdown();
    await expect(access(dirname(copy))).rejects.toThrow();
    await unpublished(fixture);
  }, 20_000);

  it('retains historical receipts across mutable identity/resource/asset removal and deletes them only with connection provenance', async () => {
    const fixture = await arrange();
    expect(await service.adopt(fixture.authority)).toBe('adopted');
    await service.onShutdown();
    await sql`DELETE FROM public.icloud_source_identity WHERE id=${fixture.identityId}::uuid`.execute(db);
    await sql`DELETE FROM public.icloud_resource WHERE id=${fixture.resource.id}::uuid`.execute(db);
    await sql`DELETE FROM public.asset WHERE id=${fixture.asset.id}::uuid`.execute(db);
    expect(
      (
        await sql`SELECT id FROM public.icloud_identity_reuse WHERE "connectionId"=${fixture.connection.id}::uuid`.execute(
          db,
        )
      ).rows,
    ).toHaveLength(1);
    await sql`UPDATE public.media_operation SET status='completed' WHERE id=${fixture.authority.operationId}::uuid`.execute(
      db,
    );
    await sync.disconnect(fixture.connection.id, fixture.user.id);
    expect(await sync.remove(fixture.connection.id, fixture.user.id, async () => {})).toBe('removed');
    expect(
      (
        await sql`SELECT id FROM public.icloud_identity_reuse WHERE "connectionId"=${fixture.connection.id}::uuid`.execute(
          db,
        )
      ).rows,
    ).toHaveLength(0);
  });
  describe('mandatory weekly admission before adoption, replay and mapped reuse', () => {
    const weekly = () => new ICloudWeeklyRepository(db);
    const recovery = () => new MediaRecoveryService(new MediaRecoveryRepository(db), integrity);
    const mappedAuthority = (f: Awaited<ReturnType<typeof arrange>>) => ({
      ownerId: f.user.id,
      resourceId: f.resource.id,
      leaseToken: f.resource.leaseToken!,
      includeHidden: true,
    });

    it.each(['execution', 'transport'] as const)(
      'refuses new adoption before file work with %s activation unavailable',
      async (kind) => {
        const f = await arrange();
        const verify = vi.fn();
        vi.stubEnv(
          kind === 'execution' ? 'FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION' : 'FRAMELEAF_ICLOUD_BRIDGE_URL',
          '',
        );
        expect(identityAdoptionEnabled()).toBe(false);
        expect(await service.adopt(f.authority)).toBe('miss');
        expect(await repository.adopt(f.authority, verify)).toBe('miss');
        expect(verify).not.toHaveBeenCalled();
        await unpublished(f);
        expect((await weekly().status(f.connection.id, f.user.id)).executionAvailable).toBe(false);
      },
    );

    it('returns a real missing-grant miss before the producer verifier, leaving fresh-download fallback eligible', async () => {
      const f = await arrange('original', {}, false);
      const verify = vi.fn();
      expect(
        (await sql`SELECT id FROM public.icloud_weekly_grant WHERE "connectionId"=${f.connection.id}::uuid`.execute(db))
          .rows,
      ).toEqual([]);
      expect(await repository.adopt(f.authority, verify)).toBe('miss');
      expect(verify).not.toHaveBeenCalled();
      await unpublished(f);
      expect((await sync.resource(f.resource.id))?.status).toBe(f.resource.status);
    });

    it('requires actual current consent before verification and preserves immutable replay provenance after revoke/regrant', async () => {
      const f = await arrange();
      await weekly().setAuthority(f.grantAuth, f.connection.id, {
        enabled: false,
        includeProtected: false,
        requestKey: randomUUID(),
      });
      const verify = vi.fn();
      expect(await repository.adopt(f.authority, verify)).toBe('miss');
      expect(verify).not.toHaveBeenCalled();
      await unpublished(f);
      await weekly().setAuthority(f.grantAuth, f.connection.id, {
        enabled: true,
        includeProtected: false,
        requestKey: randomUUID(),
      });
      expect(await service.adopt(f.authority)).toBe('adopted');
      const receipts = () =>
        sql`SELECT * FROM public.icloud_identity_reuse WHERE "sourceResourceId"=${f.resource.id}::uuid`.execute(db);
      const before = (await receipts()).rows;
      await weekly().setAuthority(f.grantAuth, f.connection.id, {
        enabled: false,
        includeProtected: false,
        requestKey: randomUUID(),
      });
      expect(await service.adopt(f.authority)).toBe('miss');
      expect((await receipts()).rows).toEqual(before);
      expect((await sync.resource(f.resource.id))?.assetId).toBe(f.asset.id);
      await weekly().setAuthority(f.grantAuth, f.connection.id, {
        enabled: true,
        includeProtected: false,
        requestKey: randomUUID(),
      });
      expect(await service.adopt(f.authority)).toBe('adopted');
      expect((await receipts()).rows).toEqual(before);
      expect(
        (
          await sql`SELECT "lastAuditResult","lastVerifiedAt" FROM public.icloud_source_identity
        WHERE id=${f.identityId}::uuid`.execute(db)
        ).rows,
      ).toEqual([{ lastAuditResult: null, lastVerifiedAt: null }]);
    });

    it('refuses activation loss after actual native verification without publishing mapping or receipt', async () => {
      const f = await arrange();
      const decode = media.decodeImage.bind(media);
      vi.spyOn(media, 'decodeImage').mockImplementation(async (...args) => {
        const actual = await decode(...args);
        vi.stubEnv('FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION', 'false');
        return actual;
      });
      expect(await service.adopt(f.authority)).toBe('miss');
      await service.onShutdown();
      await unpublished(f);
      expect(await readFile(f.originalPath)).toEqual(f.bytes);
    });

    it.each(['generation', 'config'] as const)(
      'rolls mapping back if real SQL changes captured %s between mapping and receipt CAS',
      async (kind) => {
        const f = await arrange();
        const name = `weekly_adoption_retire_${randomUUID().replaceAll('-', '')}`;
        const retire =
          kind === 'generation'
            ? sql`UPDATE public.icloud_weekly_grant SET enabled=false,"includeProtected"=false,
              "pinBinding"=NULL,generation=generation+1,"revokedAt"=clock_timestamp()
            WHERE "connectionId"=NEW."connectionId" AND "ownerId"=NEW."ownerId"`
            : sql`UPDATE public.icloud_connection SET config=config||'{"concurrency":2}'::jsonb
            WHERE id=NEW."connectionId" AND "ownerId"=NEW."ownerId"`;
        await sql`CREATE FUNCTION public.${sql.id(name)}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF OLD."assetId" IS NULL AND NEW."assetId" IS NOT NULL AND NEW.id=${sql.lit(f.resource.id)}::uuid THEN
          ${retire};
        END IF; RETURN NEW; END $$`.execute(db);
        try {
          await sql`CREATE TRIGGER ${sql.id(name)} AFTER UPDATE ON public.icloud_resource
          FOR EACH ROW EXECUTE FUNCTION public.${sql.id(name)}()`.execute(db);
          expect(await service.adopt(f.authority)).toBe('miss');
          await unpublished(f);
          // Retirement and mapping were in the rejected transaction; neither partially committed.
          expect((await weekly().status(f.connection.id, f.user.id)).enabled).toBe(true);
        } finally {
          await sql`DROP TRIGGER IF EXISTS ${sql.id(name)} ON public.icloud_resource`.execute(db);
          await sql`DROP FUNCTION public.${sql.id(name)}()`.execute(db);
        }
      },
    );

    it('serializes actual grant revocation behind held verification authority and refuses subsequent replay', async () => {
      const f = await arrange();
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const decode = media.decodeImage.bind(media);
      vi.spyOn(media, 'decodeImage').mockImplementation(async (...args) => {
        entered.resolve();
        await resume.promise;
        return decode(...args);
      });
      const running = service.adopt(f.authority);
      await entered.promise;
      const retiring = weekly().setAuthority(f.grantAuth, f.connection.id, {
        enabled: false,
        includeProtected: false,
        requestKey: randomUUID(),
      });
      void retiring.catch(() => {});
      try {
        await expect
          .poll(
            async () =>
              (
                await sql`SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND query LIKE '%user%'
            AND cardinality(pg_blocking_pids(pid))>0`.execute(db)
              ).rows.length > 0,
            { timeout: 1500 },
          )
          .toBe(true);
      } finally {
        resume.resolve();
      }
      expect(await running).toBe('adopted');
      await retiring;
      expect(await service.adopt(f.authority)).toBe('miss');
      expect((await sync.resource(f.resource.id))?.assetId).toBe(f.asset.id);
      expect(
        (
          await sql`SELECT id FROM public.icloud_identity_reuse WHERE "sourceResourceId"=${f.resource.id}::uuid`.execute(
            db,
          )
        ).rows,
      ).toHaveLength(1);
    });

    it('requires current grant for genuine mapped receipt reuse before decoder work and preserves its mapping on refusal', async () => {
      const f = await arrange();
      expect(await service.adopt(f.authority)).toBe('adopted');
      const before = (
        await sql`SELECT * FROM public.icloud_identity_reuse WHERE "sourceResourceId"=${f.resource.id}::uuid`.execute(
          db,
        )
      ).rows;
      const decoder = vi.spyOn(media, 'decodeImage');
      expect(await recovery().verifyMapped(mappedAuthority(f))).toEqual({ outcome: 'reused', assetId: f.asset.id });
      expect(decoder).toHaveBeenCalled();
      expect((await sync.resource(f.resource.id))?.verification?.basis).toBe('exact-identity');
      decoder.mockClear();
      await weekly().setAuthority(f.grantAuth, f.connection.id, {
        enabled: false,
        includeProtected: false,
        requestKey: randomUUID(),
      });
      const mapped = await sync.resource(f.resource.id);
      expect(await recovery().verifyMapped(mappedAuthority(f))).toEqual({
        outcome: 'retry',
        reason: 'identity_adoption_unavailable',
      });
      expect(decoder).not.toHaveBeenCalled();
      expect(await sync.resource(f.resource.id)).toEqual(mapped);
      expect(
        (
          await sql`SELECT * FROM public.icloud_identity_reuse WHERE "sourceResourceId"=${f.resource.id}::uuid`.execute(
            db,
          )
        ).rows,
      ).toEqual(before);
    });

    it('refuses mapped final reuse after real decode if activation disappears, retaining old proof unchanged', async () => {
      const f = await arrange();
      expect(await service.adopt(f.authority)).toBe('adopted');
      const before = await sync.resource(f.resource.id);
      const decode = media.decodeImage.bind(media);
      vi.spyOn(media, 'decodeImage').mockImplementation(async (...args) => {
        const actual = await decode(...args);
        vi.stubEnv('FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION', 'false');
        return actual;
      });
      expect(await recovery().verifyMapped(mappedAuthority(f))).toEqual({
        outcome: 'retry',
        reason: 'identity_adoption_unavailable',
      });
      expect(await sync.resource(f.resource.id)).toEqual(before);
    });

    it('allows actual revocation during mapped verification and refuses the captured generation at commit', async () => {
      const f = await arrange();
      expect(await service.adopt(f.authority)).toBe('adopted');
      const before = await sync.resource(f.resource.id);
      const decode = media.decodeImage.bind(media);
      vi.spyOn(media, 'decodeImage').mockImplementation(async (...args) => {
        const actual = await decode(...args);
        // The pre-decode grant capture transaction has ended: this real writer can commit here.
        await weekly().setAuthority(f.grantAuth, f.connection.id, {
          enabled: false,
          includeProtected: false,
          requestKey: randomUUID(),
        });
        return actual;
      });
      expect(await recovery().verifyMapped(mappedAuthority(f))).toEqual({
        outcome: 'retry',
        reason: 'identity_adoption_unavailable',
      });
      expect((await weekly().status(f.connection.id, f.user.id)).enabled).toBe(false);
      expect(await sync.resource(f.resource.id)).toEqual(before);
    });

    it('refuses mapped resource expiry during final actual native verification without updating reuse proof', async () => {
      const f = await arrange();
      expect(await service.adopt(f.authority)).toBe('adopted');
      const decode = media.decodeImage.bind(media);
      let calls = 0;
      vi.spyOn(media, 'decodeImage').mockImplementation(async (...args) => {
        const actual = await decode(...args);
        if (++calls === 1) {
          await sql`UPDATE public.icloud_resource SET "leaseExpiresAt"=clock_timestamp()+interval '1500 milliseconds'
            WHERE id=${f.resource.id}::uuid`.execute(db);
        } else {
          await sql`SELECT pg_sleep(1.6)`.execute(db);
        }
        return actual;
      });
      const before = (await sync.resource(f.resource.id))?.verification;
      expect(await recovery().verifyMapped(mappedAuthority(f))).toEqual({ outcome: 'retry', reason: 'lease_expired' });
      expect(calls).toBe(2);
      const after = await sync.resource(f.resource.id);
      expect(after?.verification).toEqual(before);
      expect(after?.assetId).toBe(f.asset.id);
    });

    it('does not let genuine scoped protected consent broaden new or mapped adoption eligibility', async () => {
      const f = await arrange('original', { includeHidden: true });
      expect(await service.adopt(f.authority)).toBe('adopted');
      await db.updateTable('user').set({ pinCode: 'b3-protected-contract' }).where('id', '=', f.user.id).execute();
      await sql`UPDATE public.session SET "pinExpiresAt"=clock_timestamp()+interval '1 hour'
        WHERE id=${f.grantAuth.session!.id}::uuid`.execute(db);
      await weekly().setAuthority(f.grantAuth, f.connection.id, {
        enabled: true,
        includeProtected: true,
        requestKey: randomUUID(),
      });
      await new AssetRepository(db).lock([f.asset.id], AssetLockReason.Marked, f.user.id);
      const before = await sync.resource(f.resource.id);
      expect(await service.adopt(f.authority)).toBe('miss');
      expect(await recovery().verifyMapped(mappedAuthority(f))).toEqual({
        outcome: 'retry',
        reason: 'identity_adoption_unavailable',
      });
      expect(await sync.resource(f.resource.id)).toEqual(before);
      expect(
        (await sql`SELECT "assetId" FROM public.asset_lock WHERE "assetId"=${f.asset.id}::uuid`.execute(db)).rows,
      ).toHaveLength(1);
    });
  });

  describe('weekly full-population producer using actual adoption receipts', () => {
    const weekly = () => new ICloudWeeklyRepository(db);
    const operations = () => new MediaOperationRepository(db);

    async function grant(f: Awaited<ReturnType<typeof arrange>>) {
      const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
      const { session } = await ctx.newSession({ userId: f.user.id });
      const auth = factory.auth({ user: f.user, session });
      const input = { enabled: true, includeProtected: false, requestKey: randomUUID() };
      await weekly().setAuthority(auth, f.connection.id, input);
      return { auth, input };
    }

    async function population(size: number) {
      const started = performance.now();
      const concurrency = size > 101 ? 4 : 1;
      const timings = { claimMs: 0, adoptionMs: 0, verificationMs: 0, finalizationMs: 0, waveMs: 0 };
      const statementTimings = {
        claimGlobalLock: { started: 0, completed: 0, elapsedMs: 0, maxMs: 0 },
        claimConnectionLock: { started: 0, completed: 0, elapsedMs: 0, maxMs: 0 },
        claimCandidate: { started: 0, completed: 0, elapsedMs: 0, maxMs: 0 },
        claimLocalReservations: { started: 0, completed: 0, elapsedMs: 0, maxMs: 0 },
        claimGlobalReservations: { started: 0, completed: 0, elapsedMs: 0, maxMs: 0 },
        claimOther: { started: 0, completed: 0, elapsedMs: 0, maxMs: 0 },
        adoptionOwnerLock: { started: 0, completed: 0, elapsedMs: 0, maxMs: 0 },
        adoptionExclusiveAdvisoryLock: { started: 0, completed: 0, elapsedMs: 0, maxMs: 0 },
        adoptionOther: { started: 0, completed: 0, elapsedMs: 0, maxMs: 0 },
      };
      type Statement = keyof typeof statementTimings;
      const planStatements = ['claimCandidate', 'claimLocalReservations', 'claimGlobalReservations'] as const;
      const planStatementLookup: readonly Statement[] = planStatements;
      type PlanStatement = (typeof planStatements)[number];
      const pendingPlans = new WeakMap<QueryId, PlanStatement>();
      const capturedPlans = new Map<PlanStatement, CompiledQuery>();
      let capturePlans = size > 101;
      captureCompiledQuery = (query) => {
        const statement = pendingPlans.get(query.queryId);
        if (statement) {
          capturedPlans.set(statement, query);
          pendingPlans.delete(query.queryId);
        }
      };
      const sanitizePlan = (value: unknown, depth = 0): Record<string, unknown> => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 16) return {};
        const node = value as Record<string, unknown>;
        const safe: Record<string, unknown> = {};
        for (const key of ['Startup Cost', 'Total Cost', 'Plan Rows', 'Plan Width']) {
          if (typeof node[key] === 'number' && Number.isFinite(node[key])) safe[key] = node[key];
        }
        // PostgreSQL structural labels only. Expressions, aliases, output columns and bindings are excluded.
        for (const key of ['Node Type', 'Parent Relationship', 'Strategy', 'Scan Direction', 'Partial Mode']) {
          if (typeof node[key] === 'string' && /^[A-Za-z ]{1,40}$/.test(node[key])) safe[key] = node[key];
        }
        if (node['Relation Name'] === 'icloud_resource') safe['Relation Name'] = node['Relation Name'];
        const knownIndexes = [
          'icloud_resource_pkey',
          'icloud_resource_pending_idx',
          'icloud_resource_lease_idx',
          'icloud_resource_asset_idx',
          'icloud_resource_owner_idx',
          'icloud_resource_jobs_idx',
        ];
        if (typeof node['Index Name'] === 'string' && knownIndexes.includes(node['Index Name'])) {
          safe['Index Name'] = node['Index Name'];
        }
        if (Array.isArray(node.Plans))
          safe.Plans = node.Plans.slice(0, 32).map((child) => sanitizePlan(child, depth + 1));
        return safe;
      };
      let plansEmitted = 0;
      const explainCapturedPlans = async (phase: 'after-analyze-first-claim' | 'after-4000-adoptions') => {
        capturePlans = false;
        for (const statement of planStatements) {
          const query = capturedPlans.get(statement);
          expect(query, `actual compiled query missing for ${statement}`).toBeDefined();
          expect(plansEmitted).toBeLessThan(6);
          plansEmitted++;
          try {
            // The supported logger supplied the exact executed SQL and bound parameters.
            // Plain EXPLAIN plans that statement without executing its selection/locks/aggregates again.
            const result = await db.executeQuery<{ 'QUERY PLAN': unknown }>(
              CompiledQuery.raw(`EXPLAIN (FORMAT JSON) ${query!.sql}`, [...query!.parameters]),
            );
            const document = result.rows[0]?.['QUERY PLAN'];
            expect(Array.isArray(document)).toBe(true);
            const root = (document as Array<{ Plan?: unknown }>)[0]?.Plan;
            expect(root).toBeDefined();
            console.info('weekly-large-population-plan', {
              phase,
              statement,
              plan: JSON.stringify(sanitizePlan(root)),
            });
          } catch {
            // Raw PostgreSQL diagnostics may include parameters; preserve only the fixed failure label.
            throw new Error(`weekly qualification plain EXPLAIN failed: ${statement}`);
          }
        }
        capturedPlans.clear();
      };
      const observe = (scope: 'claim' | 'adoption'): KyselyPlugin => {
        const pending = new WeakMap<QueryId, { statement: Statement; started: number }>();
        return {
          transformQuery({ node, queryId }) {
            let statement: Statement = scope === 'claim' ? 'claimOther' : 'adoptionOther';
            if (RawNode.is(node)) {
              // Match only static template fragments, never parameter values or result rows.
              const template = node.sqlFragments.join('?');
              if (scope === 'claim') {
                if (template.includes("hashtextextended('icloud-staging-reservations',0)")) {
                  statement = 'claimGlobalLock';
                } else if (template.includes('FROM public.icloud_connection') && template.includes('FOR UPDATE')) {
                  statement = 'claimConnectionLock';
                } else if (template.includes("ORDER BY CASE WHEN status='committed'")) {
                  statement = 'claimCandidate';
                } else if (template.includes('sum("reservedBytes")')) {
                  statement = template.includes('WHERE "connectionId"=')
                    ? 'claimLocalReservations'
                    : 'claimGlobalReservations';
                }
              } else if (template.includes('pg_advisory_xact_lock(')) {
                // Digest, metadata and pathname locks are intentionally not relabelled as separate waits.
                statement = 'adoptionExclusiveAdvisoryLock';
              }
            } else if (
              scope === 'adoption' &&
              SelectQueryNode.is(node) &&
              node.endModifiers?.some((modifier) => modifier.modifier === 'ForUpdate') &&
              node.from?.froms.some((table) => TableNode.is(table) && table.table.identifier.name === 'user')
            ) {
              statement = 'adoptionOwnerLock';
            }
            if (capturePlans && scope === 'claim' && planStatementLookup.includes(statement)) {
              pendingPlans.set(queryId, statement as PlanStatement);
            }
            statementTimings[statement].started++;
            pending.set(queryId, { statement, started: performance.now() });
            return node;
          },
          transformResult({ queryId, result }) {
            const measurement = pending.get(queryId);
            if (measurement) {
              const duration = performance.now() - measurement.started;
              const timing = statementTimings[measurement.statement];
              timing.completed++;
              timing.elapsedMs += duration;
              timing.maxMs = Math.max(timing.maxMs, duration);
              pending.delete(queryId);
            }
            return Promise.resolve(result);
          },
        };
      };
      // withPlugin shares the existing driver and pool. These observers return the exact original
      // node/result; they add no SQL, alter no authority, and are confined to this large fixture.
      // Timings include compilation/execution/waiting, not exclusive PostgreSQL lock wait time.
      // Adopter statement totals overlap across the four concurrent transactions.
      const measuredSync = size > 101 ? new ICloudSyncRepository(db.withPlugin(observe('claim'))) : sync;
      const measuredAdoption =
        size > 101 ? new ICloudIdentityAdoptionRepository(db.withPlugin(observe('adoption'))) : repository;
      const progress = (phase: string, receipts: number) => {
        if (size > 101) {
          console.info('weekly-large-population-qualification', {
            phase,
            receipts,
            elapsedMs: Math.round(performance.now() - started),
            ...Object.fromEntries(Object.entries(timings).map(([phase, duration]) => [phase, Math.round(duration)])),
            statements: Object.fromEntries(
              Object.entries(statementTimings).map(([statement, timing]) => [
                statement,
                { ...timing, elapsedMs: Math.round(timing.elapsedMs), maxMs: Math.round(timing.maxMs) },
              ]),
            ),
          });
        }
      };
      progress('fixture-started', 0);
      const f = await arrange('original', { concurrency });
      const names = [NAME, ...Array.from({ length: Math.max(0, size - 1) }, () => randomUUID().toUpperCase())];
      if (size > 1) {
        for (let offset = 1; offset < names.length; offset += 256) {
          await sync.savePage(
            f.connection.id,
            `weekly-additions:${offset}`,
            'library',
            names.slice(offset, offset + 256).map((recordName) => ({
              recordName,
              recordType: 'CPLAsset',
              recordChangeTag: 'asset-1',
              fields: { masterRef: { value: { recordName: f.master } } },
            })),
            null,
            true,
          );
        }
        progress('inventory-saved', 0);
        await sql`DELETE FROM public.icloud_checkpoint WHERE "connectionId"=${f.connection.id}::uuid
          AND scope='materialize:library'`.execute(db);
        while (
          !(await sync.materialize(f.connection, 'library', { area: 'private', zoneID: { zoneName: 'PrimarySync' } }))
        ) {
          // Consume the actual bounded keyset materializer, never a fabricated resource population.
        }
        progress('resources-materialized', 0);
        const device = randomUUID();
        const identities = names.slice(1).map((name) => ({ name, cloud: `${name}:001:${f.master}` }));
        await sql`INSERT INTO public.icloud_source_identity
          ("ownerId","assetId","libraryKey","cplAssetRecordName","cplMasterRecordName",role,sha256,"deliveredBy","cloudIdentifier","matchStrength")
          SELECT ${f.user.id}::uuid,${f.asset.id}::uuid,'library',name,${f.master},'original',${f.sha256},
            ${`device:${device}`},cloud,'corroborated'
          FROM jsonb_to_recordset(${JSON.stringify(identities)}::text::jsonb) AS x(name text,cloud text)`.execute(db);
        if (size > 101) {
          // A bulk-loaded qualification fixture must not rely on autovacuum eventually
          // refreshing statistics. In particular, these distinct item names all reuse
          // one asset: stale join/selectivity estimates can scan the whole identity
          // population for each ORDER BY id LIMIT 2 adoption lookup.
          await sql`ANALYZE public.icloud_record`.execute(db);
          await sql`ANALYZE public.icloud_resource`.execute(db);
          await sql`ANALYZE public.icloud_source_identity`.execute(db);
        }
      }
      // Every receipt is produced by the actual adoption transaction. The test verifier reads the
      // actual owned file and checks its identity after hashing; it never inserts a reuse receipt.
      if (size > 0) {
        const first = await service.adopt(f.authority);
        expect(first).toBe('adopted');
        expect(await sync.finalize(f.resource, async () => {})).toBe(true);
        const holder = `icloud-sync:${f.connection.id}`;
        for (let offset = 1; offset < size; offset += 256) {
          const requested = names.slice(offset, offset + 256);
          const claims = await identities.claim(f.user.id, requested, holder, ICLOUD_SYNC_CLAIM_SEC);
          expect(claims.map((claim) => claim.cplAssetRecordName).sort()).toEqual([...requested].sort());
          expect(claims.every((claim) => claim.holder === holder)).toBe(true);
        }
        if (size > 101) await sql`ANALYZE public.icloud_claim`.execute(db);
        progress('actual-receipts', 1);
        for (let index = 1; index < size; index += concurrency) {
          if (size > 101 && index === 3997) capturePlans = true;
          const admitted: ICloudResource[] = [];
          for (let slot = 0; slot < Math.min(concurrency, size - index); slot++) {
            const claimStarted = performance.now();
            const resource = (await measuredSync.claim(f.connection.id, f.connection.config.stagingBytes))!;
            timings.claimMs += performance.now() - claimStarted;
            expect(resource).toBeDefined();
            admitted.push(resource);
            if (size > 101 && index === 1 && slot === 0) await explainCapturedPlans('after-analyze-first-claim');
          }
          // Admission pauses until the whole wave finalizes: a new claim otherwise
          // could take another adopter's committed resource before it releases its lease.
          const waveStarted = performance.now();
          const settled = await Promise.allSettled(
            admitted.map(async (resource) => {
              const adoptionStarted = performance.now();
              expect(
                await measuredAdoption.adopt(
                  { ...f.authority, resourceId: resource.id, resourceLeaseToken: resource.leaseToken! },
                  async (candidate) => {
                    const verificationStarted = performance.now();
                    const bytes = await readFile(candidate.originalPath);
                    const stat = await lstat(candidate.originalPath);
                    const identity = {
                      dev: stat.dev,
                      ino: stat.ino,
                      size: stat.size,
                      mtimeMs: stat.mtimeMs,
                      ctimeMs: stat.ctimeMs,
                    };
                    const apple = appleFingerprintHash();
                    apple.update(bytes);
                    const evidence = {
                      sha1: createHash('sha1').update(bytes).digest(),
                      sha256: createHash('sha256').update(bytes).digest(),
                      sizeInBytes: bytes.length,
                      appleFingerprint: apple.digest(),
                      identity,
                      current: async () => {
                        const currentStarted = performance.now();
                        const current = await lstat(candidate.originalPath);
                        const matches = Object.entries(identity).every(
                          ([key, value]) => current[key as keyof typeof identity] === value,
                        );
                        timings.verificationMs += performance.now() - currentStarted;
                        return matches;
                      },
                    };
                    timings.verificationMs += performance.now() - verificationStarted;
                    return evidence;
                  },
                ),
              ).toBe('adopted');
              // Summed adopter durations include the real shared-file lock wait.
              timings.adoptionMs += performance.now() - adoptionStarted;
              const finalizationStarted = performance.now();
              expect(await sync.finalize(resource, async () => {})).toBe(true);
              timings.finalizationMs += performance.now() - finalizationStarted;
            }),
          );
          timings.waveMs += performance.now() - waveStarted;
          for (const result of settled) {
            if (result.status === 'rejected') throw result.reason;
          }
          const receipts = index + admitted.length;
          if (size > 101 && receipts === 4001) await explainCapturedPlans('after-4000-adoptions');
          if (receipts % 1000 === 1 || receipts === size) progress('actual-receipts', receipts);
        }
      }
      const published = await sql<{ count: number }>`SELECT count(*)::int AS count
        FROM public.icloud_identity_reuse WHERE "connectionId"=${f.connection.id}::uuid`.execute(db);
      expect(published.rows[0].count).toBe(size);
      progress('receipt-population-complete', published.rows[0].count);
      expect(await operations().beginValidation(f.authority.operationId, f.authority.operationClaimToken, true)).toBe(
        true,
      );
      expect(
        await operations().complete(
          f.authority.operationId,
          f.authority.operationClaimToken,
          { resultAssetId: null },
          undefined,
          true,
        ),
      ).toBe(true);
      return f;
    }

    async function members(cohortId: string) {
      return (
        await sql<{
          ordinal: string;
          receiptId: string;
          resourceRoleKey: string;
          selected: boolean;
          rank: Buffer;
          technicalEligibility: string;
          batchOrdinal: number | null;
          outcome: string;
          auditRequestId: string | null;
          bindings: { receipt: { sourceResourceId: string; role: string }; [key: string]: unknown };
        }>`SELECT * FROM public.icloud_weekly_member WHERE "cohortId"=${cohortId}::uuid ORDER BY ordinal`.execute(db)
      ).rows;
    }

    it.each([0, 1, 99, 100, 101])(
      'freezes the entire actual resource population N=%i and independently verifies the manifest/sample',
      async (size) => {
        const f = await population(size);
        await grant(f);
        const cohort = await weekly().freezeCohort(f.user.id, f.connection.id);
        const frozen = await members(cohort.id);
        expect(Number(cohort.populationCount)).toBe(size);
        expect(Number(cohort.staleCount)).toBe(0);
        expect(Number(cohort.selectedCount)).toBe(Math.ceil(size / 100));
        expect(frozen).toHaveLength(size);
        const clock = (
          await sql<{
            week: string;
          }>`SELECT date_trunc('week',clock_timestamp() AT TIME ZONE 'UTC')::date::text AS week`.execute(db)
        ).rows[0];
        expect(typeof cohort.weekStart).toBe('string');
        const week = cohort.weekStart;
        expect(week).toBe(clock.week);
        const ranked = frozen
          .map((member) => ({
            member,
            rank: createHmac('sha256', cohort.seed)
              .update(
                canonicalJson([
                  'icloud-weekly-resource-v1',
                  f.user.id,
                  f.connection.id,
                  week,
                  member.receiptId,
                  member.bindings.receipt.sourceResourceId,
                  member.bindings.receipt.role,
                ]),
              )
              .digest(),
          }))
          .sort((a, b) => Buffer.compare(a.rank, b.rank) || a.member.receiptId.localeCompare(b.member.receiptId));
        expect(
          frozen
            .filter((member) => member.selected)
            .map((member) => member.receiptId)
            .sort(),
        ).toEqual(
          ranked
            .slice(0, Math.ceil(size / 100))
            .map(({ member }) => member.receiptId)
            .sort(),
        );
        for (const { member, rank } of ranked) {
          expect(member.rank).toEqual(rank);
        }
        const manifest = createHash('sha256').update(
          canonicalJson(['icloud-weekly-manifest-v1', f.user.id, f.connection.id, week]) + '\n',
        );
        for (const member of frozen) {
          manifest.update(
            canonicalJson([
              Number(member.ordinal),
              member.receiptId,
              member.resourceRoleKey,
              member.technicalEligibility === 'current',
              member.bindings,
            ]) + '\n',
          );
        }
        expect(cohort.manifestDigest).toEqual(manifest.digest());
        expect(await weekly().freezeCohort(f.user.id, f.connection.id)).toEqual(cohort);
        if (size === 0) {
          expect(cohort.status).toBe('settled');
          expect(await weekly().createNextBatch(cohort.id, operations())).toBeNull();
          expect(
            (await sql`SELECT 1 FROM public.icloud_identity_audit WHERE "cohortId"=${cohort.id}::uuid`.execute(db))
              .rows,
          ).toEqual([]);
        }
      },
      120_000,
    );

    it('produces k>100 across bounded durable batches without truncating N=10001 or replacing members', async () => {
      const f = await population(10_001);
      await grant(f);
      const freezeStarted = performance.now();
      console.info('weekly-large-population-qualification', { phase: 'freeze-started', receipts: 10_001 });
      const cohort = await weekly().freezeCohort(f.user.id, f.connection.id);
      console.info('weekly-large-population-qualification', {
        phase: 'freeze-complete',
        receipts: 10_001,
        elapsedMs: Math.round(performance.now() - freezeStarted),
      });
      expect(Number(cohort.populationCount)).toBe(10_001);
      expect(Number(cohort.selectedCount)).toBe(101);
      const before = await members(cohort.id);
      expect(before).toHaveLength(10_001);
      const week = new Date(cohort.weekStart).toISOString().slice(0, 10);
      const ranked = before
        .map((member) => ({
          member,
          rank: createHmac('sha256', cohort.seed)
            .update(
              canonicalJson([
                'icloud-weekly-resource-v1',
                f.user.id,
                f.connection.id,
                week,
                member.receiptId,
                member.bindings.receipt.sourceResourceId,
                member.bindings.receipt.role,
              ]),
            )
            .digest(),
        }))
        .sort((a, b) => Buffer.compare(a.rank, b.rank) || a.member.receiptId.localeCompare(b.member.receiptId));
      expect(
        before
          .filter((member) => member.selected)
          .map((member) => member.receiptId)
          .sort(),
      ).toEqual(
        ranked
          .slice(0, 101)
          .map(({ member }) => member.receiptId)
          .sort(),
      );
      const manifest = createHash('sha256').update(
        canonicalJson(['icloud-weekly-manifest-v1', f.user.id, f.connection.id, week]) + '\n',
      );
      for (const member of before) {
        manifest.update(
          canonicalJson([
            Number(member.ordinal),
            member.receiptId,
            member.resourceRoleKey,
            member.technicalEligibility === 'current',
            member.bindings,
          ]) + '\n',
        );
      }
      expect(cohort.manifestDigest).toEqual(manifest.digest());
      const batchesStarted = performance.now();
      const first = (await weekly().createNextBatch(cohort.id, operations()))!;
      expect(first).not.toBeNull();
      expect(await weekly().createNextBatch(cohort.id, operations())).toBeNull();
      // This producer test settles only the operation lifecycle, never an audit result.
      const claimed = (await operations().claimNext({
        kinds: [MediaOperationKind.ICloudSync],
        workerId: 'weekly-producer-fixture',
        leaseMs: 60_000,
      }))!;
      expect(claimed.operation.id).toBe(first.id);
      expect(await operations().beginValidation(first.id, claimed.claimToken, true)).toBe(true);
      expect(await operations().complete(first.id, claimed.claimToken, { resultAssetId: null }, undefined, true)).toBe(
        true,
      );
      const second = (await weekly().createNextBatch(cohort.id, operations()))!;
      expect(first.totalUnits).toBe(100);
      expect(second.totalUnits).toBe(1);
      expect(first.snapshot.batchOrdinal).toBe(0);
      expect(second.snapshot.batchOrdinal).toBe(1);
      expect(await weekly().createNextBatch(cohort.id, operations())).toBeNull();
      expect((await members(cohort.id)).map(({ auditRequestId: _auditRequestId, ...member }) => member)).toEqual(
        before.map(({ auditRequestId: _auditRequestId, ...member }) => member),
      );
      expect(
        (
          await sql`SELECT 1 FROM public.icloud_identity_audit WHERE "cohortId"=${cohort.id}::uuid
        AND "operationId"=ANY(${[first.id, second.id]}::uuid[]) AND purpose='scheduled-weekly' AND "sessionId" IS NULL`.execute(
            db,
          )
        ).rows,
      ).toHaveLength(101);
      console.info('weekly-large-population-qualification', {
        phase: 'durable-batches-complete',
        receipts: 10_001,
        sampled: 101,
        elapsedMs: Math.round(performance.now() - batchesStarted),
      });
    }, 600_000);

    it.each(['original', 'motion', 'raw'] as const)(
      'counts each actually adopted %s resource role once',
      async (role) => {
        const f = await arrange(role);
        expect(await service.adopt(f.authority)).toBe('adopted');
        await grant(f);
        const cohort = await weekly().freezeCohort(f.user.id, f.connection.id);
        expect(Number(cohort.populationCount)).toBe(1);
        const frozen = await members(cohort.id);
        expect(frozen).toHaveLength(1);
        expect(frozen[0].bindings.receipt.role).toBe(identityRoleOf[role]);
        expect(frozen[0].selected).toBe(true);
      },
    );

    it('counts still and motion of one logical item as two frozen resource members', async () => {
      const fixture = await arrange('motion', { concurrency: 2 });
      const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'green' } })
        .jpeg()
        .toBuffer();
      const originalPath = join(dirname(fixture.originalPath), 'still.jpg');
      await writeFile(originalPath, bytes);
      const sha256 = createHash('sha256').update(bytes).digest();
      const hash = appleFingerprintHash();
      hash.update(bytes);
      const fingerprint = hash.digest();
      const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
      const { asset } = await ctx.newAsset({
        ownerId: fixture.user.id,
        originalPath,
        originalFileName: 'still.jpg',
        type: AssetType.Image,
        checksum: sha256,
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
        livePhotoVideoId: fixture.asset.id,
      });
      const field = (value: unknown) => ({ value });
      await sync.savePage(
        fixture.connection.id,
        'assets:library',
        'library',
        [
          {
            recordName: fixture.master,
            recordType: 'CPLMaster',
            recordChangeTag: 'master-2',
            fields: {
              filenameEnc: { value: 'still.jpg', type: 'STRING' },
              itemType: field('public.jpeg'),
              resOriginalRes: field({ size: bytes.length, fileChecksum: fingerprint }),
              resOriginalVidComplRes: field({ size: fixture.bytes.length, fileChecksum: fixture.resourceFingerprint }),
            },
          },
        ],
        null,
        true,
      );
      await sql`DELETE FROM public.icloud_checkpoint WHERE "connectionId"=${fixture.connection.id}::uuid AND scope='materialize:library'`.execute(
        db,
      );
      await sync.materialize(fixture.connection, 'library', { area: 'private', zoneID: { zoneName: 'PrimarySync' } });
      const resource = (await sync.claim(fixture.connection.id, fixture.connection.config.stagingBytes))!;
      expect(resource).toBeDefined();
      expect(resource.role).toBe('original');
      await sql`INSERT INTO public.icloud_source_identity
      ("ownerId","assetId","libraryKey","cplAssetRecordName","cplMasterRecordName",role,sha256,"deliveredBy","cloudIdentifier")
      VALUES (${fixture.user.id}::uuid,${asset.id}::uuid,'library',${NAME},${fixture.master},'original',${sha256},
        ${`device:${randomUUID()}`},${`${NAME}:001:${fixture.master}`})`.execute(db);
      const claim = await identities.claims(fixture.user.id, [NAME]);
      expect(claim).toHaveLength(1);
      expect(
        await Promise.all([
          service.adopt(fixture.authority),
          service.adopt({ ...fixture.authority, resourceId: resource.id, resourceLeaseToken: resource.leaseToken! }),
        ]),
      ).toEqual(['adopted', 'adopted']);
      await grant(fixture);
      const cohort = await weekly().freezeCohort(fixture.user.id, fixture.connection.id);
      expect(Number(cohort.populationCount)).toBe(2);
      expect(Number(cohort.selectedCount)).toBe(1);
      const frozen = await members(cohort.id);
      expect(frozen).toHaveLength(2);
      expect(frozen.map((member) => member.bindings.receipt.role).sort()).toEqual(['live-motion', 'original']);
      expect(new Set(frozen.map((member) => member.resourceRoleKey)).size).toBe(2);
    });

    it('reconciles concurrent repeatable-read freezes to exactly one UTC-week cohort', async () => {
      const f = await population(1);
      await grant(f);
      const attempted = await Promise.allSettled([
        weekly().freezeCohort(f.user.id, f.connection.id),
        weekly().freezeCohort(f.user.id, f.connection.id),
      ]);
      const successful = attempted.filter((result) => result.status === 'fulfilled');
      expect(successful.length).toBeGreaterThan(0);
      for (const result of attempted) {
        if (result.status === 'rejected') {
          expect(['40001', '23505']).toContain(result.reason.code);
        }
      }
      const reconciled = await weekly().freezeCohort(f.user.id, f.connection.id);
      for (const result of successful) {
        if (result.status !== 'fulfilled') {
          continue;
        }

        expect(result.value.id).toBe(reconciled.id);
        expect(result.value.seed).toEqual(reconciled.seed);
      }
      expect(
        (
          await sql`SELECT id FROM public.icloud_weekly_cohort
        WHERE "ownerId"=${f.user.id}::uuid AND "connectionId"=${f.connection.id}::uuid`.execute(db)
        ).rows,
      ).toHaveLength(1);
      expect(await members(reconciled.id)).toHaveLength(1);
    });

    it('does not turn post-import identities or hash reuse into a weekly population', async () => {
      const f = await arrange(); // Device identity exists, but actual adoption has not run.
      await grant(f);
      const cohort = await weekly().freezeCohort(f.user.id, f.connection.id);
      expect(Number(cohort.populationCount)).toBe(0);
      expect(await members(cohort.id)).toEqual([]);
      expect((await sync.resource(f.resource.id))?.assetId).toBeNull();
    });

    it.each(['resource', 'identity', 'original', 'master'] as const)(
      'retains a technically replaced %s binding as stale without substituting a resource',
      async (target) => {
        const f = await population(1);
        switch (target) {
          case 'resource': {
            await sql`DELETE FROM public.icloud_resource WHERE id=${f.resource.id}::uuid`.execute(db);

            break;
          }
          case 'identity': {
            await sql`DELETE FROM public.icloud_source_identity WHERE id=${f.identityId}::uuid`.execute(db);

            break;
          }
          case 'original': {
            await db
              .updateTable('asset')
              .set({ originalPath: f.originalPath + '.replaced' })
              .where('id', '=', f.asset.id)
              .execute();

            break;
          }
          default: {
            await sql`UPDATE public.icloud_record SET revision='master-replaced'
          WHERE "connectionId"=${f.connection.id}::uuid AND "recordId"=${f.master}`.execute(db);
          }
        }
        await grant(f);
        const cohort = await weekly().freezeCohort(f.user.id, f.connection.id);
        expect(Number(cohort.populationCount)).toBe(0);
        expect(Number(cohort.staleCount)).toBe(1);
        expect(await members(cohort.id)).toMatchObject([
          { technicalEligibility: 'stale', selected: false, auditRequestId: null },
        ]);
      },
    );

    it('keeps N/k and immutable selected membership without a grant, and cannot revive under regrant', async () => {
      const f = await population(1);
      // Adoption now requires genuine consent first. Retire it before freezing; receipt provenance remains.
      await weekly().setAuthority(f.grantAuth, f.connection.id, {
        enabled: false,
        includeProtected: false,
        requestKey: randomUUID(),
      });
      const cohort = await weekly().freezeCohort(f.user.id, f.connection.id);
      expect(Number(cohort.populationCount)).toBe(1);
      expect(Number(cohort.selectedCount)).toBe(1);
      expect(Number(cohort.unavailableCount)).toBe(1);
      expect(Number(cohort.performedCount)).toBe(0);
      const before = await members(cohort.id);
      expect(before).toMatchObject([{ selected: true, outcome: 'unavailable', auditRequestId: null }]);
      await grant(f);
      expect(await weekly().freezeCohort(f.user.id, f.connection.id)).toEqual(cohort);
      expect(await weekly().createNextBatch(cohort.id, operations())).toBeNull();
      expect(await members(cohort.id)).toEqual(before);
    });

    it('marks selected protected resources unavailable under insufficient consent while preserving N/k', async () => {
      const f = await population(1);
      await new AssetRepository(db).lock([f.asset.id], AssetLockReason.Marked, f.user.id);
      await grant(f);
      const cohort = await weekly().freezeCohort(f.user.id, f.connection.id);
      expect(Number(cohort.populationCount)).toBe(1);
      expect(Number(cohort.selectedCount)).toBe(1);
      expect(Number(cohort.unavailableCount)).toBe(1);
      expect(await weekly().createNextBatch(cohort.id, operations())).toBeNull();
    });

    it('admits formerly public Locked originals only under genuine protected consent without shrinking N', async () => {
      const f = await population(1);
      await new AssetRepository(db).lock([f.asset.id], AssetLockReason.Marked, f.user.id);
      const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
      await db.updateTable('user').set({ pinCode: 'producer-private-pin' }).where('id', '=', f.user.id).execute();
      const { session } = await ctx.newSession({ userId: f.user.id });
      await sql`UPDATE public.session SET "pinExpiresAt"=clock_timestamp()+interval '1 hour'
        WHERE id=${session.id}::uuid`.execute(db);
      await weekly().setAuthority(factory.auth({ user: f.user, session }), f.connection.id, {
        enabled: true,
        includeProtected: true,
        requestKey: randomUUID(),
      });
      const cohort = await weekly().freezeCohort(f.user.id, f.connection.id);
      expect(Number(cohort.populationCount)).toBe(1);
      expect(Number(cohort.selectedCount)).toBe(1);
      expect(Number(cohort.unavailableCount)).toBe(0);
      const operation = await weekly().createNextBatch(cohort.id, operations());
      expect(operation?.totalUnits).toBe(1);
      expect((await weekly().status(f.connection.id, f.user.id)).executionAvailable).toBe(false);
    });

    it('refuses owner removal without leaving an unbound pending obligation or a proof count', async () => {
      const f = await population(1);
      await grant(f);
      const cohort = await weekly().freezeCohort(f.user.id, f.connection.id);
      await db.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', f.user.id).execute();
      expect(await weekly().createNextBatch(cohort.id, operations())).toBeNull();
      expect(await members(cohort.id)).toMatchObject([{ outcome: 'unavailable', auditRequestId: null }]);
      const {
        rows: [current],
      } = await sql<{ status: string; performedCount: string; unavailableCount: string }>`SELECT *
        FROM public.icloud_weekly_cohort WHERE id=${cohort.id}::uuid`.execute(db);
      expect(current.status).toBe('settled');
      expect(Number(current.performedCount)).toBe(0);
      expect(Number(current.unavailableCount)).toBe(1);
    });

    it('keeps config-excluded receipt resources in N after ordinary scope invalidation', async () => {
      const f = await population(1);
      await sync.update(f.connection.id, f.user.id, {
        config: { ...f.connection.config, libraries: ['other-library'] },
      });
      await grant(f);
      const cohort = await weekly().freezeCohort(f.user.id, f.connection.id);
      expect(Number(cohort.populationCount)).toBe(1);
      expect(Number(cohort.selectedCount)).toBe(1);
      expect(Number(cohort.unavailableCount)).toBe(1);
      expect(await members(cohort.id)).toMatchObject([
        { technicalEligibility: 'current', selected: true, outcome: 'unavailable' },
      ]);
      expect(await weekly().createNextBatch(cohort.id, operations())).toBeNull();
    });

    it('serializes concurrent producers and recovers committed bindings after a new repository instance', async () => {
      const f = await population(1);
      await grant(f);
      const cohort = await weekly().freezeCohort(f.user.id, f.connection.id);
      const emitted = vi.fn();
      const outbox = operations();
      const unsubscribe = outbox.onChange(emitted);
      try {
        const created = await Promise.all([
          weekly().createNextBatch(cohort.id, outbox),
          weekly().createNextBatch(cohort.id, outbox),
        ]);
        const only = created.filter((operation) => operation !== null);
        expect(only).toHaveLength(1);
        expect(emitted).toHaveBeenCalledOnce();
        expect(emitted).toHaveBeenCalledWith([{ id: only[0]!.id, ownerId: f.user.id }]);
        expect(await weekly().createNextBatch(cohort.id, operations())).toBeNull();
        const audits = (
          await sql`SELECT * FROM public.icloud_identity_audit WHERE "cohortId"=${cohort.id}::uuid`.execute(db)
        ).rows;
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          operationId: only[0]!.id,
          sessionId: null,
          purpose: 'scheduled-weekly',
          batchOrdinal: 0,
        });
      } finally {
        unsubscribe();
      }
    });

    it.each(['outbox', 'cursor'] as const)(
      'rolls back audits/member binding/cursor/outbox and emits no event if %s insertion fails',
      async (target) => {
        const f = await population(1);
        await grant(f);
        const cohort = await weekly().freezeCohort(f.user.id, f.connection.id);
        const before = await members(cohort.id);
        const emitted = vi.fn();
        const outbox = operations();
        const unsubscribe = outbox.onChange(emitted);
        const triggerTable =
          target === 'outbox' ? sql.table('public.media_operation') : sql.table('public.icloud_weekly_cohort');
        await sql`CREATE FUNCTION public.weekly_producer_test_rollback() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_TABLE_NAME='media_operation' THEN
            IF NEW.snapshot->>'task'='identity-audit-weekly' THEN RAISE EXCEPTION 'weekly_producer_test_rollback'; END IF;
          ELSE
            IF NEW."nextBatch">OLD."nextBatch" THEN RAISE EXCEPTION 'weekly_producer_test_rollback'; END IF;
          END IF;
          RETURN NEW;
        END $$`.execute(db);
        try {
          await sql`CREATE TRIGGER weekly_producer_test_rollback BEFORE INSERT OR UPDATE ON ${triggerTable}
          FOR EACH ROW EXECUTE FUNCTION public.weekly_producer_test_rollback()`.execute(db);
          await expect(weekly().createNextBatch(cohort.id, outbox)).rejects.toThrow('weekly_producer_test_rollback');
          expect(emitted).not.toHaveBeenCalled();
          expect(await members(cohort.id)).toEqual(before);
          expect(
            (await sql`SELECT id FROM public.icloud_identity_audit WHERE "cohortId"=${cohort.id}::uuid`.execute(db))
              .rows,
          ).toEqual([]);
          expect(
            (await sql`SELECT id FROM public.media_operation WHERE snapshot->>'cohortId'=${cohort.id}`.execute(db))
              .rows,
          ).toEqual([]);
          expect(await weekly().freezeCohort(f.user.id, f.connection.id)).toEqual(cohort);
        } finally {
          await sql`DROP TRIGGER IF EXISTS weekly_producer_test_rollback ON ${triggerTable}`.execute(db);
          await sql`DROP FUNCTION public.weekly_producer_test_rollback()`.execute(db);
          unsubscribe();
        }
        expect(await weekly().createNextBatch(cohort.id, operations())).not.toBeNull();
      },
    );

    it('retires already-bound queued audits without erasing operation bindings or publishing a proof', async () => {
      const f = await population(1);
      const { auth, input } = await grant(f);
      const cohort = await weekly().freezeCohort(f.user.id, f.connection.id);
      const operation = (await weekly().createNextBatch(cohort.id, operations()))!;
      const before = await members(cohort.id);
      await weekly().setAuthority(auth, f.connection.id, { ...input, requestKey: randomUUID(), enabled: false });
      await weekly().settleUnavailable(cohort.id);
      const after = await members(cohort.id);
      expect(after[0].outcome).toBe('unavailable');
      expect(after[0].auditRequestId).toBe(before[0].auditRequestId);
      const {
        rows: [audit],
      } = await sql`SELECT * FROM public.icloud_identity_audit
        WHERE id=${after[0].auditRequestId}::uuid`.execute(db);
      expect(audit).toMatchObject({ result: 'stale', verifiedAt: null, operationId: operation.id });
      expect(
        (
          await sql`SELECT "lastVerifiedAt" FROM public.icloud_source_identity
        WHERE id=${f.identityId}::uuid`.execute(db)
        ).rows,
      ).toEqual([{ lastVerifiedAt: null }]);
      expect(await weekly().createNextBatch(cohort.id, operations())).toBeNull();
    });

    it('retires pending obligations after revoke+regrant without retokening frozen context or counting performed work', async () => {
      const f = await population(1);
      const { auth, input } = await grant(f);
      const cohort = await weekly().freezeCohort(f.user.id, f.connection.id);
      const before = await members(cohort.id);
      await weekly().setAuthority(auth, f.connection.id, { ...input, requestKey: randomUUID(), enabled: false });
      await weekly().setAuthority(auth, f.connection.id, { ...input, requestKey: randomUUID() });
      expect(await weekly().createNextBatch(cohort.id, operations())).toBeNull();
      const after = await members(cohort.id);
      expect(after.map(({ outcome: _outcome, ...member }) => member)).toEqual(
        before.map(({ outcome: _outcome, ...member }) => member),
      );
      expect(after).toMatchObject([{ outcome: 'unavailable', auditRequestId: null }]);
      const current = await weekly().freezeCohort(f.user.id, f.connection.id);
      expect(current.seed).toEqual(cohort.seed);
      expect(current.grantGeneration).toBe(cohort.grantGeneration);
      expect(Number(current.performedCount)).toBe(0);
      expect(Number(current.unavailableCount)).toBe(1);
      expect(current.status).toBe('settled');
    });

    describe('scheduled repository admission prerequisites without a byte worker', () => {
      async function scheduledAuthorityFixture(protectedOriginal = false) {
        const f = await population(1);
        const { auth, input } = await grant(f);
        if (protectedOriginal) {
          await db.updateTable('user').set({ pinCode: 'scheduled-fixture-pin' }).where('id', '=', f.user.id).execute();
          await sql`INSERT INTO public.asset_lock ("assetId",reason)
            VALUES (${f.asset.id}::uuid,${AssetLockReason.Marked})`.execute(db);
          await db
            .updateTable('session')
            .set({ pinExpiresAt: sql<Date>`clock_timestamp()+interval '10 minutes'` })
            .where('id', '=', auth.session!.id)
            .execute();
          auth.session!.hasElevatedPermission = true;
          await weekly().setAuthority(auth, f.connection.id, {
            ...input,
            requestKey: randomUUID(),
            includeProtected: true,
          });
        }
        const cohort = await weekly().freezeCohort(f.user.id, f.connection.id);
        const operation = (await weekly().createNextBatch(cohort.id, operations()))!;
        expect(operation).toBeDefined();
        const member = (await members(cohort.id)).find((row) => row.auditRequestId)!;
        const authority: ScheduledAuditAuthority = {
          purpose: 'scheduled-weekly',
          auditRequestId: member.auditRequestId!,
          operationId: operation.id,
          operationClaimToken: randomUUID(),
        };
        // Durable worker/resource lease fixtures; these do not execute a dispatcher or mint proof.
        await sql`UPDATE public.media_operation SET status='preparing',"claimToken"=${authority.operationClaimToken}::uuid,
          "claimExpiresAt"=clock_timestamp()+interval '10 minutes' WHERE id=${operation.id}::uuid`.execute(db);
        await sql`UPDATE public.icloud_claim SET "expiresAt"=clock_timestamp()-interval '1 second'
          WHERE "ownerId"=${f.user.id}::uuid`.execute(db);
        const [claim] = await identities.claim(
          f.user.id,
          [f.resource.sourceAssetId.toUpperCase()],
          `icloud-sync:audit:${operation.id}`,
          600,
        );
        expect(claim).toBeDefined();
        await new ICloudAuditRepository(db).setItemClaim(authority.auditRequestId, f.user.id, claim.id);
        const resource = { id: randomUUID(), leaseToken: randomUUID() };
        await sql`INSERT INTO public.icloud_resource (id,"ownerId","connectionId","libraryKey",library,"sourceAssetId",
          "recordId","resourceKey",role,fingerprint,source,"expectedSize",status,"auditRequestId","leaseToken","leaseExpiresAt")
          SELECT ${resource.id}::uuid,"ownerId","connectionId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,
            fingerprint,source,"expectedSize",'claimed',${authority.auditRequestId}::uuid,${resource.leaseToken}::uuid,
            clock_timestamp()+interval '10 minutes' FROM public.icloud_resource WHERE id=${f.resource.id}::uuid`.execute(
          db,
        );
        return { f, auth, input, authority, resource, cohort, claim };
      }

      it.each([false, true])(
        'admits actual durable authority after session deletion; protected=%s; publication stays unavailable',
        async (protectedOriginal) => {
          const fixture = await scheduledAuthorityFixture(protectedOriginal);
          const { f, auth, authority, resource } = fixture;
          await db.deleteFrom('session').where('id', '=', auth.session!.id).execute();
          await db.transaction().execute(async (tx) => {
            const guarded = await guardScheduledAudit(tx, authority, f.user.id, { resource });
            expect(guarded).toBeDefined();
            expect(guarded?.private).toBe(protectedOriginal);
            expect(await guardAuditAuthority(tx, authority, f.user.id, true, resource)).toBeDefined();
            const { rows } = await sql<{
              allowed: boolean;
            }>`SELECT ${scheduledAuditFinalFence(authority, guarded!, resource)} AS allowed`.execute(tx);
            expect(rows[0].allowed).toBe(true);
            await expect(publishAudit(tx, authority, f.user.id, 'match', resource)).rejects.toThrow(
              'scheduled_audit_execution_unavailable',
            );
          });
          const recovery = new MediaRecoveryRepository(db);
          const input = {
            ownerId: f.user.id,
            resourceId: resource.id,
            leaseToken: resource.leaseToken,
            includeHidden: true,
            audit: authority,
          };
          expect(await recovery.getResource(input)).toMatchObject({
            id: resource.id,
            auditRequestId: authority.auditRequestId,
          });
          const verifyFinal = vi.fn();
          expect(
            await recovery.commitVerifiedReuse({
              ...input,
              candidate: {} as never,
              verified: { sha256: f.sha256 } as never,
              verifyFinal,
            }),
          ).toEqual({ outcome: 'retry', reason: 'mapping_changed' });
          expect(verifyFinal).not.toHaveBeenCalled();
          const { rows } = await sql<{
            result: string;
          }>`SELECT result FROM public.icloud_identity_audit WHERE id=${authority.auditRequestId}::uuid`.execute(db);
          expect(rows[0].result).toBe('queued');
          expect(
            await db
              .selectFrom('asset_integrity_verification')
              .select('assetId')
              .where('assetId', '=', f.asset.id)
              .execute(),
          ).toEqual([]);
        },
      );

      it('acquires content serialization once before locking and reading the scheduled owner', async () => {
        const { f, authority, resource } = await scheduledAuthorityFixture();
        const queries: CompiledQuery[] = [];
        captureCompiledQuery = (query) => {
          queries.push(query);
        };
        await db.transaction().execute(async (tx) => {
          expect(await guardScheduledAudit(tx, authority, f.user.id, { resource })).toBeDefined();
        });
        captureCompiledQuery = undefined;
        const contentKey = createHash('sha1')
          .update(`icloud-content:${f.user.id}:${f.sha256.toString('hex')}`)
          .digest()
          .readBigInt64BE(0)
          .toString();
        const contentLocks = queries.filter(
          (query) => /SELECT pg_advisory_xact_lock\(/i.test(query.sql) && query.parameters.includes(contentKey),
        );
        expect(contentLocks).toHaveLength(1);
        const ownerReads = queries.filter(
          (query) => /from "user"/i.test(query.sql) && query.parameters.includes(f.user.id),
        );
        expect(ownerReads).toHaveLength(1);
        expect(ownerReads[0].sql).toMatch(/"pinCode".*"deletedAt".*for update/i);
        expect(queries.indexOf(contentLocks[0])).toBeLessThan(queries.indexOf(ownerReads[0]));
      });

      it('uses persisted purpose and refuses a session-style caller or nontransactional scheduled admission', async () => {
        const { f, authority, resource } = await scheduledAuthorityFixture();
        expect(await guardAuditAuthority(db, authority, f.user.id, true, resource)).toBeUndefined();
        await db.transaction().execute(async (tx) => {
          const { purpose: _purpose, ...manual } = authority;
          expect(await guardAuditAuthority(tx, manual, f.user.id, true, resource)).toBeUndefined();
          expect(
            await guardAuditAuthority(tx, { ...authority, operationId: randomUUID() }, f.user.id, true, resource),
          ).toBeUndefined();
          expect(await guardAuditAuthority(tx, authority, randomUUID(), true, resource)).toBeUndefined();
        });
      });

      it.each(['operation', 'item', 'resource', 'pause', 'cancel'] as const)(
        'refuses database-expired or stopped %s authority and final fence',
        async (kind) => {
          const { f, authority, resource, claim } = await scheduledAuthorityFixture();
          const guarded = await db
            .transaction()
            .execute((tx) => guardScheduledAudit(tx, authority, f.user.id, { resource }));
          expect(guarded).toBeDefined();
          switch (kind) {
            case 'operation': {
              await sql`UPDATE public.media_operation SET "claimExpiresAt"=clock_timestamp()-interval '1 second' WHERE id=${authority.operationId}::uuid`.execute(
                db,
              );

              break;
            }
            case 'item': {
              await sql`UPDATE public.icloud_claim SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE id=${claim.id}::uuid`.execute(
                db,
              );

              break;
            }
            case 'resource': {
              await sql`UPDATE public.icloud_resource SET "leaseExpiresAt"=clock_timestamp()-interval '1 second' WHERE id=${resource.id}::uuid`.execute(
                db,
              );

              break;
            }
            case 'pause': {
              await sql`UPDATE public.media_operation SET "pauseRequestedAt"=clock_timestamp() WHERE id=${authority.operationId}::uuid`.execute(
                db,
              );

              break;
            }
            default: {
              await sql`UPDATE public.media_operation SET "cancelRequestedAt"=clock_timestamp() WHERE id=${authority.operationId}::uuid`.execute(
                db,
              );
            }
          }
          await db.transaction().execute(async (tx) => {
            expect(await guardScheduledAudit(tx, authority, f.user.id, { resource })).toBeUndefined();
            expect(
              (
                await sql<{
                  allowed: boolean;
                }>`SELECT ${scheduledAuditFinalFence(authority, guarded!, resource)} AS allowed`.execute(tx)
              ).rows[0].allowed,
            ).toBe(false);
          });
        },
      );

      it.each(['duplicate', 'foreign', 'missing', 'purpose'] as const)(
        'refuses a %s operation audit vector despite a live claim',
        async (kind) => {
          const { f, authority, resource } = await scheduledAuthorityFixture();
          const guarded = await db
            .transaction()
            .execute((tx) => guardScheduledAudit(tx, authority, f.user.id, { resource }));
          expect(guarded).toBeDefined();
          const ids =
            kind === 'duplicate'
              ? [authority.auditRequestId, authority.auditRequestId]
              : kind === 'foreign'
                ? [randomUUID()]
                : [];
          if (kind === 'purpose') {
            await sql`UPDATE public.media_operation SET snapshot=jsonb_set(snapshot,'{purpose}','"manual-session"'::jsonb)
            WHERE id=${authority.operationId}::uuid`.execute(db);
          } else {
            await sql`UPDATE public.media_operation SET snapshot=jsonb_set(snapshot,'{auditIds}',${JSON.stringify(ids)}::jsonb)
            WHERE id=${authority.operationId}::uuid`.execute(db);
          }
          await db.transaction().execute(async (tx) => {
            expect(await guardScheduledAudit(tx, authority, f.user.id, { resource })).toBeUndefined();
            expect(
              (
                await sql<{
                  allowed: boolean;
                }>`SELECT ${scheduledAuditFinalFence(authority, guarded!, resource)} AS allowed`.execute(tx)
              ).rows[0].allowed,
            ).toBe(false);
          });
        },
      );

      it('a revoked/regranted generation cannot revive an old admitted final fence', async () => {
        const { f, auth, input, authority, resource } = await scheduledAuthorityFixture();
        const guarded = await db
          .transaction()
          .execute((tx) => guardScheduledAudit(tx, authority, f.user.id, { resource }));
        expect(guarded).toBeDefined();
        await weekly().setAuthority(auth, f.connection.id, { ...input, requestKey: randomUUID(), enabled: false });
        await weekly().setAuthority(auth, f.connection.id, { ...input, requestKey: randomUUID() });
        await db.transaction().execute(async (tx) => {
          expect(await guardScheduledAudit(tx, authority, f.user.id, { resource })).toBeUndefined();
          expect(
            (
              await sql<{
                allowed: boolean;
              }>`SELECT ${scheduledAuditFinalFence(authority, guarded!, resource)} AS allowed`.execute(tx)
            ).rows[0].allowed,
          ).toBe(false);
        });
      });

      it.each(['original', 'physical', 'pin', 'source', 'identity'] as const)(
        'refuses changed %s binding after awaited admission',
        async (kind) => {
          const { f, authority, resource } = await scheduledAuthorityFixture(kind === 'pin');
          const guarded = await db
            .transaction()
            .execute((tx) => guardScheduledAudit(tx, authority, f.user.id, { resource }));
          expect(guarded).toBeDefined();
          switch (kind) {
            case 'original': {
              await db
                .updateTable('asset')
                .set({ originalPath: `${f.asset.originalPath}.replaced` })
                .where('id', '=', f.asset.id)
                .execute();

              break;
            }
            case 'pin': {
              await db.updateTable('user').set({ pinCode: 'changed-pin' }).where('id', '=', f.user.id).execute();

              break;
            }
            case 'source': {
              await sql`UPDATE public.icloud_record SET revision='changed-after-admission'
            WHERE "connectionId"=${f.connection.id}::uuid AND "recordId"=${f.resource.sourceAssetId}`.execute(db);

              break;
            }
            case 'identity': {
              await sql`UPDATE public.icloud_source_identity SET sha256=${Buffer.alloc(32)}
            WHERE id=${f.identityId}::uuid`.execute(db);

              break;
            }
            default: {
              // A real owned asset mapping change, never authority inherited from a physical file owner.
              const physicalId = randomUUID();
              await sql`INSERT INTO public.physical_file (id,type,checksum,path,"sizeInBytes","canonicalAssetId")
                VALUES (${physicalId}::uuid,'original',${f.sha256},${`${f.asset.originalPath}.other-physical`},1,${f.asset.id}::uuid)`.execute(
                db,
              );
              await db
                .updateTable('asset')
                .set({ physicalOriginalFileId: physicalId })
                .where('id', '=', f.asset.id)
                .execute();
            }
          }
          await db.transaction().execute(async (tx) => {
            expect(await guardScheduledAudit(tx, authority, f.user.id, { resource })).toBeUndefined();
            expect(
              (
                await sql<{
                  allowed: boolean;
                }>`SELECT ${scheduledAuditFinalFence(authority, guarded!, resource)} AS allowed`.execute(tx)
              ).rows[0].allowed,
            ).toBe(false);
          });
        },
      );

      it('waits for actual metadata authority before acquiring an original asset row lock', async () => {
        const { f, authority, resource } = await scheduledAuthorityFixture();
        const database = new DatabaseRepository(db, getMocks().logger as never, new ConfigRepository());
        const entered = Promise.withResolvers<number>();
        const resume = Promise.withResolvers<void>();
        const classifying = database.withAssetMetadataLock(f.asset.id, async (tx) => {
          entered.resolve((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx)).rows[0].pid);
          await resume.promise;
        });
        const holderPid = await entered.promise;
        const admission = db.transaction().execute((tx) => guardScheduledAudit(tx, authority, f.user.id, { resource }));
        void admission.catch(() => {});
        void classifying.catch(() => {});
        try {
          await expect
            .poll(
              async () =>
                (
                  await sql`SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type='Lock' AND ${holderPid}::int=ANY(pg_blocking_pids(pid))`.execute(db)
                ).rows.length,
              { timeout: 1000 },
            )
            .toBe(1);
          const { rows } = await sql`SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
            WHERE ${holderPid}::int=ANY(pg_blocking_pids(a.pid)) AND l.relation='public.asset'::regclass
              AND l.mode='RowShareLock' AND l.granted`.execute(db);
          expect(rows).toEqual([]);
        } finally {
          resume.resolve();
          await Promise.allSettled([classifying, admission]);
        }
        await classifying;
        expect(await admission).toBeDefined();
      });

      // Aggregate budget for real staging, decode and copy setup; explicit case caps still apply.
      describe('fresh scheduled stream provenance and real decoder ownership', { timeout: 15_000 }, () => {
        async function createStageFixture(protectedOriginal = false, decoder?: MediaIntegrityService) {
          const fixture = await scheduledAuthorityFixture(protectedOriginal);
          const input = { ownerId: fixture.f.user.id, authority: fixture.authority, resource: fixture.resource };
          const root = join(await realpath(dirname(fixture.f.originalPath)), 'scheduled-stage');
          vi.stubEnv('FRAMELEAF_ICLOUD_STAGING_PATH', root);
          vi.stubEnv('FRAMELEAF_ICLOUD_FREE_SPACE_BYTES', '0');
          const key = Buffer.alloc(32, 77); // Test-only key; no actual secret or provider request.
          const probe = await open(fixture.f.originalPath, 'r');
          const syncSpy = vi.spyOn(Object.getPrototypeOf(probe), 'sync');
          await probe.close();
          let completed = false;
          const transport = {
            decodeSession: vi.fn((scope: string, encrypted: string) => {
              try {
                return Promise.resolve(
                  encrypted === 'fixture-session' ? { version: 1 } : decryptICloudSession(key, scope, encrypted),
                );
              } catch (error) {
                return Promise.reject(error);
              }
            }),
            encodeSession: vi.fn(async (scope: string, payload: unknown) => {
              if (scope.startsWith('icloud-audit-fresh-download:')) {
                const receipt = payload as ScheduledFreshPayload;
                // This observes actual pipeline completion, actual file/directory sync and exact
                // persisted-file identity BEFORE the producer creates authenticated evidence.
                expect(completed).toBe(true);
                expect(syncSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
                expect(await readFile(receipt.path)).toEqual(fixture.f.bytes);
                const stat = await lstat(receipt.path);
                expect(receipt.identity).toEqual({
                  dev: stat.dev,
                  ino: stat.ino,
                  size: stat.size,
                  mtimeMs: stat.mtimeMs,
                  ctimeMs: stat.ctimeMs,
                });
                expect(receipt.sha256).toBe(createHash('sha256').update(fixture.f.bytes).digest('hex'));
              }
              return encryptICloudSession(key, scope, payload);
            }),
            download: vi.fn(() =>
              Promise.resolve({
                stream: Readable.from(
                  (function* () {
                    yield fixture.f.bytes.subarray(0, 1);
                    yield fixture.f.bytes.subarray(1);
                    completed = true;
                  })(),
                ),
                session: { version: 1 },
                fingerprint: fixture.f.resource.fingerprint,
                size: fixture.f.bytes.length,
              }),
            ),
          };
          const repository = new ICloudScheduledStagingRepository(db, transport as never);
          const stored = vi.spyOn(repository, 'storeFreshDownload');
          const withSession = vi.spyOn(sync, 'withSession');
          const ordinary = new ICloudStagingService(
            sync,
            transport as never,
            { getAll: () => Promise.resolve([]) } as never,
          );
          const staging = new ICloudScheduledStagingService(
            repository,
            ordinary,
            transport as never,
            decoder ?? integrity,
          );
          return { ...fixture, input, root, key, repository, stored, withSession, ordinary, staging, transport };
        }

        async function createWorkerFixture(protectedOriginal = false, decoder?: MediaIntegrityService) {
          const fixture = await createStageFixture(protectedOriginal, decoder);
          // Use the actual budget allocator and actual operation claimant, replacing only old admission fixtures.
          await sql`DELETE FROM public.icloud_resource WHERE id=${fixture.resource.id}::uuid`.execute(db);
          await sql`UPDATE public.media_operation SET status='queued',"claimToken"=NULL,"claimExpiresAt"=NULL
            WHERE id=${fixture.authority.operationId}::uuid`.execute(db);
          const outbox = operations();
          const claimed = await db.transaction().execute(async (tx) => {
            // Other tests' durable queue rows stay untouched; real SKIP LOCKED selects this obligation.
            await sql`SELECT id FROM public.media_operation WHERE kind='icloud_sync' AND status='queued'
              AND id<>${fixture.authority.operationId}::uuid ORDER BY id FOR UPDATE`.execute(tx);
            return outbox.claimNext({
              kinds: [MediaOperationKind.ICloudSync],
              workerId: 'weekly-contract',
              leaseMs: 600_000,
            });
          });
          expect(claimed?.operation.id).toBe(fixture.authority.operationId);
          const workerRepository = new ICloudScheduledWorkerRepository(db, fixture.repository);
          const recoveryRepository = new MediaRecoveryRepository(db, fixture.repository);
          const recovery = new MediaRecoveryService(recoveryRepository, decoder ?? integrity, fixture.staging);
          const transport = { ...fixture.transport, enabled: () => true };
          const worker = new ICloudScheduledWorkerService(
            workerRepository,
            identities,
            fixture.staging,
            recovery,
            outbox,
            transport as never,
          );
          return { ...fixture, claimed: claimed!, workerRepository, recoveryRepository, recovery, worker };
        }

        async function scheduledWorkerState(fixture: Awaited<ReturnType<typeof createStageFixture>>) {
          const {
            rows: [cohort],
          } = await sql<{
            status: string;
            match: string;
            mismatch: string;
            performed: string;
            unavailable: string;
            cancelled: string;
          }>`SELECT status,
            "matchCount"::text AS match,"mismatchCount"::text AS mismatch,"performedCount"::text AS performed,"unavailableCount"::text AS unavailable,
            "cancelledCount"::text AS cancelled FROM public.icloud_weekly_cohort WHERE id=${fixture.cohort.id}::uuid`.execute(
            db,
          );
          const request = await new ICloudAuditRepository(db).get(fixture.authority.auditRequestId, fixture.f.user.id);
          const identity = (
            await sql<{
              lastVerifiedAt: Date | null;
              lastAuditResult: string | null;
            }>`SELECT "lastVerifiedAt","lastAuditResult"
            FROM public.icloud_source_identity WHERE id=${fixture.f.identityId}::uuid`.execute(db)
          ).rows[0];
          return { cohort, request, identity };
        }

        // A private-copy/disposition fixture, NOT evidence of a genuine source-descriptor mismatch.
        // The byte producer, owner admission, crypto, PostgreSQL and filesystem operations are real.
        async function createDispositionFixture() {
          const prerequisite = await createStageFixture();
          // Replace the admission-only resource with an actual source-byte budget reservation.
          await sql`DELETE FROM public.icloud_resource WHERE id=${prerequisite.resource.id}::uuid`.execute(db);
          const allocated = await new ICloudScheduledWorkerRepository(db, prerequisite.repository).allocate(
            prerequisite.authority,
            prerequisite.f.user.id,
          );
          expect(allocated?.leaseToken).toBeTruthy();
          if (!allocated?.leaseToken) {
            throw new Error('actual_scheduled_allocation_required');
          }
          const resource = { id: allocated.id, leaseToken: allocated.leaseToken };
          const fixture = { ...prerequisite, resource, input: { ...prerequisite.input, resource } };
          const fresh = await fixture.staging.download(fixture.input);
          const validation = await fixture.staging.validate(fixture.input);
          expect((await validation.result).status).toBe('validated');
          await validation.settled;
          const promotedPath = join(dirname(fixture.f.originalPath), '.icloud-recovery', `${randomUUID()}.jpg`);
          await mkdir(dirname(promotedPath), { mode: 0o700 });
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
          await db.transaction().execute(async (tx) => {
            await sql`SELECT pg_advisory_xact_lock(hashtextextended('icloud-staging-reservations',0))`.execute(tx);
            await sql`UPDATE public.icloud_resource SET "promotedPath"=${promotedPath},"expectedTarget"=${JSON.stringify(target)}::text::jsonb,
              verification=verification||'{"retained0217Field":"unchanged"}'::jsonb WHERE id=${fixture.resource.id}::uuid`.execute(
              tx,
            );
            expect(await fixture.repository.planPrivateCopy(tx, fixture.input, promotedPath)).toBe(true);
          });
          const state = async () =>
            (
              await sql<ICloudResource>`SELECT *,"reservedBytes"::float8 AS "reservedBytes"
            FROM public.icloud_resource WHERE id=${fixture.resource.id}::uuid`.execute(db)
            ).rows[0];
          expect((await state()).reservedBytes).toBe(2 * fixture.f.bytes.length);
          const retire = async () =>
            expect(
              await new ICloudScheduledWorkerRepository(db, fixture.repository).settleUnavailable(
                fixture.authority,
                fixture.f.user.id,
                'unavailable',
              ),
            ).toBe(true);
          return { ...fixture, fresh, promotedPath, target, state, retire };
        }

        it('disposes only the actual owned pair after settlement, preserves original/0217 fields and resumes after credential loss', async () => {
          const fixture = await createDispositionFixture();
          await fixture.staging.copyRecovery(fixture.input, fixture.promotedPath);
          const before = await fixture.state();
          const copy = before.verification?.auditPrivateCopy;
          expect(privateCopyFiles.validPrivateCopy(copy)).toBe(true);
          if (!privateCopyFiles.validPrivateCopy(copy)) {
            throw new Error('actual_owned_copy_required');
          }
          expect(copy.payload).toMatchObject({
            settled: true,
            promoted: true,
            identity: privateCopyFiles.privateCopyIdentity(await lstat(fixture.promotedPath)),
          });
          await fixture.retire();
          await sync.update(fixture.f.connection.id, fixture.f.user.id, {
            state: 'disconnected',
            encryptedSession: null,
          });
          await db.deleteFrom('session').where('id', '=', fixture.auth.session!.id).execute();
          const restarted = new ICloudScheduledStagingService(
            new ICloudScheduledStagingRepository(db, fixture.transport as never),
            fixture.ordinary,
            fixture.transport as never,
            integrity,
          );
          await restarted.housekeeping();
          expect(await fixture.state()).toMatchObject({
            status: 'removed',
            reservedBytes: 0,
            promotedPath: null,
            stagingPath: null,
            pendingJobs: [],
          });
          expect((await fixture.state()).verification?.retained0217Field).toBe('unchanged');
          await expect(access(fixture.promotedPath)).rejects.toMatchObject({ code: 'ENOENT' });
          await expect(access(fixture.fresh.payload.path)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await readFile(fixture.f.originalPath)).toEqual(fixture.f.bytes);
          expect(
            (await new ICloudAuditRepository(db).get(fixture.authority.auditRequestId, fixture.f.user.id))?.result,
          ).toBe('failed');
          await restarted.housekeeping(); // Idempotent retry neither releases twice nor publishes proof.
          expect((await fixture.state()).reservedBytes).toBe(0);
        });

        it('never adopts an EEXIST destination; only its real private partial/source copies can be disposed', async () => {
          const fixture = await createDispositionFixture();
          const existing = Buffer.from('preexisting unowned destination');
          await writeFile(fixture.promotedPath, existing, { mode: 0o600, flag: 'wx' });
          await expect(fixture.staging.copyRecovery(fixture.input, fixture.promotedPath)).rejects.toMatchObject({
            code: 'EEXIST',
          });
          const copy = (await fixture.state()).verification?.auditPrivateCopy;
          expect(privateCopyFiles.validPrivateCopy(copy) && copy.payload.promoted).toBe(false);
          await fixture.retire();
          await fixture.staging.cleanupRetired(fixture.input);
          expect(await readFile(fixture.promotedPath)).toEqual(existing);
          expect(await fixture.state()).toMatchObject({ status: 'removed', reservedBytes: 0 });
          expect(await readFile(fixture.f.originalPath)).toEqual(fixture.f.bytes);
        });

        it.each([
          'owner-forgery',
          'generation-forgery',
          'inode-replacement',
          'operation-replacement',
          'item-replacement',
          'outbox',
          'asset-reference',
          'physical-reference',
          'resource-reservation',
          'legacy',
        ] as const)('retains private charged copies under %s rather than borrowing cleanup authority', async (kind) => {
          const fixture = await createDispositionFixture();
          await fixture.staging.copyRecovery(fixture.input, fixture.promotedPath);
          await fixture.retire();
          const before = await fixture.state();
          switch (kind) {
            case 'owner-forgery':
            case 'generation-forgery': {
              const copy = structuredClone(
                before.verification!.auditPrivateCopy,
              ) as privateCopyFiles.ScheduledPrivateCopyRecord;
              if (kind === 'owner-forgery') {
                copy.payload.ownerId = randomUUID();
              } else {
                copy.payload.generation = randomUUID();
              }
              await sql`UPDATE public.icloud_resource SET verification=verification||jsonb_build_object('auditPrivateCopy',${JSON.stringify(copy)}::text::jsonb)
              WHERE id=${fixture.resource.id}::uuid`.execute(db); // Old server seal cannot authenticate authored JSON.

              break;
            }
            case 'inode-replacement': {
              await rename(fixture.promotedPath, `${fixture.promotedPath}.original-inode`);
              await writeFile(fixture.promotedPath, fixture.f.bytes, { mode: 0o600, flag: 'wx' });

              break;
            }
            case 'operation-replacement': {
              await sql`UPDATE public.media_operation SET "claimToken"=${randomUUID()}::uuid
              WHERE id=${fixture.authority.operationId}::uuid`.execute(db);

              break;
            }
            case 'item-replacement': {
              await sql`UPDATE public.icloud_claim SET "expiresAt"=clock_timestamp()-interval '1 second'
              WHERE id=${fixture.claim.id}::uuid`.execute(db);
              await identities.claim(
                fixture.f.user.id,
                [fixture.f.resource.sourceAssetId.toUpperCase()],
                `device:${randomUUID()}`,
                1800,
              );

              break;
            }
            case 'outbox': {
              await sql`UPDATE public.icloud_resource SET "pendingJobs"=${JSON.stringify([{ name: 'metadataExtraction', data: { id: fixture.target.assetId } }])}::text::jsonb
              WHERE id=${fixture.resource.id}::uuid`.execute(db);

              break;
            }
            case 'asset-reference': {
              await db
                .updateTable('asset')
                .set({ originalPath: fixture.promotedPath })
                .where('id', '=', fixture.f.asset.id)
                .execute();

              break;
            }
            case 'physical-reference': {
              await sql`INSERT INTO public.physical_file (id,type,checksum,path,"sizeInBytes","createdAt","updatedAt")
              VALUES (${randomUUID()}::uuid,'original',${fixture.f.sha256},${fixture.promotedPath},${fixture.f.bytes.length},clock_timestamp(),clock_timestamp())`.execute(
                db,
              );

              break;
            }
            case 'resource-reservation': {
              // A distinct durable recovery obligation owns its reserved destination even before publication.
              await sql`UPDATE public.icloud_resource SET "promotedPath"=${fixture.promotedPath}
                WHERE id=${fixture.f.resource.id}::uuid`.execute(db);

              break;
            }
            default: {
              await sql`UPDATE public.icloud_resource SET verification=verification-'auditPrivateCopy'
              WHERE id=${fixture.resource.id}::uuid`.execute(db);
            }
          }
          await fixture.staging.cleanupRetired(fixture.input);
          expect((await fixture.state()).reservedBytes).toBe(before.reservedBytes);
          expect((await fixture.state()).status).toBe('failed');
          expect(await readFile(fixture.promotedPath)).toEqual(fixture.f.bytes);
          expect(await readFile(fixture.fresh.payload.path)).toEqual(fixture.f.bytes);
          expect((await fixture.state()).pendingJobs).toEqual(
            kind === 'outbox' ? [{ name: 'metadataExtraction', data: { id: fixture.target.assetId } }] : [],
          );
        });

        it('keeps actual late decoder work pending across a restarted cleanup and deletes only after true settlement', async ({
          signal,
        }) => {
          const settled = Promise.withResolvers<void>();
          stagedProofSettled = settled.promise;
          const decoderDone = Promise.withResolvers<void>();
          let staging: ICloudScheduledStagingService | undefined;
          let validation: Awaited<ReturnType<ICloudScheduledStagingService['validate']>> | undefined;
          let restoreDecoder: (() => void) | undefined;
          try {
            const fixture = await createDispositionFixture();
            staging = fixture.staging;
            await fixture.staging.copyRecovery(fixture.input, fixture.promotedPath);
            const decoding = vi.spyOn(integrity, 'validateWithSettlement').mockReturnValueOnce({
              result: Promise.resolve({ status: 'timeout', reason: 'validation_timeout' }),
              settled: decoderDone.promise,
              cancel: vi.fn(),
            });
            restoreDecoder = () => decoding.mockRestore();
            validation = await fixture.staging.validate(fixture.input, signal, fixture.promotedPath);
            expect(await validation.result).toEqual({ status: 'unavailable' });
            await fixture.retire();
            const restarted = new ICloudScheduledStagingService(
              fixture.repository,
              fixture.ordinary,
              fixture.transport as never,
              integrity,
            );
            const cleanup = fixture.staging.cleanupRetired(fixture.input);
            try {
              await restarted.housekeeping();
              expect((await fixture.state()).lastError).toBe('scheduled_private_copy_retained_pending-settlement');
              expect((await fixture.state()).reservedBytes).toBe(2 * fixture.f.bytes.length);
              expect(await readFile(fixture.promotedPath)).toEqual(fixture.f.bytes);
            } finally {
              decoderDone.resolve();
              decoding.mockRestore();
            }
            await validation.settled;
            await cleanup;
            expect(await fixture.state()).toMatchObject({ status: 'removed', reservedBytes: 0 });
            expect(await readFile(fixture.f.originalPath)).toEqual(fixture.f.bytes);
          } finally {
            try {
              decoderDone.resolve();
              restoreDecoder?.();
              validation?.cancel();
              await staging?.onShutdown();
            } finally {
              settled.resolve();
            }
          }
        });

        it('refuses a replacement JSON generation between authenticated read and terminal cleanup locks', async () => {
          const fixture = await createDispositionFixture();
          await fixture.staging.copyRecovery(fixture.input, fixture.promotedPath);
          await fixture.retire();
          const reached = Promise.withResolvers<void>();
          const resume = Promise.withResolvers<void>();
          // Save the real crypto implementation; binding the mock recurses when spyOn replaces it.
          const decode = fixture.transport.decodeSession.getMockImplementation();
          if (!decode) {
            throw new Error('actual_session_decoder_required');
          }
          const barrier = vi.spyOn(fixture.transport, 'decodeSession').mockImplementation(async (scope, encrypted) => {
            const payload = await decode(scope, encrypted);
            if (scope.startsWith('icloud-scheduled-private-copy:')) {
              reached.resolve();
              await resume.promise;
            }
            return payload;
          });
          const cleanup = fixture.staging.cleanupRetired(fixture.input);
          try {
            await reached.promise;
            const copy = structuredClone(
              (await fixture.state()).verification!.auditPrivateCopy,
            ) as privateCopyFiles.ScheduledPrivateCopyRecord;
            copy.payload.generation = randomUUID();
            await sql`UPDATE public.icloud_resource SET verification=verification||jsonb_build_object('auditPrivateCopy',${JSON.stringify(copy)}::text::jsonb)
              WHERE id=${fixture.resource.id}::uuid`.execute(db);
            resume.resolve();
            await cleanup;
          } finally {
            resume.resolve();
            try {
              await cleanup;
            } finally {
              barrier.mockRestore();
            }
          }
          expect(await fixture.state()).toMatchObject({ status: 'failed', reservedBytes: 2 * fixture.f.bytes.length });
          expect(await readFile(fixture.promotedPath)).toEqual(fixture.f.bytes);
          expect(await readFile(fixture.fresh.payload.path)).toEqual(fixture.f.bytes);
        });

        it.each([
          { disposition: 'copy', absent: false },
          { disposition: 'copy', absent: true },
          { disposition: 'staging', absent: false },
          { disposition: 'staging', absent: true },
        ] as const)(
          'fences whole-item reclaim through actual $disposition unlink/settlement; absent=$absent',
          async ({ disposition, absent }) => {
            const fixture = await createDispositionFixture();
            await fixture.staging.copyRecovery(fixture.input, fixture.promotedPath);
            await fixture.retire();
            if (disposition === 'staging') {
              expect(await fixture.repository.disposePrivateCopy(fixture.input)).toBe(true);
            }
            await sql`UPDATE public.icloud_claim SET "expiresAt"=clock_timestamp()-interval '1 second'
            WHERE id=${fixture.claim.id}::uuid`.execute(db);
            if (absent) {
              expect(await identities.release(fixture.f.user.id, [fixture.claim.id], fixture.claim.holder)).toEqual([
                fixture.claim.id,
              ]);
            }

            const path = disposition === 'copy' ? fixture.promotedPath : fixture.fresh.payload.path;
            const entered = Promise.withResolvers<void>();
            const resume = Promise.withResolvers<void>();
            const unlink = privateCopyFiles.unlinkOwnedPrivateCopy;
            let paused = false;
            const barrier = vi
              .spyOn(privateCopyFiles, 'unlinkOwnedPrivateCopy')
              .mockImplementation(async (named, identity) => {
                if (named === path && !paused) {
                  paused = true;
                  entered.resolve();
                  await resume.promise;
                }
                await unlink(named, identity); // Real NOFOLLOW inode checks and unlink, never a fake freed-byte result.
              });
            const disposing =
              disposition === 'copy'
                ? fixture.repository.disposePrivateCopy(fixture.input)
                : fixture.repository.disposeRefusedStaging(fixture.input);
            void disposing.catch(() => {});
            let reclaimed = false;
            let reclaiming: ReturnType<typeof identities.claim> | undefined;
            try {
              await entered.promise; // Paused after the real claim/refcount authority checks, before actual unlink.
              const key = iCloudItemClaimLockKey(fixture.f.user.id, fixture.f.resource.sourceAssetId);
              const holder = (
                await sql<{ pid: number }>`WITH fence AS (SELECT hashtextextended(${key},0) AS key)
              SELECT l.pid FROM pg_locks l,fence WHERE l.locktype='advisory' AND l.granted AND l.objsubid=1
                AND l.classid::bigint=((fence.key>>32)&4294967295::bigint)
                AND l.objid::bigint=(fence.key&4294967295::bigint)`.execute(db)
              ).rows;
              expect(holder).toHaveLength(1);
              reclaiming = identities
                .claim(
                  fixture.f.user.id,
                  [fixture.f.resource.sourceAssetId.toLowerCase()],
                  `device:${randomUUID()}`,
                  1800,
                )
                .then((claims) => {
                  reclaimed = true;
                  return claims;
                });
              void reclaiming.catch(() => {});
              // Backend lock ownership is the witness. Elapsed time or a still-pending JS promise is not proof.
              await expect
                .poll(
                  async () =>
                    (
                      await sql`SELECT waiting.pid FROM pg_stat_activity waiting
              WHERE waiting.wait_event_type='Lock' AND ${holder[0].pid}::int=ANY(pg_blocking_pids(waiting.pid))
                AND waiting.query LIKE '%pg_advisory_xact_lock%'`.execute(db)
                    ).rows.length,
                  { timeout: 1000 },
                )
                .toBe(1);
              expect(reclaimed).toBe(false);
              expect(await readFile(path)).toEqual(fixture.f.bytes);
              expect((await fixture.state()).reservedBytes).toBe(
                (disposition === 'copy' ? 2 : 1) * fixture.f.bytes.length,
              );
            } finally {
              resume.resolve();
              await Promise.allSettled([disposing, ...(reclaiming ? [reclaiming] : [])]);
              barrier.mockRestore();
            }
            expect(await disposing).toBe(true);
            expect(
              await access(path)
                .then(() => true)
                .catch(() => false),
            ).toBe(false);
            const [replacement] = await reclaiming!;
            expect(replacement.cplAssetRecordName).toBe(fixture.f.resource.sourceAssetId.toUpperCase());
            expect(replacement.id).not.toBe(fixture.claim.id);
            expect(await fixture.state()).toMatchObject({
              reservedBytes: disposition === 'copy' ? fixture.f.bytes.length : 0,
              status: disposition === 'copy' ? 'failed' : 'removed',
              pendingJobs: [],
            });
            expect(await readFile(fixture.f.originalPath)).toEqual(fixture.f.bytes);
          },
          15_000, // Actual staging/decode/copy setup; the PostgreSQL lock witness remains bounded to 1s.
        );

        it('does not authenticate authored work-generation JSON when a late decoder finally settles', async ({
          signal,
        }) => {
          const settled = Promise.withResolvers<void>();
          stagedProofSettled = settled.promise;
          const done = Promise.withResolvers<void>();
          let staging: ICloudScheduledStagingService | undefined;
          let validation: Awaited<ReturnType<ICloudScheduledStagingService['validate']>> | undefined;
          let restoreDecoder: (() => void) | undefined;
          try {
            const fixture = await createDispositionFixture();
            staging = fixture.staging;
            await fixture.staging.copyRecovery(fixture.input, fixture.promotedPath);
            const decoder = vi.spyOn(integrity, 'validateWithSettlement').mockReturnValueOnce({
              result: Promise.resolve({ status: 'timeout', reason: 'validation_timeout' }),
              settled: done.promise,
              cancel: vi.fn(),
            });
            restoreDecoder = () => decoder.mockRestore();
            validation = await fixture.staging.validate(fixture.input, signal, fixture.promotedPath);
            const work = structuredClone(
              (await fixture.state()).verification!.auditOwnedWork,
            ) as privateCopyFiles.ScheduledPrivateWorkRecord;
            work.payload.generation = randomUUID(); // Old server seal authenticates neither this generation nor its settlement.
            await sql`UPDATE public.icloud_resource SET verification=verification||jsonb_build_object('auditOwnedWork',${JSON.stringify(work)}::text::jsonb)
              WHERE id=${fixture.resource.id}::uuid`.execute(db);
            await fixture.retire();
            done.resolve();
            decoder.mockRestore();
            await validation.settled;
            await fixture.staging.cleanupRetired(fixture.input);
            expect(await fixture.state()).toMatchObject({
              status: 'failed',
              reservedBytes: 2 * fixture.f.bytes.length,
            });
            expect(await readFile(fixture.promotedPath)).toEqual(fixture.f.bytes);
            expect(await readFile(fixture.fresh.payload.path)).toEqual(fixture.f.bytes);
          } finally {
            try {
              done.resolve();
              restoreDecoder?.();
              validation?.cancel();
              await staging?.onShutdown();
            } finally {
              settled.resolve();
            }
          }
        });

        it('retains charge after an injected unlink fault and resumes the same sealed generation', async () => {
          const fixture = await createDispositionFixture();
          await fixture.staging.copyRecovery(fixture.input, fixture.promotedPath);
          await fixture.retire();
          const fault = vi
            .spyOn(privateCopyFiles, 'unlinkOwnedPrivateCopy')
            .mockRejectedValueOnce(Object.assign(new Error('forced-unlink-fault'), { code: 'EIO' }));
          await fixture.staging.cleanupRetired(fixture.input);
          fault.mockRestore();
          expect((await fixture.state()).reservedBytes).toBe(2 * fixture.f.bytes.length);
          expect(await readFile(fixture.promotedPath)).toEqual(fixture.f.bytes);
          await fixture.staging.housekeeping();
          expect(await fixture.state()).toMatchObject({ status: 'removed', reservedBytes: 0 });
        });

        it('retains charge when the actual unlink succeeds but PostgreSQL rolls back, then retries the same generation', async () => {
          const fixture = await createDispositionFixture();
          await fixture.staging.copyRecovery(fixture.input, fixture.promotedPath);
          await fixture.retire();
          const before = await fixture.state();
          await sql`CREATE FUNCTION public.private_disposition_test_rollback() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF OLD."promotedPath" IS NOT NULL AND NEW."promotedPath" IS NULL
              AND NEW."lastError"='scheduled_private_copy_disposed' THEN
              RAISE EXCEPTION 'private_disposition_test_rollback';
            END IF;
            RETURN NEW;
          END $$`.execute(db);
          try {
            await sql`CREATE TRIGGER private_disposition_test_rollback BEFORE UPDATE ON public.icloud_resource
              FOR EACH ROW EXECUTE FUNCTION public.private_disposition_test_rollback()`.execute(db);
            await fixture.staging.cleanupRetired(fixture.input);
            expect(
              await access(fixture.promotedPath)
                .then(() => true)
                .catch(() => false),
            ).toBe(false);
            expect(await fixture.state()).toMatchObject({
              status: 'failed',
              reservedBytes: before.reservedBytes,
              promotedPath: fixture.promotedPath,
              pendingJobs: [],
            });
            expect((await fixture.state()).verification).toEqual(before.verification);
            expect(await readFile(fixture.fresh.payload.path)).toEqual(fixture.f.bytes);
          } finally {
            await sql`DROP TRIGGER IF EXISTS private_disposition_test_rollback ON public.icloud_resource`.execute(db);
            await sql`DROP FUNCTION public.private_disposition_test_rollback()`.execute(db);
          }
          await fixture.staging.housekeeping();
          expect(await fixture.state()).toMatchObject({
            status: 'removed',
            reservedBytes: 0,
            promotedPath: null,
            pendingJobs: [],
          });
          expect(await readFile(fixture.f.originalPath)).toEqual(fixture.f.bytes);
        });

        it('keeps an actually promoted copy pending when final ownership persistence fails', async () => {
          const fixture = await createDispositionFixture();
          const store = fixture.repository.storePrivateCopy.bind(fixture.repository);
          let calls = 0;
          const refusal = vi
            .spyOn(fixture.repository, 'storePrivateCopy')
            .mockImplementation((...args) => (++calls >= 3 ? Promise.resolve(false) : store(...args)));
          try {
            await expect(fixture.staging.copyRecovery(fixture.input, fixture.promotedPath)).rejects.toThrow(
              'scheduled_private_copy_changed',
            );
          } finally {
            refusal.mockRestore();
          }
          await fixture.retire();
          await fixture.staging.housekeeping();
          expect(await fixture.state()).toMatchObject({
            status: 'failed',
            reservedBytes: 2 * fixture.f.bytes.length,
            lastError: 'scheduled_private_copy_retained_pending-settlement',
          });
          expect(await readFile(fixture.promotedPath)).toEqual(fixture.f.bytes);
          expect(await readFile(fixture.f.originalPath)).toEqual(fixture.f.bytes);
        });

        it.each([false, true])(
          'executes actual claimed scheduled stream and settles match exactly once without a session; protected=%s',
          async (protectedOriginal) => {
            const fixture = await createWorkerFixture(protectedOriginal);
            await db.deleteFrom('session').where('id', '=', fixture.auth.session!.id).execute();
            vi.stubEnv('FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION', 'true'); // Test seam only; deployment gate stays OFF.
            await fixture.worker.run(fixture.claimed.operation, fixture.claimed.claimToken);
            const first = await scheduledWorkerState(fixture);
            expect(first.request?.result).toBe('match');
            expect(first.identity.lastVerifiedAt).toBeInstanceOf(Date);
            expect(first.identity.lastAuditResult).toBe('match');
            expect(first.cohort).toEqual({
              status: 'settled',
              match: '1',
              mismatch: '0',
              performed: '1',
              unavailable: '0',
              cancelled: '0',
            });
            expect(fixture.transport.download).toHaveBeenCalledTimes(1);
            expect(fixture.withSession).not.toHaveBeenCalled();
            const {
              rows: [resource],
            } = await sql<ICloudResource>`SELECT *,"expectedSize"::float8 AS "expectedSize" FROM public.icloud_resource
            WHERE "auditRequestId"=${fixture.authority.auditRequestId}::uuid`.execute(db);
            expect(resource.status).toBe('committed');
            expect(Number(resource.reservedBytes)).toBe(fixture.f.bytes.length);
            expect(resource.verification?.auditFreshDownload).toBeDefined();
            expect(resource.pendingJobs).toEqual([]);
            await fixture.worker.run(fixture.claimed.operation, fixture.claimed.claimToken);
            expect(await scheduledWorkerState(fixture)).toEqual(first);
            expect(fixture.transport.download).toHaveBeenCalledTimes(1);
            await fixture.staging.onShutdown();
          },
        );

        it('refuses authored deep-decode JSON and a healthy result without actual settlement evidence', async () => {
          const fixture = await createStageFixture();
          const fresh = await fixture.staging.download(fixture.input);
          await expect(fixture.staging.holdPublicationFiles(fixture.input)).rejects.toThrow(
            'scheduled_audit_unavailable',
          );
          const forged = {
            payload: {
              version: 1 as const,
              basis: 'audit-settled-decode' as const,
              fresh,
              path: fresh.payload.path,
              identity: fresh.payload.identity,
              sha1: fresh.payload.sha1,
              sha256: fresh.payload.sha256,
              sizeInBytes: fresh.payload.binding.sizeInBytes,
            },
            seal: 'authored-decode-json',
          };
          expect(await fixture.repository.storeDeepValidation(fixture.input, forged)).toBe(false);
          expect(await fixture.repository.authenticateDeepValidation(fixture.input, forged)).toBe(false);
          expect(
            (await new ICloudAuditRepository(db).get(fixture.authority.auditRequestId, fixture.f.user.id))?.result,
          ).toBe('queued');
          expect((await members(fixture.cohort.id))[0].outcome).toBe('pending');
        });

        it('rolls back a duplicate reservation at the real owner/checksum constraint after actual destination decode', async () => {
          // Negative reservation test only. This is not a genuine same-descriptor weekly mismatch.
          const fixture = await createStageFixture(true);
          const fresh = await fixture.staging.download(fixture.input);
          const stageValidation = await fixture.staging.validate(fixture.input);
          const staged = await stageValidation.result;
          expect(staged.status).toBe('validated');
          await stageValidation.settled;
          if (staged.status !== 'validated') {
            throw new Error('actual_validation_required');
          }
          const assetId = randomUUID();
          const promotedPath = join(dirname(fixture.f.originalPath), '.icloud-recovery', `${assetId}.jpg`);
          await mkdir(dirname(promotedPath), { mode: 0o700 });
          await copyFile(fresh.payload.path, promotedPath);
          const target = {
            assetId,
            updateId: null,
            originalPath: null,
            checksumHex: null,
            checksumAlgorithm: null,
            isExternal: false,
            libraryId: null,
            physicalOriginalFileId: null,
            outcome: 'imported' as const,
          };
          // Malicious durable reservation is the negative input. No authored validation/proof stamp.
          await sql`UPDATE public.icloud_resource SET "expectedTarget"=${JSON.stringify(target)}::text::jsonb,"promotedPath"=${promotedPath}
            WHERE id=${fixture.resource.id}::uuid`.execute(db);
          const publicationQueries: CompiledQuery[] = [];
          captureCompiledQuery = (query) => {
            publicationQueries.push(query);
          };
          const quotaBefore = await db
            .selectFrom('user')
            .select('quotaUsageInBytes')
            .where('id', '=', fixture.f.user.id)
            .executeTakeFirstOrThrow();
          const repository = new MediaRecoveryRepository(db, fixture.repository);
          let files: Awaited<ReturnType<ICloudScheduledStagingService['holdPublicationFiles']>> | undefined;
          const publication = {
            receipt: fresh,
            validation: staged.validation,
            paths: [] as string[],
            current: () => Promise.resolve(false),
          };
          let duplicateGate: { mockRestore: () => void } | undefined;
          try {
            const commit = () =>
              repository.commit({
                ownerId: fixture.f.user.id,
                resourceId: fixture.resource.id,
                leaseToken: fixture.resource.leaseToken,
                includeHidden: true,
                audit: fixture.authority,
                scheduled: publication,
                reservation: { target, promotedPath },
                verified: staged.verified,
                originalFileName: 'recovered.jpg',
                type: AssetType.Image,
                verifyFinal: async () => {
                  const validation = await fixture.staging.validate(fixture.input, undefined, promotedPath);
                  const result = await validation.result;
                  expect(result.status).toBe('validated');
                  await validation.settled;
                  if (result.status !== 'validated') {
                    throw new Error('actual_validation_required');
                  }
                  files = await fixture.staging.holdPublicationFiles(fixture.input, undefined, promotedPath);
                  publication.paths = files.paths;
                  publication.current = files.current;
                  publication.validation = files.validation;
                  return result.verified;
                },
              });
            // The real original still owns these bytes. Keep the production guard as a positive control.
            expect(await commit()).toEqual({ outcome: 'retry', reason: 'matching_asset_created' });
            await files?.release();
            files = undefined;
            // Isolated uniqueness rollback: bypass only the earlier duplicate short-circuit.
            // Frozen identity, live authority, actual decode and authenticated proof remain real.
            duplicateGate = vi
              .spyOn(repository as unknown as { hasManagedMatch: () => Promise<boolean> }, 'hasManagedMatch')
              .mockResolvedValue(false);
            await expect(commit()).rejects.toMatchObject({
              code: '23505',
              constraint_name: 'UQ_assets_owner_checksum',
            });
          } finally {
            try {
              await files?.release();
            } finally {
              duplicateGate?.mockRestore();
            }
          }
          // The existing same-byte original forbids an imported replacement before protection or outbox writes.
          expect(files).toBeDefined();
          const protectionWrite = publicationQueries.findIndex(
            (query) => /insert into "asset_lock"/i.test(query.sql) && query.parameters.includes(assetId),
          );
          const outboxWrite = publicationQueries.findIndex(
            (query) =>
              /UPDATE public\.icloud_resource SET status = 'committed'/i.test(query.sql) &&
              query.sql.includes('"pendingJobs"') &&
              query.parameters.includes(fixture.resource.id),
          );
          expect(protectionWrite).toBe(-1);
          expect(outboxWrite).toBe(-1);
          expect(
            await db
              .selectFrom('user')
              .select('quotaUsageInBytes')
              .where('id', '=', fixture.f.user.id)
              .executeTakeFirstOrThrow(),
          ).toEqual(quotaBefore);
          expect(await readFile(fixture.f.originalPath)).toEqual(fixture.f.bytes);
          expect(await readFile(promotedPath)).toEqual(fixture.f.bytes);
          expect(await db.selectFrom('asset').select('id').where('id', '=', assetId).execute()).toEqual([]);
          expect(
            (await sql`SELECT 1 FROM public.physical_file WHERE "canonicalAssetId"=${assetId}::uuid`.execute(db)).rows,
          ).toEqual([]);
          expect((await fixture.repository.read(fixture.input))!.resource.pendingJobs).toEqual([]);
          expect((await members(fixture.cohort.id))[0].outcome).toBe('pending');
          // Two genuine destination decode/publication attempts need their own bounded test budget.
        }, 10_000);

        it('rejects a matching receipt published as mismatch and rolls back test-only privacy sentinel writes', async () => {
          const fixture = await createStageFixture(true);
          const fresh = await fixture.staging.download(fixture.input);
          const validation = await fixture.staging.validate(fixture.input);
          const staged = await validation.result;
          await validation.settled;
          expect(staged.status).toBe('validated');
          if (staged.status !== 'validated') {
            throw new Error('actual_validation_required');
          }
          expect(await fixture.repository.authenticateReceipt(fixture.input, fresh)).toBe(true);
          expect(await fixture.repository.authenticateDeepValidation(fixture.input, staged.validation)).toBe(true);
          const sentinelId = randomUUID();
          const physicalId = randomUUID();
          // Metadata-only transaction sentinel: not a decoded recovery destination,
          // authored proof, production commit privacy path or genuine worker mismatch.
          const sentinelChecksum = createHash('sha256').update(`writer-sentinel:${sentinelId}`).digest();
          const sentinelPath = join(dirname(fixture.f.originalPath), `writer-sentinel-${sentinelId}.jpg`);
          const before = await sql<{ state: unknown }>`SELECT jsonb_build_object(
            'original', (SELECT to_jsonb(a) FROM public.asset a WHERE id=${fixture.f.asset.id}::uuid),
            'identity', (SELECT to_jsonb(i) FROM public.icloud_source_identity i WHERE id=${fixture.f.identityId}::uuid),
            'cohort', (SELECT to_jsonb(c) FROM public.icloud_weekly_cohort c WHERE id=${fixture.cohort.id}::uuid),
            'request', (SELECT to_jsonb(r) FROM public.icloud_identity_audit r WHERE id=${fixture.authority.auditRequestId}::uuid),
            'quota', (SELECT "quotaUsageInBytes" FROM public."user" WHERE id=${fixture.f.user.id}::uuid)
          ) AS state`.execute(db);
          const files = await fixture.staging.holdPublicationFiles(fixture.input);
          try {
            expect(files.receipt).toEqual(fresh);
            expect(files.validation).toEqual(staged.validation);
            expect(await files.current()).toBe(true);
            await expect(
              db.transaction().execute(async (tx) => {
                const guarded = await guardScheduledAudit(tx, fixture.authority, fixture.f.user.id, {
                  resource: fixture.resource,
                });
                expect(guarded?.private).toBe(true);
                if (!guarded) {
                  throw new Error('actual_authority_required');
                }
                expect(fresh.payload.sha256).toBe(guarded.request.expectedSha256.toString('hex'));
                expect(sentinelChecksum.equals(guarded.request.expectedSha256)).toBe(false);
                const createdAt = new Date();
                await tx
                  .insertInto('asset')
                  .values({
                    id: sentinelId,
                    ownerId: fixture.f.user.id,
                    originalPath: sentinelPath,
                    originalFileName: 'writer-sentinel.jpg',
                    type: AssetType.Image,
                    checksum: sentinelChecksum,
                    checksumAlgorithm: ChecksumAlgorithm.sha256File,
                    fileCreatedAt: createdAt,
                    fileModifiedAt: createdAt,
                    localDateTime: createdAt,
                    visibility: AssetVisibility.Timeline,
                    status: AssetStatus.Active,
                  })
                  .execute();
                await tx
                  .insertInto('asset_lock')
                  .values({ assetId: sentinelId, reason: AssetLockReason.Marked, lockedBy: null })
                  .execute();
                expect(
                  await tx.selectFrom('asset_lock').select('assetId').where('assetId', '=', sentinelId).execute(),
                ).toHaveLength(1);
                expect(
                  (
                    await sql<{ pendingJobs: unknown[] }>`SELECT "pendingJobs" FROM public.icloud_resource
                    WHERE id=${fixture.resource.id}::uuid`.execute(tx)
                  ).rows[0].pendingJobs,
                ).toEqual([]);
                await tx
                  .insertInto('physical_file')
                  .values({
                    id: physicalId,
                    canonicalAssetId: sentinelId,
                    checksum: sentinelChecksum,
                    path: sentinelPath,
                    sizeInBytes: 1,
                    type: PhysicalFileType.Original,
                  })
                  .execute();
                await tx
                  .updateTable('user')
                  .set({ quotaUsageInBytes: sql`"quotaUsageInBytes" + 1` })
                  .where('id', '=', fixture.f.user.id)
                  .execute();
                // Call the actual transaction-only writer with genuine authenticated
                // match evidence and deliberately false result; no worker/commit seam.
                await publishScheduledAudit(
                  tx,
                  fixture.authority,
                  guarded,
                  fixture.resource,
                  files,
                  'mismatch',
                  sentinelId,
                );
              }),
            ).rejects.toThrow('scheduled_audit_result_invalid');
          } finally {
            await files.release();
          }
          expect(await db.selectFrom('asset').select('id').where('id', '=', sentinelId).execute()).toEqual([]);
          expect(
            await db.selectFrom('asset_lock').select('assetId').where('assetId', '=', sentinelId).execute(),
          ).toEqual([]);
          expect(await db.selectFrom('physical_file').select('id').where('id', '=', physicalId).execute()).toEqual([]);
          const after = await sql<{ state: unknown }>`SELECT jsonb_build_object(
            'original', (SELECT to_jsonb(a) FROM public.asset a WHERE id=${fixture.f.asset.id}::uuid),
            'identity', (SELECT to_jsonb(i) FROM public.icloud_source_identity i WHERE id=${fixture.f.identityId}::uuid),
            'cohort', (SELECT to_jsonb(c) FROM public.icloud_weekly_cohort c WHERE id=${fixture.cohort.id}::uuid),
            'request', (SELECT to_jsonb(r) FROM public.icloud_identity_audit r WHERE id=${fixture.authority.auditRequestId}::uuid),
            'quota', (SELECT "quotaUsageInBytes" FROM public."user" WHERE id=${fixture.f.user.id}::uuid)
          ) AS state`.execute(db);
          expect(after.rows).toEqual(before.rows);
          expect((await fixture.repository.read(fixture.input))!.resource.pendingJobs).toEqual([]);
          expect((await members(fixture.cohort.id))[0].outcome).toBe('pending');
        });

        it('keeps execution unavailable by default without transport or a successful counter', async () => {
          const fixture = await createWorkerFixture();
          vi.stubEnv('FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION', 'false');
          await fixture.worker.run(fixture.claimed.operation, fixture.claimed.claimToken);
          expect(fixture.transport.download).not.toHaveBeenCalled();
          expect((await scheduledWorkerState(fixture)).cohort.performed).toBe('0');
          expect((await weekly().status(fixture.f.connection.id, fixture.f.user.id)).executionAvailable).toBe(false);
        });

        it('cancels frozen pending membership without ordinary connection bookkeeping or transport, even with execution OFF', async () => {
          const fixture = await createWorkerFixture();
          vi.stubEnv('FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION', 'false');
          await sql`UPDATE public.media_operation SET status='cancelling',"cancelRequestedAt"=clock_timestamp()
            WHERE id=${fixture.claimed.operation.id}::uuid`.execute(db);
          const before = await sync.get(fixture.f.connection.id, fixture.f.user.id);
          await fixture.worker.run(fixture.claimed.operation, fixture.claimed.claimToken);
          expect(fixture.transport.download).not.toHaveBeenCalled();
          expect((await scheduledWorkerState(fixture)).cohort).toMatchObject({
            performed: '0',
            cancelled: '1',
            status: 'settled',
          });
          expect((await members(fixture.cohort.id))[0].outcome).toBe('cancelled');
          expect(await sync.get(fixture.f.connection.id, fixture.f.user.id)).toEqual(before);
        });

        it('pauses the same frozen obligation without terminal settlement or ordinary bookkeeping', async () => {
          const fixture = await createWorkerFixture();
          vi.stubEnv('FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION', 'true');
          await sql`UPDATE public.media_operation SET "pauseRequestedAt"=clock_timestamp()
            WHERE id=${fixture.claimed.operation.id}::uuid`.execute(db);
          const frozen = await members(fixture.cohort.id);
          await fixture.worker.run(fixture.claimed.operation, fixture.claimed.claimToken);
          expect(fixture.transport.download).not.toHaveBeenCalled();
          expect(await members(fixture.cohort.id)).toEqual(frozen);
          expect((await scheduledWorkerState(fixture)).cohort.performed).toBe('0');
        });

        it('does not revive an expired operation with a scheduled heartbeat', async () => {
          const fixture = await createWorkerFixture();
          await sql`UPDATE public.media_operation SET "claimExpiresAt"=clock_timestamp()-interval '1 second'
            WHERE id=${fixture.claimed.operation.id}::uuid`.execute(db);
          expect(
            await fixture.workerRepository.renewOperation(
              fixture.claimed.operation.id,
              fixture.f.user.id,
              fixture.claimed.claimToken,
            ),
          ).toBe(false);
          expect(
            await fixture.workerRepository.dispatch(fixture.claimed.operation, fixture.claimed.claimToken),
          ).toBeUndefined();
          expect(fixture.transport.download).not.toHaveBeenCalled();
        });

        it('enforces actual staging budget without allocating or settling a replacement', async () => {
          const fixture = await createWorkerFixture();
          vi.stubEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES', '0');
          vi.stubEnv('FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION', 'true');
          await fixture.worker.run(fixture.claimed.operation, fixture.claimed.claimToken);
          expect(fixture.transport.download).not.toHaveBeenCalled();
          expect((await scheduledWorkerState(fixture)).request?.result).toBe('queued');
          expect((await members(fixture.cohort.id))[0].outcome).toBe('pending');
          expect(
            (
              await sql`SELECT id FROM public.icloud_resource WHERE "auditRequestId"=${fixture.authority.auditRequestId}::uuid`.execute(
                db,
              )
            ).rows,
          ).toEqual([]);
        });

        it('commits real consent revocation while an actual noncooperative decoder owns its input, then refuses all proof', async () => {
          const entered = Promise.withResolvers<string>();
          const release = Promise.withResolvers<void>();
          const decoder = new MediaIntegrityService(
            new StorageRepository(getMocks().logger as never),
            new CryptoRepository(),
            {
              decodeImage: async (path: string) => {
                entered.resolve(path);
                await release.promise;
                return {} as never;
              },
            } as never,
          );
          const fixture = await createWorkerFixture(false, decoder);
          vi.stubEnv('FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION', 'true');
          const running = fixture.worker.run(fixture.claimed.operation, fixture.claimed.claimToken);
          const path = await entered.promise;
          try {
            await weekly().setAuthority(fixture.auth, fixture.f.connection.id, {
              enabled: false,
              includeProtected: false,
              requestKey: randomUUID(),
            });
            expect(await readFile(path)).toEqual(fixture.f.bytes);
          } finally {
            release.resolve();
          }
          await running;
          const state = await scheduledWorkerState(fixture);
          expect(state.request?.result).toBe('failed');
          expect(state.identity.lastVerifiedAt).toBeNull();
          expect(state.cohort).toMatchObject({
            performed: '0',
            unavailable: '1',
            match: '0',
            mismatch: '0',
            status: 'settled',
          });
          await fixture.staging.onShutdown();
          await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
        });

        it.each(['staging', 'original'] as const)(
          'refuses actual %s inode replacement before final guarded publication',
          async (kind) => {
            const fixture = await createStageFixture();
            await fixture.staging.download(fixture.input);
            const validation = await fixture.staging.validate(fixture.input);
            const outcome = await validation.result;
            expect(outcome.status).toBe('validated');
            await validation.settled;
            if (outcome.status !== 'validated') {
              throw new Error('actual_validation_required');
            }
            const files = await fixture.staging.holdPublicationFiles(fixture.input);
            const target = kind === 'staging' ? files.receipt.payload.path : fixture.f.originalPath;
            await rename(target, `${target}.replaced`);
            await writeFile(target, fixture.f.bytes, { mode: 0o600 });
            try {
              const repository = new ICloudScheduledWorkerRepository(db, fixture.repository);
              await expect(repository.publishMatch(fixture.input, files, outcome.verified)).rejects.toThrow(
                'scheduled_audit_file_changed',
              );
            } finally {
              await files.release();
            }
            expect(
              (await new ICloudAuditRepository(db).get(fixture.authority.auditRequestId, fixture.f.user.id))?.result,
            ).toBe('queued');
            expect((await members(fixture.cohort.id))[0].outcome).toBe('pending');
          },
        );

        it.each(['match', 'existing-candidate mismatch'] as const)(
          'waits on the real managed move path before asset rows for scheduled %s publication',
          async (kind) => {
            const fixture = await createStageFixture();
            const fresh = await fixture.staging.download(fixture.input);
            let assetId = fixture.f.asset.id;
            if (kind === 'existing-candidate mismatch') {
              // A negative reservation exercises existing-candidate admission, not genuine provider mismatch proof.
              const originalPath = join(dirname(fixture.f.originalPath), 'candidate.jpg');
              await copyFile(fresh.payload.path, originalPath);
              const { ctx } = newMediumService(BaseService, {
                database: db,
                real: [],
                mock: [LoggingRepository],
              });
              const { asset } = await ctx.newAsset({
                ownerId: fixture.f.user.id,
                originalPath,
                originalFileName: 'candidate.jpg',
                type: AssetType.Image,
                checksum: createHash('sha1').update(fixture.f.bytes).digest(),
                checksumAlgorithm: ChecksumAlgorithm.sha1File,
              });
              assetId = asset.id;
            }
            const asset = await db.selectFrom('asset').selectAll().where('id', '=', assetId).executeTakeFirstOrThrow();
            const candidatePath = kind === 'match' ? undefined : asset.originalPath;
            const validation = await fixture.staging.validate(fixture.input, undefined, candidatePath);
            const outcome = await validation.result;
            await validation.settled;
            if (outcome.status !== 'validated') {
              throw new Error('actual_validation_required');
            }
            const files = await fixture.staging.holdPublicationFiles(fixture.input, undefined, candidatePath);
            const target = {
              assetId: asset.id,
              updateId: asset.updateId,
              originalPath: asset.originalPath,
              checksumHex: asset.checksum.toString('hex'),
              checksumAlgorithm: asset.checksumAlgorithm,
              isExternal: false,
              libraryId: null,
              physicalOriginalFileId: asset.physicalOriginalFileId,
              outcome: 'reused' as const,
            };
            if (kind !== 'match') {
              await sql`UPDATE public.icloud_resource SET "expectedTarget"=${JSON.stringify(target)}::text::jsonb,
                "promotedPath"=${asset.originalPath} WHERE id=${fixture.resource.id}::uuid`.execute(db);
            }
            const authenticated = Promise.withResolvers<boolean>();
            const publish = Promise.withResolvers<void>();
            const resumeMove = Promise.withResolvers<void>();
            let moveEntered = false;
            // Pause only after the real receipt authentication, so the race reaches the publication transaction.
            const authenticate = fixture.repository.authenticateDeepValidation.bind(fixture.repository);
            vi.spyOn(fixture.repository, 'authenticateDeepValidation').mockImplementationOnce(async (...args) => {
              const accepted = await authenticate(...args);
              authenticated.resolve(accepted);
              await publish.promise;
              return accepted;
            });
            const publishing =
              kind === 'match'
                ? new ICloudScheduledWorkerRepository(db, fixture.repository).publishMatch(
                    fixture.input,
                    files,
                    outcome.verified,
                  )
                : new MediaRecoveryRepository(db, fixture.repository).commit({
                    ownerId: fixture.f.user.id,
                    resourceId: fixture.resource.id,
                    leaseToken: fixture.resource.leaseToken,
                    includeHidden: false,
                    audit: fixture.authority,
                    scheduled: files,
                    reservation: { target, promotedPath: asset.originalPath },
                    verified: outcome.verified,
                    originalFileName: asset.originalFileName,
                    type: AssetType.Image,
                    verifyFinal: () => Promise.resolve(outcome.verified),
                  });
            void publishing.catch(() => {});
            const movedPath = `${asset.originalPath}.moved`;
            let moving: ReturnType<AssetRepository['moveFile']> | undefined;
            try {
              expect(await Promise.race([authenticated.promise, publishing.then(() => false)])).toBe(true);
              moving = new AssetRepository(db).moveFile(
                {
                  moveId: randomUUID(),
                  assetId: asset.id,
                  pathType: AssetPathType.Original,
                  from: asset.originalPath,
                  source: asset.originalPath,
                  to: movedPath,
                },
                {
                  rename: async () => {
                    moveEntered = true; // The actual repository now owns both path and asset row locks.
                    await resumeMove.promise;
                    await rename(asset.originalPath, movedPath);
                    return true;
                  },
                  undo: () => rename(movedPath, asset.originalPath),
                  finish: async () => {},
                },
              );
              void moving.catch(() => {});
              await expect.poll(() => moveEntered, { timeout: 2500 }).toBe(true);
              publish.resolve();
              const key = createHash('sha1').update(asset.originalPath).digest().readBigUInt64BE(0);
              const blocked = () =>
                sql<{ pid: number; assetRows: boolean }>`SELECT waiting.pid,
                EXISTS (SELECT 1 FROM pg_locks asset_lock WHERE asset_lock.pid=waiting.pid
                  AND asset_lock.relation='public.asset'::regclass AND asset_lock.mode='RowShareLock'
                  AND asset_lock.granted) AS "assetRows"
                FROM pg_locks waiting JOIN pg_locks held
                  ON held.locktype=waiting.locktype AND held.classid=waiting.classid AND held.objid=waiting.objid
                WHERE waiting.locktype='advisory' AND NOT waiting.granted AND held.granted
                  AND waiting.classid=${Number(key >> 32n)}::oid AND waiting.objid=${Number(key & 0xff_ff_ff_ffn)}::oid
                  AND held.pid=ANY(pg_blocking_pids(waiting.pid))`.execute(db);
              await expect.poll(async () => (await blocked()).rows.length, { timeout: 2500 }).toBe(1);
              expect((await blocked()).rows[0].assetRows).toBe(false);
            } finally {
              publish.resolve();
              resumeMove.resolve();
              await Promise.allSettled([publishing, ...(moving ? [moving] : [])]);
              await files.release();
            }
            expect(await moving).toBe('moved');
            expect(await publishing).toEqual(
              kind === 'match' ? false : { outcome: 'retry', reason: 'scheduled_authority_changed' },
            );
            expect(await readFile(movedPath)).toEqual(fixture.f.bytes);
            expect(
              (await db.selectFrom('asset').select('originalPath').where('id', '=', asset.id).executeTakeFirst())
                ?.originalPath,
            ).toBe(movedPath);
            const state = await scheduledWorkerState(fixture);
            expect(state.request?.result).toBe('queued');
            expect(state.identity.lastVerifiedAt).toBeNull();
            expect(state.cohort).toMatchObject({ performed: '0', unavailable: '0' });
            expect((await members(fixture.cohort.id))[0].outcome).toBe('pending');
          },
          15_000, // Real staging/decode setup plus the unchanged bounded lock-wait witness.
        );

        it.each(['expiry', 'revoke'] as const)(
          'refuses late readonly guard settlement after actual %s without closing its descriptor early',
          async (kind) => {
            const fixture = await createStageFixture();
            await fixture.staging.download(fixture.input);
            const validation = await fixture.staging.validate(fixture.input);
            const outcome = await validation.result;
            expect(outcome.status).toBe('validated');
            await validation.settled;
            if (outcome.status !== 'validated') {
              throw new Error('actual_validation_required');
            }
            const files = await fixture.staging.holdPublicationFiles(fixture.input);
            const probe = await open(files.receipt.payload.path, 'r');
            const prototype = Object.getPrototypeOf(probe) as FileHandle;
            await probe.close();
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const actualStat = prototype.stat;
            const closed = new Set<number>();
            const observed = new Set<FileHandle>();
            let guardedFd!: number;
            vi.spyOn(prototype, 'stat').mockImplementation(async function (
              this: FileHandle,
              ...args: Parameters<FileHandle['stat']>
            ) {
              // FileHandle.close belongs to each real instance, rather than its prototype.
              if (!observed.has(this)) {
                observed.add(this);
                const actualClose = this.close;
                vi.spyOn(this, 'close').mockImplementation(function (
                  this: FileHandle,
                  ...closeArgs: Parameters<FileHandle['close']>
                ) {
                  closed.add(this.fd);
                  return actualClose.apply(this, closeArgs);
                });
              }
              const result = await actualStat.apply(this, args);
              guardedFd = this.fd;
              entered.resolve();
              await release.promise;
              return result;
            });
            if (kind === 'expiry') {
              await sql`UPDATE public.media_operation SET "claimExpiresAt"=clock_timestamp()+interval '1.5 seconds'
              WHERE id=${fixture.authority.operationId}::uuid`.execute(db);
            }
            const publishing = new ICloudScheduledWorkerRepository(db, fixture.repository).publishMatch(
              fixture.input,
              files,
              outcome.verified,
            );
            void publishing.catch(() => {});
            let cleanup: Promise<void> | undefined;
            try {
              await entered.promise;
              let revoked: Promise<unknown> | undefined;
              if (kind === 'revoke') {
                revoked = weekly().setAuthority(fixture.auth, fixture.f.connection.id, {
                  enabled: false,
                  includeProtected: false,
                  requestKey: randomUUID(),
                });
                void revoked.catch(() => {});
              }
              await sql`SELECT pg_sleep(${kind === 'expiry' ? 1.6 : 2.1})`.execute(db); // Actual DB time, hosted-only authored contract.
              if (kind === 'expiry') {
                release.resolve();
              }
              await expect(publishing).rejects.toThrow(
                kind === 'expiry' ? 'scheduled_audit_authority_expired' : 'scheduled_audit_file_changed',
              );
              await revoked; // Owner mutation can commit once the bounded readonly transaction refuses/releases.
              if (kind === 'revoke') {
                expect(
                  (
                    await sql<{ enabled: boolean }>`SELECT enabled FROM public.icloud_weekly_grant
              WHERE "connectionId"=${fixture.f.connection.id}::uuid`.execute(db)
                  ).rows[0].enabled,
                ).toBe(false);
              }
              cleanup = files.release();
              if (kind === 'revoke') {
                expect(closed.has(guardedFd)).toBe(false);
              }
              expect((await members(fixture.cohort.id))[0].outcome).toBe('pending');
              expect(
                (await new ICloudAuditRepository(db).get(fixture.authority.auditRequestId, fixture.f.user.id))?.result,
              ).toBe('queued');
            } finally {
              release.resolve();
              await (cleanup ?? files.release());
            }
            expect(closed.has(guardedFd)).toBe(true);
          },
          15_000, // Real staging/decode setup plus the unchanged 2s readonly refusal and descriptor settlement.
        );

        it.for([false, true])(
          'creates only actual completed stream evidence, resumes same obligation and validates real private bytes; protected=%s',
          async (protectedOriginal, { signal }) => {
            const settled = Promise.withResolvers<void>();
            stagedProofSettled = settled.promise;
            const controller = new AbortController();
            const workSignal = AbortSignal.any([signal, controller.signal]);
            let staging: ICloudScheduledStagingService | undefined;
            let validation: Awaited<ReturnType<ICloudScheduledStagingService['validate']>> | undefined;
            let cleanupFailure: { error: unknown } | undefined;
            const started = performance.now();
            let phase = 'setup';
            const logAbort = () =>
              console.info(
                'iCloud staged proof aborted',
                protectedOriginal,
                phase,
                Math.round(performance.now() - started),
              );
            signal.addEventListener('abort', logAbort, { once: true });
            try {
              await operationExecution.run(
                {
                  signal: workSignal,
                  settled: false,
                  completed: new Map(),
                  progress: () => {},
                  settle: async () => {},
                },
                async () => {
                  workSignal.throwIfAborted();
                  const fixture = await createStageFixture(protectedOriginal);
                  staging = fixture.staging;
                  const { f, input, transport, stored, withSession, repository, key } = fixture;
                  phase = 'download';
                  const receipt = await staging.download(input, workSignal);
                  expect(transport.download).toHaveBeenCalledTimes(1);
                  expect(stored).toHaveBeenCalledTimes(1);
                  expect(receipt.payload.binding).toMatchObject({
                    ownerId: f.user.id,
                    connectionId: f.connection.id,
                    auditRequestId: input.authority.auditRequestId,
                    resourceId: input.resource.id,
                    cohortId: fixture.cohort.id,
                    sourceResourceId: f.resource.id,
                    grantGeneration: Number(fixture.cohort.grantGeneration),
                  });
                  expect(() => decryptICloudSession(key, f.connection.id, receipt.seal)).toThrow(
                    'icloud_session_invalid',
                  );
                  phase = 'resume';
                  expect((await repository.read(input))!.resource.verification?.auditFreshDownload).toEqual(receipt);
                  expect(await staging.download(input, workSignal)).toEqual(receipt);
                  expect(transport.download).toHaveBeenCalledTimes(1);
                  expect(stored).toHaveBeenCalledTimes(1);
                  phase = 'validation-setup';
                  validation = await staging.validate(input, workSignal);
                  phase = 'validation-result';
                  const outcome = await validation.result;
                  expect(outcome).toMatchObject({
                    status: 'validated',
                    verified: { status: 'healthy', sha256: f.sha256 },
                  });
                  phase = 'validation-settlement';
                  await validation.settled;
                  phase = 'evidence';
                  expect(
                    (await readdir(join(fixture.root, input.resource.id))).filter((name) =>
                      name.startsWith('.validation-'),
                    ),
                  ).toEqual([]);
                  expect(withSession).not.toHaveBeenCalled();
                  const { rows } = await sql<{ result: string; verifiedAt: Date | null }>`SELECT result,"verifiedAt"
                  FROM public.icloud_identity_audit WHERE id=${input.authority.auditRequestId}::uuid`.execute(db);
                  expect(rows[0]).toEqual({ result: 'queued', verifiedAt: null });
                  expect(
                    await db
                      .selectFrom('asset_integrity_verification')
                      .select('assetId')
                      .where('assetId', '=', f.asset.id)
                      .execute(),
                  ).toEqual([]);
                },
              );
            } finally {
              phase = 'cleanup';
              try {
                controller.abort();
                validation?.cancel();
                try {
                  await validation?.settled;
                } finally {
                  await staging?.onShutdown();
                }
              } catch (error) {
                cleanupFailure = { error };
              } finally {
                signal.removeEventListener('abort', logAbort);
                settled.resolve();
              }
            }
            if (cleanupFailure && !signal.aborted) throw cleanupFailure.error;
          },
        );

        it.each(['missing', 'forged', 'altered', 'wrong-obligation'] as const)(
          'refuses %s cached provenance without a new transport or stamp',
          async (kind) => {
            const fixture = await createStageFixture();
            const receipt = await fixture.staging.download(fixture.input);
            if (kind === 'missing') {
              await sql`UPDATE public.icloud_resource SET verification=NULL WHERE id=${fixture.resource.id}::uuid`.execute(
                db,
              );
            } else {
              const changed =
                kind === 'forged'
                  ? { ...receipt, seal: 'manually-authored-json' }
                  : {
                      ...receipt,
                      payload: {
                        ...receipt.payload,
                        binding: {
                          ...receipt.payload.binding,
                          ...(kind === 'altered' ? { sourceRevision: 'invented' } : { auditRequestId: randomUUID() }),
                        },
                      },
                    };
              await sql`UPDATE public.icloud_resource SET verification=${JSON.stringify({ auditFreshDownload: changed })}::text::jsonb
              WHERE id=${fixture.resource.id}::uuid`.execute(db);
            }
            await expect(fixture.staging.download(fixture.input)).rejects.toThrow('scheduled_audit_unavailable');
            expect(fixture.transport.download).toHaveBeenCalledTimes(1);
            expect(fixture.stored).toHaveBeenCalledTimes(1);
          },
        );

        it('refuses directly authored JSON before any persisted fresh evidence can change', async () => {
          const fixture = await createStageFixture();
          const receipt = await fixture.staging.download(fixture.input);
          expect(
            await fixture.repository.storeFreshDownload(fixture.input, { ...receipt, seal: 'manually-authored-json' }),
          ).toBe(false);
          expect((await fixture.repository.read(fixture.input))!.resource.verification?.auditFreshDownload).toEqual(
            receipt,
          );
        });

        it('refuses an ordinary complete file even when its bytes match the expected digest', async () => {
          const fixture = await createStageFixture();
          const owned = (await sync.resource(fixture.resource.id))!;
          const complete = await fixture.ordinary.download(fixture.f.connection, owned, () => Promise.resolve(true));
          expect(await readFile(complete)).toEqual(fixture.f.bytes);
          await expect(fixture.staging.download(fixture.input)).rejects.toThrow('scheduled_audit_unavailable');
          expect(fixture.stored).not.toHaveBeenCalled();
          expect(fixture.transport.download).toHaveBeenCalledTimes(1);
        });

        it.each(['bytes', 'inode', 'grant'] as const)(
          'refuses changed %s after a genuine cached receipt',
          async (kind) => {
            const fixture = await createStageFixture();
            const receipt = await fixture.staging.download(fixture.input);
            if (kind === 'bytes') {
              await writeFile(receipt.payload.path, Buffer.alloc(fixture.f.bytes.length));
            } else if (kind === 'inode') {
              await rename(receipt.payload.path, `${receipt.payload.path}.old`);
              await writeFile(receipt.payload.path, fixture.f.bytes, { mode: 0o600 });
            } else {
              await weekly().setAuthority(fixture.auth, fixture.f.connection.id, {
                enabled: false,
                includeProtected: false,
                requestKey: randomUUID(),
              });
            }
            await expect(fixture.staging.download(fixture.input)).rejects.toThrow('scheduled_audit_unavailable');
            expect(fixture.transport.download).toHaveBeenCalledTimes(1);
            expect(fixture.stored).toHaveBeenCalledTimes(1);
          },
        );

        it('never revives terminal resource ownership even when a malformed row retains a live lease', async () => {
          const fixture = await createStageFixture();
          await sql`UPDATE public.icloud_resource SET status='committed' WHERE id=${fixture.resource.id}::uuid`.execute(
            db,
          );
          expect(
            await fixture.repository.heartbeat(fixture.input, join(fixture.root, fixture.resource.id, 'complete')),
          ).toBeUndefined();
          expect((await sync.resource(fixture.resource.id))!.status).toBe('committed');
          await expect(fixture.staging.download(fixture.input)).rejects.toThrow('scheduled_audit_unavailable');
          expect(fixture.transport.download).not.toHaveBeenCalled();
        });

        it('refuses an audit resource whose provider zone no longer matches the frozen source', async () => {
          const fixture = await createStageFixture();
          await sql`UPDATE public.icloud_resource SET library='{"area":"private","zoneID":{"zoneName":"foreign-zone"}}'::jsonb
            WHERE id=${fixture.resource.id}::uuid`.execute(db);
          await expect(fixture.staging.download(fixture.input)).rejects.toThrow('scheduled_audit_unavailable');
          expect(fixture.transport.download).not.toHaveBeenCalled();
          expect(fixture.stored).not.toHaveBeenCalled();
        });

        it.each(['short', 'oversize', 'descriptor', 'fingerprint'] as const)(
          'cannot create provenance from %s stream failure',
          async (kind) => {
            const fixture = await createStageFixture();
            const bytes =
              kind === 'short'
                ? fixture.f.bytes.subarray(1)
                : kind === 'oversize'
                  ? Buffer.concat([fixture.f.bytes, Buffer.from('extra')])
                  : kind === 'fingerprint'
                    ? Buffer.alloc(fixture.f.bytes.length)
                    : fixture.f.bytes;
            fixture.transport.download.mockImplementationOnce(() =>
              Promise.resolve({
                stream: Readable.from([bytes]),
                session: { version: 1 },
                fingerprint: kind === 'descriptor' ? 'changed' : fixture.f.resource.fingerprint,
                size: fixture.f.bytes.length,
              }),
            );
            await expect(fixture.staging.download(fixture.input)).rejects.toThrow('scheduled_audit_unavailable');
            expect(fixture.stored).not.toHaveBeenCalled();
            expect((await fixture.repository.read(fixture.input))!.resource.verification).toBeNull();
            expect(
              fixture.transport.encodeSession.mock.calls.some(([scope]) =>
                scope.startsWith('icloud-audit-fresh-download:'),
              ),
            ).toBe(false);
          },
        );

        it('revokes consent during actual streaming without a connection transaction spanning the request', async () => {
          const fixture = await createStageFixture();
          const entered = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          fixture.transport.download.mockImplementationOnce(() =>
            Promise.resolve({
              stream: Readable.from(
                (async function* () {
                  yield fixture.f.bytes.subarray(0, 1);
                  entered.resolve();
                  await release.promise;
                  yield fixture.f.bytes.subarray(1);
                })(),
              ),
              session: { version: 1 },
              fingerprint: fixture.f.resource.fingerprint,
              size: fixture.f.bytes.length,
            }),
          );
          const downloading = fixture.staging.download(fixture.input);
          void downloading.catch(() => {});
          try {
            await entered.promise;
            // Real owner consent update must commit while the network stream is still admitted.
            await weekly().setAuthority(fixture.auth, fixture.f.connection.id, {
              enabled: false,
              includeProtected: false,
              requestKey: randomUUID(),
            });
          } finally {
            release.resolve();
          }
          await expect(downloading).rejects.toThrow('scheduled_audit_unavailable');
          expect(fixture.stored).not.toHaveBeenCalled();
          expect(fixture.withSession).not.toHaveBeenCalled();
        });

        it('owns the private decoder input through actual noncooperative failure and then cleans it', async () => {
          const entered = Promise.withResolvers<string>();
          const release = Promise.withResolvers<void>();
          const decoder = new MediaIntegrityService(
            new StorageRepository(getMocks().logger as never),
            new CryptoRepository(),
            {
              decodeImage: async (path: string) => {
                entered.resolve(path);
                await release.promise;
                throw new Error('native_decode_failed');
              },
            } as never,
          );
          const fixture = await createStageFixture(false, decoder);
          await fixture.staging.download(fixture.input);
          const validation = await fixture.staging.validate(fixture.input);
          const path = await entered.promise;
          try {
            expect(await readFile(path)).toEqual(fixture.f.bytes);
          } finally {
            release.resolve();
          }
          expect(await validation.result).toEqual({ status: 'unavailable' });
          await validation.settled;
          await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
          await fixture.staging.onShutdown();
        });

        it.each(['cancel', 'timeout', 'revoke'] as const)(
          'retains noncooperative decoder input after %s refusal, then cleans at actual settlement',
          async (kind) => {
            const entered = Promise.withResolvers<string>();
            const release = Promise.withResolvers<void>();
            vi.stubEnv('FRAMELEAF_MEDIA_VALIDATION_TIMEOUT_MS', '10000');
            const decoder = new MediaIntegrityService(
              new StorageRepository(getMocks().logger as never),
              new CryptoRepository(),
              {
                decodeImage: async (path: string) => {
                  entered.resolve(path);
                  await release.promise;
                  return {} as never;
                },
              } as never,
            );
            const fixture = await createStageFixture(false, decoder);
            await fixture.staging.download(fixture.input);
            let timeout!: () => void;
            const actualTimer = setTimeout;
            vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
              callback: () => void,
              delay?: number,
              ...args: unknown[]
            ) => {
              if (delay === 10_000) {
                timeout = callback;
              }
              return actualTimer(callback, delay, ...args);
            }) as never);
            let heartbeat!: () => void;
            const actualInterval = setInterval;
            vi.spyOn(globalThis, 'setInterval').mockImplementation(((
              callback: () => void,
              delay?: number,
              ...args: unknown[]
            ) => {
              if (delay === 15_000) {
                heartbeat = callback;
              }
              return actualInterval(callback, delay, ...args);
            }) as never);
            const controller = new AbortController();
            const validation = await fixture.staging.validate(fixture.input, controller.signal);
            const path = await entered.promise;
            let settled = false;
            void validation.settled.then(() => {
              settled = true;
            });
            try {
              if (kind === 'timeout') {
                timeout();
              } else if (kind === 'revoke') {
                await weekly().setAuthority(fixture.auth, fixture.f.connection.id, {
                  enabled: false,
                  includeProtected: false,
                  requestKey: randomUUID(),
                });
                heartbeat(); // Exercise actual admission revocation, without waiting/polling a timer.
              } else {
                controller.abort();
              }
              expect(await validation.result).toEqual({ status: 'unavailable' });
              expect(settled).toBe(false);
              expect(await readFile(path)).toEqual(fixture.f.bytes);
              const resource = (await sync.resource(fixture.resource.id))!;
              // Owned staging cleanup is credential-independent and cannot remove the decoder copy.
              await fixture.ordinary.cleanup(resource);
              expect(await readFile(path)).toEqual(fixture.f.bytes);
              const { rows } = await sql<{
                verifiedAt: Date | null;
              }>`SELECT "verifiedAt" FROM public.icloud_identity_audit
              WHERE id=${fixture.authority.auditRequestId}::uuid`.execute(db);
              expect(rows[0].verifiedAt).toBeNull();
            } finally {
              release.resolve();
              await validation.settled;
              await fixture.staging.onShutdown();
            }
            await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
          },
        );
      });

      it('keeps manual integrity privacy filters while scheduled structural lookup requires separate authority', async () => {
        const { f, auth } = await scheduledAuthorityFixture();
        const integrity = new IntegrityRepository(db);
        const hash = [f.sha256.toString('hex')];
        expect(await integrity.getSafetyQuery(auth, hash).where('asset.id', '=', f.asset.id).execute()).toHaveLength(1);
        await sql`INSERT INTO public.asset_lock ("assetId",reason) VALUES (${f.asset.id}::uuid,${AssetLockReason.Marked})`.execute(
          db,
        );
        expect(await integrity.getSafetyQuery(auth, hash).where('asset.id', '=', f.asset.id).execute()).toEqual([]);
        expect(
          await integrity.getOwnedOriginalSafetyQuery(f.user.id, hash).where('asset.id', '=', f.asset.id).execute(),
        ).toHaveLength(1);
        expect(await integrity.getOwnedOriginalSafetyQuery(randomUUID(), hash).execute()).toEqual([]);
      });
    });
  });
});
