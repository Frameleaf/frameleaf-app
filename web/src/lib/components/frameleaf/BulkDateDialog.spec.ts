import { fireEvent, screen } from '@testing-library/svelte';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithTooltips } from '$tests/helpers';
import BulkDateDialog from './BulkDateDialog.svelte';

const item = (id: string, localDateTime: string, utcOffsetMinutes: number) => ({
  id,
  ownerId: 'me',
  localDateTime,
  utcOffsetMinutes,
});

describe('BulkDateDialog (FL-32, T-19)', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView ??= () => {};
    vi.stubGlobal('visualViewport', null);
  });

  const zoneInput = () => screen.getByRole('combobox', { name: 'frameleaf_bulk_date_time_zone' }) as HTMLInputElement;
  const apply = () => fireEvent.click(screen.getByRole('button', { name: 'frameleaf_bulk_apply_to' }));
  const chooseZone = async (city: string) => {
    await fireEvent.input(zoneInput(), { target: { value: city } });
    await fireEvent.click(await screen.findByText(new RegExp(String.raw`^${city} \(`)));
  };

  it('opens on the first selected item’s date and time', () => {
    renderWithTooltips(BulkDateDialog, {
      count: 1,
      assets: [item('a', '2024-12-11T18:42', -480)],
      onSubmit: vi.fn(),
    });
    expect(screen.getByLabelText('date')).toHaveValue('2024-12-11');
    expect(screen.getByLabelText('time')).toHaveValue('18:42');
  });

  it('sends a chosen zone’s wall time with that zone’s offset, never a bare time', async () => {
    const onSubmit = vi.fn();
    renderWithTooltips(BulkDateDialog, { count: 1, assets: [item('a', '2024-12-11T18:42', 60)], onSubmit });
    await chooseZone('Vancouver');
    expect(zoneInput().value).not.toContain('America/');
    await apply();
    expect(onSubmit).toHaveBeenCalledWith({
      dateMode: 'set',
      dateTimeOriginal: '2024-12-11T18:42:00-08:00',
      timeZone: 'America/Vancouver',
    });
  });

  it('keeps each item’s own zone by default: the same wall time at each item’s offset', async () => {
    const onSubmit = vi.fn();
    renderWithTooltips(BulkDateDialog, {
      count: 2,
      assets: [item('a', '2024-12-11T18:42', -480), item('b', '2024-06-01T09:00', 120)],
      onSubmit,
    });
    expect(zoneInput().value).toBe('frameleaf_bulk_date_keep_time_zone');
    await apply();
    expect(onSubmit).toHaveBeenCalledWith({
      dateMode: 'set',
      dateTimeOriginal: '2024-12-11T18:42',
      offsetMinutesById: { a: -480, b: 120 },
    });
  });

  it('opens on the first item’s zone when the selection is not all loaded', async () => {
    const onSubmit = vi.fn();
    // Three selected, one loaded: "keep" cannot know the others' zones, so it is not offered.
    renderWithTooltips(BulkDateDialog, { count: 3, assets: [item('a', '2024-12-11T18:42', 0)], onSubmit });
    expect(zoneInput().value).not.toBe('frameleaf_bulk_date_keep_time_zone');
    await apply();
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.dateTimeOriginal).toMatch(/^2024-12-11T18:42:00(Z|[+-]00:00)$/);
    expect(payload.offsetMinutesById).toBeUndefined();
  });

  it('reads each zone’s offset on the date being set, across a daylight-saving change', async () => {
    const onSubmit = vi.fn();
    renderWithTooltips(BulkDateDialog, { count: 1, assets: [item('a', '2026-03-08T12:00', -420)], onSubmit });
    await chooseZone('Vancouver');
    // Spring forward was at 02:00 that morning: noon is on daylight time.
    expect(zoneInput().value).toContain('UTC−07:00');

    await fireEvent.input(screen.getByLabelText('date'), { target: { value: '2026-03-07' } });
    // The chosen zone is relabelled for the new date.
    expect(zoneInput().value).toContain('UTC−08:00');
    await apply();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ dateTimeOriginal: '2026-03-07T12:00:00-08:00', timeZone: 'America/Vancouver' }),
    );
  });
});
