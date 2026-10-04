import { EventEmitter } from 'node:events';
import {
  DEFAULT_SHUTDOWN_DEADLINE_SECONDS,
  DEFAULT_SHUTDOWN_GRACE_SECONDS,
  HttpRequestTracker,
  SupervisorStop,
  WORKER_STOP_MESSAGE,
  closeGracefully,
  getWorkerDeadlineMs,
  onStopRequest,
} from 'src/utils/shutdown.js';

class FakeServer extends EventEmitter {
  close = vi.fn();
  closeIdleConnections = vi.fn();
  closeAllConnections = vi.fn();

  request(url = '/api/assets') {
    const res = new EventEmitter();
    this.emit('request', { url }, res);
    return { end: () => res.emit('close') };
  }
}

describe('shutdown budget (FL-291)', () => {
  it('fits the 10 s stop_grace_period of the provided compose files and NAS packages by default', () => {
    expect(DEFAULT_SHUTDOWN_GRACE_SECONDS).toBeLessThan(DEFAULT_SHUTDOWN_DEADLINE_SECONDS);
    expect(DEFAULT_SHUTDOWN_DEADLINE_SECONDS).toBeLessThan(10);
  });

  it.each([
    [5000, 9000, 8000],
    [20_000, 28_000, 27_000],
    [2000, 2500, 2250],
  ])('exits a worker with grace %i ms and deadline %i ms at %i ms', (grace, deadline, expected) => {
    expect(getWorkerDeadlineMs(grace, deadline)).toBe(expected);
  });
});

describe(HttpRequestTracker.name, () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops accepting connections and returns at once with nothing in flight', async () => {
    const server = new FakeServer();
    const tracker = new HttpRequestTracker(server as any);

    await expect(tracker.drain(5000)).resolves.toBe(true);

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight request to finish before closing the remaining connections', async () => {
    const server = new FakeServer();
    const tracker = new HttpRequestTracker(server as any);
    const upload = server.request();

    let drained: boolean | undefined;
    const draining = tracker.drain(5000).then((result) => (drained = result));
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.close).toHaveBeenCalled();
    expect(drained).toBeUndefined();
    expect(server.closeAllConnections).not.toHaveBeenCalled();

    upload.end();
    await draining;
    expect(drained).toBe(true);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  it('cuts requests still running when the grace period ends', async () => {
    const server = new FakeServer();
    const tracker = new HttpRequestTracker(server as any);
    server.request();

    let drained: boolean | undefined;
    const draining = tracker.drain(5000).then((result) => (drained = result));
    await vi.advanceTimersByTimeAsync(4999);
    expect(drained).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await draining;

    expect(drained).toBe(false);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  it('does not wait for socket.io long-polls, which never finish on their own', async () => {
    const server = new FakeServer();
    const tracker = new HttpRequestTracker(server as any);
    server.request('/api/socket.io/?EIO=4&transport=polling');

    await expect(tracker.drain(5000)).resolves.toBe(true);
  });

  it('counts a request once even if it closes twice', async () => {
    const server = new FakeServer();
    const tracker = new HttpRequestTracker(server as any);
    const first = server.request();
    server.request();
    first.end();
    first.end();

    let drained: boolean | undefined;
    void tracker.drain(5000).then((result) => (drained = result));
    await vi.advanceTimersByTimeAsync(100);
    expect(drained).toBeUndefined();
  });
});

describe(closeGracefully.name, () => {
  it('drains HTTP and stops jobs side by side within one grace period, then closes the app', async () => {
    const order: string[] = [];
    let finishDrain!: () => void;
    let finishJobs!: () => void;
    const http = {
      drain: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            order.push('drain:start');
            finishDrain = () => resolve(true);
          }),
      ),
    };
    const stopJobs = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          order.push('jobs:start');
          finishJobs = resolve;
        }),
    );
    const close = vi.fn(() => {
      order.push('close');
      return Promise.resolve();
    });

    const closing = closeGracefully({ http: http as any, stopJobs, close, graceMs: 7000 });
    await vi.waitFor(() => expect(order).toEqual(['drain:start', 'jobs:start']));
    expect(http.drain).toHaveBeenCalledWith(7000);
    expect(stopJobs).toHaveBeenCalledWith(7000);

    finishJobs();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    finishDrain();
    await closing;
    expect(order).toEqual(['drain:start', 'jobs:start', 'close']);
  });

  it('still closes the app when stopping the jobs fails', async () => {
    const close = vi.fn(() => Promise.resolve());
    const stopJobs = vi.fn(() => Promise.reject(new Error('queue shutdown unavailable')));

    await expect(closeGracefully({ stopJobs, close, graceMs: 5000 })).rejects.toThrow('queue shutdown unavailable');
    expect(close).toHaveBeenCalled();
  });

  it('reports how long each part of the stop took (FL-299)', async () => {
    const debug = vi.fn();
    const http = { drain: vi.fn(() => Promise.resolve(true)) };

    await closeGracefully({
      http,
      stopJobs: () => Promise.resolve(),
      close: () => Promise.resolve(),
      graceMs: 5000,
      debug,
    });

    expect(debug.mock.calls.map(([message]) => message)).toEqual([
      expect.stringMatching(/^Stop: draining HTTP requests took \d+ ms$/),
      expect.stringMatching(/^Stop: stopping the job workers took \d+ ms$/),
      expect.stringMatching(/^Stop: closing the application took \d+ ms$/),
    ]);
  });

  it('reports only the parts a worker has', async () => {
    const debug = vi.fn();

    await closeGracefully({ close: () => Promise.resolve(), graceMs: 5000, debug });

    expect(debug.mock.calls.map(([message]) => message)).toEqual([
      expect.stringMatching(/^Stop: closing the application took \d+ ms$/),
    ]);
  });
});

describe(onStopRequest.name, () => {
  it('stops a forked process on SIGTERM or SIGINT, once', () => {
    const proc = new EventEmitter();
    const stop = vi.fn();

    onStopRequest(stop, { port: null, proc: proc as any });
    proc.emit('SIGTERM');
    proc.emit('SIGINT');

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops a worker thread when the supervisor posts the stop message', () => {
    const port = new EventEmitter();
    const proc = new EventEmitter();
    const stop = vi.fn();

    onStopRequest(stop, { port: port as any, proc: proc as any });
    port.emit('message', 'something else');
    expect(stop).not.toHaveBeenCalled();
    port.emit('message', WORKER_STOP_MESSAGE);
    port.emit('message', WORKER_STOP_MESSAGE);

    expect(stop).toHaveBeenCalledTimes(1);
    // a thread shares the process: its signals are the supervisor's to handle
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });
});

describe(SupervisorStop.name, () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const DEADLINE_MS = 9000;
  const worker = () => ({ stop: vi.fn(), kill: vi.fn() });

  it('asks every worker to stop and exits once the last one has', () => {
    const exit = vi.fn();
    const api = worker();
    const microservices = worker();
    const workers = [api, microservices];
    const sut = new SupervisorStop({ exit, deadlineMs: DEADLINE_MS });

    sut.begin(() => workers);
    expect(sut.stopping).toBe(true);
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(microservices.stop).toHaveBeenCalledTimes(1);

    workers.pop();
    sut.workerExited(workers.length);
    expect(exit).not.toHaveBeenCalled();
    workers.pop();
    sut.workerExited(workers.length);
    expect(exit).toHaveBeenCalledWith(0);

    vi.advanceTimersByTime(DEADLINE_MS);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(api.kill).not.toHaveBeenCalled();
  });

  it('kills whatever is still running at the deadline, then exits', () => {
    const exit = vi.fn();
    const stuck = worker();
    const sut = new SupervisorStop({ exit, deadlineMs: DEADLINE_MS });

    sut.begin(() => [stuck]);
    vi.advanceTimersByTime(DEADLINE_MS - 1);
    expect(stuck.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(stuck.kill).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('ignores a second stop request', () => {
    const exit = vi.fn();
    const api = worker();
    const sut = new SupervisorStop({ exit, deadlineMs: DEADLINE_MS });

    sut.begin(() => [api]);
    sut.begin(() => [api]);

    expect(api.stop).toHaveBeenCalledTimes(1);
  });

  it('exits at once when no worker is running yet', () => {
    const exit = vi.fn();
    const sut = new SupervisorStop({ exit, deadlineMs: DEADLINE_MS });

    sut.begin(() => []);

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('does nothing on a worker exit before a stop was asked for', () => {
    const exit = vi.fn();
    const sut = new SupervisorStop({ exit, deadlineMs: DEADLINE_MS });

    sut.workerExited(0);

    expect(exit).not.toHaveBeenCalled();
  });
});
