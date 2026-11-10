import { BadRequestException, NotFoundException } from '@nestjs/common';
import { JobRunPageDto, JobRunSearchDto } from 'src/dtos/job-run.dto.js';
import { RunItemRead, RunRead } from 'src/queue/run-query.js';
import { JobService } from 'src/services/job.service.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const counts = {
  total: 1,
  completed: 0,
  failed: 0,
  needsAttention: 0,
  cancelled: 0,
  active: 1,
  retrying: 0,
  delayed: 0,
  paused: 0,
  waiting: 0,
  blocked: 0,
};
const run: RunRead = {
  ...counts,
  id: '0195e2a0-0000-7000-8000-000000000001',
  kind: 'thumbnailGeneration',
  createdAt: new Date('2026-10-04T10:00:00.000Z'),
  finishedAt: null,
  enumerationDone: true,
  stageTotals: { ...counts, total: 3, active: 2, failed: 1 },
  state: 'running',
  lastProgressAt: new Date('2026-10-04T10:01:00.000Z'),
  lastStage: 'AssetThumbnailGeneration',
  reasons: ['stage_failed'],
  noDispatchBacklog: false,
  held: 0,
  canRelease: false,
  countsPhotos: true,
  failedQueues: ['thumbnailGeneration'],
  nightly: false,
  pausedQueues: [],
};
describe('durable run read service', () => {
  let sut: JobService;
  let mocks: ServiceMocks;
  beforeEach(() => {
    ({ sut, mocks } = newTestService(JobService));
  });
  it('paginates with a lookahead and withholds repository payloads from the summary', async () => {
    mocks.job.listRuns.mockResolvedValue([
      { ...run, selection: { assetIds: ['private-id'] }, error: 'private-name' },
      run,
    ] as never);
    const page = await sut.getRuns(JobRunSearchDto.schema.parse({ take: 1, skip: 25 }));
    expect(mocks.job.listRuns).toHaveBeenCalledWith(2, 25, false);
    expect(page).toMatchObject({
      hasNextPage: true,
      items: [{ total: 1, active: 1, failed: 0, stageTotals: { failed: 1 }, state: 'running' }],
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].lastProgressAt).toBe('2026-10-04T10:01:00.000Z');
    expect(JSON.stringify(page)).not.toMatch(/private-id|private-name|selection|error/);
  });
  it('returns only opaque operational IDs and safe progress from the inspector', async () => {
    const item: RunItemRead = {
      id: 'opaque-operational-id',
      outcome: 'active',
      stageTotals: run.stageTotals,
      lastProgressAt: run.lastProgressAt,
      lastStage: run.lastStage,
      reasons: ['stage_failed'],
    };
    mocks.job.listRunItems.mockResolvedValue([
      { ...item, itemKey: 'face-id', rootItemKey: 'media-id', selection: { filename: 'private-name' } },
    ] as never);
    const page = await sut.getRunItems(run.id, JobRunSearchDto.schema.parse({}));
    expect(mocks.job.listRunItems).toHaveBeenCalledWith(run.id, 26, 0);
    expect(page).toMatchObject({ hasNextPage: false, items: [{ id: 'opaque-operational-id', outcome: 'active' }] });
    expect(JSON.stringify(page)).not.toMatch(/face-id|media-id|private-name|itemKey|rootItemKey|selection/);
  });
  it('distinguishes a missing run from an empty item page', async () => {
    mocks.job.listRunItems.mockResolvedValue(undefined);
    await expect(sut.getRunItems(run.id, JobRunSearchDto.schema.parse({}))).rejects.toThrow('Job run not found');
    mocks.job.listRunItems.mockResolvedValue([]);
    await expect(sut.getRunItems(run.id, JobRunSearchDto.schema.parse({}))).resolves.toEqual({
      items: [],
      hasNextPage: false,
    });
  });
  it('maps the additive release, photo and failed-queue fields', async () => {
    mocks.job.listRuns.mockResolvedValue([{ ...run, held: 4, canRelease: true, countsPhotos: false }]);
    const page = await sut.getRuns(JobRunSearchDto.schema.parse({}));
    expect(page.items[0]).toMatchObject({
      held: 4,
      canRelease: true,
      countsPhotos: false,
      failedQueues: ['thumbnailGeneration'],
    });
  });
  it('getRuns passes foldNightly and maps the new fields', async () => {
    mocks.job.listRuns.mockResolvedValue([
      {
        ...run,
        nightly: true,
        pausedQueues: ['faceDetection'],
        unreachableLibraries: ['Holiday drive'],
        failureCauses: [{ cause: 'unsupported', count: 863 }],
        earlierRuns: [
          {
            id: '0195e2a0-0000-7000-8000-000000000002',
            createdAt: new Date('2026-10-03T02:00:00.000Z'),
            finishedAt: new Date('2026-10-03T04:00:00.000Z'),
            total: 900,
            leftOver: 863,
          },
        ],
        leftOverStreak: { photos: 863, nights: 2 },
      },
    ]);
    const page = await sut.getRuns(JobRunSearchDto.schema.parse({ foldNightly: 'true' }));
    expect(mocks.job.listRuns).toHaveBeenCalledWith(26, 0, true);
    expect(page.items[0]).toMatchObject({
      nightly: true,
      pausedQueues: ['faceDetection'],
      unreachableLibraries: ['Holiday drive'],
      failureCauses: [{ cause: 'unsupported', count: 863 }],
      earlierRuns: [
        {
          id: '0195e2a0-0000-7000-8000-000000000002',
          createdAt: '2026-10-03T02:00:00.000Z',
          finishedAt: '2026-10-03T04:00:00.000Z',
          total: 900,
          leftOver: 863,
        },
      ],
      leftOverStreak: { photos: 863, nights: 2 },
    });
    expect(JobRunPageDto.schema.parse(page)).toEqual(page);

    mocks.job.listRuns.mockResolvedValue([run]);
    const plain = await sut.getRuns(JobRunSearchDto.schema.parse({}));
    expect(mocks.job.listRuns).toHaveBeenLastCalledWith(26, 0, false);
    expect(plain.items[0]).not.toHaveProperty('earlierRuns');
    expect(plain.items[0]).not.toHaveProperty('leftOverStreak');
  });
  describe('left-over photos (FL-1349)', () => {
    const review = {
      photos: 2,
      countsPhotos: true,
      causes: [
        {
          cause: 'unsupported' as const,
          count: 2,
          stopped: 0,
          repaired: 0,
          libraries: [],
          queues: ['thumbnailGeneration'],
          message: 'unsupported image format',
          samples: [
            { assetId: '0195e2a0-0000-7000-8000-00000000000a', fileName: 'a.heic', ownerId: 'me', ownerName: 'Me' },
            { assetId: '0195e2a0-0000-7000-8000-00000000000b', fileName: 'b.heic', ownerId: 'them', ownerName: 'Them' },
          ],
        },
      ],
    };

    it('passes the reader’s privacy to the sample read', async () => {
      const auth = factory.auth({ user: { id: 'me', isAdmin: true }, session: { hasElevatedPermission: true } });
      mocks.job.reviewRunFailures.mockResolvedValue(review);
      const page = await sut.getRunFailures(auth, run.id);
      expect(mocks.job.reviewRunFailures).toHaveBeenCalledWith(run.id, {
        revealLockedOwnerId: 'me',
        lockedOwnerId: 'me',
        othersRulesViewerId: 'me',
      });
      expect(page.causes[0].samples).toEqual([
        { assetId: '0195e2a0-0000-7000-8000-00000000000a', fileName: 'a.heic', ownerName: 'Me', pictureAllowed: true },
        {
          assetId: '0195e2a0-0000-7000-8000-00000000000b',
          fileName: 'b.heic',
          ownerName: 'Them',
          pictureAllowed: false,
        },
      ]);
      expect(JSON.stringify(page)).not.toContain('ownerId');

      const hiding = factory.auth({ user: { id: 'me', isAdmin: true } });
      hiding.hideNsfwAssets = true;
      await sut.getRunFailures(hiding, run.id);
      expect(mocks.job.reviewRunFailures).toHaveBeenLastCalledWith(run.id, {
        excludeNsfw: true,
        othersRulesViewerId: 'me',
      });
    });

    it('404 for an unknown run', async () => {
      mocks.job.reviewRunFailures.mockResolvedValue(undefined);
      await expect(sut.getRunFailures(factory.auth(), run.id)).rejects.toBeInstanceOf(NotFoundException);
      mocks.job.retryRunFailures.mockResolvedValue(undefined);
      await expect(sut.actOnRunFailures(run.id, { cause: 'drive', action: 'retry' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses stop for damaged (400)', async () => {
      for (const body of [
        { cause: 'damaged', action: 'stop' },
        { cause: 'missing', action: 'retry' },
        { cause: 'unsupported', action: 'retry' },
        { cause: 'other', action: 'stop' },
      ] as const) {
        await expect(sut.actOnRunFailures(run.id, body)).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(mocks.job.stopRunFailures).not.toHaveBeenCalled();
      expect(mocks.job.retryRunFailures).not.toHaveBeenCalled();
    });

    it('tries a drive or other cause again, and stops trying an unsupported one', async () => {
      mocks.job.retryRunFailures.mockResolvedValue(3);
      await expect(sut.actOnRunFailures(run.id, { cause: 'drive', action: 'retry' })).resolves.toEqual({ count: 3 });
      expect(mocks.job.retryRunFailures).toHaveBeenCalledWith(run.id, 'drive');
      mocks.job.stopRunFailures.mockResolvedValue(863);
      await expect(sut.actOnRunFailures(run.id, { cause: 'unsupported', action: 'stop' })).resolves.toEqual({
        count: 863,
      });
      expect(mocks.job.stopRunFailures).toHaveBeenCalledWith(run.id, 'unsupported');
    });
  });
  it('releases a held run and refuses an import that is not activated yet', async () => {
    mocks.job.releaseRun.mockResolvedValueOnce('released');
    await expect(sut.releaseRun(run.id)).resolves.toBeUndefined();
    expect(mocks.job.releaseRun).toHaveBeenCalledWith(run.id);
    mocks.job.releaseRun.mockResolvedValueOnce('not_held');
    await expect(sut.releaseRun(run.id)).resolves.toBeUndefined();
    mocks.job.releaseRun.mockResolvedValueOnce('import_not_activated');
    await expect(sut.releaseRun(run.id)).rejects.toBeInstanceOf(BadRequestException);
    mocks.job.releaseRun.mockResolvedValueOnce('not_found');
    await expect(sut.releaseRun(run.id)).rejects.toBeInstanceOf(NotFoundException);
  });
  it.each([{ take: 0 }, { take: 101 }, { skip: -1 }, { take: 'all' }])('rejects invalid pagination %j', (page) => {
    expect(() => JobRunSearchDto.schema.parse(page)).toThrow();
  });
});
