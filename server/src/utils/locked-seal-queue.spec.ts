import type { QueueExecution } from 'src/queue/types.js';
import { JobName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { queueLockedSealFor, queueLockedSealOf } from 'src/utils/locked-seal-queue.js';

describe('Locked seal publication', () => {
  const setup = () => ({
    asset: { getLockedEncryptionItems: vi.fn().mockResolvedValue([{ id: 'asset', pending: false }]) },
    lockedFile: { encryptedSetOwner: vi.fn().mockResolvedValue('owner') },
    job: { queueAll: vi.fn().mockResolvedValue(undefined) },
    logger: { warn: vi.fn() },
  });

  for (const queueSeal of [queueLockedSealFor, queueLockedSealOf]) {
    it(`${queueSeal.name} waits for generated file publication before queuing sealing`, async () => {
      const deps = setup();
      const context = {
        signal: new AbortController().signal,
        adoptions: [],
      } as unknown as QueueExecution;
      let published = false;
      context.adoptions.push(() => {
        published = true;
        return Promise.resolve();
      });
      deps.job.queueAll.mockImplementation(() => {
        expect(published).toBe(true);
        return Promise.resolve();
      });

      await queueExecution.run(context, () => queueSeal(deps, ['asset']));
      expect(deps.job.queueAll).not.toHaveBeenCalled();
      for (const adopt of context.adoptions) await adopt({} as never);
      expect(deps.job.queueAll).toHaveBeenCalledWith([{ name: JobName.LockedSeal, data: { id: 'asset' } }]);
    });

    it(`${queueSeal.name} still queues immediately outside a job`, async () => {
      const deps = setup();
      await queueSeal(deps, ['asset']);
      expect(deps.job.queueAll).toHaveBeenCalledWith([{ name: JobName.LockedSeal, data: { id: 'asset' } }]);
    });
  }
});
