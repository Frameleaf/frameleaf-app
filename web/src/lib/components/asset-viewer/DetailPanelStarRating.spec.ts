import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import DetailPanelStarRating from '$lib/components/asset-viewer/DetailPanelStarRating.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../i18n/en.json';

/**
 * FL-36 / FL-83: the information panel's rating. Setting and clearing are the same `updateAsset`
 * change; clearing sends no rating (`null`).
 */

const owned = (rating: number | null) =>
  assetFactory.build({ ownerId: 'owner', isTrashed: false, exifInfo: { rating } as never });

describe('DetailPanelStarRating', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.resetAllMocks();
    authManager.setUser(userAdminFactory.build({ id: 'owner' }));
    const preferences = preferencesFactory.build();
    authManager.setPreferences({ ...preferences, ratings: { ...preferences.ratings, enabled: true } });
    sdkMock.updateAsset.mockResolvedValue(owned(null));
  });
  afterEach(() => authManager.reset());

  it('sets a rating', async () => {
    const asset = owned(null);
    const onAssetRefresh = vi.fn();
    render(DetailPanelStarRating, { asset, isOwner: true, onAssetRefresh });

    await userEvent.click(screen.getByLabelText('4 stars'));

    await waitFor(() =>
      expect(sdkMock.updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { rating: 4 } }),
    );
    expect(onAssetRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ exifInfo: { rating: 4, isRejected: false } }),
    );
  });

  it('clears a rating with no rating at all', async () => {
    const asset = owned(3);
    const onAssetRefresh = vi.fn();
    render(DetailPanelStarRating, { asset, isOwner: true, onAssetRefresh });

    await userEvent.click(screen.getByRole('button', { name: en.clear }));

    expect(sdkMock.updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { rating: null } });
    await waitFor(() =>
      expect(onAssetRefresh).toHaveBeenCalledWith(
        expect.objectContaining({ exifInfo: { rating: null, isRejected: false } }),
      ),
    );
  });

  it('shows and clears a rejected EXIF response', async () => {
    const asset = owned(null);
    asset.exifInfo = { rating: null, isRejected: true };
    const onAssetRefresh = vi.fn();
    render(DetailPanelStarRating, { asset, isOwner: true, onAssetRefresh });
    expect(screen.getByText(en.frameleaf_library_rating_rejected)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: en.clear }));
    await waitFor(() =>
      expect(onAssetRefresh).toHaveBeenCalledWith(
        expect.objectContaining({ exifInfo: { rating: null, isRejected: false } }),
      ),
    );
    expect(sdkMock.updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { rating: null } });
  });

  it('cannot clear what is not rated', () => {
    render(DetailPanelStarRating, { asset: owned(null), isOwner: true });
    expect(screen.getByRole('button', { name: en.clear })).toBeDisabled();
  });
});
