import { emptyQueue, getQueue, QueueCommand, QueueName, runQueueCommandLegacy } from '@immich/sdk';
import { handleClearFailedJobs, handleClearWaitingJobs } from '$lib/services/queue.service';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  emptyQueue: vi.fn(),
  getQueue: vi.fn(),
  runQueueCommandLegacy: vi.fn(),
}));
vi.mock('$lib/managers/event-manager.svelte', () => ({ eventManager: { emit: vi.fn(), on: vi.fn() } }));

/**
 * The Job manager's clear commands (FL-71): "Remove failed records" must leave waiting, delayed and
 * active jobs alone, which only the queue command's ClearFailed does (`emptyQueue` with `failed`
 * also drains the waiting jobs); "Clear waiting jobs" keeps the failed records.
 */
describe('queue clear commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getQueue).mockResolvedValue({} as never);
  });

  it('removes failed records without emptying the waiting jobs', async () => {
    await handleClearFailedJobs({ name: QueueName.Ocr });

    expect(runQueueCommandLegacy).toHaveBeenCalledWith({
      name: QueueName.Ocr,
      queueCommandDto: { command: QueueCommand.ClearFailed, force: false },
    });
    expect(emptyQueue).not.toHaveBeenCalled();
  });

  it('clears waiting jobs and keeps the failed records', async () => {
    await handleClearWaitingJobs({ name: QueueName.Ocr });

    expect(emptyQueue).toHaveBeenCalledWith({ name: QueueName.Ocr, queueDeleteDto: { failed: false } });
    expect(runQueueCommandLegacy).not.toHaveBeenCalled();
  });
});
