import { updateAsset } from '@immich/sdk';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { DateTime } from 'luxon';
import { assetFactory } from '@test-data/factories/asset-factory';
import ViewerDateDialog from './ViewerDateDialog.svelte';

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return { ...sdk, updateAsset: vi.fn() };
});

describe('ViewerDateDialog (V-23)', () => {
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

  const initialDate = DateTime.fromISO('2026-09-24T18:05:00', { zone: 'Asia/Tokyo' });

  it('starts from the current capture time and keeps the time zone by default', () => {
    render(ViewerDateDialog, {
      asset: assetFactory.build(),
      initialDate,
      initialTimeZone: 'Asia/Tokyo',
      onClose: vi.fn(),
    });
    expect(screen.getByLabelText('date')).toHaveValue('2026-09-24');
    expect(screen.getByLabelText('time')).toHaveValue('18:05');
    expect(screen.getByLabelText('frameleaf_info_time_zone')).toHaveValue('');
    expect(screen.getByText('frameleaf_info_capture_time_becomes')).toBeInTheDocument();
  });

  it('saves the new time in the current zone', async () => {
    const onClose = vi.fn();
    const asset = assetFactory.build();
    render(ViewerDateDialog, { asset, initialDate, initialTimeZone: 'Asia/Tokyo', onClose });

    await fireEvent.input(screen.getByLabelText('time'), { target: { value: '07:30' } });
    await fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(updateAsset).toHaveBeenCalledWith({
        id: asset.id,
        updateAssetDto: { dateTimeOriginal: '2026-09-24T07:30:00.000+09:00' },
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
  });

  it('writes the chosen zone', async () => {
    const asset = assetFactory.build();
    render(ViewerDateDialog, { asset, initialDate, initialTimeZone: 'Asia/Tokyo', onClose: vi.fn() });

    await fireEvent.change(screen.getByLabelText('frameleaf_info_time_zone'), { target: { value: 'UTC' } });
    await fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(updateAsset).toHaveBeenCalledWith({
        id: asset.id,
        updateAssetDto: { dateTimeOriginal: '2026-09-24T18:05:00.000Z' },
      }),
    );
  });

  it('refuses an incomplete date', async () => {
    render(ViewerDateDialog, { asset: assetFactory.build(), initialDate, onClose: vi.fn() });
    await fireEvent.input(screen.getByLabelText('date'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
    expect(screen.getByText('frameleaf_info_enter_valid_date')).toBeInTheDocument();
  });
});
