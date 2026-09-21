import { ArchiveOperationService } from 'src/services/archive-operation.service.js';

it('returns the durable receipt when Redis dispatch fails and the drain recovers the same operation', async () => {
  const receipt = { id: 'recorded', pending: 2 };
  const repository = {
    create: vi.fn().mockResolvedValue('recorded'),
    get: vi.fn().mockResolvedValue(receipt),
    pending: vi.fn().mockResolvedValue(['recorded']),
  };
  const jobs = {
    queue: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
    queueAll: vi.fn().mockResolvedValue(undefined),
  };
  const logger = { warn: vi.fn() };
  const service = new ArchiveOperationService(
    repository as never,
    jobs as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    logger as never,
  );
  expect(await service.create({ user: { id: 'owner' } } as never, {} as never)).toEqual(receipt);
  await service.dispatchPending();
  expect(jobs.queueAll).toHaveBeenCalledWith([{ name: 'ArchiveOperation', data: { id: 'recorded' } }]);
  expect(repository.create).toHaveBeenCalledTimes(1);
});
