import { IconButton } from '@frameleaf/ui';
import { fireEvent, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { renderWithTooltips } from '$tests/helpers';

/**
 * The kit Tooltip opens on focus only after a keyboard navigation key (viewer report: opening the
 * viewer focuses Close, and its tooltip covered the photo, phones included).
 */
describe('kit Tooltip focus', () => {
  const close = () =>
    renderWithTooltips(IconButton, {
      icon: 'M0 0h24v24H0z',
      'aria-label': 'Close viewer',
      title: 'Close viewer (Escape)',
    });

  it('stays closed when a page focuses the control itself', async () => {
    close();
    screen.getByRole('button', { name: 'Close viewer' }).focus();
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(document.body.textContent).not.toContain('Close viewer (Escape)');
  });

  it('opens when the person tabs to the control', async () => {
    close();
    const button = screen.getByRole('button', { name: 'Close viewer' });
    // The key reaches the window's listener the way a real Tab does, through the document.
    await fireEvent.keyDown(document, { key: 'Tab' });
    button.focus();
    expect(await screen.findByText('Close viewer (Escape)')).toBeInTheDocument();
  });
});
