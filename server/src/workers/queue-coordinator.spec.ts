import { EventEmitter } from 'node:events';
import type { MessagePort } from 'node:worker_threads';
import { QUEUE_EXECUTION_CAPACITY } from 'src/queue/admission.js';
import { QueueClaim, QueueDispatch } from 'src/queue/types.js';
import { coordinate } from 'src/workers/queue-coordinator.js';

const fixture = vi.hoisted(() => ({
  port: undefined as (EventEmitter & { postMessage: (message: QueueDispatch) => void }) | undefined,
  store: {
    initialize: vi.fn(),
    heartbeat: vi.fn(),
    recoverExpired: vi.fn(),
    progress: vi.fn(),
    deadlines: vi.fn(),
    feedManifest: vi.fn(),
    claim: vi.fn(),
  },
}));

vi.mock('node:worker_threads', () => ({
  get parentPort() {
    return fixture.port;
  },
  workerData: undefined,
}));
vi.mock('postgres', () => ({ default: () => ({ end: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock('src/queue/store.js', () => ({
  SqlQueueStore: class {
    constructor() {
      return fixture.store;
    }
  },
}));
vi.mock('src/queue/retention.js', () => ({ pruneQueueHistory: vi.fn().mockResolvedValue(undefined) }));
vi.mock('src/queue/notifications.js', () => ({
  queueNotifications: () => ({ connect: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }),
}));

describe('coordinator capacity admission', () => {
  beforeEach(() => {
    fixture.store.deadlines.mockResolvedValue([]);
    fixture.store.claim.mockClear();
    fixture.port = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  });
  afterEach(() => {
    fixture.port!.emit('message', { type: 'stop' });
    fixture.port!.emit('close');
    fixture.port = undefined;
  });

  it('claims only free capacity and rotates queues as slots settle without claiming waiting work', async () => {
    const dispatched: QueueClaim[] = [];
    fixture.port!.postMessage = (message) => {
      if (message.type === 'execute') dispatched.push(message.claim);
    };
    fixture.store.claim.mockImplementation((queue: string, workerId: string, capacity: number) =>
      Promise.resolve(
        Array.from({ length: capacity }, (_, index) => ({
          id: `${queue}-${index}`,
          queue,
          workerId,
          deadlineMs: 60_000,
        })),
      ),
    );
    await coordinate({
      workerId: 'worker',
      queues: ['deep', 'thumbnail', 'ml'],
      connection: { connectionType: 'url', url: 'postgres://fixture' },
      supervisor: { postMessage: vi.fn() } as unknown as MessagePort,
    });
    expect(dispatched).toHaveLength(QUEUE_EXECUTION_CAPACITY);
    expect(fixture.store.claim.mock.calls).toEqual([['deep', 'worker', QUEUE_EXECUTION_CAPACITY]]);
    fixture.port!.emit('message', { type: 'settled', id: dispatched[0].id });
    await vi.waitFor(() => expect(dispatched).toHaveLength(QUEUE_EXECUTION_CAPACITY + 1));
    expect(dispatched.at(-1)!.queue).toBe('thumbnail');
    expect(fixture.store.claim).toHaveBeenLastCalledWith('thumbnail', 'worker', 1);
    fixture.port!.emit('message', { type: 'settled', id: dispatched.at(-1)!.id });
    await vi.waitFor(() => expect(dispatched).toHaveLength(QUEUE_EXECUTION_CAPACITY + 2));
    expect(dispatched.at(-1)!.queue).toBe('ml');
    expect(fixture.store.claim).toHaveBeenLastCalledWith('ml', 'worker', 1);
    expect(fixture.store.progress).not.toHaveBeenCalled();
  });
});
