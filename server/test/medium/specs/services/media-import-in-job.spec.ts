import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { JobName, JobStatus, LibraryScope, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { ApiKeyRepository } from 'src/repositories/api-key.repository.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { AssetUploadResourceRepository } from 'src/repositories/asset-upload-resource.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CaptureRepository } from 'src/repositories/capture.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { type MediaImportAuthority, MediaImportRepository } from 'src/repositories/media-import.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetUploadResourceService } from 'src/services/asset-upload-resource.service.js';
import { mediaSourceKey } from 'src/utils/media-import.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>, directory: string;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
  directory = await mkdtemp(join(tmpdir(), 'frameleaf-media-ingestion-'));
  StorageCore.setMediaLocation(directory);
  await mkdir(join(directory, 'upload'), { recursive: true });
}, 60_000);
afterAll(async () => {
  await db?.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('ingests a download from inside its import job, whatever else the account is uploading', async () => {
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
      ApiKeyRepository,
      SessionRepository,
      StorageRepository,
    ],
    mock: [EventRepository, LoggingRepository, JobRepository],
  });
  const real = new JobRepository({} as never, {} as never, {} as never, { setContext: () => {} } as never, db);
  real['handlers'][JobName.AssetExtractMetadata] = {
    queueName: QueueName.MetadataExtraction,
    handler: () => Promise.resolve(JobStatus.Success),
  } as never;
  const jobMock = ctx.getMock(JobRepository);
  jobMock.queue.mockImplementation((item) => real.queue(item));
  jobMock.queueAll.mockImplementation((items) => real.queueAll(items));
  jobMock.queueUpload.mockImplementation((item, origin) => real.queueUpload(item, origin));
  ctx.getMock(EventRepository).emit.mockResolvedValue(undefined);
  const { user } = await ctx.newUser();
  const { album } = await ctx.newAlbum({ ownerId: user.id, libraryScope: LibraryScope.Design });
  const repo = new MediaImportRepository(db, new CaptureRepository(db));
  const imports = new AssetUploadResourceService(
    new AssetUploadResourceRepository(db),
    media,
    ctx.get(AssetRepository),
    ctx.get(AccessRepository),
    ctx.get(StorageRepository),
    ctx.get(PhysicalFileRepository),
    ctx.getMock(LoggingRepository),
    {} as never,
    {} as never,
    {} as never,
    new CaptureRepository(db),
    repo,
  );
  const entry = {
    provider: 'fixture',
    creatorId: 'creator',
    postId: 'post',
    attachmentId: 'photo',
    pageUrl: 'https://example.org/post',
    title: 'Fixture',
    description: '',
    creator: 'Creator',
    publishedAt: '2026-11-20T18:04:11.000Z',
    kind: 'video' as const,
  };
  const operation = await db
    .insertInto('media_import')
    .values({ ownerId: user.id, albumId: album.id, urls: [entry.pageUrl], state: 'queued' })
    .returningAll()
    .executeTakeFirstOrThrow();
  const item = await db
    .insertInto('media_import_item')
    .values({ ownerId: user.id, importId: operation.id, entry, sourceKey: mediaSourceKey(entry) })
    .returningAll()
    .executeTakeFirstOrThrow();
  const jobId = randomUUID(),
    jobToken = randomUUID();
  await db
    .insertInto('job_queue')
    .values({ name: 'media-fixture', concurrency: 2 })
    .onConflict((oc) => oc.doNothing())
    .execute();
  await sql`insert into job (id, queue, name, data, state, token, "safeToRetry", "deadlineMs", "leaseExpiresAt")
    values (${jobId}::uuid,'media-fixture','media-import',${JSON.stringify({ id: operation.id })}::jsonb,'active',${jobToken}::uuid,true,3600000,now()+interval '1 hour')`.execute(
    db,
  );
  const authority: MediaImportAuthority = {
    ownerId: user.id,
    importId: operation.id,
    itemId: item.id,
    generation: 1,
    subscriptionGeneration: null,
    jobId,
    jobToken,
  };
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1EAAAAASUVORK5CYII=',
    'base64',
  );
  const path = join(directory, 'fixture.mp4');
  await writeFile(path, bytes);
  const file = {
    path,
    filename: 'Look at this 😮 https___t.co_AbC123.mp4',
    mimeType: 'video/mp4',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    entry,
  };
  // Other unfinished uploads (a phone backing up, earlier downloads that failed) never stop a new one: no cap.
  for (let index = 0; index < 6; index++) {
    await new AssetUploadResourceRepository(db).create(randomUUID(), user.id, {
      metadata: { filename: `phone-${index}.jpg`, deviceAssetId: String(index), deviceId: 'phone' } as never,
      checksum: createHash('sha256').update(String(index)).digest(),
      contentType: 'image/jpeg',
      size: 10,
    });
  }
  const context = {
    claim: { id: jobId, token: jobToken, queue: 'media-fixture', name: 'media-import', data: { id: operation.id } },
    signal: new AbortController().signal,
    progress: () => {},
    progressUnits: 0,
    adoptions: [],
    followups: [],
    buffering: false,
  };
  const assetId = await queueExecution.run(context as never, () =>
    imports.importMedia(authority, file, item.createdAt),
  );
  const queued = await sql<{ name: string }>`select name from job where data->>'id' = ${assetId}`.execute(db);
  expect(queued.rows.map(({ name }) => name)).toEqual([JobName.AssetExtractMetadata]);
  const upload = await db
    .selectFrom('asset_upload_resource')
    .select('ingested')
    .where('resultAssetId', '=', assetId)
    .executeTakeFirstOrThrow();
  expect(upload.ingested).toBe(true);
});
