import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { DB } from 'src/schema/index.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { AssetUploadResourceRepository } from 'src/repositories/asset-upload-resource.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { ICloudIdentityRepository } from 'src/repositories/icloud-identity.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotoSourceRepository } from 'src/repositories/photo-source.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetUploadResourceService } from 'src/services/asset-upload-resource.service.js';
import { PhotoSourceService } from 'src/services/photo-source.service.js';
import { canonicalDatabaseUrl } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let folder: string;
let admission: RateLimitRepository;
beforeAll(async () => {
  db = await getKyselyDB();
  folder = await mkdtemp(join(tmpdir(), 'frameleaf-folder-upload-'));
  StorageCore.setMediaLocation(folder);
  await mkdir(join(folder, 'upload'), { recursive: true });
  const { rows } = await sql<{ name: string }>`select current_database() name`.execute(db);
  const config = new ConfigRepository();
  const env = config.getEnv();
  vi.spyOn(config, 'getEnv').mockReturnValue({
    ...env,
    database: {
      ...env.database,
      config: {
        connectionType: 'url',
        url: canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, rows[0].name),
      },
    },
  });
  admission = new RateLimitRepository(config);
});
afterAll(async () => {
  await admission?.onModuleDestroy();
  await db?.destroy();
  if (folder) await rm(folder, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function setup() {
  const { sut: media, ctx } = newMediumService(AssetMediaService, {
    database: db,
    real: [
      ConfigRepository,
      SystemMetadataRepository,
      PhysicalFileRepository,
      AssetChecksumRepository,
      AccessRepository,
      AlbumRepository,
      AssetRepository,
      SharedLinkRepository,
      UserRepository,
      StorageRepository,
    ],
    mock: [EventRepository, LoggingRepository, JobRepository],
  });
  ctx.getMock(JobRepository).queue.mockResolvedValue(undefined);
  ctx.getMock(EventRepository).emit.mockResolvedValue(undefined);
  const { user } = await ctx.newUser();
  const { session } = await ctx.newSession({ userId: user.id });
  const auth = { user, session: { ...session, hasElevatedPermission: false } } as AuthDto;
  const authority = { ownerId: user.id, sessionId: session.id };
  const devices = new DesktopDeviceRepository(db);
  const device = (await devices.enroll({
    userId: user.id,
    installationId: randomUUID(),
    publicKey: Buffer.alloc(32, 7).toString('base64'),
    name: 'Fixture',
    platform: 'linux',
    architecture: 'x86_64',
    mode: 'client-worker',
    state: 'awaiting-approval',
  }))!;
  const sources = new PhotoSourceRepository(db);
  const source = await sources.create(authority, {
    id: randomUUID(),
    deviceId: device.id,
    kind: 'folder',
    mode: 'copy',
    name: 'Synthetic folder',
    scopeFingerprint: 'a'.repeat(64),
  });
  const run = await sources.run(authority, source.id, { id: randomUUID(), maxItems: 1, maxBytes: 100 });
  const bytes = Buffer.from('independent synthetic original');
  const checksum = createHash('sha256').update(bytes).digest();
  const item = await sources.plan(authority, source.id, run.id, {
    id: randomUUID(),
    resourceKey: 'b'.repeat(64),
    version: 'c'.repeat(64),
    sha256: checksum.toString('hex'),
    bytes: bytes.length,
  });
  const repository = new AssetUploadResourceRepository(db);
  const native = new AssetUploadResourceService(
    repository,
    media,
    ctx.get(AssetRepository),
    ctx.get(AccessRepository),
    ctx.get(StorageRepository),
    ctx.get(PhysicalFileRepository),
    ctx.getMock(LoggingRepository),
    admission,
    new ICloudIdentityRepository(db),
    sources,
  );
  const identity = { kind: 'folder' as const, sourceId: source.id, runId: run.id, itemId: item.id };
  const headers = {
    'upload-draft-interop-version': '9',
    'upload-complete': '?0',
    'upload-length': String(bytes.length),
    'content-type': 'image/jpeg',
    'repr-digest': `sha-256=:${checksum.toString('base64')}:`,
    'asset-metadata': Buffer.from(
      JSON.stringify({
        filename: 'synthetic.jpg',
        fileCreatedAt: new Date().toISOString(),
        fileModifiedAt: new Date().toISOString(),
        sourceIdentity: identity,
      }),
    ).toString('base64url'),
  };
  const append = {
    'upload-draft-interop-version': '9',
    'upload-complete': '?1',
    'content-type': 'application/partial-upload',
    'upload-offset': '0',
  };
  return { native, repository, media, ctx, auth, authority, sources, source, run, item, bytes, headers, append };
}
it('publishes a folder upload through the real native pipeline and verifies its independently stored bytes', async () => {
  const f = await setup();
  const created = await f.native.create(f.auth, f.headers, Readable.from([]), () => {});
  const result = await f.native.append(f.auth, created.resource.id, f.append, Readable.from([f.bytes]));
  expect(result.result?.status).toBe('created');
  const asset = await f.ctx.get(AssetRepository).getById(result.result!.id);
  expect(await readFile(asset!.originalPath)).toEqual(f.bytes);
  const service = new PhotoSourceService(
    f.sources,
    f.ctx.get(AccessRepository),
    f.ctx.get(StorageRepository),
    new CryptoRepository(),
    f.ctx.get(SystemMetadataRepository),
    admission,
    f.ctx.getMock(LoggingRepository),
  );
  const receipt = await service.verify(f.auth, f.source.id, f.run.id, f.item.id, {
    uploadResourceId: created.resource.id,
  });
  expect(receipt).toMatchObject({ assetId: asset!.id, storage: 'managed', sha256: f.item.checksum.toString('hex') });
});
it('refuses revoked folder authority before assigning a URI or reading a request body', async () => {
  const f = await setup();
  await f.sources.revoke(f.authority, f.source.id);
  let read = false;
  const resume = vi.fn();
  await expect(
    f.native.create(
      f.auth,
      f.headers,
      Readable.from(
        (function* () {
          read = true;
          yield f.bytes;
        })(),
      ),
      resume,
    ),
  ).rejects.toThrow();
  expect(read).toBe(false);
  expect(resume).not.toHaveBeenCalled();
  expect(
    await db.selectFrom('asset_upload_resource').select('id').where('ownerId', '=', f.auth.user.id).execute(),
  ).toHaveLength(0);
});
it('a revocation after real media preparation prevents publication and retains the verified resumable bytes', async () => {
  const f = await setup();
  const created = await f.native.create(f.auth, f.headers, Readable.from([]), () => {});
  const prepare = f.media.prepareUploadAsset.bind(f.media);
  vi.spyOn(f.media, 'prepareUploadAsset').mockImplementation(async (...args) => {
    const prepared = await prepare(...args);
    await f.sources.revoke(f.authority, f.source.id);
    return prepared;
  });
  await expect(f.native.append(f.auth, created.resource.id, f.append, Readable.from([f.bytes]))).rejects.toThrow();
  const retained = await f.repository.get(created.resource.id, f.auth.user.id);
  expect(retained.state).toBe('verified');
  expect(retained.resultAssetId).toBeNull();
  expect(await readFile(retained.finalPath!)).toEqual(f.bytes);
  expect(await db.selectFrom('asset').select('id').where('ownerId', '=', f.auth.user.id).execute()).toHaveLength(0);
  await f.native['recover']();
  expect((await f.repository.get(created.resource.id, f.auth.user.id)).state).toBe('verified');
});
