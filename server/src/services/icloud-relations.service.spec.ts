import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { ICloudRelationsService } from 'src/services/icloud-relations.service.js';
import type { ICloudRelationsRepository } from 'src/repositories/icloud-relations.repository.js';

describe('iCloud relations service lifetime and dispatch', () => {
  const fixture = () => {
    const repository = {
      enqueuePending: vi.fn<ICloudRelationsRepository['enqueuePending']>().mockResolvedValue(0),
      resolveEffectOwner: vi.fn<ICloudRelationsRepository['resolveEffectOwner']>().mockResolvedValue(undefined),
      dispatchOwnerEffects: vi.fn<ICloudRelationsRepository['dispatchOwnerEffects']>().mockResolvedValue(false),
      resolveLocalTarget: vi
        .fn<ICloudRelationsRepository['resolveLocalTarget']>()
        .mockResolvedValue({ id: 'accepted', ownerId: 'owner' }),
      reconcile: vi.fn<ICloudRelationsRepository['reconcile']>().mockResolvedValue(true),
      dispatchEvent: vi.fn<ICloudRelationsRepository['dispatchEvent']>().mockResolvedValue(false),
    };
    const events = { emit: vi.fn().mockResolvedValue(undefined) };
    const cron = { create: vi.fn() };
    const logger = { warn: vi.fn() };
    const sut = new ICloudRelationsService(repository as never, events as never, cron as never, logger as never);
    return { sut, repository, events, cron, logger };
  };

  it('does not register a cron job when shutdown begins during bootstrap dispatch', async () => {
    const f = fixture();
    const pending = Promise.withResolvers<number>();
    f.repository.enqueuePending.mockReturnValue(pending.promise);
    const bootstrap = f.sut.onBootstrap();
    const shutdown = f.sut.onShutdown();
    pending.resolve(0);
    await Promise.all([bootstrap, shutdown]);
    expect(f.cron.create).not.toHaveBeenCalled();
  });

  it('coalesces concurrent wakes, waits for dispatch during shutdown and refuses later wakes', async () => {
    const f = fixture();
    const pending = Promise.withResolvers<number>();
    f.repository.enqueuePending.mockReturnValue(pending.promise);
    const first = f.sut.enqueue();
    const second = f.sut.enqueue();
    let stopped = false;
    const shutdown = f.sut.onShutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(f.repository.enqueuePending).toHaveBeenCalledOnce();
    pending.resolve(0);
    await Promise.all([first, second, shutdown]);
    await f.sut.enqueue();
    expect(f.repository.enqueuePending).toHaveBeenCalledOnce();
  });

  it('logs a failed cron wake and permits the next tick to recover the durable marker', async () => {
    const f = fixture();
    await f.sut.onBootstrap();
    const onTick = f.cron.create.mock.calls[0][0].onTick as () => Promise<void>;
    f.repository.enqueuePending.mockRejectedValueOnce(new Error('queue unavailable'));
    await onTick();
    expect(f.logger.warn).toHaveBeenCalledWith(
      'Local edit relations dispatch failed; durable decisions remain pending',
    );
    await onTick();
    expect(f.repository.enqueuePending).toHaveBeenCalledTimes(3);
  });

  it('uses the accepted claim target instead of the replacement payload', async () => {
    const f = fixture();
    const context = { claim: { name: JobName.ICloudRelations, queue: QueueName.BackgroundTask } };
    const result = await queueExecution.run(context as never, () =>
      f.sut.handleLocalRelations({ id: 'foreign', ownerId: 'foreign' }),
    );
    expect(result).toBe(JobStatus.Success);
    expect(f.repository.resolveLocalTarget).toHaveBeenCalledOnce();
    expect(f.repository.reconcile).toHaveBeenCalledWith('accepted', 'owner');
  });

  it('bounds an accepted owner-effect drain without consulting the payload target', async () => {
    const f = fixture();
    f.repository.resolveEffectOwner.mockResolvedValue('owner');
    f.repository.dispatchOwnerEffects.mockResolvedValue(true);
    const result = await queueExecution.run(
      { claim: { name: JobName.ICloudRelations, queue: QueueName.BackgroundTask } } as never,
      () => f.sut.handleLocalRelations({ id: 'foreign', ownerId: 'foreign' }),
    );
    expect(result).toBe(JobStatus.Failed);
    expect(f.repository.dispatchOwnerEffects).toHaveBeenCalledTimes(25);
    expect(f.repository.dispatchOwnerEffects).toHaveBeenCalledWith('owner', expect.any(Function));
    expect(f.repository.reconcile).not.toHaveBeenCalled();
  });

  it('dispatches committed events with the requested owner and flushes before and after reconciliation', async () => {
    const f = fixture();
    f.repository.dispatchEvent.mockImplementationOnce(async (_id, _owner, send) => {
      await send({ name: 'AssetHide', assetId: 'asset', userId: 'foreign' });
      return true;
    });
    await expect(f.sut.reconcile('connection', 'owner')).resolves.toBe(true);
    expect(f.events.emit).toHaveBeenCalledWith('AssetHide', { assetId: 'asset', userId: 'owner' });
    expect(f.repository.dispatchEvent).toHaveBeenCalledTimes(3);
    expect(f.repository.reconcile).toHaveBeenCalledWith('connection', 'owner');
  });

  it('propagates a failed event send before performing new relationship writes', async () => {
    const f = fixture();
    f.repository.dispatchEvent.mockImplementationOnce(async (_id, _owner, send) => {
      await send({ name: 'StackCreate', stackId: 'stack', userId: 'owner' });
      return true;
    });
    f.events.emit.mockRejectedValueOnce(new Error('dispatch failed'));
    await expect(f.sut.reconcile('connection', 'owner')).rejects.toThrow('dispatch failed');
    expect(f.repository.reconcile).not.toHaveBeenCalled();
  });
});
