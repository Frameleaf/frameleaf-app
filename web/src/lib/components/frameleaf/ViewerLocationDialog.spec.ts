import { updateAsset } from '@immich/sdk';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import ViewerLocationDialog from './ViewerLocationDialog.svelte';

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return { ...sdk, updateAsset: vi.fn() };
});
vi.mock('$lib/components/shared-components/map/Map.svelte', () => ({ default: () => {} }));

describe('ViewerLocationDialog (V-24)', () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const located = () =>
    assetFactory.build({
      exifInfo: { latitude: 51.4, longitude: -116.2, city: 'Banff', state: 'Alberta', country: 'Canada' },
    });

  it('shows the place and the coordinates', () => {
    render(ViewerLocationDialog, { asset: located(), onClose: vi.fn() });
    expect(screen.getByRole('heading', { name: 'edit_location' })).toBeInTheDocument();
    expect(screen.getByLabelText('city')).toHaveValue('Banff');
    expect(screen.getByLabelText('frameleaf_info_state_or_region')).toHaveValue('Alberta');
    expect(screen.getByLabelText('country')).toHaveValue('Canada');
    expect(screen.getByLabelText('latitude')).toHaveValue('51.4');
  });

  it('saves a typed place name', async () => {
    const asset = located();
    const updated = { ...asset };
    vi.mocked(updateAsset).mockResolvedValue(updated);
    const onClose = vi.fn();
    render(ViewerLocationDialog, { asset, onClose });

    await fireEvent.input(screen.getByLabelText('city'), { target: { value: 'Lake Louise' } });
    await fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { city: 'Lake Louise' } }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(updated));
  });

  it('moves the pin with the arrow keys', async () => {
    const asset = located();
    vi.mocked(updateAsset).mockResolvedValue(asset);
    render(ViewerLocationDialog, { asset, onClose: vi.fn() });

    await fireEvent.keyDown(screen.getByRole('application'), { key: 'ArrowUp' });
    expect(screen.getByLabelText('latitude')).toHaveValue('51.405');
    await fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() =>
      expect(updateAsset).toHaveBeenCalledWith({
        id: asset.id,
        updateAssetDto: { latitude: 51.405, longitude: -116.2 },
      }),
    );
  });

  it('cannot remove the coordinates of a located item', async () => {
    render(ViewerLocationDialog, { asset: located(), onClose: vi.fn() });
    await fireEvent.input(screen.getByLabelText('latitude'), { target: { value: '' } });
    await fireEvent.input(screen.getByLabelText('longitude'), { target: { value: '' } });
    expect(screen.getByRole('alert')).toHaveTextContent('frameleaf_info_coordinates_required');
    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
  });
});
