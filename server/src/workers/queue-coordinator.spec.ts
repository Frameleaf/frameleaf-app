import { EventEmitter } from 'node:events';
import type { MessagePort } from 'node:worker_threads';
import { QUEUE_EXECUTION_CAPACITY } from 'src/queue/admission.js';
import { QUEUE_TIMING, QueueClaim, QueueDispatch } from 'src/queue/types.js';
import { coordinate } from 'src/workers/queue-coordinator.js';

const fixture = vi.hoisted(() => ({
  port: undefined as (EventEmitter & { postMessage: (message: QueueDispatch) => void }) | undefined,
  wake: undefined as (() => void) | undefined,
  store: {
    initialize: vi.fn(),
    heartbeat: vi.fn(),
    recoverExpired: vi.fn(),
    progress: vi.fn(),
    deadlines: vi.fn(),
    feedManifest: vi.fn(),
    claim: vi.fn(),
    queuesWithUnfinishedWork: vi.fn(),
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
  queueNotifications: (_client: unknown, wake: () => void) => {
    fixture.wake = wake;
    return { connect: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  },
}));

const coordinatorData = {
  workerId: 'worker',
  queues: ['deep', 'thumbnail', 'ml'],
  connection: { connectionType: 'url' as const, url: 'postgres://fixture' },
  supervisor: { postMessage: vi.fn() } as unknown as MessagePort,
};

describe('coordinator capacity admission', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fixture.store.deadlines.mockResolvedValue([]);
    fixture.store.claim.mockResolvedValue([]);
    fixture.store.queuesWithUnfinishedWork.mockResolvedValue(coordinatorData.queues);
    fixture.port = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  });
  afterEach(() => {
    fixture.port!.emit('message', { type: 'stop' });
    fixture.port!.emit('close');
    fixture.port = undefined;
    fixture.wake = undefined;
    vi.useRealTimers();
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
    await coordinate(coordinatorData);
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

  it('rediscovers cross-queue children when a notification arrives during dispatch without overlapping visits', async () => {
    await coordinate(coordinatorData);
    fixture.store.claim.mockClear();
    fixture.store.feedManifest.mockClear();
    const outstanding = new Set(['deep']);
    fixture.store.queuesWithUnfinishedWork.mockImplementation(() => Promise.resolve([...outstanding]));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let visiting = 0;
    let maximumVisiting = 0;
    fixture.store.claim.mockImplementation(async (queue: string) => {
      maximumVisiting = Math.max(maximumVisiting, ++visiting);
      try {
        if (queue === 'deep') {
          await held;
          return [{ id: 'parent', queue, deadlineMs: 60_000 }];
        }
        return [{ id: 'child', queue, deadlineMs: 60_000 }];
      } finally {
        visiting--;
      }
    });
    try {
      fixture.wake!();
      await vi.waitFor(() => expect(fixture.store.claim).toHaveBeenCalledOnce());
      outstanding.delete('deep');
      outstanding.add('thumbnail');
      fixture.wake!(); // committed child arrives while the previous queue visit is still waiting
      release();
      await vi.waitFor(() => expect(fixture.port!.postMessage).toHaveBeenCalledTimes(2));
      expect(fixture.store.queuesWithUnfinishedWork).toHaveBeenCalledTimes(2);
      expect(fixture.store.feedManifest.mock.calls).toEqual([['deep'], ['thumbnail']]);
      expect(fixture.store.claim.mock.calls).toEqual([
        ['deep', 'worker', QUEUE_EXECUTION_CAPACITY],
        ['thumbnail', 'worker', QUEUE_EXECUTION_CAPACITY - 1],
      ]);
      expect(maximumVisiting).toBe(1);
    } finally {
      release();
    }
  });

  it('leaves pause admission to the store and lets another outstanding queue use the free capacity', async () => {
    await coordinate(coordinatorData);
    fixture.store.claim.mockClear();
    fixture.store.feedManifest.mockClear();
    fixture.store.queuesWithUnfinishedWork.mockResolvedValue(['deep', 'thumbnail']);
    let paused = true;
    fixture.store.claim.mockImplementation((queue: string) =>
      Promise.resolve(queue === 'deep' && paused ? [] : [{ id: queue, queue, deadlineMs: 60_000 }]),
    );
    fixture.wake!();
    await vi.waitFor(() => expect(fixture.port!.postMessage).toHaveBeenCalledOnce());
    expect(fixture.port!.postMessage).toHaveBeenLastCalledWith({
      type: 'execute',
      claim: { id: 'thumbnail', queue: 'thumbnail', deadlineMs: 60_000 },
    });
    expect(fixture.store.claim.mock.calls).toEqual([
      ['deep', 'worker', QUEUE_EXECUTION_CAPACITY],
      ['thumbnail', 'worker', QUEUE_EXECUTION_CAPACITY],
    ]);
    paused = false;
    fixture.store.queuesWithUnfinishedWork.mockResolvedValue(['deep']);
    fixture.wake!();
    await vi.waitFor(() => expect(fixture.port!.postMessage).toHaveBeenCalledTimes(2));
    expect(fixture.store.claim).toHaveBeenLastCalledWith('deep', 'worker', QUEUE_EXECUTION_CAPACITY - 1);
  });

  it('reconciles all queues on startup and every five seconds despite dropped notifications, including idle cleanup', async () => {
    vi.useFakeTimers();
    await coordinate(coordinatorData);
    expect(fixture.store.feedManifest.mock.calls).toEqual(coordinatorData.queues.map((queue) => [queue]));
    fixture.store.feedManifest.mockClear();
    fixture.store.queuesWithUnfinishedWork.mockResolvedValue([]);
    fixture.wake!();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.store.queuesWithUnfinishedWork).toHaveBeenCalledOnce();
    expect(fixture.store.feedManifest).not.toHaveBeenCalled();
    // A durable child commits with no delivered notification. Only the full scan discovers it.
    let childAvailable = true;
    fixture.store.claim.mockImplementation((queue: string) => {
      if (queue !== 'thumbnail' || !childAvailable) return Promise.resolve([]);
      childAvailable = false;
      return Promise.resolve([{ id: 'dropped-child', queue, deadlineMs: 60_000 }]);
    });
    await vi.advanceTimersByTimeAsync(QUEUE_TIMING.scan);
    expect(fixture.port!.postMessage).toHaveBeenCalledWith({
      type: 'execute',
      claim: { id: 'dropped-child', queue: 'thumbnail', deadlineMs: 60_000 },
    });
    expect(fixture.store.feedManifest.mock.calls).toEqual(coordinatorData.queues.map((queue) => [queue]));
    expect(fixture.store.queuesWithUnfinishedWork).toHaveBeenCalledOnce();
    fixture.store.feedManifest.mockClear();
    fixture.port!.emit('message', { type: 'settled', id: 'dropped-child' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.store.feedManifest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(QUEUE_TIMING.scan);
    // feedManifest runs sharing/terminal-alias settlement and redaction even without unfinished work.
    expect(fixture.store.feedManifest.mock.calls).toEqual(coordinatorData.queues.map((queue) => [queue]));
  });

  it('remembers a full scan requested while an ordinary dispatch visit is waiting', async () => {
    vi.useFakeTimers();
    await coordinate(coordinatorData);
    fixture.store.feedManifest.mockClear();
    fixture.store.queuesWithUnfinishedWork.mockResolvedValue(['deep']);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    fixture.store.feedManifest.mockImplementationOnce(() => held);
    try {
      fixture.wake!();
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.store.feedManifest.mock.calls).toEqual([['deep']]);
      await vi.advanceTimersByTimeAsync(QUEUE_TIMING.scan);
      expect(fixture.store.feedManifest).toHaveBeenCalledOnce();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.store.feedManifest.mock.calls).toEqual([['deep'], ['thumbnail'], ['ml'], ['deep']]);
      expect(fixture.store.queuesWithUnfinishedWork).toHaveBeenCalledOnce();
    } finally {
      release();
    }
  });

  it('retains a failed full reconciliation for the next ordinary wake', async () => {
    fixture.store.feedManifest.mockRejectedValueOnce(new Error('fixture outage'));
    await coordinate(coordinatorData);
    expect(fixture.port!.postMessage).toHaveBeenCalledWith({ type: 'unavailable' });
    fixture.store.feedManifest.mockClear();
    fixture.wake!();
    await vi.waitFor(() => expect(fixture.store.feedManifest).toHaveBeenCalledTimes(3));
    expect(fixture.store.queuesWithUnfinishedWork).not.toHaveBeenCalled();
  });
});
