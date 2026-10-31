import type { UserAdminResponseDto } from '@frameleaf/sdk';
import { beforeEach, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { addAssetsToAlbums } from '$lib/services/album.service';
import * as i18n from '$lib/utils/i18n';
import { preferencesFactory } from '@test-data/factories/preferences-factory';

const translate = ((key: string) => key) as Awaited<ReturnType<typeof i18n.getFormatter>>;
beforeEach(() => {
  vi.clearAllMocks();
  authManager.reset();
  authManager.setUser({ id: 'owner-a' } as UserAdminResponseDto);
  authManager.setPreferences(preferencesFactory.build());
  vi.spyOn(i18n, 'getFormatter').mockResolvedValue(translate);
  sdkMock.addAssetsToAlbum.mockReset().mockResolvedValue([]);
  sdkMock.addAssetsToAlbums.mockReset().mockResolvedValue({ success: true });
  vi.spyOn(eventManager, 'emit');
});

it.each([['album-a'], ['album-a', 'album-b']])(
  'does not dispatch album assignment after formatter setup outlives its account: %s',
  async (...albumIds) => {
    let complete: ((formatter: typeof translate) => void) | undefined;
    vi.mocked(i18n.getFormatter).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = addAssetsToAlbums(albumIds, ['asset-a'], { notify: false });
    authManager.setUser({ id: 'owner-b' } as UserAdminResponseDto);
    complete!(translate);
    await expect(pending).resolves.toBe(false);
    expect(sdkMock.addAssetsToAlbum).not.toHaveBeenCalled();
    expect(sdkMock.addAssetsToAlbums).not.toHaveBeenCalled();
    expect(eventManager.emit).not.toHaveBeenCalled();
  },
);

it('preserves the single-album request and event while the authority remains current', async () => {
  const assetIds = ['asset-a'];
  await expect(addAssetsToAlbums(['album-a'], assetIds, { notify: false })).resolves.toBe(true);
  expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledExactlyOnceWith({ id: 'album-a', bulkIdsDto: { ids: assetIds } });
  expect(eventManager.emit).toHaveBeenCalledExactlyOnceWith('AlbumAddAssets', { assetIds, albumIds: ['album-a'] });
});

it('does not announce a late album response to a different account', async () => {
  let complete: ((results: Awaited<ReturnType<typeof sdkMock.addAssetsToAlbum>>) => void) | undefined;
  sdkMock.addAssetsToAlbum.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const pending = addAssetsToAlbums(['album-a'], ['asset-a'], { notify: false });
  await vi.waitFor(() => expect(complete).toBeDefined());
  authManager.setUser({ id: 'owner-b' } as UserAdminResponseDto);
  complete!([]);
  await expect(pending).resolves.toBe(false);
  expect(eventManager.emit).not.toHaveBeenCalled();
});
