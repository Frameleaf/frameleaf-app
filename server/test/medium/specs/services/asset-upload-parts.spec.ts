import { ConflictException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
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
import { CaptureRepository } from 'src/repositories/capture.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
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
import { canonicalDatabaseUrl } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

// FL-1268: parallel parts, in any order, assemble into one verified asset.
let db: Kysely<DB>;
let folder: string;
let admission: RateLimitRepository;
beforeAll(async () => {
  db = await getKyselyDB();
  folder = await mkdtemp(join(tmpdir(), 'frameleaf-upload-parts-'));
  StorageCore.setMediaLocation(folder);
  await mkdir(join(folder, 'upload'), { recursive: true });
  const { rows } = await sql<{ name: string }>`select current_database() name`.execute(db);
  const config = new ConfigRepository();
  const env = config.getEnv();
  vi.spyOn(config, 'getEnv').mockReturnValue({
    ...env,
    database: {
      ...env.database,
      config: { connectionType: 'url', url: canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, rows[0].name) },
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

async function setup(bytes: Buffer) {
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
  const service = new AssetUploadResourceService(
    new AssetUploadResourceRepository(db),
    media,
    ctx.get(AssetRepository),
    ctx.get(AccessRepository),
    ctx.get(StorageRepository),
    ctx.get(PhysicalFileRepository),
    ctx.getMock(LoggingRepository),
    admission,
    new ICloudIdentityRepository(db),
    new PhotoSourceRepository(db),
    new CaptureRepository(db),
  );
  const checksum = createHash('sha256').update(bytes).digest();
  const created = await service.create(
    auth,
    {
      'upload-draft-interop-version': '9',
      'upload-complete': '?0',
      'upload-length': String(bytes.length),
      'content-type': 'video/mp4',
      'repr-digest': `sha-256=:${checksum.toString('base64')}:`,
      'asset-metadata': Buffer.from(
        JSON.stringify({
          filename: 'long.mp4',
          fileCreatedAt: new Date().toISOString(),
          fileModifiedAt: new Date().toISOString(),
        }),
      ).toString('base64url'),
    },
    Readable.from([]),
    () => {},
  );
  const id = created.resource.id;
  const put = (offset: number, size: number) =>
    service.putPart(
      auth,
      id,
      { 'content-type': 'application/octet-stream', 'upload-offset': String(offset), 'content-length': String(size) },
      Readable.from([bytes.subarray(offset, offset + size)]),
    );
  return { service, auth, id, checksum, put };
}

it('assembles parts sent out of order and in parallel into one verified asset', async () => {
  const bytes = randomBytes(40);
  const f = await setup(bytes);

  // The tail first, then two in parallel; HEAD's offset is only the contiguous prefix.
  const tail = await f.put(30, 10);
  expect(Number(tail.resource.offset)).toBe(0);
  const [first, second] = await Promise.all([f.put(0, 10), f.put(10, 10)]);
  expect([first, second].every(({ resource }) => resource.state === 'receiving')).toBe(true);
  const listed = await f.service.parts(f.auth, f.id);
  expect(Number(listed.resource.offset)).toBe(20);
  expect(listed.parts).toEqual([
    { offset: 0, size: 10 },
    { offset: 10, size: 10 },
    { offset: 30, size: 10 },
  ]);

  // A repeated identical part is accepted; an overlapping different one is refused.
  await expect(f.put(10, 10)).resolves.toBeDefined();
  await expect(f.put(15, 10)).rejects.toBeInstanceOf(ConflictException);

  const last = await f.put(20, 10);
  expect(last.result?.sha256).toBe(f.checksum.toString('hex'));
  const row = await db.selectFrom('asset_upload_resource').selectAll().where('id', '=', f.id).executeTakeFirstOrThrow();
  expect(row.state).toBe('published');
  expect(await readFile(row.finalPath!)).toEqual(bytes);
});

// FL-1270: the Relay direct channel and older apps append sequentially; they must finish an upload begun as parts.
it('lets a sequential append supersede parallel parts and finish the upload', async () => {
  const bytes = randomBytes(40);
  const f = await setup(bytes);
  await f.put(10, 10);
  await f.put(30, 10);
  const held = await db.selectFrom('asset_upload_part').select('path').where('resourceId', '=', f.id).execute();
  const append = (offset: number, end: number) =>
    f.service.append(
      f.auth,
      f.id,
      {
        'upload-draft-interop-version': '9',
        'upload-complete': end === bytes.length ? '?1' : '?0',
        'content-type': 'application/partial-upload',
        'upload-offset': String(offset),
      },
      Readable.from([bytes.subarray(offset, end)]),
    );

  // The acknowledged offset is exactly what was sent, as the direct channel's receipt requires.
  const first = await append(0, 20);
  expect(Number(first.resource.offset)).toBe(20);
  expect((await f.service.parts(f.auth, f.id)).parts).toEqual([{ offset: 0, size: 20 }]);
  await expect(Promise.all(held.map(({ path }) => readFile(path)))).rejects.toThrow();

  const last = await append(20, 40);
  expect(last.result?.sha256).toBe(f.checksum.toString('hex'));
  const row = await db.selectFrom('asset_upload_resource').selectAll().where('id', '=', f.id).executeTakeFirstOrThrow();
  expect(row.state).toBe('published');
  expect(await readFile(row.finalPath!)).toEqual(bytes);
});
