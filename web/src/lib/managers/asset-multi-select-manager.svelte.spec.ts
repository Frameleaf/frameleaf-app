import { AssetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

describe('AssetMultiSelectManager', () => {
  let sut: AssetMultiSelectManager;

  beforeEach(() => {
    sut = new AssetMultiSelectManager();
  });

  it('tracks selection state as assets are selected and cleared', () => {
    const asset = timelineAssetFactory.build();

    expect(sut.selectionActive).toBe(false);

    sut.selectAsset(asset);
    expect(sut.selectionActive).toBe(true);
    expect(sut.hasSelectedAsset(asset.id)).toBe(true);

    sut.clear();
    expect(sut.selectionActive).toBe(false);
    expect(sut.hasSelectedAsset(asset.id)).toBe(false);
  });

  it('filters ownedAssets to the active user once authenticated', () => {
    const [user1, user2] = userAdminFactory.buildList(2);
    sut.selectAsset(timelineAssetFactory.build({ ownerId: user1.id }));

    const cleanup = $effect.root(() => {
      // Before authentication (e.g. a shared link), ownedAssets returns the full selection.
      expect(sut.ownedAssets).toHaveLength(1);

      authManager.setUser(user1);
      authManager.setPreferences(preferencesFactory.build());
      expect(sut.ownedAssets).toHaveLength(1);

      authManager.setUser(user2);
      expect(sut.ownedAssets).toHaveLength(0);
    });

    cleanup();
    authManager.reset();
  });
});
