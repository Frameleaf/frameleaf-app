import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import FocusTrapTest from '$lib/actions/__test__/FocusTrapTest.svelte';
import { setDefaultTabbleOptions } from '$lib/utils/focus-util';

setDefaultTabbleOptions({ displayCheck: 'none' });

describe('focusTrap action', () => {
  const user = userEvent.setup();

  it('sets focus to the first focusable element', async () => {
    render(FocusTrapTest, { show: true });
    await tick();
    expect(document.activeElement).toEqual(screen.getByTestId('one'));
  });

  it('should not set focus if inactive', async () => {
    render(FocusTrapTest, { show: true, active: false });
    await tick();
    expect(document.activeElement).toBe(document.body);
  });

  it('supports backward focus wrapping', async () => {
    render(FocusTrapTest, { show: true });
    await tick();
    await user.keyboard('{Shift}{Tab}{/Shift}');
    expect(document.activeElement).toEqual(screen.getByTestId('three'));
  });

  it('supports forward focus wrapping', async () => {
    render(FocusTrapTest, { show: true });
    await tick();
    screen.getByTestId('three').focus();
    await user.keyboard('{Tab}');
    expect(document.activeElement).toEqual(screen.getByTestId('one'));
  });

  describe('the sentinels', () => {
    const SENTINELS = { start: '[data-focus-trap="start"]', end: '[data-focus-trap="end"]' } as const;
    const sentinel = (which: 'start' | 'end') => document.querySelector<HTMLElement>(SENTINELS[which])!;
    const onSentinel = () =>
      document.activeElement instanceof HTMLElement && !!document.activeElement.dataset.focusTrap;

    // Left tabbable they were two invisible stops in whatever an inactive trap wraps (the library
    // rail on desktop).
    it('are no tab stops, and are kept from assistive technology, while the trap is inactive', async () => {
      render(FocusTrapTest, { show: true, active: false });
      await tick();

      for (const which of ['start', 'end'] as const) {
        expect(sentinel(which)).toHaveAttribute('tabindex', '-1');
        expect(sentinel(which)).toHaveAttribute('aria-hidden', 'true');
      }
      const stops: (string | undefined)[] = [];
      for (let step = 0; step < 4; step++) {
        await user.tab();
        expect(onSentinel()).toBe(false);
        stops.push((document.activeElement as HTMLElement).dataset.testid ?? document.activeElement?.textContent ?? '');
      }
      // Open, the two controls inside, then out again: nothing in between.
      expect(stops.slice(0, 3)).toEqual(['Open', 'one', 'three']);
      for (let step = 0; step < 3; step++) {
        await user.tab({ shift: true });
        expect(onSentinel()).toBe(false);
      }
    });

    it('catch focus once a trap created inactive is activated, and stop when it is deactivated', async () => {
      const { rerender } = render(FocusTrapTest, { show: true, active: false });
      await tick();

      await rerender({ active: true });
      await tick();
      for (const which of ['start', 'end'] as const) {
        expect(sentinel(which)).toHaveAttribute('tabindex', '0');
        // a tabbable node is never hidden from assistive technology
        expect(sentinel(which)).toHaveAttribute('aria-hidden', 'false');
      }
      expect(document.activeElement).toEqual(screen.getByTestId('one'));
      await user.tab({ shift: true });
      expect(document.activeElement).toEqual(screen.getByTestId('three'));
      await user.tab();
      expect(document.activeElement).toEqual(screen.getByTestId('one'));

      await rerender({ active: false });
      await tick();
      for (const which of ['start', 'end'] as const) {
        expect(sentinel(which)).toHaveAttribute('tabindex', '-1');
        expect(sentinel(which)).toHaveAttribute('aria-hidden', 'true');
      }
      await user.tab({ shift: true });
      expect(onSentinel()).toBe(false);
    });

    it('never hold focus or draw a ring in an active trap', async () => {
      render(FocusTrapTest, { show: true });
      await tick();

      for (const shift of [true, true, false, false, false]) {
        await user.tab({ shift });
        expect(onSentinel()).toBe(false);
      }
      expect(sentinel('start').style.outline).toContain('none');
      expect(sentinel('end').style.outline).toContain('none');
    });
  });

  it('restores focus to the triggering element', async () => {
    render(FocusTrapTest, { show: false });
    const openButton = screen.getByText('Open');

    await user.click(openButton);
    await tick();
    expect(document.activeElement).toEqual(screen.getByTestId('one'));

    screen.getByText('Close').click();
    await tick();
    expect(document.activeElement).toEqual(openButton);
  });
});
