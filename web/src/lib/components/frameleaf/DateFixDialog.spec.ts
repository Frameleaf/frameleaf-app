import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { renderWithTooltips } from '$tests/helpers';
import en from '../../../../../i18n/en.json';
import DateFixDialog from './DateFixDialog.svelte';

/** The timeline's "Fix dates" (FL-943): a zone or a clock shift, previewed by the Date & Time Doctor, then applied. */
describe('DateFixDialog (FL-943)', () => {
  beforeAll(() => {
    addMessages('dev', en);
    Element.prototype.scrollIntoView ??= () => {};
    vi.stubGlobal('visualViewport', null);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.previewDateFix.mockImplementation(({ dateDoctorFixDto }) =>
      Promise.resolve({
        items: dateDoctorFixDto.assetIds.map((assetId) => ({
          assetId,
          before: { date: '2026-08-12T22:40:00.000Z', zone: 'America/Edmonton', local: '2026-08-12T16:40:00' },
          after: { date: '2026-08-12T15:40:00.000Z', zone: 'America/Edmonton', local: '2026-08-12T09:40:00' },
        })),
      }),
    );
    sdkMock.getBaseUrl.mockReturnValue('/api');
    sdkMock.getAssetThumbnailPath.mockImplementation((id: string) => `/assets/${id}/thumbnail`);
  });

  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  it('previews a clock shift on the first photos, and fixes the whole selection with it', async () => {
    const onSubmit = vi.fn();
    renderWithTooltips(DateFixDialog, { count: ids.length, ids, onSubmit });

    await fireEvent.click(screen.getByRole('radio', { name: 'The camera’s clock was off' }));
    await fireEvent.input(screen.getByRole('spinbutton'), { target: { value: '7' } });
    await fireEvent.change(screen.getByLabelText(en.frameleaf_bulk_date_direction), { target: { value: 'earlier' } });

    await waitFor(() =>
      expect(sdkMock.previewDateFix).toHaveBeenLastCalledWith({
        dateDoctorFixDto: { assetIds: ids.slice(0, 6), shiftMinutes: -420 },
      }),
    );
    expect(await screen.findAllByText(/^Aug 12, 2026, 9:40\sAM MDT$/)).toHaveLength(6);

    await fireEvent.click(screen.getByRole('button', { name: 'Fix 7 photos' }));
    expect(onSubmit).toHaveBeenCalledWith({ dateMode: 'shift', minutes: -420 });
  });

  it('sends a zone, keeping the clock time', async () => {
    const onSubmit = vi.fn();
    renderWithTooltips(DateFixDialog, { count: 2, ids: ['a', 'b'], onSubmit });

    await waitFor(() =>
      expect(sdkMock.previewDateFix).toHaveBeenCalledWith({
        dateDoctorFixDto: expect.objectContaining({ assetIds: ['a', 'b'], keepWallTime: true }),
      }),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Fix 2 photos' }));
    expect(onSubmit).toHaveBeenCalledWith({ timeZone: expect.any(String) });
  });

  it('hands over to Change date for a date to set outright', async () => {
    const onChangeDate = vi.fn();
    renderWithTooltips(DateFixDialog, { count: 1, ids: ['a'], onSubmit: vi.fn(), onChangeDate });

    await fireEvent.click(screen.getByRole('button', { name: 'Set one date and time instead…' }));
    expect(onChangeDate).toHaveBeenCalled();
  });
});
