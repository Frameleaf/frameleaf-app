import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import DimensionFilters from './DimensionFilters.svelte';

describe('shared source dimensions and duration controls', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });
  it('expresses duration in seconds while preserving millisecond API bounds', async () => {
    const onChange = vi.fn();
    render(DimensionFilters, { filter: { durationMs: { gte: 1000, lte: 10_000 } }, onChange });
    const minimum = screen.getByRole('spinbutton', { name: 'Duration (seconds): minimum' });
    expect(minimum).toHaveValue(1);
    await fireEvent.change(minimum, { target: { value: '2.5' } });
    expect(onChange).toHaveBeenCalledWith('durationMs', { gte: 2500, lte: 10_000 });
  });
  it('removes only the edited bound when an input is cleared', async () => {
    const onChange = vi.fn();
    render(DimensionFilters, { filter: { height: { gte: 1080, lte: 2160 } }, onChange });
    await fireEvent.change(screen.getByRole('spinbutton', { name: 'Source height (px): minimum' }), {
      target: { value: '' },
    });
    expect(onChange).toHaveBeenCalledWith('height', { lte: 2160 });
  });
  it('retains custom predicates until they are explicitly cleared', async () => {
    const onChange = vi.fn();
    render(DimensionFilters, { filter: { width: { eq: 1920 } }, onChange });
    expect(screen.getByRole('spinbutton', { name: 'Source width (px): minimum' })).toBeDisabled();
    await fireEvent.click(screen.getByRole('button', { name: 'Clear Source width (px)' }));
    expect(onChange).toHaveBeenCalledWith('width', undefined);
  });
});
