import { boundPoolClose } from 'src/utils/database.js';
import { DATABASE_CLOSE_TIMEOUT_SECONDS, RESTART_BUDGET } from 'src/utils/shutdown.js';

describe(boundPoolClose.name, () => {
  it('closes the pool with a timeout when the driver asks for none (FL-299)', async () => {
    const end = vi.fn(() => Promise.resolve());

    await boundPoolClose({ end }).end();

    expect(end).toHaveBeenCalledWith({ timeout: DATABASE_CLOSE_TIMEOUT_SECONDS });
  });

  it('keeps a timeout the caller chose', async () => {
    const end = vi.fn((_options?: { timeout?: number }) => Promise.resolve());

    await boundPoolClose({ end }).end({ timeout: 0 });

    expect(end).toHaveBeenCalledWith({ timeout: 0 });
  });

  it('fits between the grace period and the worker deadline of a restart', () => {
    expect(DATABASE_CLOSE_TIMEOUT_SECONDS * 1000).toBeLessThan(
      RESTART_BUDGET.workerDeadlineMs - RESTART_BUDGET.graceMs,
    );
  });
});
