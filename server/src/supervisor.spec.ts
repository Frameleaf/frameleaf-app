import { generateKeyPair } from '@frameleaf/locked-crypto';
import { EventEmitter } from 'node:events';
import { ExitCode, FrameleafWorker } from 'src/enum.js';
import { API_STARTUP_RETRY_EXIT_CODE } from 'src/utils/shutdown.js';

const fixture = vi.hoisted(() => ({
  maintenance: false,
  starts: [] as string[],
  workers: [] as (EventEmitter & { name: string; stopped: Promise<void> })[],
  signals: new Map<string, () => void>(),
  nextStopped: undefined as Promise<void> | undefined,
  clients: [] as { destroy: ReturnType<typeof vi.fn> }[],
  lockAvailable: true,
  lockError: undefined as Error | undefined,
  unlockError: undefined as Error | undefined,
  lockAttempts: 0,
  failStart: undefined as string | undefined,
}));

// Import the real entry point; replace only OS processes, database and stop-proof transport.
// No worker thread, child process, credentials or PostgreSQL connection is created.
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    fork: (file: string) => {
      if (file.endsWith(`/${fixture.failStart}.js`)) throw new Error('worker construction failed');
      const worker = Object.assign(new EventEmitter(), {
        name: file.split('/').at(-1)!.replace('.js', ''),
        stopped: Promise.resolve(),
        kill: vi.fn(),
        connected: true,
        send: vi.fn((_message: string, callback: (error: Error | null) => void) => {
          callback(null);
          return true;
        }),
      });
      fixture.starts.push(worker.name);
      fixture.workers.push(worker);
      return worker;
    },
  };
});
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      name: string;
      stopped = fixture.nextStopped ?? Promise.resolve();
      terminate = vi.fn().mockResolvedValue(0);
      postMessage = vi.fn();
      constructor(file: string) {
        super();
        if (file.endsWith(`/${fixture.failStart}.js`)) throw new Error('worker construction failed');
        this.name = file.split('/').at(-1)!.replace('.js', '');
        fixture.nextStopped = undefined;
        fixture.starts.push(this.name);
        fixture.workers.push(this);
      }
    },
    parentPort: null,
  };
});
vi.mock('kysely', () => ({
  Kysely: class {
    constructor() {
      fixture.clients.push(this);
    }
    destroy = vi.fn().mockResolvedValue(undefined);
    connection = () => ({ execute: (action: (db: unknown) => Promise<unknown>) => action(this) });
  },
  sql: (strings: TemplateStringsArray) => ({
    execute: () => {
      if (strings.join('').includes('pg_advisory_unlock')) {
        return fixture.unlockError ? Promise.reject(fixture.unlockError) : Promise.resolve({ rows: [] });
      }
      fixture.lockAttempts++;
      return fixture.lockError
        ? Promise.reject(fixture.lockError)
        : Promise.resolve({ rows: [{ pg_try_advisory_lock: fixture.lockAvailable }] });
    },
  }),
}));
vi.mock('nest-commander', () => ({ CommandFactory: {} }));
vi.mock('src/repositories/config.repository.js', () => ({
  ConfigRepository: class {
    getEnv() {
      return {
        workers: ['api', 'microservices', 'edge'],
        database: { config: {} },
        shutdown: { deadlineMs: 9000 },
      };
    }
  },
  warnDeprecatedEnv: () => {},
}));
vi.mock('src/repositories/system-metadata.repository.js', () => ({
  SystemMetadataRepository: class {
    get() {
      return Promise.resolve({ isMaintenanceMode: fixture.maintenance });
    }
  },
}));
vi.mock('src/utils/database.js', () => ({ getKyselyConfig: () => ({}) }));
vi.mock('src/utils/buddy-backup-maintenance.js', () => ({ buddyMaintenanceState: () => Promise.resolve(false) }));
vi.mock('src/queue/worker-stop-proof.js', () => ({
  WorkerStopProofRecorder: class {
    record = vi.fn().mockResolvedValue(undefined);
    republish = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock('src/queue/supervisor.js', () => ({
  superviseQueueWorker: (worker: { stopped: Promise<void> }) => ({ stopped: worker.stopped }),
}));

const latest = (name: FrameleafWorker) => fixture.workers.findLast((worker) => worker.name === name)!;

describe('supervisor worker-local restart lifecycle', () => {
  let Workers: typeof import('src/supervisor.js').Workers;
  const argv = process.argv;
  const title = process.title;
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    fixture.maintenance = false;
    fixture.starts = [];
    fixture.workers = [];
    fixture.signals.clear();
    fixture.nextStopped = undefined;
    fixture.clients = [];
    fixture.lockAvailable = true;
    fixture.lockError = undefined;
    fixture.unlockError = undefined;
    fixture.lockAttempts = 0;
    fixture.failStart = undefined;
    process.argv = ['node', 'supervisor'];
    vi.stubEnv('FRAMELEAF_EDGE_SECRET', 'supervisor-unit-fixture');
    vi.stubEnv('FRAMELEAF_NATIVE_OWNER', '0');
    const on = process.on.bind(process);
    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => {
      if (['SIGTERM', 'SIGINT', 'message', 'disconnect'].includes(event)) {
        fixture.signals.set(event, listener);
        return process;
      }
      return on(event, listener);
    }) as typeof process.on);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    Workers = (await import('src/supervisor.js')).Workers;
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.starts).toEqual(['api', 'microservices', 'edge']);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.argv = argv;
    process.title = title;
    vi.unstubAllEnvs();
  });

  it.each(['lock', 'unlock'] as const)('releases the lock-check client after a %s query failure', async (phase) => {
    const failure = new Error(`${phase} failed`);
    fixture[phase === 'lock' ? 'lockError' : 'unlockError'] = failure;
    const workers = new Workers();
    await expect(workers['waitForFreeLock']()).rejects.toBe(failure);
    expect(fixture.clients.at(-1)!.destroy).toHaveBeenCalledOnce();
  });

  it.each(['callback', 'throw'])('fails native attachment when owner-ready send fails: %s', async (failure) => {
    const connected = Object.getOwnPropertyDescriptor(process, 'connected');
    const send = Object.getOwnPropertyDescriptor(process, 'send');
    const exitCode = process.exitCode;
    vi.stubEnv('FRAMELEAF_NATIVE_OWNER', '1');
    fixture.starts = [];
    fixture.workers = [];
    Object.defineProperties(process, {
      connected: { configurable: true, value: true },
      send: {
        configurable: true,
        value: vi.fn((_message, callback) => {
          if (failure === 'throw') throw new Error('synthetic IPC failure');
          callback(new Error('synthetic IPC failure'));
          return false;
        }),
      },
    });
    try {
      vi.resetModules();
      await import('src/supervisor.js');
      await vi.advanceTimersByTimeAsync(0);
      expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(fixture.starts).toEqual([]);
    } finally {
      if (connected) Object.defineProperty(process, 'connected', connected);
      else Reflect.deleteProperty(process, 'connected');
      if (send) Object.defineProperty(process, 'send', send);
      else Reflect.deleteProperty(process, 'send');
      process.exitCode = exitCode;
    }
  });

  it('uses private IPC to drain native API/edge forks and reports a successful stop', async () => {
    vi.stubEnv('FRAMELEAF_NATIVE_OWNER', '1');
    const workers = new Workers();
    await workers.bootstrap();
    workers.stop('SIGTERM');
    for (const name of [FrameleafWorker.Api, FrameleafWorker.Edge]) {
      const worker = latest(name) as unknown as { send: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> };
      expect(worker.send).toHaveBeenCalledWith('frameleaf:stop', expect.any(Function));
      expect(worker.kill).not.toHaveBeenCalled();
    }
    for (const name of [FrameleafWorker.Api, FrameleafWorker.Microservices, FrameleafWorker.Edge])
      latest(name).emit('exit', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each(['send failure', 'deadline'] as const)('reports a forced native stop after %s', async (failure) => {
    vi.stubEnv('FRAMELEAF_NATIVE_OWNER', '1');
    const workers = new Workers();
    await workers.bootstrap();
    const api = latest(FrameleafWorker.Api) as unknown as {
      send: ReturnType<typeof vi.fn>;
      kill: ReturnType<typeof vi.fn>;
    };
    if (failure === 'send failure') {
      api.send.mockImplementation((_message: string, callback: (error: Error) => void) => {
        callback(new Error('synthetic IPC failure'));
        return false;
      });
    }
    workers.stop('SIGTERM');
    if (failure === 'send failure') {
      expect(api.kill).toHaveBeenCalledWith('SIGKILL');
      for (const name of [FrameleafWorker.Api, FrameleafWorker.Microservices, FrameleafWorker.Edge])
        latest(name).emit('exit', 0);
      await vi.advanceTimersByTimeAsync(0);
    } else {
      await vi.advanceTimersByTimeAsync(9000);
      expect(api.kill).toHaveBeenCalledWith('SIGKILL');
    }
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('reports a native worker cleanup failure even when every process exits before the deadline', async () => {
    vi.stubEnv('FRAMELEAF_NATIVE_OWNER', '1');
    const workers = new Workers();
    await workers.bootstrap();
    workers.stop('SIGTERM');
    latest(FrameleafWorker.Api).emit('exit', 1);
    latest(FrameleafWorker.Microservices).emit('exit', 0);
    latest(FrameleafWorker.Edge).emit('exit', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each([FrameleafWorker.Microservices, FrameleafWorker.Edge])(
    'drains already started workers when constructing %s fails, then exits unsuccessfully',
    async (failedWorker) => {
      const workers = new Workers();
      const starts = fixture.workers.length;
      fixture.failStart = failedWorker;
      await expect(workers.bootstrap()).resolves.toBeUndefined();
      const running = fixture.workers.slice(starts);
      expect(running.map(({ name }) => name)).toEqual(
        failedWorker === FrameleafWorker.Edge ? ['api', 'microservices'] : ['api'],
      );
      expect((running[0] as unknown as { kill: ReturnType<typeof vi.fn> }).kill).toHaveBeenCalledWith('SIGTERM');
      if (running.length === 2) {
        expect((running[1] as unknown as { postMessage: ReturnType<typeof vi.fn> }).postMessage).toHaveBeenCalledWith(
          'frameleaf:stop',
        );
      }
      expect(process.exit).not.toHaveBeenCalled();
      for (const worker of running) worker.emit('exit', 0);
      await vi.advanceTimersByTimeAsync(0);
      expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fixture.workers).toHaveLength(starts + running.length);
      expect(process.exit).toHaveBeenCalledTimes(1);
    },
  );

  it('exits unsuccessfully at the shutdown deadline if a startup survivor does not stop', async () => {
    const workers = new Workers();
    fixture.failStart = FrameleafWorker.Edge;
    await expect(workers.bootstrap()).resolves.toBeUndefined();
    const api = latest(FrameleafWorker.Api) as unknown as { kill: ReturnType<typeof vi.fn> };
    await vi.advanceTimersByTimeAsync(9000);
    expect(api.kill).toHaveBeenCalledWith('SIGKILL');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it.each(['lock', 'unlock', 'proof'] as const)(
    'exits unsuccessfully when %s fails before any worker starts',
    async (phase) => {
      const workers = new Workers();
      const starts = fixture.starts.length;
      const failure = new Error('startup admission failed');
      if (phase === 'proof') vi.mocked(workers['workerStopProofs'].republish).mockRejectedValue(failure);
      else fixture[phase === 'lock' ? 'lockError' : 'unlockError'] = failure;
      await expect(workers.bootstrap()).resolves.toBeUndefined();
      expect(fixture.starts).toHaveLength(starts);
      expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    },
  );

  it('retains successful exit status for an ordinary empty supervisor stop', () => {
    new Workers().stop('SIGTERM');
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('keeps an already requested normal stop successful when pending startup rejects', async () => {
    const workers = new Workers();
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<void>();
    vi.mocked(workers['workerStopProofs'].republish).mockImplementation(() => {
      entered.resolve();
      return pending.promise;
    });
    const boot = workers.bootstrap();
    await entered.promise;
    workers.stop('SIGTERM');
    pending.reject(new Error('closed during shutdown'));
    await boot;
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('stops retrying a busy lock without republishing proofs or admitting replacement workers', async () => {
    fixture.lockAvailable = false;
    const workers = new Workers();
    const attempts = fixture.lockAttempts;
    const starts = fixture.starts.length;
    let settled = false;
    const pending = workers.bootstrap().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    const client = fixture.clients.at(-1)!;
    expect(fixture.lockAttempts).toBe(attempts + 1);
    workers.stop('SIGTERM');
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(true);
    expect(fixture.lockAttempts).toBe(attempts + 1);
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(workers['workerStopProofs'].republish).not.toHaveBeenCalled();
    expect(fixture.starts).toHaveLength(starts);
    await pending;
  });

  it('waits for lock release before republishing proof and admitting replacement workers', async () => {
    fixture.lockAvailable = false;
    const workers = new Workers();
    const starts = fixture.starts.length;
    const pending = workers.bootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(workers['workerStopProofs'].republish).not.toHaveBeenCalled();
    expect(fixture.starts).toHaveLength(starts);
    const client = fixture.clients.at(-1)!;
    vi.mocked(workers['workerStopProofs'].republish).mockImplementation(() => {
      expect(client.destroy).toHaveBeenCalledOnce();
      return Promise.resolve();
    });
    fixture.lockAvailable = true;
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(workers['workerStopProofs'].republish).toHaveBeenCalledOnce();
    expect(fixture.starts.slice(starts)).toEqual(['api', 'microservices', 'edge']);
  });

  it('invalidates a failed executor retry across maintenance and reopens the API after End', async () => {
    // Hosted ordering: startup fails during restart, before API/edge exit with AppRestart.
    latest(FrameleafWorker.Microservices).emit('exit', 1);
    await vi.advanceTimersByTimeAsync(0);
    fixture.maintenance = true;
    latest(FrameleafWorker.Api).emit('exit', ExitCode.AppRestart);
    latest(FrameleafWorker.Edge).emit('exit', ExitCode.AppRestart);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.starts).toEqual(['api', 'microservices', 'edge', 'maintenance']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.starts).toEqual(['api', 'microservices', 'edge', 'maintenance']);
    fixture.maintenance = false;
    latest(FrameleafWorker.Maintenance).emit('exit', ExitCode.AppRestart);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.starts).toEqual(['api', 'microservices', 'edge', 'maintenance', 'api', 'microservices', 'edge']);
  });

  it('refuses an already-dispatched retry callback after maintenance bootstrap', async () => {
    const schedule = setTimeout;
    let pending: (() => void) | undefined;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((action: () => void, delay: number) => {
      if (delay === 1000) pending = action;
      return schedule(action, delay);
    }) as typeof setTimeout);
    latest(FrameleafWorker.Microservices).emit('exit', 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toBeDefined();
    fixture.maintenance = true;
    latest(FrameleafWorker.Api).emit('exit', ExitCode.AppRestart);
    latest(FrameleafWorker.Edge).emit('exit', ExitCode.AppRestart);
    await vi.advanceTimersByTimeAsync(0);
    // Clearing a timer cannot recall a callback already handed to the event loop.
    pending!();
    expect(fixture.starts).toEqual(['api', 'microservices', 'edge', 'maintenance']);
  });

  it('still restarts an ordinary failed executor in the same lifecycle', async () => {
    latest(FrameleafWorker.Microservices).emit('exit', 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.starts).toEqual(['api', 'microservices', 'edge', 'microservices']);
  });

  it('backs off an executor that keeps failing at startup, and resets after a minute of running', async () => {
    const restarts = () => fixture.starts.filter((name) => name === 'microservices').length;
    latest(FrameleafWorker.Microservices).emit('exit', 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(restarts()).toBe(2);
    latest(FrameleafWorker.Microservices).emit('exit', 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(restarts()).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(restarts()).toBe(3);
    latest(FrameleafWorker.Microservices).emit('exit', 1);
    await vi.advanceTimersByTimeAsync(3999);
    expect(restarts()).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(restarts()).toBe(4);
    await vi.advanceTimersByTimeAsync(61_000);
    latest(FrameleafWorker.Microservices).emit('exit', 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(restarts()).toBe(5);
  });

  // FL-646: an API start-up that lost a lock race to another worker comes back instead of stopping the server.
  it('restarts an API worker whose start-up hit a transient lock conflict, backing off while it keeps failing', async () => {
    latest(FrameleafWorker.Api).emit('exit', API_STARTUP_RETRY_EXIT_CODE);
    expect(process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.starts).toEqual(['api', 'microservices', 'edge', 'api']);
    latest(FrameleafWorker.Api).emit('exit', API_STARTUP_RETRY_EXIT_CODE);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.starts).toEqual(['api', 'microservices', 'edge', 'api']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.starts).toEqual(['api', 'microservices', 'edge', 'api', 'api']);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('still stops the server when the API worker fails for any other reason', async () => {
    latest(FrameleafWorker.Api).emit('exit', 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(fixture.starts).toEqual(['api', 'microservices', 'edge']);
  });

  it('still restarts a poisoned API pool without restarting healthy workers', async () => {
    latest(FrameleafWorker.Api).emit('message', { type: 'database-unusable' });
    latest(FrameleafWorker.Api).emit('exit', 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.starts).toEqual(['api', 'microservices', 'edge', 'api']);
  });

  it('does not restart a failed executor after supervisor stop', async () => {
    latest(FrameleafWorker.Microservices).emit('exit', 1);
    await vi.advanceTimersByTimeAsync(0);
    fixture.signals.get('SIGTERM')!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.starts).toEqual(['api', 'microservices', 'edge']);
  });

  describe('FL-721 Locked keys', () => {
    const pair = generateKeyPair();
    const load = {
      type: 'locked-key',
      action: 'load',
      userId: 'owner',
      publicKey: pair.publicKey.toString('base64'),
      privateKey: pair.privateKey.toString('base64'),
      expiresAt: null,
      grants: [],
    } as const;
    const pin = { type: 'locked-key', action: 'pin', userId: 'owner' } as const;
    type Thread = EventEmitter & { postMessage: ReturnType<typeof vi.fn> };
    type Fork = EventEmitter & { send: ReturnType<typeof vi.fn> };
    const posted = (worker: Thread) => worker.postMessage.mock.calls.map(([message]) => message);
    const sent = (worker: Fork) => worker.send.mock.calls.map(([message]) => message);

    it('relays keys from the API to the job worker and the edge worker only', () => {
      latest(FrameleafWorker.Api).emit('message', load);
      latest(FrameleafWorker.Api).emit('message', pin);

      expect(posted(latest(FrameleafWorker.Microservices) as unknown as Thread)).toEqual([load, pin]);
      expect(sent(latest(FrameleafWorker.Edge) as unknown as Fork)).toEqual([load, pin]);
      expect(sent(latest(FrameleafWorker.Api) as unknown as Fork)).toEqual([]);
    });

    it('replays the loaded keys to a worker that restarts, once it listens', async () => {
      latest(FrameleafWorker.Api).emit('message', load);
      latest(FrameleafWorker.Api).emit('message', pin);
      latest(FrameleafWorker.Microservices).emit('exit', 1);
      await vi.advanceTimersByTimeAsync(1000);
      const restarted = latest(FrameleafWorker.Microservices) as unknown as Thread;
      expect(posted(restarted)).toEqual([]);

      restarted.emit('message', { type: 'locked-key-ready' });

      expect(posted(restarted)).toEqual([load, pin]);
    });

    it('does not relay locked-key messages that come from a job worker', () => {
      latest(FrameleafWorker.Microservices).emit('message', load);
      expect(sent(latest(FrameleafWorker.Edge) as unknown as Fork)).toEqual([]);
    });

    it('empties the workers when the API process starts again', async () => {
      latest(FrameleafWorker.Api).emit('message', load);
      latest(FrameleafWorker.Api).emit('message', pin);
      latest(FrameleafWorker.Api).emit('exit', API_STARTUP_RETRY_EXIT_CODE);
      await vi.advanceTimersByTimeAsync(1000);

      const drop = [
        { type: 'locked-key', action: 'unpin', userId: 'owner' },
        { type: 'locked-key', action: 'drop', userId: 'owner' },
      ];
      expect(posted(latest(FrameleafWorker.Microservices) as unknown as Thread)).toEqual([load, pin, ...drop]);
      expect(sent(latest(FrameleafWorker.Edge) as unknown as Fork)).toEqual([load, pin, ...drop]);
      latest(FrameleafWorker.Microservices).emit('message', { type: 'locked-key-ready' });
      expect(posted(latest(FrameleafWorker.Microservices) as unknown as Thread)).toHaveLength(4);
    });
  });

  it('does not admit a replacement while actual stop confirmation remains unresolved', async () => {
    // The stopped boundary represents real exit/native-child confirmation and first proof write.
    const proof = Promise.withResolvers<void>();
    // Give the next replacement the controlled stop boundary.
    fixture.nextStopped = proof.promise;
    latest(FrameleafWorker.Microservices).emit('exit', 1);
    await vi.advanceTimersByTimeAsync(1000);
    latest(FrameleafWorker.Microservices).emit('exit', 1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fixture.starts).toEqual(['api', 'microservices', 'edge', 'microservices']);
    proof.resolve();
    // its second failure in a row waits 2 s
    await vi.advanceTimersByTimeAsync(2000);
    expect(fixture.starts).toEqual(['api', 'microservices', 'edge', 'microservices', 'microservices']);
  });
});
