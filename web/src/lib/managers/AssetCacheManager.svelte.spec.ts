import { getAssetInfo, getAssetOcr, getFaces } from '@immich/sdk';
import { assetFactory } from '@test-data/factories/asset-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import { assetCacheManager } from './AssetCacheManager.svelte';
import { eventManager } from './event-manager.svelte';

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<object>()),
  getAssetInfo: vi.fn(),
  getAssetOcr: vi.fn(),
  getFaces: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  assetCacheManager.invalidate();
});

const families = [
  {
    name: 'asset',
    fetch: vi.mocked(getAssetInfo),
    load: () => assetCacheManager.getAsset({ id: 'private' }),
    value: assetFactory.build({ id: 'private' }),
  },
  { name: 'faces', fetch: vi.mocked(getFaces), load: () => assetCacheManager.getAssetFaces('private'), value: [] },
  { name: 'OCR', fetch: vi.mocked(getAssetOcr), load: () => assetCacheManager.getAssetOcr('private'), value: [] },
] as const;

for (const family of families) {
  it.each(['lock', 'account', 'asset update'] as const)(
    `${family.name} rejects a pending response and clears cached evidence on %s`,
    async (change) => {
      const invalidate = () => {
        if (change === 'lock') {
          eventManager.emit('SessionLocked');
        } else if (change === 'account') {
          eventManager.emit('AuthUserLoaded', userAdminFactory.build());
        } else {
          eventManager.emit('AssetUpdate', assetFactory.build({ id: 'private' }));
        }
      };
      let resolve!: (value: unknown) => void;
      family.fetch.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }) as never,
      );
      const pending = family.load();
      invalidate();
      resolve(family.value);
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      family.fetch.mockResolvedValue(family.value as never);
      await family.load();
      await family.load();
      expect(family.fetch).toHaveBeenCalledTimes(2);
      invalidate();
      await family.load();
      expect(family.fetch).toHaveBeenCalledTimes(3);
    },
  );
}

it('lets a pending response resolve across a plain refresh', async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(getAssetOcr).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }) as never,
  );
  const pending = assetCacheManager.getAssetOcr('neighbour');
  assetCacheManager.invalidate();
  resolve([]);
  await expect(pending).resolves.toEqual([]);
});
