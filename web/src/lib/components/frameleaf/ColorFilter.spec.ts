import { ColorTolerance } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import ColorFilter from './ColorFilter.svelte';

describe('find by colour', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  it('names all 16 swatches and applies the chosen one only on Show matches', async () => {
    const onChange = vi.fn();
    render(ColorFilter, { onChange });
    const swatches = screen.getAllByRole('button').filter((button) => button.classList.contains('fl-color-swatch'));
    expect(swatches).toHaveLength(16);
    await fireEvent.click(screen.getByRole('button', { name: 'Teal' }));
    expect(screen.getByRole('button', { name: 'Teal' })).toHaveAttribute('aria-pressed', 'true');
    expect(onChange).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Show matches' }));
    expect(onChange).toHaveBeenCalledWith({ hex: '#3f8f8a', tolerance: ColorTolerance.Normal, minWeight: 0.05 });
    expect(screen.getByText('Videos and GIFs match a frame from the middle.')).toBeInTheDocument();
  });

  it('maps Exact and "Only the main colour" onto tolerance and coverage', async () => {
    const onChange = vi.fn();
    render(ColorFilter, { onChange });
    await fireEvent.input(screen.getByRole('textbox', { name: 'Hex color' }), { target: { value: '60A060' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Exact' }));
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Only the main colour' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Show matches' }));
    expect(onChange).toHaveBeenCalledWith({ hex: '#60a060', tolerance: ColorTolerance.Tight, minWeight: 0.25 });
  });

  it('keeps malformed colours out of the query and explains the error', async () => {
    const onChange = vi.fn();
    render(ColorFilter, { onChange });
    const field = screen.getByRole('textbox', { name: 'Hex color' });
    await fireEvent.input(field, { target: { value: 'green' } });
    await fireEvent.change(field, { target: { value: 'green' } });
    expect(screen.getByRole('button', { name: 'Show matches' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a hex color such as #609060.');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reads the applied filter back, cancels a draft and clears explicitly', async () => {
    const onChange = vi.fn();
    const onCancel = vi.fn();
    render(ColorFilter, {
      color: { hex: '#609060', tolerance: ColorTolerance.Broad, minWeight: 0.3 },
      onChange,
      onCancel,
    });
    expect(screen.getByRole('button', { name: 'Loose' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('checkbox', { name: 'Only the main colour' })).toBeChecked();
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Loose' })).toHaveAttribute('aria-pressed', 'true');
    expect(onChange).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Clear color filter' }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});
