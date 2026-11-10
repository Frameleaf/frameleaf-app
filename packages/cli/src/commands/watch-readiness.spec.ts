import { getSupportedMediaTypes } from '@frameleaf/sdk';
import { FSWatcher, watch } from 'chokidar';
import { EventEmitter } from 'node:events';
import { startWatch } from 'src/commands/asset';

vi.mock('@frameleaf/sdk');
vi.mock('chokidar', () => ({ watch: vi.fn() }));

const setup = () => {
  // eslint-disable-next-line unicorn/prefer-event-target -- Chokidar uses Node EventEmitter semantics.
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn().mockResolvedValue(undefined) });
  vi.mocked(watch).mockReturnValue(watcher as unknown as FSWatcher);
  vi.mocked(getSupportedMediaTypes).mockResolvedValue({ image: ['.jpg'], sidecar: [], video: [], font: [] });
  return watcher;
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

it('does not acknowledge a watch until the initial scan is ready, even after the old startup sleep', async () => {
  const before = process.listeners('SIGINT');
  const watcher = setup();
  const pending = startWatch(['synthetic-watch'], { concurrency: 1 });
  let isAcknowledged = false;
  void pending.then(() => {
    isAcknowledged = true;
  });
  try {
    await vi.advanceTimersByTimeAsync(500);
    expect(watch).toHaveBeenCalledOnce();
    expect(isAcknowledged).toBe(false);
    watcher.emit('ready');
    const stop = await pending;
    expect(isAcknowledged).toBe(true);
    await stop();
    expect(watcher.close).toHaveBeenCalledOnce();
    expect(process.listeners('SIGINT')).toEqual(before);
  } finally {
    watcher.emit('ready');
    await pending;
    for (const listener of process.listeners('SIGINT')) {
      if (!before.includes(listener)) {
        process.off('SIGINT', listener);
      }
    }
  }
});

it('closes a watch that fails initialization and removes its interrupt handler', async () => {
  const before = process.listeners('SIGINT');
  const watcher = setup();
  const failure = new Error('synthetic initial scan failed');
  const outcome = (async () => {
    try {
      return { value: await startWatch(['synthetic-watch'], { concurrency: 1 }) };
    } catch (error) {
      return { error };
    }
  })();
  try {
    await vi.advanceTimersByTimeAsync(500);
    watcher.emit('error', failure);
    expect(await outcome).toEqual({ error: failure });
    expect(watcher.close).toHaveBeenCalledOnce();
    expect(process.listeners('SIGINT')).toEqual(before);
  } finally {
    watcher.emit('ready');
    await outcome;
    for (const listener of process.listeners('SIGINT')) {
      if (!before.includes(listener)) {
        process.off('SIGINT', listener);
      }
    }
  }
});
