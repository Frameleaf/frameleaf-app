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
    expect(screen.getByLabelText('frameleaf_date_field_how_sure')).toHaveValue('day');
    expect(screen.getByLabelText('day')).toHaveValue(24);
    expect(screen.getByLabelText('month')).toHaveValue('9');
    expect(screen.getByLabelText('year')).toHaveValue(2026);
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
    await fireEvent.input(screen.getByLabelText('year'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
    expect(screen.getByText('frameleaf_info_enter_valid_date')).toBeInTheDocument();
  });

  it('refuses a day that does not exist, such as 31 April', async () => {
    render(ViewerDateDialog, { asset: assetFactory.build(), initialDate, onClose: vi.fn() });
    await fireEvent.change(screen.getByLabelText('month'), { target: { value: '4' } });
    await fireEvent.input(screen.getByLabelText('day'), { target: { value: '31' } });
    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
    expect(screen.getByText('frameleaf_date_field_not_a_day')).toBeInTheDocument();
  });

  describe('how sure (FL-936, FL-1814)', () => {
    const stored = (localDateTime: string, dateAccuracy: string | null = null, dateDetail: string | null = null) =>
      ({ ...assetFactory.build(), localDateTime, dateAccuracy, dateDetail }) as ReturnType<typeof assetFactory.build>;
    const sure = (value: string) =>
      fireEvent.change(screen.getByLabelText('frameleaf_date_field_how_sure'), { target: { value } });
    const saved = () => vi.mocked(updateAssets).mock.calls[0][0].assetBulkUpdateDto;

    it('saves a month as its 1st, with the detail', async () => {
      const asset = stored('1987-03-15T12:00:00.000Z');
      render(ViewerDateDialog, { asset, initialDate, onClose: vi.fn() });
      await sure('month');
      await fireEvent.change(screen.getByLabelText('month'), { target: { value: '3' } });
      await fireEvent.input(screen.getByLabelText('year'), { target: { value: '1987' } });
      expect(screen.queryByLabelText('day')).toBeNull();
      expect(screen.queryByLabelText('frameleaf_info_time_zone')).toBeNull();
      await fireEvent.click(screen.getByRole('button', { name: 'save' }));
      await waitFor(() => expect(updateAssets).toHaveBeenCalled());
      expect(saved()).toEqual({
        ids: [asset.id],
        dateTimeOriginal: '1987-03-01T00:00:00.000Z',
        dateAccuracy: 'year',
        dateDetail: 'month',
      });
    });

    it('saves around a year as the start of the year, and a year only without a detail', async () => {
      const asset = stored('1980-06-01T12:00:00.000Z');
      render(ViewerDateDialog, { asset, initialDate, onClose: vi.fn() });
      await sure('about');
      await fireEvent.input(screen.getByLabelText('year'), { target: { value: '1975' } });
      await fireEvent.click(screen.getByRole('button', { name: 'save' }));
      await waitFor(() => expect(updateAssets).toHaveBeenCalled());
      expect(saved()).toEqual({
        ids: [asset.id],
        dateTimeOriginal: '1975-01-01T00:00:00.000Z',
        dateAccuracy: 'year',
        dateDetail: 'about',
      });
    });

    it('opens a stored decade as it is and keeps it a decade', async () => {
      const asset = stored('1970-01-01T00:00:00.000Z', 'decade');
      render(ViewerDateDialog, { asset, onClose: vi.fn() });
      expect(screen.getByLabelText('frameleaf_date_field_how_sure')).toHaveValue('decade');
      expect(screen.getByLabelText('year')).toHaveValue(1970);
      await fireEvent.click(screen.getByRole('button', { name: 'save' }));
      await waitFor(() => expect(updateAssets).toHaveBeenCalled());
      expect(saved()).toEqual({
        ids: [asset.id],
        dateTimeOriginal: '1970-01-01T00:00:00.000Z',
        dateAccuracy: 'decade',
        dateDetail: null,
      });
    });

    it('opens a stored month as a month', () => {
      render(ViewerDateDialog, { asset: stored('1987-03-01T00:00:00.000Z', 'year', 'month'), onClose: vi.fn() });
      expect(screen.getByLabelText('frameleaf_date_field_how_sure')).toHaveValue('month');
      expect(screen.getByLabelText('month')).toHaveValue('3');
    });

    it('makes the date exact again without sending an accuracy', async () => {
      const asset = stored('1975-01-01T00:00:00.000Z', 'year');
      render(ViewerDateDialog, { asset, initialDate, initialTimeZone: 'Asia/Tokyo', onClose: vi.fn() });
      await sure('day');
      await fireEvent.input(screen.getByLabelText('day'), { target: { value: '24' } });
      await fireEvent.change(screen.getByLabelText('month'), { target: { value: '9' } });
      await fireEvent.input(screen.getByLabelText('year'), { target: { value: '2026' } });
      await fireEvent.input(screen.getByLabelText('time'), { target: { value: '18:05' } });
      await fireEvent.click(screen.getByRole('button', { name: 'save' }));
      await waitFor(() => expect(updateAssets).toHaveBeenCalled());
      expect(saved()).not.toHaveProperty('dateAccuracy');
      expect(saved().dateTimeOriginal).toBe('2026-09-24T18:05:00.000+09:00');
    });

    it('refuses a year out of range, with a message', async () => {
      render(ViewerDateDialog, { asset: stored('1975-01-01T00:00:00.000Z', 'year'), onClose: vi.fn() });
      await fireEvent.input(screen.getByLabelText('year'), { target: { value: '1700' } });
      expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
      expect(screen.getByText('frameleaf_date_year_range')).toBeInTheDocument();
    });
  });
});
