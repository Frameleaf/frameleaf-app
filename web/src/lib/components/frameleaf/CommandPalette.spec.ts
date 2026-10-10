import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCommandIndex } from '$lib/frameleaf/command-palette';
import CommandPalette from './CommandPalette.svelte';

const reducedMotion = vi.hoisted(() => ({ value: false }));
vi.mock('$lib/frameleaf/motion', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/motion')>()),
  prefersReducedMotion: () => reducedMotion.value,
}));

const index = buildCommandIndex({
  pages: [
    { id: 'people', title: 'People', href: '/people' },
    { id: 'map', title: 'Map', href: '/map' },
  ],
});

describe('CommandPalette', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    Element.prototype.scrollIntoView ??= () => {};
  });

  beforeEach(() => {
    localStorage.clear();
    reducedMotion.value = false;
  });

  it('opens on the glass palette with the text typed before the hand-off and runs the active command', async () => {
    const onRun = vi.fn();
    const onClose = vi.fn();
    render(CommandPalette, { index, initialQuery: '>peo', onRun, onClose });
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    expect(dialog).toHaveClass('command-palette');
    expect(dialog).not.toHaveClass('reduced-motion');
    const input = screen.getByRole('combobox');
    expect(input).toHaveValue('peo');
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'pages:people' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('can be left without a keyboard: the Close control and a press on the backdrop both close it', async () => {
    const onClose = vi.fn();
    render(CommandPalette, { index, onClose });
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a press outside the panel and not on one inside it', async () => {
    const onClose = vi.fn();
    render(CommandPalette, { index, onClose });
    await fireEvent.click(screen.getByRole('combobox'));
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('dialog', { name: 'Command palette' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says how to reach commands, not how many groups there are, while idle', () => {
    render(CommandPalette, { index, onClose: vi.fn() });
    expect(screen.getByText('Tip: type > in search to jump to pages and settings')).toBeInTheDocument();
  });

  it('crossfades instead of springing under Reduce Motion, checked in JavaScript', () => {
    reducedMotion.value = true;
    render(CommandPalette, { index, onClose: vi.fn() });
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toHaveClass('reduced-motion');
  });
});
