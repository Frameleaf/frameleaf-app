import { fireEvent, screen } from '@testing-library/svelte';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithTooltips } from '$tests/helpers';
import BulkDateDialog from './BulkDateDialog.svelte';

describe('BulkDateDialog (FL-32, T-19)', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView ??= () => {};
    vi.stubGlobal('visualViewport', null);
  });

  it('opens on the first selected item’s date and time', () => {
    renderWithTooltips(BulkDateDialog, { count: 3, initialDateTime: '2024-12-11T18:42', onSubmit: vi.fn() });
    expect(screen.getByLabelText('date')).toHaveValue('2024-12-11');
    expect(screen.getByLabelText('time')).toHaveValue('18:42');
  });

  it('offers a searchable list of places, not raw IANA ids, and keeps each item’s zone by default', async () => {
    const onSubmit = vi.fn();
    renderWithTooltips(BulkDateDialog, { count: 3, initialDateTime: '2024-12-11T18:42', onSubmit });
    const zone = screen.getByRole('combobox', { name: 'frameleaf_bulk_date_time_zone' }) as HTMLInputElement;
    expect(zone.value).toBe('frameleaf_bulk_date_keep_time_zone');

    await fireEvent.input(zone, { target: { value: 'Vancouver' } });
    const option = await screen.findByText(/^Vancouver \(/);
    expect(option.textContent).not.toContain('America/');
    await fireEvent.click(option);

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_bulk_apply_to' }));
    expect(onSubmit).toHaveBeenCalledWith({
      dateMode: 'set',
      dateTimeOriginal: '2024-12-11T18:42:00',
      timeZone: 'America/Vancouver',
    });
  });

  it('sends no time zone while "keep each item’s time zone" is chosen', async () => {
    const onSubmit = vi.fn();
    renderWithTooltips(BulkDateDialog, { count: 1, initialDateTime: '2024-12-11T18:42', onSubmit });
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_bulk_apply_to' }));
    expect(onSubmit).toHaveBeenCalledWith({ dateMode: 'set', dateTimeOriginal: '2024-12-11T18:42:00' });
  });
});
