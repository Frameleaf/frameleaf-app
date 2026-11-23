import { offerScanSplit } from '@frameleaf/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { scanOffers } from '$lib/stores/scan-offers.svelte';
import { setupProgress } from '$lib/stores/setup-progress.svelte';

vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  offerScanSplit: vi.fn(),
}));

describe('stores holding one account’s state', () => {
  it('drops scan offers at sign-out', async () => {
    vi.mocked(offerScanSplit).mockResolvedValue({ printCount: 2, inScanAlbum: true } as never);
    scanOffers.check('asset-1', 'private-name.jpg');
    await vi.waitFor(() => expect(scanOffers.current?.name).toBe('private-name.jpg'));

    eventManager.emit('AuthLogout');

    expect(scanOffers.offers).toEqual([]);
  });

  it('drops setup progress at sign-out and ignores an answer from before it', () => {
    setupProgress.progress = { active: true, completedAt: null } as never;
    const inFlight = ++setupProgress.requested;

    eventManager.emit('AuthLogout');

    expect(setupProgress.progress).toBeNull();
    expect(inFlight <= setupProgress.applied).toBe(true);
    expect(++setupProgress.requested > setupProgress.applied).toBe(true);
  });
});
