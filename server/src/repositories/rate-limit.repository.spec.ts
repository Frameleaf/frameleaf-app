import { RELEASE_SCRIPT, RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { newConfigRepositoryMock } from 'test/repositories/config.repository.mock.js';

const redis = vi.hoisted(() => {
  const exec = vi.fn();
  const multi = { incr: vi.fn(), ttl: vi.fn(), exec };
  multi.incr.mockReturnValue(multi);
  multi.ttl.mockReturnValue(multi);
  return {
    multi,
    exec,
    created: vi.fn(),
    client: {
      status: 'ready',
      multi: vi.fn(() => multi),
      expire: vi.fn(),
      eval: vi.fn(),
      on: vi.fn(),
      quit: vi.fn(),
      disconnect: vi.fn(),
    },
  };
});

vi.mock('ioredis', () => ({
  Redis: vi.fn(function (options: unknown) {
    redis.created(options);
    return redis.client;
  }),
}));

describe(RateLimitRepository.name, () => {
  let sut: RateLimitRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    redis.multi.incr.mockReturnValue(redis.multi);
    redis.multi.ttl.mockReturnValue(redis.multi);
    redis.client.multi.mockReturnValue(redis.multi);
    redis.client.quit.mockResolvedValue('OK');
    sut = new RateLimitRepository(newConfigRepositoryMock() as never);
  });

  it('connects when the API starts, with commands that fail at once instead of queueing', async () => {
    expect(redis.created).not.toHaveBeenCalled();
    sut.onModuleInit();
    expect(redis.created).toHaveBeenCalledTimes(1);
    expect(redis.created).toHaveBeenCalledWith(
      expect.objectContaining({ enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 2000 }),
    );
    expect(redis.client.on).toHaveBeenCalledWith('error', expect.any(Function));

    redis.exec.mockResolvedValue([
      [null, 3],
      [null, 42],
    ]);
    await sut.hit('frameleaf:rate-limit:login:ip:198.51.100.7', 600);
    expect(redis.created).toHaveBeenCalledTimes(1);
  });

  it('gives an attempt back with one atomic script that never recreates or leaves a spent counter', async () => {
    redis.client.eval.mockResolvedValueOnce(3);
    await sut.release('key');
    expect(redis.client.eval).toHaveBeenCalledWith(RELEASE_SCRIPT, 1, 'key');
    expect(RELEASE_SCRIPT).toContain(`redis.call('EXISTS', KEYS[1]) == 0`);
    expect(RELEASE_SCRIPT).toContain(`redis.call('DECR', KEYS[1])`);
    expect(RELEASE_SCRIPT).toContain(`redis.call('DEL', KEYS[1])`);
  });

  it('counts with INCR and reports the time left in the window', async () => {
    redis.exec.mockResolvedValue([
      [null, 3],
      [null, 42],
    ]);

    await expect(sut.hit('key', 600)).resolves.toEqual({ count: 3, resetSeconds: 42 });
    expect(redis.multi.incr).toHaveBeenCalledWith('key');
    expect(redis.multi.ttl).toHaveBeenCalledWith('key');
    expect(redis.client.expire).not.toHaveBeenCalled();
  });

  it('starts the window with EXPIRE on a counter that has none', async () => {
    redis.exec.mockResolvedValue([
      [null, 1],
      [null, -1],
    ]);

    await expect(sut.hit('key', 600)).resolves.toEqual({ count: 1, resetSeconds: 600 });
    expect(redis.client.expire).toHaveBeenCalledWith('key', 600);
  });

  it('never reports less than a second left', async () => {
    redis.exec.mockResolvedValue([
      [null, 9],
      [null, 0],
    ]);

    await expect(sut.hit('key', 60)).resolves.toEqual({ count: 9, resetSeconds: 1 });
  });

  it('fails when Redis refuses a command or discards the transaction', async () => {
    redis.exec.mockResolvedValueOnce([
      [new Error('READONLY'), null],
      [null, 10],
    ]);
    await expect(sut.hit('key', 60)).rejects.toThrow('READONLY');

    redis.exec.mockResolvedValueOnce(null);
    await expect(sut.hit('key', 60)).rejects.toThrow('discarded');

    redis.exec.mockRejectedValueOnce(new Error('Connection is closed.'));
    await expect(sut.hit('key', 60)).rejects.toThrow('Connection is closed.');
  });

  it('closes its connection on shutdown', async () => {
    redis.exec.mockResolvedValue([
      [null, 1],
      [null, 5],
    ]);
    await sut.hit('key', 60);

    await sut.onModuleDestroy();

    expect(redis.client.quit).toHaveBeenCalledTimes(1);
  });
});
