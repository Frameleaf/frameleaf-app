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
const { confirmRequest } = vi.hoisted(() => ({ confirmRequest: vi.fn<(options: unknown) => Promise<boolean>>() }));
vi.mock('$lib/frameleaf/confirm', () => ({ confirmFrameleaf: confirmRequest }));

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

  it('removes the location after the owner confirms it (FL-51, FL-146)', async () => {
    const asset = located();
    const updated = { ...asset };
    vi.mocked(updateAsset).mockResolvedValue(updated);
    confirmRequest.mockResolvedValue(true);
    const onClose = vi.fn();
    render(ViewerLocationDialog, { asset, onClose });

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_info_remove_location' }));

    await waitFor(() =>
      expect(updateAsset).toHaveBeenCalledWith({
        id: asset.id,
        updateAssetDto: { latitude: null, longitude: null },
      }),
    );
    expect(confirmRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'frameleaf_info_remove_location_title',
        prompt: 'frameleaf_info_remove_location_prompt',
        confirmText: 'frameleaf_info_remove_location',
        danger: true,
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(updated));
  });

  it('keeps the location and the dialog when the owner chooses Keep', async () => {
    confirmRequest.mockResolvedValue(false);
    const onClose = vi.fn();
    render(ViewerLocationDialog, { asset: located(), onClose });

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_info_remove_location' }));

    await waitFor(() => expect(confirmRequest).toHaveBeenCalledOnce());
    expect(updateAsset).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // every field is as it was, so a later Save changes nothing
    expect(screen.getByLabelText('latitude')).toHaveValue('51.4');
    expect(screen.getByLabelText('longitude')).toHaveValue('-116.2');
    expect(screen.getByLabelText('city')).toHaveValue('Banff');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { name: 'edit_location' })).toBeInTheDocument();
  });

  it('says a Live Photo video loses its location too, and confirms emptied coordinates as a removal', async () => {
    const asset = { ...located(), livePhotoVideoId: 'motion-1' };
    vi.mocked(updateAsset).mockResolvedValue(asset);
    confirmRequest.mockResolvedValue(true);
    render(ViewerLocationDialog, { asset, onClose: vi.fn() });

    await fireEvent.input(screen.getByLabelText('latitude'), { target: { value: '' } });
    await fireEvent.input(screen.getByLabelText('longitude'), { target: { value: '' } });
    expect(screen.queryByRole('alert')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(confirmRequest).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'frameleaf_info_remove_location_prompt_live' }),
      ),
    );
    await waitFor(() =>
      expect(updateAsset).toHaveBeenCalledWith({ id: asset.id, updateAssetDto: { latitude: null, longitude: null } }),
    );
  });

  it('offers no removal for an item without a location', () => {
    render(ViewerLocationDialog, { asset: assetFactory.build({ exifInfo: {} }), onClose: vi.fn() });
    expect(screen.queryByRole('button', { name: 'frameleaf_info_remove_location' })).toBeNull();
  });

  it('refuses a lone coordinate', async () => {
    render(ViewerLocationDialog, { asset: located(), onClose: vi.fn() });
    await fireEvent.input(screen.getByLabelText('longitude'), { target: { value: '' } });
    expect(screen.getByRole('alert')).toHaveTextContent('frameleaf_info_coordinates_invalid');
    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
  });
});
