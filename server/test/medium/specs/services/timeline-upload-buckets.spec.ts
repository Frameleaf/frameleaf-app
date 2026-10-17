import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import { Stats } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { TimelineController } from 'src/controllers/timeline.controller.js';
import { AssetVisibility, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { ApiKeyRepository } from 'src/repositories/api-key.repository.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AuthService } from 'src/services/auth.service.js';
import { MetadataService } from 'src/services/metadata.service.js';
import { TimelineService } from 'src/services/timeline.service.js';
import { mediumFactory, newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { controllerSetup, getKyselyDB, newRandomImage } from 'test/utils.js';

let db: Kysely<DB>;

beforeAll(async () => {
  db = await getKyselyDB();
});

/**
 * FL-432: the Android pre-launch review uploaded the e2e nature album with POST /assets (fileCreatedAt
 * in the upload month), let metadata extraction move each photo to its capture date, and then read
 * GET /timeline/buckets?visibility=timeline with an admin API key. Every photo must count in the bucket
 * of its capture month, the pre-2009 ones included, and the buckets must add up to the whole timeline.
 */
describe('timeline buckets after upload and metadata extraction (FL-432)', () => {
  it('counts each uploaded photo in the month extraction gave it, read with an API key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fl432-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));

    const upload = newMediumService(AssetMediaService, {
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
      ],
      mock: [EventRepository, LoggingRepository, JobRepository, StorageRepository, MetadataRepository],
    });
    upload.ctx.getMock(StorageRepository).utimes.mockResolvedValue();
    upload.ctx.getMock(EventRepository).emit.mockResolvedValue();
    upload.ctx.getMock(JobRepository).queue.mockResolvedValue();

    const extraction = newMediumService(MetadataService, {
      database: db,
      real: [
        AssetRepository,
        AssetJobRepository,
        ConfigRepository,
        MetadataRepository,
        SystemMetadataRepository,
        TagRepository,
      ],
      mock: [EventRepository, StorageRepository, LoggingRepository, MapRepository],
    });
    extraction.ctx.getMock(EventRepository).emit.mockResolvedValue();
    extraction.ctx.getMock(StorageRepository).stat.mockResolvedValue({
      size: 123_456,
      mtime: new Date('2026-05-18T14:59:11Z'),
      mtimeMs: Date.parse('2026-05-18T14:59:11Z'),
      birthtimeMs: Date.parse('2026-05-18T14:59:11Z'),
    } as Stats);

    const { user } = await upload.ctx.newUser({ isAdmin: true });
    const auth = factory.auth({ user: { id: user.id, isAdmin: true } });

    // The capture dates of the nature album's cyclamen_persicum.jpg (+09:00, a year-later CreateDate),
    // notocactus_minimus.jpg (no offset) and el_torcal_rocks.jpg (a later, unzoned capture).
    const files = [
      {
        name: 'cyclamen_persicum.jpg',
        fileCreatedAt: '2026-10-15T12:00:00Z',
        tags: { DateTimeOriginal: '2007:12:06 14:33:18+09:00', CreateDate: '2008:12:14 23:50:20+09:00' },
      },
      {
        name: 'notocactus_minimus.jpg',
        fileCreatedAt: '2026-10-13T12:00:00Z',
        tags: { DateTimeOriginal: '2008:05:23 15:54:59', CreateDate: '2008:05:23 15:54:59' },
      },
      {
        name: 'el_torcal_rocks.jpg',
        fileCreatedAt: '2026-10-15T12:00:00Z',
        tags: { DateTimeOriginal: '2012:08:05 11:39:59', CreateDate: '2012:08:05 11:39:59' },
      },
    ];
    for (const { name, fileCreatedAt, tags } of files) {
      // the synthetic image is a PNG; the upload keeps the album's file name
      const originalPath = join(directory, name.replace(/\.jpg$/, '.png'));
      await writeFile(originalPath, newRandomImage());
      await extraction.ctx.get(MetadataRepository).writeTags(originalPath, tags);
      const { id } = await upload.sut.uploadAsset(
        auth,
        { fileCreatedAt: new Date(fileCreatedAt), fileModifiedAt: new Date(fileCreatedAt), assetData: Buffer.from('') },
        mediumFactory.uploadFile({ originalPath, originalName: name, checksum: randomBytes(20) }),
      );
      await extraction.sut.handleMetadataExtraction({ id });
    }

    const apiKey = randomBytes(24).toString('hex');
    await new ApiKeyRepository(db).create({
      name: 'fl432',
      userId: user.id,
      key: extraction.ctx.get(CryptoRepository).hashSha256(apiKey),
      permissions: [Permission.All],
    });
    const authentication = newMediumService(AuthService, {
      database: db,
      real: [
        ConfigRepository,
        CryptoRepository,
        SessionRepository,
        UserRepository,
        ApiKeyRepository,
        SharedLinkRepository,
      ],
      mock: [LoggingRepository],
    });
    const timeline = newMediumService(TimelineService, {
      database: db,
      real: [AssetRepository, AccessRepository, PartnerRepository],
      mock: [LoggingRepository],
    });
    const http = await controllerSetup(TimelineController, [
      { provide: TimelineService, useValue: timeline.sut },
      { provide: AuthService, useValue: authentication.sut },
    ]);
    onTestFinished(() => http.close());

    const { body } = await request(http.getHttpServer())
      .get('/timeline/buckets?visibility=timeline')
      .set('x-api-key', apiKey)
      .expect(200);

    const onTimeline = await db
      .selectFrom('asset')
      .select('id')
      .where('ownerId', '=', user.id)
      .where('visibility', '=', AssetVisibility.Timeline)
      .where('deletedAt', 'is', null)
      .execute();
    expect(body.reduce((sum: number, bucket: { count: number }) => sum + bucket.count, 0)).toBe(onTimeline.length);
    expect(body).toEqual([
      { timeBucket: '2012-08-01', count: 1 },
      { timeBucket: '2008-05-01', count: 1 },
      { timeBucket: '2007-12-01', count: 1 },
    ]);
  }, 60_000);
});
