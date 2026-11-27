import { jobSettled } from 'src/queue/settled.js';
import { QUEUE_PROGRESS_INTERVAL_MS, QueueProgressEventService } from 'src/services/queue-progress-event.service.js';

describe(QueueProgressEventService.name, () => {
  let users: { getAdmins: ReturnType<typeof vi.fn> };
  let websocket: { clientSend: ReturnType<typeof vi.fn> };
  let sut: QueueProgressEventService;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-11-26T12:00:00Z') });
    users = { getAdmins: vi.fn().mockResolvedValue([{ id: 'admin-a' }, { id: 'admin-b' }]) };
    websocket = { clientSend: vi.fn() };
    sut = new QueueProgressEventService(users as never, websocket as never);
  });

  afterEach(() => {
    sut.onShutdown();
    vi.useRealTimers();
  });

  it('tells each administrator, and nobody else, that the queues moved (FL-1794)', async () => {
    sut.onJobStart();
    await vi.advanceTimersByTimeAsync(0);

    expect(websocket.clientSend.mock.calls).toEqual([
      ['on_queue_progress', 'admin-a'],
      ['on_queue_progress', 'admin-b'],
    ]);
  });

  it('sends at most one nudge a second however many jobs run, and one more after the last', async () => {
    for (let job = 0; job < 5000; job++) {
      sut.onJobStart();
      sut.onJobSettled();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(websocket.clientSend).toHaveBeenCalledTimes(2);

    // the changes since the first nudge are announced once the second is over
    await vi.advanceTimersByTimeAsync(QUEUE_PROGRESS_INTERVAL_MS - 1);
    expect(websocket.clientSend).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(websocket.clientSend).toHaveBeenCalledTimes(4);

    // nothing changed since: nothing more is sent
    await vi.advanceTimersByTimeAsync(10 * QUEUE_PROGRESS_INTERVAL_MS);
    expect(websocket.clientSend).toHaveBeenCalledTimes(4);
  });

  it('sends for a queue that was started or resumed', async () => {
    sut.onQueueStart();
    await vi.advanceTimersByTimeAsync(QUEUE_PROGRESS_INTERVAL_MS);
    sut.onQueueResumed();
    await vi.advanceTimersByTimeAsync(0);
    expect(websocket.clientSend).toHaveBeenCalledTimes(4);
  });

  it('reads the administrators once a minute, not once a nudge', async () => {
    for (let second = 0; second < 30; second++) {
      sut.onJobSettled();
      await vi.advanceTimersByTimeAsync(QUEUE_PROGRESS_INTERVAL_MS);
    }
    expect(users.getAdmins).toHaveBeenCalledTimes(1);

    users.getAdmins.mockResolvedValue([{ id: 'admin-b' }]);
    await vi.advanceTimersByTimeAsync(31_000);
    websocket.clientSend.mockClear();
    sut.onJobSettled();
    await vi.advanceTimersByTimeAsync(0);
    expect(users.getAdmins).toHaveBeenCalledTimes(2);
    expect(websocket.clientSend.mock.calls).toEqual([['on_queue_progress', 'admin-b']]);
  });

  it('keeps going after the administrators could not be read', async () => {
    users.getAdmins.mockRejectedValueOnce(new Error('database restarting'));
    sut.onJobStart();
    await vi.advanceTimersByTimeAsync(QUEUE_PROGRESS_INTERVAL_MS);
    expect(websocket.clientSend).not.toHaveBeenCalled();

    sut.onJobStart();
    await vi.advanceTimersByTimeAsync(0);
    expect(websocket.clientSend).toHaveBeenCalledTimes(2);
  });

  it('sends nothing after shutdown', async () => {
    sut.onJobStart();
    await vi.advanceTimersByTimeAsync(0);
    sut.onJobStart();
    sut.onShutdown();
    await vi.advanceTimersByTimeAsync(10 * QUEUE_PROGRESS_INTERVAL_MS);
    expect(websocket.clientSend).toHaveBeenCalledTimes(2);
  });

  it('announces a job that failed or was deferred, not only one that succeeded', async () => {
    sut.onBootstrap();
    jobSettled('thumbnailGeneration');
    await vi.advanceTimersByTimeAsync(0);
    expect(websocket.clientSend).toHaveBeenCalledTimes(2);

    sut.onShutdown();
    jobSettled('thumbnailGeneration');
    await vi.advanceTimersByTimeAsync(10 * QUEUE_PROGRESS_INTERVAL_MS);
    expect(websocket.clientSend).toHaveBeenCalledTimes(2);
  });
});
