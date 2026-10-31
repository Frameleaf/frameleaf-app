import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { IMMICH_SERVER_START } from 'src/constants.js';
import { MaintenanceHealthRepository, healthCheckEnv } from 'src/maintenance/maintenance-health.repository.js';

describe('healthCheckEnv (FL-294)', () => {
  it('starts the check server on its own loopback address under the FRAMELEAF_ names', () => {
    expect(healthCheckEnv({ DB_HOSTNAME: 'db' })).toEqual({
      DB_HOSTNAME: 'db',
      FRAMELEAF_HOST: '127.0.0.1',
      FRAMELEAF_PORT: '33001',
      FRAMELEAF_LOG_LEVEL: 'log',
    });
  });

  it('keeps the readiness marker observable without changing the quiet parent or retaining a conflicting alias', () => {
    const parent = { FRAMELEAF_LOG_LEVEL: 'warn', IMMICH_LOG_LEVEL: 'error', DB_HOSTNAME: 'db' };
    const env = healthCheckEnv(parent);

    expect(env.FRAMELEAF_LOG_LEVEL).toBe('log');
    expect(env).not.toHaveProperty('IMMICH_LOG_LEVEL');
    expect(env.DB_HOSTNAME).toBe('db');
    expect(parent).toEqual({ FRAMELEAF_LOG_LEVEL: 'warn', IMMICH_LOG_LEVEL: 'error', DB_HOSTNAME: 'db' });
  });

  it('drops the deprecated IMMICH_ names, which would otherwise conflict with the check address', () => {
    const env = healthCheckEnv({ IMMICH_HOST: '0.0.0.0', IMMICH_PORT: '2283', FRAMELEAF_PORT: '2283' });

    expect(env).not.toHaveProperty('IMMICH_HOST');
    expect(env).not.toHaveProperty('IMMICH_PORT');
    expect(env).toMatchObject({ FRAMELEAF_HOST: '127.0.0.1', FRAMELEAF_PORT: '33001' });
  });
});

vi.mock('node:child_process', () => ({ fork: vi.fn() }));

describe('maintenance API health lifecycle', () => {
  let worker: ReturnType<typeof child>;
  const child = () =>
    Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      exitCode: null as number | null,
      kill: vi.fn(),
    });
  const start = () => new MaintenanceHealthRepository().checkApiHealth();

  beforeEach(() => {
    vi.useFakeTimers();
    worker = child();
    vi.mocked(fork).mockReturnValue(worker as unknown as ChildProcess);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('accepts split readiness and releases the deadline immediately', async () => {
    const checking = start();
    worker.stdout.emit('data', Buffer.from(IMMICH_SERVER_START.slice(0, 3)));
    worker.stdout.emit('data', Buffer.from(IMMICH_SERVER_START.slice(3)));
    await expect(checking).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(worker.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    worker.stdout.emit('data', Buffer.from(IMMICH_SERVER_START));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(worker.kill).toHaveBeenCalledTimes(1);
  });

  it.each(['exit', 'error'])('releases the deadline when the child reports %s', async (event) => {
    const checking = start();
    const rejected = expect(checking).rejects.toThrow('Server health check failed');
    worker.emit(event, event === 'exit' ? 1 : new Error('Spawn failed'));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(worker.kill).not.toHaveBeenCalled();
  });

  it('times out and stops the child once when readiness never arrives', async () => {
    const checking = start();
    const rejected = expect(checking).rejects.toThrow('took too long to start');
    await vi.advanceTimersByTimeAsync(180_000);
    await rejected;
    expect(worker.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(vi.getTimerCount()).toBe(0);
    worker.stdout.emit('data', Buffer.from(IMMICH_SERVER_START));
    expect(worker.kill).toHaveBeenCalledTimes(1);
  });

  it('does not rescan all previous stdout while waiting for the readiness marker', async () => {
    const nativeIncludes = String.prototype.includes;
    let longest = 0;
    vi.spyOn(String.prototype, 'includes').mockImplementation(function (this: string, search, position) {
      if (search === IMMICH_SERVER_START) longest = Math.max(longest, this.length);
      return nativeIncludes.call(this, search, position);
    });
    const checking = start();
    const noise = Buffer.alloc(4096, 'x');
    for (let index = 0; index < 32; index++) worker.stdout.emit('data', noise);
    for (const character of IMMICH_SERVER_START) worker.stdout.emit('data', Buffer.from(character));
    await checking;
    expect(longest).toBeLessThanOrEqual(noise.length + IMMICH_SERVER_START.length);
  });
});
