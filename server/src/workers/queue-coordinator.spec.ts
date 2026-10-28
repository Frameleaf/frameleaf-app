import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import type { MessagePort } from 'node:worker_threads';
import { QUEUE_EXECUTION_CAPACITY } from 'src/queue/admission.js';
import { pruneQueueHistory } from 'src/queue/retention.js';
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
    vi.restoreAllMocks();
  });

  it.each(['manifest', 'claim'])(
    'starts no further claims after shutdown during a pending %s request',
    async (stage) => {
      vi.useFakeTimers();
      await coordinate(coordinatorData);
      fixture.store.feedManifest.mockClear();
      fixture.store.claim.mockClear();
      fixture.store.queuesWithUnfinishedWork.mockResolvedValue(['deep', 'thumbnail']);
      const held = Promise.withResolvers<unknown[]>();
      if (stage === 'manifest') fixture.store.feedManifest.mockImplementationOnce(() => held.promise);
      else fixture.store.claim.mockImplementationOnce(() => held.promise);
      fixture.wake!();
      await vi.advanceTimersByTimeAsync(0);
      fixture.port!.emit('message', { type: 'stop' });
      const admitted = { id: 'late-claim', queue: 'deep', deadlineMs: 60_000 };
      held.resolve(stage === 'claim' ? [admitted] : []);
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.store.feedManifest.mock.calls).toEqual([['deep']]);
      expect(fixture.store.claim.mock.calls).toEqual(
        stage === 'claim' ? [['deep', 'worker', QUEUE_EXECUTION_CAPACITY]] : [],
      );
      // Already acquired claims reach the executor's pre-handler deferral guard.
      expect(vi.mocked(fixture.port!.postMessage).mock.calls).toEqual(
        stage === 'claim' ? [[{ type: 'execute', claim: admitted }]] : [],
      );
    },
  );

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

  it('renews leases while recovery is still waiting', async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    fixture.store.claim.mockResolvedValueOnce([{ id: 'running', queue: 'deep', deadlineMs: 600_000 }]);
    await coordinate(coordinatorData);
    const recovery = Promise.withResolvers<void>();
    fixture.store.recoverExpired.mockImplementationOnce(() => recovery.promise);
    try {
      await vi.advanceTimersByTimeAsync(QUEUE_TIMING.sweep);
      const beats = fixture.store.heartbeat.mock.calls.length;
      await vi.advanceTimersByTimeAsync(QUEUE_TIMING.heartbeat * 2);
      expect(fixture.store.heartbeat.mock.calls.length).toBeGreaterThan(beats);
      expect(coordinatorData.supervisor.postMessage).not.toHaveBeenCalledWith({ type: 'terminate' });
      expect(fixture.port!.postMessage).not.toHaveBeenCalledWith({ type: 'cancel', id: 'running' });
    } finally {
      recovery.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it.each(['recovery', 'retention'])(
    'dispatches while %s is pending without overlapping maintenance',
    async (stage) => {
      vi.useFakeTimers();
      vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
      await coordinate(coordinatorData);
      const held = Promise.withResolvers<number>();
      const task = stage === 'recovery' ? fixture.store.recoverExpired : vi.mocked(pruneQueueHistory);
      task.mockImplementationOnce(() => held.promise);
      try {
        await vi.advanceTimersByTimeAsync(QUEUE_TIMING.sweep);
        const sweeps = fixture.store.recoverExpired.mock.calls.length;
        const prunes = vi.mocked(pruneQueueHistory).mock.calls.length;
        fixture.store.claim.mockResolvedValueOnce([{ id: 'new-work', queue: 'deep', deadlineMs: 600_000 }]);
        fixture.wake!();
        await vi.advanceTimersByTimeAsync(QUEUE_TIMING.sweep * 2);
        expect(fixture.port!.postMessage).toHaveBeenCalledWith({
          type: 'execute',
          claim: { id: 'new-work', queue: 'deep', deadlineMs: 600_000 },
        });
        expect(fixture.store.recoverExpired).toHaveBeenCalledTimes(sweeps);
        expect(pruneQueueHistory).toHaveBeenCalledTimes(prunes);
      } finally {
        held.resolve(0);
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );

  it('does not start maintenance before initialization succeeds', async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    const initialized = Promise.withResolvers<void>();
    fixture.store.initialize.mockImplementationOnce(() => initialized.promise);
    const started = coordinate(coordinatorData);
    await vi.advanceTimersByTimeAsync(QUEUE_TIMING.sweep * 2);
    expect(fixture.store.recoverExpired).not.toHaveBeenCalled();
    expect(pruneQueueHistory).not.toHaveBeenCalled();
    initialized.resolve();
    await started;
    expect(fixture.store.recoverExpired).toHaveBeenCalledOnce();
  });

  it('retries failed maintenance on the next sweep without stopping dispatch', async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    fixture.store.recoverExpired.mockRejectedValueOnce(new Error('fixture recovery failure'));
    await coordinate(coordinatorData);
    expect(fixture.port!.postMessage).toHaveBeenCalledWith({ type: 'unavailable' });
    expect(fixture.store.feedManifest).toHaveBeenCalledTimes(coordinatorData.queues.length);
    expect(pruneQueueHistory).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(QUEUE_TIMING.sweep);
    expect(fixture.store.recoverExpired).toHaveBeenCalledTimes(2);
    expect(pruneQueueHistory).toHaveBeenCalledOnce();
  });

  it('does not start retention after shutdown during pending recovery', async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    const recovery = Promise.withResolvers<void>();
    fixture.store.recoverExpired.mockImplementationOnce(() => recovery.promise);
    await coordinate(coordinatorData);
    fixture.port!.emit('message', { type: 'stop' });
    recovery.resolve();
    await vi.advanceTimersByTimeAsync(QUEUE_TIMING.sweep * 2);
    expect(fixture.store.recoverExpired).toHaveBeenCalledOnce();
    expect(pruneQueueHistory).not.toHaveBeenCalled();
  });

  it('keeps heartbeat requests serialized and still terminates after a real heartbeat outage', async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    fixture.store.claim.mockResolvedValueOnce([{ id: 'running', queue: 'deep', deadlineMs: 600_000 }]);
    await coordinate(coordinatorData);
    const heartbeat = Promise.withResolvers<void>();
    fixture.store.heartbeat.mockImplementation(() => heartbeat.promise);
    try {
      await vi.advanceTimersByTimeAsync(QUEUE_TIMING.heartbeat * 4 + QUEUE_TIMING.cancelGrace);
      // One initial heartbeat and one pending request; timer wakes cannot overlap it.
      expect(fixture.store.heartbeat).toHaveBeenCalledTimes(2);
      expect(coordinatorData.supervisor.postMessage).toHaveBeenCalledWith({ type: 'terminate' });
      expect(fixture.port!.postMessage).toHaveBeenCalledWith({ type: 'cancel', id: 'running' });
    } finally {
      heartbeat.resolve();
      await vi.advanceTimersByTimeAsync(0);
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
