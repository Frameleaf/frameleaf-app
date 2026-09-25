import { Kysely } from 'kysely';
import { StudioPreviewQuality } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StudioPreviewRepository } from 'src/repositories/studio-preview.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: defaultDatabase, real: [], mock: [LoggingRepository] });
  return { ctx, sut: new StudioPreviewRepository(defaultDatabase) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

afterEach(async () => {
  await defaultDatabase.deleteFrom('studio_preview_frame').execute();
});

describe(StudioPreviewRepository.name, () => {
  const frame = (ownerId: string, projectId: string, cacheKey: string, expiresAt: Date | null = null) => ({
    ownerId,
    projectId,
    revisionDigest: 'digest-a',
    projectRevision: 1,
    grantToken: 'grant',
    grantSessionId: 'session',
    cacheKey,
    timeNumerator: '1001' as never,
    timeDenominator: '30000' as never,
    quality: StudioPreviewQuality.Draft,
    viewportWidth: 960,
    viewportHeight: 540,
    operationId: null,
    seekGeneration: '0' as never,
    framePath: null,
    contentType: null,
    sizeInBytes: null,
    frameChecksum: null,
    framePts: null,
    framePtsTimebase: null,
    toneMapped: false,
    errorCode: null,
    readyAt: null,
    expiresAt,
  });

  it('lists the live frames of projects, optionally for one account (FL-90)', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: reviewer } = await ctx.newUser();
    const { frame: mine } = await sut.upsert(frame(owner.id, 'project-1', 'k1'));
    const { frame: theirs } = await sut.upsert(frame(reviewer.id, 'project-1', 'k2'));
    const { frame: gone } = await sut.upsert(frame(owner.id, 'project-1', 'k3'));
    await sut.evict([gone.id]);
    await sut.upsert(frame(owner.id, 'project-2', 'k4'));

    const live = await sut.listLiveForProjects(['project-1']);
    expect(live.map((row) => row.id).toSorted()).toEqual([mine.id, theirs.id].toSorted());
    expect((await sut.listLiveForProjects(['project-1'], reviewer.id)).map((row) => row.id)).toEqual([theirs.id]);
    expect(await sut.listLiveForProjects([])).toEqual([]);
  });

  it('lists expired ready frames and old superseded or failed frames for the retention sweep (FL-96)', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    const { frame: expired } = await sut.upsert(frame(user.id, 'project-1', 'k1', past));
    const { frame: fresh } = await sut.upsert(frame(user.id, 'project-1', 'k2', future));
    const { frame: failed } = await sut.upsert(frame(user.id, 'project-1', 'k3'));
    for (const row of [expired, fresh]) {
      await sut.publish(row.id, 'digest-a', {
        framePath: `/frames/${row.id}.png`,
        contentType: 'image/png',
        sizeInBytes: 1,
        frameChecksum: null,
        framePts: null,
        framePtsTimebase: null,
        toneMapped: false,
        readyAt: new Date(),
        expiresAt: row.id === expired.id ? past : future,
      });
    }
    await sut.markFailed(failed.id, 'gpu_lost');

    const now = new Date();
    const retiredNow = await sut.listRetired(now, new Date(now.getTime() - 3_600_000), 100);
    expect(retiredNow.map((row) => row.id)).toEqual([expired.id]);

    const later = await sut.listRetired(now, new Date(now.getTime() + 1000), 100);
    expect(later.map((row) => row.id).toSorted()).toEqual([expired.id, failed.id].toSorted());
    expect(later.find((row) => row.id === fresh.id)).toBeUndefined();
  });
});
