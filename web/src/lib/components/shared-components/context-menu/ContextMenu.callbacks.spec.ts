import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ContextMenu from '$lib/components/shared-components/context-menu/ContextMenu.svelte';

describe('context menu close callback', () => {
  it('uses the current parent callback after the menu props change', async () => {
    const old = vi.fn();
    const current = vi.fn();
    const menu = render(ContextMenu, { isVisible: true, onClose: old });
    await menu.rerender({ isVisible: true, onClose: current });
    await fireEvent.mouseDown(document.body);
    expect(old).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledExactlyOnceWith();
  });

  it('can add and remove the close callback while mounted', async () => {
    const current = vi.fn();
    const menu = render(ContextMenu, { isVisible: true });
    await menu.rerender({ isVisible: true, onClose: current });
    await fireEvent.mouseDown(document.body);
    expect(current).toHaveBeenCalledOnce();
    await menu.rerender({ isVisible: true, onClose: undefined });
    await fireEvent.mouseDown(document.body);
    expect(current).toHaveBeenCalledOnce();
  });

  it('ignores clicks inside the menu and removes its document listener on unmount', async () => {
    const close = vi.fn();
    const menu = render(ContextMenu, { isVisible: true, onClose: close });
    await fireEvent.mouseDown(menu.container.querySelector('ul')!);
    expect(close).not.toHaveBeenCalled();
    menu.unmount();
    await fireEvent.mouseDown(document.body);
    expect(close).not.toHaveBeenCalled();
  });
});
