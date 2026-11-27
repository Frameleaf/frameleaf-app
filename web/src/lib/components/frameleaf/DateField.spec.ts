import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dateFieldStart, isDateFieldValid, type DateFieldValue } from '$lib/frameleaf/date-field';
import DateField from './DateField.svelte';

/** FL-1814: the one date field. */
describe('DateField', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  const value = (patch: Partial<DateFieldValue>): DateFieldValue => ({
    sure: 'day',
    year: 1987,
    month: 3,
    day: 15,
    ...patch,
  });

  it('asks how sure you are first and shows only the fields that answer needs', async () => {
    const onChange = vi.fn();
    const { rerender } = render(DateField, { label: 'Taken', value: value({}), onChange, withTime: true });
    expect(screen.getByLabelText('How sure are you?')).toHaveValue('day');
    for (const name of ['Day', 'Month', 'Year', 'Time']) {
      expect(screen.getByLabelText(name)).toBeInTheDocument();
    }

    await rerender({ label: 'Taken', value: value({ sure: 'month' }), onChange, withTime: true });
    expect(screen.queryByLabelText('Day')).toBeNull();
    expect(screen.queryByLabelText('Time')).toBeNull();
    expect(screen.getByText('March 1987')).toBeInTheDocument();

    await rerender({ label: 'Taken', value: value({ sure: 'about' }), onChange });
    expect(screen.queryByLabelText('Month')).toBeNull();
    expect(screen.getByText('Around 1987')).toBeInTheDocument();
  });

  it('offers a decade only for a date stored as one', async () => {
    const { rerender } = render(DateField, { label: 'Taken', value: value({}), onChange: vi.fn() });
    expect(screen.queryByRole('option', { name: 'Decade' })).toBeNull();
    await rerender({ label: 'Taken', value: value({ sure: 'decade', year: 1970 }), onChange: vi.fn() });
    expect(screen.getByRole('option', { name: 'Decade' })).toBeInTheDocument();
    expect(screen.getByText('Circa 1970s')).toBeInTheDocument();
  });

  it('reads the date back, and says when a day does not exist', async () => {
    const { rerender } = render(DateField, {
      label: 'Taken',
      value: value({ time: '07:14' }),
      onChange: vi.fn(),
      withTime: true,
    });
    expect(screen.getByText(/March 15, 1987 at 7:14/)).toBeInTheDocument();
    await rerender({ label: 'Taken', value: value({ month: 2, day: 29 }), onChange: vi.fn() });
    expect(screen.getByText('That day doesn’t exist in that month.')).toBeInTheDocument();
  });

  it('passes each change on', async () => {
    const onChange = vi.fn();
    render(DateField, { label: 'Taken', value: value({}), onChange });
    await fireEvent.change(screen.getByLabelText('How sure are you?'), { target: { value: 'year' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ sure: 'year' }));
  });

  it('stores each answer as the start of its period, and knows a real day', () => {
    expect(dateFieldStart(value({}))).toBe('1987-03-15');
    expect(dateFieldStart(value({ sure: 'month' }))).toBe('1987-03-01');
    expect(dateFieldStart(value({ sure: 'about' }))).toBe('1987-01-01');
    expect(dateFieldStart(value({ sure: 'decade' }))).toBe('1980-01-01');
    expect(isDateFieldValid(value({ year: 2024, month: 2, day: 29 }))).toBe(true);
    expect(isDateFieldValid(value({ year: 2023, month: 2, day: 29 }))).toBe(false);
    expect(isDateFieldValid(value({ month: 4, day: 31 }))).toBe(false);
    expect(isDateFieldValid(value({ year: 1799, sure: 'year' }))).toBe(false);
    expect(isDateFieldValid(value({ year: NaN, sure: 'year' }))).toBe(false);
    // years 1–99 are those years, not 1901–1999
    expect(isDateFieldValid(value({ year: 50, month: 3, day: 15 }), 1, 9999)).toBe(true);
  });

  it('refuses a month that has not begun, as the server does', async () => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const ahead = value({ sure: 'month', year: next.getFullYear(), month: next.getMonth() + 1 });
    expect(isDateFieldValid(ahead, 1800, next.getFullYear())).toBe(false);
    expect(isDateFieldValid(value({ sure: 'month', year: now.getFullYear(), month: now.getMonth() + 1 }))).toBe(true);
    render(DateField, { label: 'Born', value: ahead, maxYear: next.getFullYear(), onChange: vi.fn() });
    expect(screen.getByText('Choose a date that is not in the future.', { exact: false })).toBeInTheDocument();
  });

  it('marks a year out of range and can take the cursor as its dialog opens', () => {
    render(DateField, { label: 'Taken', value: value({ year: 1700 }), focusOnOpen: true, onChange: vi.fn() });
    expect(screen.getByLabelText('Year')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('How sure are you?')).toHaveAttribute('data-initial-focus');
  });
});
