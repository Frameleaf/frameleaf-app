import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { newConfigRepositoryMock } from 'test/repositories/config.repository.mock.js';

const fixture = vi.hoisted(() => ({ query: vi.fn(), close: vi.fn(), create: vi.fn() }));
vi.mock('src/utils/shared-service-pool.js', () => ({
  createSharedServicePool: fixture.create,
  closeSharedServicePool: fixture.close,
  trackPoolClients: () => new Set(),
}));

describe(RateLimitRepository.name, () => {
  let sut: RateLimitRepository;
  beforeEach(() => {
    vi.resetAllMocks();
    fixture.create.mockReturnValue({ query: fixture.query });
    fixture.query.mockResolvedValue({ rows: [], rowCount: 0 });
    sut = new RateLimitRepository(newConfigRepositoryMock() as never);
  });
  afterEach(async () => sut.onModuleDestroy());

  it('uses a single bounded pool for the lifetime of the repository', async () => {
    sut.onModuleInit();
    fixture.query.mockResolvedValue({ rows: [{ count: 3, resetSeconds: 42 }] });
    await expect(sut.hit('key', 600)).resolves.toEqual({ count: 3, resetSeconds: 42 });
    await sut.isUploadStreamCurrent('resource', 'token');
    expect(fixture.create).toHaveBeenCalledOnce();
    expect(fixture.create).toHaveBeenCalledWith(expect.anything(), 'admission');
  });

  it('passes opaque keys and tokens as parameters and preserves the fifteen-minute upload lease', async () => {
    fixture.query.mockResolvedValueOnce({ rowCount: 1 });
    await expect(sut.claimUploadStream('resource', 'token')).resolves.toBe(true);
    expect(fixture.query).toHaveBeenCalledWith(expect.stringContaining("interval '900 seconds'"), [
      'resource',
      'token',
    ]);
    fixture.query.mockResolvedValue({ rowCount: 0 });
    await expect(sut.claimUploadStream('resource', 'replacement')).resolves.toBe(false);
    await expect(sut.isUploadStreamCurrent('resource', 'replacement')).resolves.toBe(false);
    await sut.releaseUploadStream('resource', 'old-token');
    expect(fixture.query).toHaveBeenLastCalledWith(expect.stringContaining('key = $1 AND token = $2'), [
      'resource',
      'old-token',
    ]);
  });

  it('does not hide failed admission queries', async () => {
    fixture.query.mockRejectedValueOnce(new Error('query timeout'));
    await expect(sut.hit('key', 60)).rejects.toThrow('query timeout');
    fixture.query.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(sut.claimUploadStream('resource', 'token')).rejects.toThrow('database unavailable');
  });

  it('rejects invalid window lengths before issuing SQL', async () => {
    for (const seconds of [0, -1, 1.5, NaN]) {
      await expect(sut.hit('key', seconds)).rejects.toThrow('positive integer');
    }
    expect(fixture.query).not.toHaveBeenCalled();
  });

  it('bounds cleanup to one pass per minute and closes the pool', async () => {
    fixture.query.mockResolvedValue({ rows: [{ count: 1, resetSeconds: 60 }], rowCount: 1 });
    await sut.hit('key', 60);
    await sut.hit('key', 60);
    await sut.onModuleDestroy();
    const cleanup = fixture.query.mock.calls.filter(([query]) => query.includes('LIMIT 256'));
    expect(cleanup).toHaveLength(2);
    expect(fixture.close).toHaveBeenCalledOnce();
  });
});
