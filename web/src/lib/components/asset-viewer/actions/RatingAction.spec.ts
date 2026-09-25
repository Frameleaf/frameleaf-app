import { updateAsset } from '@immich/sdk';
import '@testing-library/jest-dom';
import { fireEvent, waitFor } from '@testing-library/svelte';
import { AssetAction } from '$lib/constants';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import RatingAction from './RatingAction.svelte';

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return { ...sdk, updateAsset: vi.fn() };
});

describe('RatingAction (V-3)', () => {
  beforeEach(() => {
    authManager.setUser(userAdminFactory.build({ id: 'owner' }));
    authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: true } }));
  });

  afterEach(() => {
    authManager.reset();
    vi.clearAllMocks();
  });

  const render = (rating: number | null) => {
    const onAction = vi.fn();
    const asset = assetFactory.build({ ownerId: 'owner', exifInfo: { rating } });
    return { onAction, asset, ...renderWithTooltips(RatingAction, { asset, onAction }) };
  };

  it('names the current rating on the button', () => {
    const { getByTestId } = render(3);
    expect(getByTestId('viewer-rating-button')).toHaveAttribute('aria-label', 'frameleaf_viewer_rating_label');
  });

  it('opens five stars and Clear, and rates through the asset update', async () => {
    const { getByTestId, getByRole, getAllByRole, onAction, asset } = render(null);
    await fireEvent.click(getByTestId('viewer-rating-button'));

    const group = getByRole('group', { name: 'frameleaf_viewer_rate_item' });
    expect(group).toBeInTheDocument();
    expect(getAllByRole('button', { name: 'frameleaf_viewer_rate_stars' })).toHaveLength(5);
    expect(getByRole('button', { name: 'clear' })).toBeDisabled();

    await fireEvent.click(getAllByRole('button', { name: 'frameleaf_viewer_rate_stars' })[3]);
    await waitFor(() => expect(updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { rating: 4 } }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: AssetAction.RATING, rating: 4 }));
  });

  it('clears the rating when the current star is pressed again', async () => {
    const { getByTestId, getAllByRole, asset } = render(2);
    await fireEvent.click(getByTestId('viewer-rating-button'));
    await fireEvent.click(getAllByRole('button', { name: 'frameleaf_viewer_rate_stars' })[1]);
    await waitFor(() => expect(updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { rating: null } }));
  });

  it('closes on Escape and returns focus to the button', async () => {
    const { getByTestId, getByRole, queryByRole } = render(1);
    await fireEvent.click(getByTestId('viewer-rating-button'));
    await fireEvent.keyDown(getByRole('group', { name: 'frameleaf_viewer_rate_item' }), { key: 'Escape' });
    expect(queryByRole('group', { name: 'frameleaf_viewer_rate_item' })).not.toBeInTheDocument();
    expect(getByTestId('viewer-rating-button')).toHaveFocus();
  });

  it('is absent when ratings are turned off', () => {
    authManager.setPreferences(preferencesFactory.build({ ratings: { enabled: false } }));
    const { queryByTestId } = render(3);
    expect(queryByTestId('viewer-rating-button')).not.toBeInTheDocument();
  });
});
