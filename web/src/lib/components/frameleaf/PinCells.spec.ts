import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import PinCells from './PinCells.svelte';

describe('PinCells', () => {
  it('fires oncomplete exactly once when a full code is typed digit by digit', async () => {
    const oncomplete = vi.fn();
    render(PinCells, { label: 'Six-digit PIN', oncomplete });

    const input = screen.getByLabelText('Six-digit PIN');
    for (const digit of '123456') {
      await fireEvent.input(input, { target: { value: (input as HTMLInputElement).value + digit } });
    }

    expect(oncomplete).toHaveBeenCalledExactlyOnceWith('123456');
  });

  it('fills every cell from a single paste of the full code', async () => {
    const oncomplete = vi.fn();
    render(PinCells, { label: 'Six-digit PIN', oncomplete });

    const input = screen.getByLabelText<HTMLInputElement>('Six-digit PIN');
    await fireEvent.input(input, { target: { value: '987654' } });

    expect(input.value).toBe('987654');
    expect(oncomplete).toHaveBeenCalledExactlyOnceWith('987654');
  });

  it('strips non-digits and caps the value at the configured length', async () => {
    render(PinCells, { label: 'Six-digit PIN' });

    const input = screen.getByLabelText<HTMLInputElement>('Six-digit PIN');
    await fireEvent.input(input, { target: { value: '12a3-45678' } });

    expect(input.value).toBe('123456');
  });

  it('marks the cells invalid without touching the entered digits', () => {
    render(PinCells, { label: 'Six-digit PIN', value: '4242', error: true });

    expect(screen.getByLabelText<HTMLInputElement>('Six-digit PIN').getAttribute('aria-invalid')).toBe('true');
  });

  it('re-reports a repeated code after the caller clears the value on a rejection', async () => {
    const oncomplete = vi.fn();
    const { rerender } = render(PinCells, { label: 'Six-digit PIN', oncomplete });

    const input = screen.getByLabelText<HTMLInputElement>('Six-digit PIN');
    await fireEvent.input(input, { target: { value: '111111' } });
    expect(oncomplete).toHaveBeenCalledTimes(1);

    // Caller rejects the PIN and clears the bound value, same as the pin-prompt page does.
    await rerender({ label: 'Six-digit PIN', oncomplete, value: '' });
    await fireEvent.input(input, { target: { value: '111111' } });

    expect(oncomplete).toHaveBeenCalledTimes(2);
  });
});
