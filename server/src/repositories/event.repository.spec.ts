import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

type Handler = (...args: unknown[]) => Promise<void>;

const setup = (event: string, handlers: Handler[]) => {
  const logger = { setContext: vi.fn(), error: vi.fn() };
  const sut = new EventRepository({} as never, {} as never, logger as unknown as LoggingRepository);
  (sut as unknown as { emitHandlers: Record<string, unknown[]> }).emitHandlers = {
    [event]: handlers.map((handler, index) => ({ event, handler, server: false, label: `Handler${index}` })),
  };
  return { sut, logger };
};

describe(EventRepository.name, () => {
  describe('AssetDelete (FL-169)', () => {
    it('runs every handler though an earlier one throws, and logs the failure', async () => {
      const revoke = vi.fn(async () => {});
      const cleanup = vi.fn(async () => {});
      const { sut, logger } = setup('AssetDelete', [
        vi.fn(async () => {
          throw new Error('move history unavailable');
        }),
        revoke,
        cleanup,
      ]);

      await expect(sut.emit('AssetDelete', { assetId: 'asset-1', userId: 'user-1' })).resolves.toBeUndefined();

      expect(revoke).toHaveBeenCalledWith({ assetId: 'asset-1', userId: 'user-1' });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('AssetDelete handler Handler0 failed'),
        expect.any(String),
      );
    });
  });

  it('still stops other events at the first failure and rethrows it', async () => {
    const next = vi.fn(async () => {});
    const { sut } = setup('AssetTrash', [
      vi.fn(async () => {
        throw new Error('handler failed');
      }),
      next,
    ]);

    await expect(sut.emit('AssetTrash', { assetId: 'asset-1', userId: 'user-1' })).rejects.toThrow('handler failed');

    expect(next).not.toHaveBeenCalled();
  });
});
