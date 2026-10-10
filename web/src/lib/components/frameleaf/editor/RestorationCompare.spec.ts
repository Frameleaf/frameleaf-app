import { fireEvent, render, screen } from '@testing-library/svelte';
import RestorationCompare from './RestorationCompare.svelte';

/** Before-and-after split and the prototype's 100% loupe (FL-115, `Studio.jsx:1487-1567`). */
describe('RestorationCompare', () => {
  const props = {
    before: '/before.jpg',
    after: '/after.png',
    isVideo: false,
    beforeLabel: 'Before',
    afterLabel: 'After',
    alt: 'photo.jpg',
  };

  beforeEach(() => {
    // jsdom has no canvas; the loupe simply stays dark without a 2D context.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  it('shows the loupe under the pointer only while it is switched on', async () => {
    const { rerender } = render(RestorationCompare, { ...props, loupe: false });
    const stage = screen.getByTestId('restoration-compare');

    await fireEvent.pointerMove(stage, { clientX: 40, clientY: 30 });
    expect(screen.queryByTestId('restoration-loupe')).toBeNull();

    await rerender({ ...props, loupe: true });
    await fireEvent.pointerMove(stage, { clientX: 40, clientY: 30 });
    const loupe = screen.getByTestId('restoration-loupe');
    expect(loupe.textContent).toContain('100%');
    expect(loupe.getAttribute('style')).toContain('left: 40px');

    await fireEvent.pointerLeave(stage);
    expect(screen.queryByTestId('restoration-loupe')).toBeNull();
  });

  it('moves the divider from the keyboard', async () => {
    render(RestorationCompare, props);
    const divider = screen.getByRole('slider');

    await fireEvent.keyDown(divider, { key: 'End' });
    expect(divider.getAttribute('aria-valuenow')).toBe('96');
    await fireEvent.keyDown(divider, { key: 'ArrowLeft' });
    expect(divider.getAttribute('aria-valuenow')).toBe('94');
  });
});
