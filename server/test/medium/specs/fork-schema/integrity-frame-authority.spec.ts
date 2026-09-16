import { Kysely, sql } from 'kysely';
import { IntegrityReport } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DuplicateRepository } from 'src/repositories/duplicate.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { IntegrityService } from 'src/services/integrity.service.js';
import { mediumFactory, newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

describe('integrity authoritative duplicate frames', () => {
  let db: Kysely<DB>;
  beforeAll(async () => {
    db = await getKyselyDB();
  });
  afterAll(async () => {
    await db.destroy();
  });

  it('protects active-sidecar frames during scanning, refresh, and single/batch stale-report deletion', async () => {
    const { sut, ctx } = newMediumService(IntegrityService, {
      database: db,
      real: [IntegrityRepository, AssetRepository, ConfigRepository, SystemMetadataRepository, ForkSchemaRepository],
      mock: [LoggingRepository, EventRepository, StorageRepository, JobRepository],
    });
    const owner = await mediumFactory.userWithClusterGroup(db);
    await db.insertInto('user').values(owner).execute();
    const asset = mediumFactory.assetInsert({ ownerId: owner.id });
    await db.insertInto('asset').values(asset).execute();
    await sql`UPDATE immich_fork.state SET phase = 'active', active = true WHERE id = 1`.execute(db);
    await new DuplicateRepository(db).replaceVideoDuplicateFrames(asset.id!, [
      {
        assetId: asset.id!,
        frameIndex: 0,
        timestampMs: 0,
        path: '/thumbs/live-frame.jpg',
        embedding: `[${Array.from({ length: 512 }, () => 0).join(',')}]`,
      },
    ]);
    // Official-origin databases have no legacy frame table at all.
    await sql`DROP TABLE public.asset_video_duplicate_frame`.execute(db);
    const repository = ctx.get(IntegrityRepository);
    await sut.handleUntrackedFiles({ type: 'asset_file', paths: ['/thumbs/live-frame.jpg'] });
    expect(await db.selectFrom('integrity_report').selectAll().execute()).toEqual([]);
    for (const mode of ['single', 'batch', 'refresh']) {
      const report = await repository.create({ type: IntegrityReport.UntrackedFile, path: '/thumbs/live-frame.jpg' });
      if (mode === 'single') {
        await sut.deleteIntegrityReport(owner.id, report.id);
      } else if (mode === 'batch') {
        await sut.handleDeleteIntegrityReports({ reports: [report] });
      } else {
        await sut.handleUntrackedRefresh({ items: [{ reportId: report.id, path: report.path }] });
      }
      expect(await db.selectFrom('integrity_report').selectAll().execute()).toEqual([]);
    }
    expect(ctx.getMock(StorageRepository).unlink).not.toHaveBeenCalled();
  });
});
