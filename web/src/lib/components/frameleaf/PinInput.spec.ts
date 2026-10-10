import { cleanup, render, screen } from '@testing-library/svelte';
import PinInputTestHarness from './PinInputTestHarness.svelte';

describe('PIN disabled state', () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(async () => {
    try {
      cleanup();
      // Finish bits-ui autofill callbacks before Vitest restores the global Event constructor.
      await vi.runOnlyPendingTimersAsync();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the native input and cell styling in sync with field disabling and enabling', async () => {
    const view = render(PinInputTestHarness, { disabled: true });
    const input = screen.getByRole('textbox', { name: 'Recovery code' });
    expect(input).toBeDisabled();
    expect(input.closest('.group')).toHaveAttribute('data-disabled');
    await view.rerender({ disabled: false });
    expect(input).toBeEnabled();
    expect(input.closest('.group')).not.toHaveAttribute('data-disabled');
  });

  it('respects an explicit disabled override in either direction', () => {
    const enabled = render(PinInputTestHarness, { disabled: true, override: false });
    expect(screen.getByRole('textbox', { name: 'Recovery code' })).toBeEnabled();
    expect(screen.getByRole('textbox').closest('.group')).not.toHaveAttribute('data-disabled');
    enabled.unmount();
    render(PinInputTestHarness, { disabled: false, override: true });
    expect(screen.getByRole('textbox', { name: 'Recovery code' })).toBeDisabled();
    expect(screen.getByRole('textbox').closest('.group')).toHaveAttribute('data-disabled');
  });

  it('keeps an explicitly forwarded undefined disabled prop enabled instead of using the field default', async () => {
    const view = render(PinInputTestHarness, { disabled: true, override: undefined, forwardOverride: true });
    const input = screen.getByRole('textbox', { name: 'Recovery code' });
    expect(input).toBeEnabled();
    expect(input.closest('.group')).not.toHaveAttribute('data-disabled');
    await view.rerender({ disabled: true, forwardOverride: false });
    expect(screen.getByRole('textbox', { name: 'Recovery code' })).toBeDisabled();
    expect(screen.getByRole('textbox').closest('.group')).toHaveAttribute('data-disabled');
  });
});
