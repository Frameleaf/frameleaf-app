import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetStatus, LibraryScope } from 'src/enum.js';
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

it('recovers a committed media publication exactly once with one quota debit and physical file', async () => {
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
  ctx.getMock(JobRepository).queue.mockResolvedValue(undefined);
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
    publishedAt: null,
    kind: 'image' as const,
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
  const path = join(directory, 'fixture.png');
  await writeFile(path, bytes);
  const file = {
    path,
    filename: 'fixture.png',
    mimeType: 'image/png',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    entry,
  };
  const finish = vi.spyOn(media, 'finishUploadAsset');
  finish.mockRejectedValueOnce(new Error('process stopped after receipt commit'));
  await expect(imports.importMedia(authority, file, item.createdAt)).rejects.toThrow('process stopped');
  const published = (await repo.items(operation.id))[0];
  expect(published.state).toBe('saved');
  const usage = await db
    .selectFrom('user')
    .select('quotaUsageInBytes')
    .where('id', '=', user.id)
    .executeTakeFirstOrThrow();
  expect(usage.quotaUsageInBytes).toBe(bytes.length);
  // A stopped ingestion claim expires independently of the already committed publication receipt.
  await db
    .updateTable('asset_upload_resource')
    .set({ ingestionLeaseExpiresAt: new Date(0) })
    .where('id', '=', published.uploadId!)
    .execute();
  finish.mockRestore();
  expect(await imports.importMedia(authority, file, item.createdAt)).toBe(published.assetId);
  const final = await db
    .selectFrom('user')
    .select('quotaUsageInBytes')
    .where('id', '=', user.id)
    .executeTakeFirstOrThrow();
  expect(final.quotaUsageInBytes).toBe(bytes.length);
  const asset = await db.selectFrom('asset').selectAll().where('id', '=', published.assetId!).executeTakeFirstOrThrow();
  expect(await readFile(asset.originalPath)).toEqual(bytes);
  expect(asset.physicalOriginalFileId).not.toBeNull();
  expect(await db.selectFrom('asset_source').selectAll().where('assetId', '=', asset.id).execute()).toHaveLength(1);
  expect(await db.selectFrom('album_asset').selectAll().where('assetId', '=', asset.id).execute()).toHaveLength(1);
  await db
    .updateTable('asset')
    .set({ deletedAt: new Date(), status: AssetStatus.Trashed })
    .where('id', '=', asset.id)
    .execute();
  const manual = await db
    .insertInto('media_import')
    .values({ ownerId: user.id, albumId: album.id, urls: [entry.pageUrl], state: 'queued', overrideSuppression: true })
    .returningAll()
    .executeTakeFirstOrThrow();
  const manualItem = await db
    .insertInto('media_import_item')
    .values({ ownerId: user.id, importId: manual.id, sourceKey: mediaSourceKey(entry), entry })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .updateTable('job')
    .set({ data: { id: manual.id } })
    .where('id', '=', jobId)
    .execute();
  const manualAuthority = { ...authority, importId: manual.id, itemId: manualItem.id };
  expect(await imports.importMedia(manualAuthority, file, manualItem.createdAt)).toBe(asset.id);
  expect(
    await db.selectFrom('asset').select(['deletedAt', 'status']).where('id', '=', asset.id).executeTakeFirstOrThrow(),
  ).toEqual({ deletedAt: null, status: AssetStatus.Active });
  expect(
    (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', user.id).executeTakeFirstOrThrow())
      .quotaUsageInBytes,
  ).toBe(bytes.length);
  expect(await db.selectFrom('asset').select('id').where('ownerId', '=', user.id).execute()).toHaveLength(1);
  expect(
    await db.selectFrom('asset_local_effect').select('effectId').where('ownerId', '=', user.id).execute(),
  ).toHaveLength(1);
});
