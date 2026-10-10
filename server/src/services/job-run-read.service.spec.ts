import { JobRunSearchDto } from 'src/dtos/job-run.dto.js';
import { RunItemRead, RunRead } from 'src/queue/run-query.js';
import { JobService } from 'src/services/job.service.js';
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
    expect(mocks.job.listRuns).toHaveBeenCalledWith(2, 25);
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
  it.each([{ take: 0 }, { take: 101 }, { skip: -1 }, { take: 'all' }])('rejects invalid pagination %j', (page) => {
    expect(() => JobRunSearchDto.schema.parse(page)).toThrow();
  });
});
