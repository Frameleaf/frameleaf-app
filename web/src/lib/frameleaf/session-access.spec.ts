import { describe, expect, it, vi } from 'vitest';
import { closeSessionModals, trackSessionModals } from '$lib/frameleaf/session-access.svelte';

describe('closeSessionModals', () => {
  it('retries a modal whose close was rejected instead of replaying the rejection', async () => {
    const close = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce(undefined);
    const manager = {
      open: () => ({ onClose: new Promise(() => {}), close }),
    } as unknown as typeof import('@immich/ui').modalManager;
    trackSessionModals(manager);
    manager.open({} as never);

    await expect(closeSessionModals()).rejects.toThrow('busy');
    await expect(closeSessionModals()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });
});
