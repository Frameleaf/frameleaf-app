import { AssetVisibility } from '@immich/sdk';
import { waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import Photos from './+page.svelte';

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: {} } }));
vi.mock('$app/navigation', () => ({
  afterNavigate: vi.fn(),
  beforeNavigate: vi.fn(),
  goto: vi.fn(),
  onNavigate: vi.fn(),
}));
vi.mock('$lib/elements/HotModuleReload.svelte', async () => {
  const { default: component } = await import('@test-data/components/MockText.svelte');
  return { default: component };
});
vi.mock('$lib/managers/memory-manager.svelte', () => ({ memoryManager: { memories: [], setFilters: vi.fn() } }));

it('uses the route-owned library scope and destroys it exactly once when leaving the route', async () => {
  sdkMock.getTimeBuckets.mockResolvedValue([]);
  sdkMock.getNotifications.mockResolvedValue([]);
  authManager.setUser(userAdminFactory.build());
  authManager.setPreferences(preferencesFactory.build());
  const destroy = vi.spyOn(TimelineManager.prototype, 'destroy');
  const view = renderWithTooltips(Photos, {});
  await waitFor(() =>
    expect(sdkMock.getTimeBuckets).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: AssetVisibility.Timeline, withPartners: true, withStacked: true }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  );
  view.unmount();
  expect(destroy).toHaveBeenCalledOnce();
  destroy.mockRestore();
});
