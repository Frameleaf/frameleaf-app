import { updateAssets } from '@frameleaf/sdk';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { DateTime } from 'luxon';
import en from '$i18n/en.json';
import { assetFactory } from '@test-data/factories/asset-factory';
import ViewerDateDialog from './ViewerDateDialog.svelte';

vi.mock('@frameleaf/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@frameleaf/sdk')>('@frameleaf/sdk');
  return { ...sdk, updateAssets: vi.fn() };
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
      expect(updateAssets).toHaveBeenCalledWith({
        assetBulkUpdateDto: {
          ids: [asset.id],
          dateTimeOriginal: '2026-09-24T07:30:00.000+09:00',
          timeZone: 'Asia/Tokyo',
        },
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
      expect(updateAssets).toHaveBeenCalledWith({
        assetBulkUpdateDto: { ids: [asset.id], dateTimeOriginal: '2026-09-24T18:05:00.000Z', timeZone: 'UTC' },
      }),
    );
  });

  // LIB-02: America/Edmonton previewed 4:56 p.m. but saved as 3:56 p.m. in America/Vancouver, because only the
  // offset was sent; a zone with the same offset as the current one saved nothing at all
  it.each([
    ['America/Edmonton', '2026-06-21T16:56:00.000-06:00'],
    ['America/Los_Angeles', '2026-06-21T16:56:00.000-07:00'],
  ])('keeps the chosen zone %s by name with the previewed wall time', async (chosen, dateTimeOriginal) => {
    const asset = assetFactory.build();
    const capture = DateTime.fromISO('2026-06-21T16:56:00', { zone: 'America/Vancouver' });
    render(ViewerDateDialog, { asset, initialDate: capture, initialTimeZone: 'America/Vancouver', onClose: vi.fn() });

    await fireEvent.change(screen.getByLabelText('frameleaf_info_time_zone'), { target: { value: chosen } });
    await fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(updateAssets).toHaveBeenCalledWith({
        assetBulkUpdateDto: { ids: [asset.id], dateTimeOriginal, timeZone: chosen },
      }),
    );
  });

  // LIB-02: the time can end in "p.m.", which left "p.m.." at the end of the line
  it('ends the preview line with the time, not a full stop', () => {
    expect(en.frameleaf_info_capture_time_becomes).toMatch(/\{time\}$/);
  });

  it('refuses an incomplete date', async () => {
    render(ViewerDateDialog, { asset: assetFactory.build(), initialDate, onClose: vi.fn() });
    await fireEvent.input(screen.getByLabelText('date'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
    expect(screen.getByText('frameleaf_info_enter_valid_date')).toBeInTheDocument();
  });
});
