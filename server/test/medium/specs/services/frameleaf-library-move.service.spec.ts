import { Kysely } from 'kysely';
import { QueueName, SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { FrameleafLibraryMoveService } from 'src/services/frameleaf-library-move.service.js';
import { libraryMoveFence } from 'src/utils/frameleaf-library-move-fence.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;

/** One API process: the real queue store and system metadata, with the job repository's SQL paths. */
const setup = () => {
  const { sut, ctx } = newMediumService(FrameleafLibraryMoveService, {
    database: db,
    real: [SystemMetadataRepository],
    mock: [JobRepository, LoggingRepository, ConfigRepository],
  });
  const jobs = new JobRepository({} as never, {} as never, {} as never, ctx.getMock(LoggingRepository), db);
  const mock = ctx.getMock(JobRepository);
  mock.isPaused.mockImplementation((name) => jobs.isPaused(name));
  mock.pause.mockImplementation((name) => jobs.pause(name));
  mock.resume.mockImplementation((name) => jobs.resume(name));
  mock.getJobCounts.mockImplementation((name) => jobs.getJobCounts(name));
  ctx.getMock(ConfigRepository).getWorker.mockReturnValue('api' as never);
  return { sut, jobs };
};

beforeAll(async () => {
  db = await getKyselyDB();
});

afterEach(() => libraryMoveFence.lower());

describe(`${FrameleafLibraryMoveService.name} (FL-360 library move pause)`, () => {
  it('pauses queues durably, survives a restart and resumes only what it paused', async () => {
    const first = setup();
    await first.jobs.resume(QueueName.SmartSearch);
    await first.jobs.pause(QueueName.Ocr); // an administrator's own pause

    await expect(first.sut.pause('op-medium')).resolves.toMatchObject({ paused: true, drained: true });
    for (const name of Object.values(QueueName)) {
      await expect(first.jobs.isPaused(name)).resolves.toBe(true);
    }
    first.sut.onShutdown();

    // A new process on the same database: the stored pause raises the fence again.
    libraryMoveFence.lower();
    const second = setup();
    await second.sut.onBootstrap();
    expect(libraryMoveFence.active).toBe(true);
    await expect(second.sut.status()).resolves.toMatchObject({ paused: true, operationId: 'op-medium' });
    expect(libraryMoveFence.admit('POST', '/api/assets')).toBe(false);

    await expect(second.sut.resume('op-medium')).resolves.toMatchObject({ paused: false });
    await expect(second.jobs.isPaused(QueueName.SmartSearch)).resolves.toBe(false);
    await expect(second.jobs.isPaused(QueueName.Ocr)).resolves.toBe(true);
    const metadata = new SystemMetadataRepository(db as never);
    await expect(metadata.get(SystemMetadataKey.FrameleafLibraryMovePause)).resolves.toBeNull();
    second.sut.onShutdown();
    await second.jobs.resume(QueueName.Ocr);
  });
});
