import { getQueues, type QueueResponseDto } from '@frameleaf/sdk';
import { QueueManager } from '$lib/managers/queue-manager.svelte';

vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<typeof import('@frameleaf/sdk')>()),
  getQueues: vi.fn(),
}));

const queue = (name: string) => ({ name, isPaused: false }) as unknown as QueueResponseDto;

describe('QueueManager', () => {
  beforeEach(() => {
    vi.mocked(getQueues).mockReset();
  });

  it('starts with no queues', () => {
    expect(new QueueManager().queues).toEqual([]);
  });

  it('keeps the last list the server gave when a poll fails', async () => {
    const manager = new QueueManager();
    const queues = [queue('thumbnailGeneration'), queue('metadataExtraction')];

    vi.mocked(getQueues).mockResolvedValueOnce(queues);
    await manager.refresh();
    expect(manager.queues).toEqual(queues);

    vi.mocked(getQueues).mockRejectedValueOnce(new Error('offline'));
    await manager.refresh();

    expect(manager.queues).toEqual(queues);
    // The history still records the gap, so a chart of it does not invent a reading.
    expect(manager.snapshots).toHaveLength(2);
    expect(manager.snapshots[0].snapshot).toEqual(queues);
    expect(manager.snapshots[1].snapshot).toBeUndefined();
  });

  it('keeps the list through a tick nobody is listening to, without asking the server', async () => {
    const manager = new QueueManager();
    const queues = [queue('thumbnailGeneration')];
    vi.mocked(getQueues).mockResolvedValueOnce(queues);
    await manager.refresh();

    await manager.refresh(true);

    expect(getQueues).toHaveBeenCalledOnce();
    expect(manager.queues).toEqual(queues);
  });

  it('takes the next list that arrives', async () => {
    const manager = new QueueManager();
    vi.mocked(getQueues).mockResolvedValueOnce([queue('thumbnailGeneration')]);
    await manager.refresh();
    vi.mocked(getQueues).mockRejectedValueOnce(new Error('offline'));
    await manager.refresh();

    vi.mocked(getQueues).mockResolvedValueOnce([]);
    await manager.refresh();

    expect(manager.queues).toEqual([]);
  });

  it('keeps thirty readings of history', async () => {
    const manager = new QueueManager();
    vi.mocked(getQueues).mockResolvedValue([]);
    for (let index = 0; index < 32; index++) {
      await manager.refresh();
    }
    expect(manager.snapshots).toHaveLength(30);
  });
});
