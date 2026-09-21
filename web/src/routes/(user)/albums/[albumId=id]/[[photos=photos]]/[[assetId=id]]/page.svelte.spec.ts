import { AlbumUserRole } from '@immich/sdk';
import { fireEvent, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { albumFactory } from '@test-data/factories/album-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import AlbumPage from './+page.svelte';

vi.mock('$app/navigation', () => ({
  afterNavigate: vi.fn(),
  beforeNavigate: vi.fn(),
  goto: vi.fn(),
  onNavigate: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('$lib/elements/HotModuleReload.svelte', async () => {
  const { default: component } = await import('@test-data/components/MockText.svelte');
  return { default: component };
});
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: {} } }));

it('uses the real album action to switch the retained manager to its library picker', async () => {
  sdkMock.getTimeBuckets.mockResolvedValue([]);
  const user = userAdminFactory.build();
  authManager.setUser(user);
  authManager.setPreferences(preferencesFactory.build());
  const album = albumFactory.build({ assetCount: 0, albumUsers: [{ user, role: AlbumUserRole.Editor }] });
  const destroy = vi.spyOn(TimelineManager.prototype, 'destroy');
  const view = renderWithTooltips(AlbumPage, {
    data: { error: undefined, asset: undefined, album, ownedAlbums: [], meta: { title: album.albumName } },
  });
  await waitFor(() =>
    expect(sdkMock.getTimeBuckets.mock.calls.at(-1)?.[0]).toMatchObject({ albumId: album.id, order: album.order }),
  );
  await fireEvent.click(view.getByRole('button', { name: 'select_photos' }));
  await waitFor(() =>
    expect(sdkMock.getTimeBuckets.mock.calls.at(-1)?.[0]).toMatchObject({
      timelineAlbumId: album.id,
      withPartners: true,
    }),
  );
  expect(sdkMock.getTimeBuckets.mock.calls.at(-1)?.[0]).not.toHaveProperty('albumId');
  expect(sdkMock.updateAlbumInfo).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
  view.unmount();
  expect(destroy).toHaveBeenCalledOnce();
  destroy.mockRestore();
});
