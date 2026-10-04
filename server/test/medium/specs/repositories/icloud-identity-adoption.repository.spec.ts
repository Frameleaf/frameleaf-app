import { Kysely, sql } from 'kysely';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { access, lstat, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import {
  AssetLockReason,
  AssetPathType,
  AssetType,
  AssetVisibility,
  ChecksumAlgorithm,
  UserMetadataKey,
} from 'src/enum.js';
import * as auditMigration from 'src/fork-schema/migrations/0000000000216-ICloudIdentityAudit.js';
import * as reuseMigration from 'src/fork-schema/migrations/0000000000217-ICloudIdentityReuse.js';
import * as weeklyMigration from 'src/fork-schema/migrations/0000000000218-ICloudWeeklyAuthority.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { ForkPrivacyRepository } from 'src/repositories/fork-privacy.repository.js';
import {
  ICloudIdentityAdoptionRepository,
  IdentityAdoptionAuthority,
} from 'src/repositories/icloud-identity-adoption.repository.js';
import { ICLOUD_SYNC_CLAIM_SEC, ICloudIdentityRepository } from 'src/repositories/icloud-identity.repository.js';
import { type ICloudResource, ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { ICloudWeeklyRepository } from 'src/repositories/icloud-weekly.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import {
  ICloudIdentityAdoptionService,
  identityAdoptionEnabled,
} from 'src/services/icloud-identity-adoption.service.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { appleFingerprintHash, identityRoleOf } from 'src/utils/icloud-identity.js';
import { canonicalJson } from 'src/utils/studio-project.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB, getMocks } from 'test/utils.js';

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
  const directories = new Set<string>();
  const connections = new Set<string>();
  beforeAll(async () => {
    db = await getActiveForkKyselyDB();
    const table = await sql<{
      present: string | null;
    }>`SELECT to_regclass('immich_fork.icloud_identity_reuse')::text AS present`.execute(db);
    if (!table.rows[0].present) {
      await reuseMigration.up(db);
    }
    const audit = await sql<{
      present: string | null;
    }>`SELECT to_regclass('immich_fork.icloud_identity_audit')::text AS present`.execute(db);
    if (!audit.rows[0].present) {
      await auditMigration.up(db);
    }
    const weekly = await sql<{
      present: string | null;
    }>`SELECT to_regclass('immich_fork.icloud_weekly_grant')::text AS present`.execute(db);
    if (!weekly.rows[0].present) {
      await weeklyMigration.up(db);
    }
    sync = new ICloudSyncRepository(db);
    repository = new ICloudIdentityAdoptionRepository(db);
    identities = new ICloudIdentityRepository(db);
  });
  beforeEach(() => {
    vi.stubEnv('FRAMELEAF_ICLOUD_IDENTITY_ADOPTION', 'true');
    vi.stubEnv('FRAMELEAF_ICLOUD_IDENTITY_MATCHING', 'true');
    const mocks = getMocks();
    media = new MediaRepository(mocks.logger as never);
    integrity = new MediaIntegrityService(new StorageRepository(mocks.logger as never), new CryptoRepository(), media);
    service = new ICloudIdentityAdoptionService(repository, integrity);
  });
  afterEach(async () => {
    await service.onShutdown();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (connections.size > 0) {
      await sql`DELETE FROM immich_fork.icloud_connection WHERE id=ANY(${[...connections]}::uuid[])`.execute(db);
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
  ) {
    const directory = await mkdtemp(join(tmpdir(), 'identity-adoption-'));
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
    await sql`INSERT INTO immich_fork.icloud_source_identity
      (id,"ownerId","assetId","libraryKey","cplAssetRecordName","cplMasterRecordName",role,sha256,"deliveredBy","cloudIdentifier","matchStrength")
      VALUES (${identityId}::uuid,${user.id}::uuid,${asset.id}::uuid,'library',${NAME},${master},${identityRoleOf[role]},
        ${sha256},${`device:${device}`},${`${NAME}:001:${master}`},'corroborated')`.execute(db);
    await identities.claimForSync(user.id, NAME, connection.id);
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
    };
  }

  async function unpublished(fixture: Awaited<ReturnType<typeof arrange>>) {
    const resource = await sync.resource(fixture.resource.id);
    expect(resource?.assetId).toBeNull();
    const receipts =
      await sql`SELECT id FROM immich_fork.icloud_identity_reuse WHERE "sourceResourceId"=${fixture.resource.id}::uuid`.execute(
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
      }>`SELECT basis,role FROM immich_fork.icloud_identity_reuse WHERE "sourceResourceId"=${fixture.resource.id}::uuid`.execute(
        db,
      );
      expect(receipts.rows).toEqual([{ basis: 'exact-identity', role: identityRoleOf[role] }]);
      const fingerprints = await sql<{
        appleFingerprint: string;
      }>`SELECT "appleFingerprint" FROM immich_fork.icloud_identity_reuse
      WHERE "sourceResourceId"=${fixture.resource.id}::uuid`.execute(db);
      expect(fingerprints.rows[0].appleFingerprint).toBe(fixture.resourceFingerprint);
      if (role === 'motion') {
        expect(fixture.resourceFingerprint).not.toBe(fixture.master);
      }
      const proof = await sql<{
        lastAuditResult: string | null;
        lastVerifiedAt: Date | null;
      }>`SELECT "lastAuditResult","lastVerifiedAt" FROM immich_fork.icloud_source_identity WHERE id=${fixture.identityId}::uuid`.execute(
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
    await sql`UPDATE immich_fork.icloud_source_identity SET "deliveredBy"=${`icloud-sync:${fixture.connection.id}`},"matchStrength"='exact' WHERE id=${fixture.identityId}::uuid`.execute(
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
    await sql`DELETE FROM immich_fork.icloud_checkpoint WHERE "connectionId"=${fixture.connection.id}::uuid AND scope='materialize:library'`.execute(
      db,
    );
    await sync.materialize(fixture.connection, 'library', { area: 'private', zoneID: { zoneName: 'PrimarySync' } });
    const resource = (await sync.claim(fixture.connection.id, fixture.connection.config.stagingBytes))!;
    expect(resource).toBeDefined();
    expect(resource.role).toBe('original');
    await sql`INSERT INTO immich_fork.icloud_source_identity
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
    }>`SELECT "itemClaimId",role FROM immich_fork.icloud_identity_reuse
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
          await sql`UPDATE immich_fork.icloud_resource SET "leaseExpiresAt"=clock_timestamp()-interval '1 second' WHERE id=${fixture.resource.id}::uuid`.execute(
            db,
          );

          break;
        }
        case 'item': {
          await sql`UPDATE immich_fork.icloud_claim SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE "ownerId"=${fixture.user.id}::uuid`.execute(
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
    await sql`UPDATE immich_fork.icloud_source_identity SET "ownerId"=${randomUUID()}::uuid WHERE id=${fixture.identityId}::uuid`.execute(
      db,
    );
    expect(await service.adopt(fixture.authority)).toBe('miss');
    await unpublished(fixture);
    await sql`UPDATE immich_fork.icloud_source_identity SET "ownerId"=${fixture.user.id}::uuid WHERE id=${fixture.identityId}::uuid`.execute(
      db,
    );
    await sql`UPDATE immich_fork.icloud_resource SET "assetId"=${fixture.asset.id}::uuid,sha256=${fixture.sha256} WHERE id=${fixture.resource.id}::uuid`.execute(
      db,
    );
    expect(await service.adopt(fixture.authority)).toBe('miss');
    expect(
      (
        await sql`SELECT id FROM immich_fork.icloud_identity_reuse WHERE "sourceResourceId"=${fixture.resource.id}::uuid`.execute(
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
          await sql`UPDATE immich_fork.icloud_record SET deleted=true WHERE "connectionId"=${fixture.connection.id}::uuid AND "recordId"=${fixture.master}`.execute(
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
          await sql`UPDATE immich_fork.icloud_source_identity SET sha256=${Buffer.alloc(32)} WHERE id=${fixture.identityId}::uuid`.execute(
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
    'reservation',
    'album',
    'library',
  ] as const)('refuses %s evidence without publishing a mapping or receipt', async (kind) => {
    const fixture = await arrange();
    switch (kind) {
      case 'missing': {
        await sql`DELETE FROM immich_fork.icloud_source_identity WHERE id=${fixture.identityId}::uuid`.execute(db);

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
        await sql`INSERT INTO immich_fork.icloud_source_identity
          ("ownerId","assetId","libraryKey","cplAssetRecordName","cplMasterRecordName",role,sha256,"deliveredBy","cloudIdentifier")
          SELECT "ownerId",${asset.id}::uuid,"libraryKey","cplAssetRecordName","cplMasterRecordName",role,sha256,"deliveredBy","cloudIdentifier"
          FROM immich_fork.icloud_source_identity WHERE id=${fixture.identityId}::uuid`.execute(db);

        break;
      }
      case 'master': {
        await sql`UPDATE immich_fork.icloud_source_identity SET "cplMasterRecordName"='different' WHERE id=${fixture.identityId}::uuid`.execute(
          db,
        );

        break;
      }
      case 'role': {
        await sql`UPDATE immich_fork.icloud_source_identity SET role='raw-alternate' WHERE id=${fixture.identityId}::uuid`.execute(
          db,
        );

        break;
      }
      case 'review': {
        await sql`UPDATE immich_fork.icloud_source_identity SET "lastAuditResult"='mismatch' WHERE id=${fixture.identityId}::uuid`.execute(
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
      case 'reservation': {
        await sql`INSERT INTO immich_fork.asset_storage_reservation
          ("assetId",token,"sourcePath","upstreamPath","temporaryPath",status)
          VALUES (${fixture.asset.id}::uuid,${randomUUID()}::uuid,${fixture.originalPath},${`${fixture.originalPath}.upstream`},
            ${`${fixture.originalPath}.temporary`},'reserved')`.execute(db);

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
    const privacy = new ForkPrivacyRepository(db);
    const database = new DatabaseRepository(db, getMocks().logger as never, new ConfigRepository());
    await privacy.saveClassification(fixture.asset.id, false, null, db);
    const entered = Promise.withResolvers<number>();
    const resume = Promise.withResolvers<void>();
    const classifying = database.withAssetMetadataLock(fixture.asset.id, async (transaction) => {
      const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(transaction);
      entered.resolve(pid.rows[0].pid);
      await resume.promise;
      await privacy.saveClassification(fixture.asset.id, true, null, transaction);
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
    const privacy = new ForkPrivacyRepository(db);
    const database = new DatabaseRepository(db, getMocks().logger as never, new ConfigRepository());
    await privacy.saveClassification(fixture.asset.id, false, null, db);
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
        await privacy.saveClassification(fixture.asset.id, true, null, transaction);
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
      const current = await sql<{ isNsfw: boolean }>`SELECT "isNsfw" FROM immich_fork.asset_privacy
        WHERE "assetId"=${fixture.asset.id}::uuid`.execute(db);
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
        await sql`SELECT id FROM immich_fork.icloud_identity_reuse WHERE "sourceResourceId"=${fixture.resource.id}::uuid`.execute(
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
        await sql`SELECT id FROM immich_fork.icloud_identity_reuse WHERE "sourceResourceId"=${fixture.resource.id}::uuid`.execute(
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
          await sql`UPDATE immich_fork.icloud_resource SET "leaseExpiresAt"=clock_timestamp()+interval '1 second' WHERE id=${fixture.resource.id}::uuid`.execute(
            db,
          );

          break;
        }
        case 'item': {
          await sql`UPDATE immich_fork.icloud_claim SET "expiresAt"=clock_timestamp()+interval '1 second' WHERE "ownerId"=${fixture.user.id}::uuid`.execute(
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
        await sql`SELECT id FROM immich_fork.icloud_identity_reuse WHERE "sourceResourceId"=${fixture.resource.id}::uuid`.execute(
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
    await sql`ALTER TABLE immich_fork.icloud_identity_reuse ADD CONSTRAINT ${sql.id(constraint)}
      CHECK ("ownerId"<>${sql.lit(fixture.user.id)}::uuid)`.execute(db);
    try {
      expect(await service.adopt(fixture.authority)).toBe('retry');
      await unpublished(fixture);
      expect(await readFile(fixture.originalPath)).toEqual(fixture.bytes);
    } finally {
      await sql`ALTER TABLE immich_fork.icloud_identity_reuse DROP CONSTRAINT ${sql.id(constraint)}`.execute(db);
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
    await sql`DELETE FROM immich_fork.icloud_source_identity WHERE id=${fixture.identityId}::uuid`.execute(db);
    await sql`DELETE FROM immich_fork.icloud_resource WHERE id=${fixture.resource.id}::uuid`.execute(db);
    await sql`DELETE FROM public.asset WHERE id=${fixture.asset.id}::uuid`.execute(db);
    expect(
      (
        await sql`SELECT id FROM immich_fork.icloud_identity_reuse WHERE "connectionId"=${fixture.connection.id}::uuid`.execute(
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
        await sql`SELECT id FROM immich_fork.icloud_identity_reuse WHERE "connectionId"=${fixture.connection.id}::uuid`.execute(
          db,
        )
      ).rows,
    ).toHaveLength(0);
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
      const progress = (phase: string, receipts: number) => {
        if (size > 101) {
          console.info('weekly-large-population-qualification', {
            phase,
            receipts,
            elapsedMs: Math.round(performance.now() - started),
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
        await sql`DELETE FROM immich_fork.icloud_checkpoint WHERE "connectionId"=${f.connection.id}::uuid
          AND scope='materialize:library'`.execute(db);
        while (
          !(await sync.materialize(f.connection, 'library', { area: 'private', zoneID: { zoneName: 'PrimarySync' } }))
        ) {
          // Consume the actual bounded keyset materializer, never a fabricated resource population.
        }
        progress('resources-materialized', 0);
        const device = randomUUID();
        const identities = names.slice(1).map((name) => ({ name, cloud: `${name}:001:${f.master}` }));
        await sql`INSERT INTO immich_fork.icloud_source_identity
          ("ownerId","assetId","libraryKey","cplAssetRecordName","cplMasterRecordName",role,sha256,"deliveredBy","cloudIdentifier","matchStrength")
          SELECT ${f.user.id}::uuid,${f.asset.id}::uuid,'library',name,${f.master},'original',${f.sha256},
            ${`device:${device}`},cloud,'corroborated'
          FROM jsonb_to_recordset(${JSON.stringify(identities)}::text::jsonb) AS x(name text,cloud text)`.execute(db);
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
        progress('actual-receipts', 1);
        for (let index = 1; index < size; index += concurrency) {
          const admitted: ICloudResource[] = [];
          for (let slot = 0; slot < Math.min(concurrency, size - index); slot++) {
            const resource = (await sync.claim(f.connection.id, f.connection.config.stagingBytes))!;
            expect(resource).toBeDefined();
            admitted.push(resource);
          }
          // Admission pauses until the whole wave finalizes: a new claim otherwise
          // could take another adopter's committed resource before it releases its lease.
          const settled = await Promise.allSettled(
            admitted.map(async (resource) => {
              expect(
                await repository.adopt(
                  { ...f.authority, resourceId: resource.id, resourceLeaseToken: resource.leaseToken! },
                  async (candidate) => {
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
                    return {
                      sha1: createHash('sha1').update(bytes).digest(),
                      sha256: createHash('sha256').update(bytes).digest(),
                      sizeInBytes: bytes.length,
                      appleFingerprint: apple.digest(),
                      identity,
                      current: async () => {
                        const current = await lstat(candidate.originalPath);
                        return Object.entries(identity).every(
                          ([key, value]) => current[key as keyof typeof identity] === value,
                        );
                      },
                    };
                  },
                ),
              ).toBe('adopted');
              expect(await sync.finalize(resource, async () => {})).toBe(true);
            }),
          );
          for (const result of settled) {
            if (result.status === 'rejected') throw result.reason;
          }
          const receipts = index + admitted.length;
          if (receipts % 1000 === 1 || receipts === size) progress('actual-receipts', receipts);
        }
      }
      const published = await sql<{ count: number }>`SELECT count(*)::int AS count
        FROM immich_fork.icloud_identity_reuse WHERE "connectionId"=${f.connection.id}::uuid`.execute(db);
      expect(published.rows[0].count).toBe(size);
      progress('receipt-population-complete', published.rows[0].count);
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
        }>`SELECT * FROM immich_fork.icloud_weekly_member WHERE "cohortId"=${cohortId}::uuid ORDER BY ordinal`.execute(
          db,
        )
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
        const week =
          (cohort.weekStart as unknown) instanceof Date
            ? (cohort.weekStart as unknown as Date).toISOString().slice(0, 10)
            : cohort.weekStart.slice(0, 10);
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
            (await sql`SELECT 1 FROM immich_fork.icloud_identity_audit WHERE "cohortId"=${cohort.id}::uuid`.execute(db))
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
      const week = cohort.weekStart.slice(0, 10);
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
          await sql`SELECT 1 FROM immich_fork.icloud_identity_audit WHERE "cohortId"=${cohort.id}::uuid
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
      await sql`DELETE FROM immich_fork.icloud_checkpoint WHERE "connectionId"=${fixture.connection.id}::uuid AND scope='materialize:library'`.execute(
        db,
      );
      await sync.materialize(fixture.connection, 'library', { area: 'private', zoneID: { zoneName: 'PrimarySync' } });
      const resource = (await sync.claim(fixture.connection.id, fixture.connection.config.stagingBytes))!;
      expect(resource).toBeDefined();
      expect(resource.role).toBe('original');
      await sql`INSERT INTO immich_fork.icloud_source_identity
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
          await sql`SELECT id FROM immich_fork.icloud_weekly_cohort
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
            await sql`DELETE FROM immich_fork.icloud_resource WHERE id=${f.resource.id}::uuid`.execute(db);

            break;
          }
          case 'identity': {
            await sql`DELETE FROM immich_fork.icloud_source_identity WHERE id=${f.identityId}::uuid`.execute(db);

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
            await sql`UPDATE immich_fork.icloud_record SET revision='master-replaced'
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
        FROM immich_fork.icloud_weekly_cohort WHERE id=${cohort.id}::uuid`.execute(db);
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
          await sql`SELECT * FROM immich_fork.icloud_identity_audit WHERE "cohortId"=${cohort.id}::uuid`.execute(db)
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
          target === 'outbox' ? sql.table('public.media_operation') : sql.table('immich_fork.icloud_weekly_cohort');
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
            (
              await sql`SELECT id FROM immich_fork.icloud_identity_audit WHERE "cohortId"=${cohort.id}::uuid`.execute(
                db,
              )
            ).rows,
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
      } = await sql`SELECT * FROM immich_fork.icloud_identity_audit
        WHERE id=${after[0].auditRequestId}::uuid`.execute(db);
      expect(audit).toMatchObject({ result: 'stale', verifiedAt: null, operationId: operation.id });
      expect(
        (
          await sql`SELECT "lastVerifiedAt" FROM immich_fork.icloud_source_identity
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
  });
});
