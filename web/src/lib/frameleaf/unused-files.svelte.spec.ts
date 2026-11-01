import { getUtilitiesSummary } from '@frameleaf/sdk';
import { unusedFilesAccess } from '$lib/frameleaf/unused-files.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { deferredPromise } from '@test-data/deferred';

vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  getUtilitiesSummary: vi.fn(),
}));

type Summary = Awaited<ReturnType<typeof getUtilitiesSummary>>;
const summary = (unusedFiles: number | null) => ({ unusedFiles, unusedBytes: 100 }) as unknown as Summary;

describe('Unused files access (FL-416)', () => {
  beforeEach(() => {
    unusedFilesAccess.reset();
    vi.mocked(getUtilitiesSummary).mockReset();
  });

  it('drops an answer from before a sign-out, even when the same account signs straight back in', async () => {
    const stale = deferredPromise<Summary>();
    const fresh = deferredPromise<Summary>();
    vi.mocked(getUtilitiesSummary).mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);

    const first = unusedFilesAccess.load('user-a', true);
    eventManager.emit('AuthLogout');
    const second = unusedFilesAccess.load('user-a', true);

    stale.resolve(summary(1));
    await first;
    expect(unusedFilesAccess.totals).toBeNull();
    expect(unusedFilesAccess.loaded).toBe(false);

    fresh.resolve(summary(2));
    await second;
    expect(unusedFilesAccess.totals).toEqual({ files: 2, bytes: 100 });
    expect(unusedFilesAccess.loaded).toBe(true);
  });
});
