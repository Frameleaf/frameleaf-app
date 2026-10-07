import { ICloudWeeklyService } from 'src/services/icloud-weekly.service.js';

describe(ICloudWeeklyService.name, () => {
  const weekly = { scheduleCandidates: vi.fn(), freezeCohort: vi.fn(), createNextBatch: vi.fn() };
  const operations = {};
  const logger = { setContext: vi.fn(), warn: vi.fn() };
  let sut: ICloudWeeklyService;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION', 'true');
    vi.stubEnv('FRAMELEAF_ICLOUD_BRIDGE_URL', 'https://fixture.invalid');
    weekly.scheduleCandidates.mockResolvedValue([]);
    weekly.freezeCohort.mockResolvedValue({ id: 'current-week' });
    weekly.createNextBatch.mockResolvedValue(null);
    sut = new ICloudWeeklyService(weekly as never, operations as never, logger as never);
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['', 'false'])('does no discovery or production while execution is %j', async (flag) => {
    vi.stubEnv('FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION', flag);
    await sut.schedule();
    expect(weekly.scheduleCandidates).not.toHaveBeenCalled();
    expect(weekly.freezeCohort).not.toHaveBeenCalled();
    expect(weekly.createNextBatch).not.toHaveBeenCalled();
  });

  it('requires a configured bridge before discovering work', async () => {
    vi.stubEnv('FRAMELEAF_ICLOUD_BRIDGE_URL', '');
    vi.stubEnv('IMMICH_ICLOUD_BRIDGE_URL', '');
    await sut.schedule();
    expect(weekly.scheduleCandidates).not.toHaveBeenCalled();
  });

  it('resumes the exact old cohort and requires current authority to freeze a new week', async () => {
    weekly.scheduleCandidates.mockResolvedValue([
      { ownerId: 'owner', connectionId: 'connection', cohortId: 'old-week' },
      { ownerId: 'other-owner', connectionId: 'other-connection', cohortId: null },
    ]);
    await sut.schedule();
    expect(weekly.freezeCohort).toHaveBeenCalledExactlyOnceWith('other-owner', 'other-connection', true);
    expect(weekly.createNextBatch.mock.calls).toEqual([
      ['old-week', operations],
      ['current-week', operations],
    ]);
  });

  it('shares one pass across overlapping ticks and allows the next pass after completion', async () => {
    const pending = Promise.withResolvers<[]>();
    weekly.scheduleCandidates.mockReturnValueOnce(pending.promise);
    const first = sut.schedule();
    const second = sut.schedule();
    expect(second).toBe(first);
    expect(weekly.scheduleCandidates).toHaveBeenCalledTimes(1);
    pending.resolve([]);
    await first;
    await sut.schedule();
    expect(weekly.scheduleCandidates).toHaveBeenCalledTimes(2);
  });

  it('continues other connections after a failure without logging the error payload', async () => {
    weekly.scheduleCandidates.mockResolvedValue([
      { ownerId: 'owner', connectionId: 'connection', cohortId: 'old-week' },
      { ownerId: 'other-owner', connectionId: 'other-connection', cohortId: 'other-week' },
    ]);
    weekly.createNextBatch.mockRejectedValueOnce(new Error('fixture-private-provider-payload'));
    await sut.schedule();
    expect(weekly.createNextBatch).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith('iCloud weekly production failed');
  });

  it('stops admitting further connections when activation is withdrawn during a pass', async () => {
    weekly.scheduleCandidates.mockResolvedValue([
      { ownerId: 'owner', connectionId: 'connection', cohortId: 'old-week' },
      { ownerId: 'other-owner', connectionId: 'other-connection', cohortId: 'other-week' },
    ]);
    weekly.createNextBatch.mockImplementationOnce(() => {
      vi.stubEnv('FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION', 'false');
      return Promise.resolve(null);
    });
    await sut.schedule();
    expect(weekly.createNextBatch).toHaveBeenCalledExactlyOnceWith('old-week', operations);
  });
});
