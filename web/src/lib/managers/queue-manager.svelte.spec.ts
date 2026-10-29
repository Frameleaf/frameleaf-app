import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { QueueManager } from '$lib/managers/queue-manager.svelte';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  sdkMock.getQueues.mockResolvedValue([]);
});

afterEach(() => vi.useRealTimers());

it('stops polling after the last listener leaves and restarts for a new listener', async () => {
  const manager = new QueueManager();
  const stop = manager.listen();
  await vi.advanceTimersByTimeAsync(0);
  stop();
  const count = manager.snapshots.length;
  await vi.advanceTimersByTimeAsync(6000);
  expect(manager.snapshots).toHaveLength(count);
  expect(vi.getTimerCount()).toBe(0);

  const restart = manager.listen();
  try {
    await vi.advanceTimersByTimeAsync(3000);
    expect(manager.snapshots.length).toBeGreaterThan(count);
    expect(vi.getTimerCount()).toBe(1);
  } finally {
    restart();
  }
});

it('keeps polling for another listener when an earlier cleanup is called twice', async () => {
  const manager = new QueueManager();
  const first = manager.listen();
  const second = manager.listen();
  await vi.advanceTimersByTimeAsync(0);
  first();
  first();
  const count = manager.snapshots.length;
  try {
    await vi.advanceTimersByTimeAsync(3000);
    expect(manager.snapshots.at(-1)?.snapshot).toEqual([]);
    expect(manager.snapshots.length).toBeGreaterThan(count);
    expect(vi.getTimerCount()).toBe(1);
  } finally {
    second();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('does not poll a hidden tab or stack a poll on one still waiting', async () => {
  const manager = new QueueManager();
  let answer: (value: never[]) => void = () => {};
  sdkMock.getQueues.mockImplementation(() => new Promise((resolve) => (answer = resolve)) as never);
  const stop = manager.listen();
  try {
    expect(sdkMock.getQueues).toHaveBeenCalledTimes(1);
    // the first answer is still waiting: the ticks add nothing
    await vi.advanceTimersByTimeAsync(9000);
    expect(sdkMock.getQueues).toHaveBeenCalledTimes(1);
    answer([]);
    await vi.advanceTimersByTimeAsync(0);
    sdkMock.getQueues.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sdkMock.getQueues).toHaveBeenCalledTimes(2);

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(9000);
    expect(sdkMock.getQueues).toHaveBeenCalledTimes(2);
    hidden.mockRestore();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sdkMock.getQueues).toHaveBeenCalledTimes(3);
  } finally {
    stop();
  }
});
