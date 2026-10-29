import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import DimensionFilters from './DimensionFilters.svelte';

describe('size and shape', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  it('maps shapes onto aspect-ratio ranges and reads them back', async () => {
    const onChange = vi.fn();
    render(DimensionFilters, { filter: { aspectRatio: { gt: 1.9 } }, onChange });
    expect(screen.getByRole('button', { name: 'Wide' })).toHaveAttribute('aria-pressed', 'true');
    await fireEvent.click(screen.getByRole('button', { name: 'Portrait' }));
    expect(onChange).toHaveBeenCalledWith('aspectRatio', { lt: 0.95 });
    await fireEvent.click(screen.getByRole('button', { name: 'Any shape' }));
    expect(onChange).toHaveBeenLastCalledWith('aspectRatio', undefined);
  });

  it('sets a minimum width and transparent backgrounds', async () => {
    const onChange = vi.fn();
    render(DimensionFilters, { filter: {}, onChange });
    await fireEvent.change(screen.getByRole('combobox', { name: 'At least this wide' }), {
      target: { value: '1920' },
    });
    expect(onChange).toHaveBeenCalledWith('width', { gte: 1920 });
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Transparent background only' }));
    expect(onChange).toHaveBeenLastCalledWith('hasTransparency', { eq: true });
  });

  it('expresses video length in seconds while preserving millisecond API bounds', async () => {
    const onChange = vi.fn();
    render(DimensionFilters, { filter: { durationMs: { gte: 1000, lte: 10_000 } }, onChange });
    const minimum = screen.getByRole('spinbutton', { name: 'Duration (seconds): minimum' });
    expect(minimum).toHaveValue(1);
    await fireEvent.change(minimum, { target: { value: '2.5' } });
    expect(onChange).toHaveBeenCalledWith('durationMs', { gte: 2500, lte: 10_000 });
  });

  it('names a condition it cannot show and clears everything with Clear', async () => {
    const onChange = vi.fn();
    const onDone = vi.fn();
    render(DimensionFilters, { filter: { aspectRatio: { gte: 3 }, width: { eq: 1920 } }, onChange, onDone });
    expect(
      screen.getAllByText('Set by a more specific filter. Remove its chip to change it here.').length,
    ).toBeGreaterThan(0);
    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenCalledWith('aspectRatio', undefined);
    expect(onChange).toHaveBeenCalledWith('width', undefined);
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledOnce();
  });
});
