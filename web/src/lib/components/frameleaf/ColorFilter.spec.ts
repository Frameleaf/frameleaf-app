import { ColorTolerance } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import ColorFilter from './ColorFilter.svelte';

describe('shared color filter', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });
  it('accepts a normalized hex value with the shared defaults', async () => {
    const onChange = vi.fn();
    render(ColorFilter, { onChange });
    await fireEvent.change(screen.getByRole('textbox', { name: 'Hex color' }), { target: { value: '#60A060' } });
    expect(onChange).toHaveBeenCalledWith({ hex: '#60a060', tolerance: ColorTolerance.Normal, minWeight: 0.05 });
  });
  it('keeps malformed colors out of the query and explains the error', async () => {
    const onChange = vi.fn();
    render(ColorFilter, { onChange });
    await fireEvent.change(screen.getByRole('textbox', { name: 'Hex color' }), { target: { value: 'green' } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a hex color such as #609060.');
  });
  it('changes tolerance without dropping the selected color or coverage, and clears explicitly', async () => {
    const onChange = vi.fn();
    render(ColorFilter, { color: { hex: '#609060', tolerance: ColorTolerance.Tight, minWeight: 0.1 }, onChange });
    await fireEvent.click(screen.getByRole('button', { name: 'Broad' }));
    expect(onChange).toHaveBeenCalledWith({ hex: '#609060', tolerance: ColorTolerance.Broad, minWeight: 0.1 });
    await fireEvent.click(screen.getByRole('button', { name: 'Clear color filter' }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});
