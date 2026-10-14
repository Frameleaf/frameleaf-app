import { EventEmitter } from 'node:events';
import { ExitCode, FrameleafWorker } from 'src/enum.js';

const fixture = vi.hoisted(() => ({
  maintenance: false,
  starts: [] as string[],
  workers: [] as (EventEmitter & { name: string; stopped: Promise<void> })[],
  signals: new Map<string, () => void>(),
  nextStopped: undefined as Promise<void> | undefined,
}));

// Import the real entry point; replace only OS processes, database and stop-proof transport.
// No worker thread, child process, credentials or PostgreSQL connection is created.
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    fork: (file: string) => {
      const worker = Object.assign(new EventEmitter(), {
        name: file.split('/').at(-1)!.replace('.js', ''),
        stopped: Promise.resolve(),
        kill: vi.fn(),
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
    destroy = vi.fn().mockResolvedValue(undefined);
    connection = () => ({ execute: (action: (db: unknown) => Promise<unknown>) => action(this) });
  },
  sql: () => ({ execute: () => Promise.resolve({ rows: [{ pg_try_advisory_lock: true }] }) }),
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
    process.argv = ['node', 'supervisor'];
    vi.stubEnv('FRAMELEAF_EDGE_SECRET', 'supervisor-unit-fixture');
    const on = process.on.bind(process);
    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => {
      if (event === 'SIGTERM' || event === 'SIGINT') {
        fixture.signals.set(event, listener);
        return process;
      }
      return on(event, listener);
    }) as typeof process.on);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await import('src/supervisor.js');
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
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.starts).toEqual(['api', 'microservices', 'edge', 'microservices', 'microservices']);
  });
});
