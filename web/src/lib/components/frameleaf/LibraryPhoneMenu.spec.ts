import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
import LibraryPhoneMenu from './LibraryPhoneMenu.svelte';

const fakeSession = () =>
  ({
    state: { sort: 'captured-desc', grouping: 'all' },
    setLayout: vi.fn(),
    patchView: vi.fn(),
  }) as unknown as LibrarySessionStore;

const openMenu = async () => {
  await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_library_view_menu' }));
  return screen.getByRole('menu', { name: 'frameleaf_library_view_menu' });
};

/** Review "phone library header takes four rows": one menu carries what the rows carried. */
describe('LibraryPhoneMenu', () => {
  it('offers the three layouts, marks the current one, and opens the Timeline grouped by day', async () => {
    const session = fakeSession();
    render(LibraryPhoneMenu, { session, current: 'browse' });
    await openMenu();

    expect(screen.getByRole('menuitemcheckbox', { name: 'frameleaf_library_layout_browse' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'frameleaf_library_layout_timeline' }));
    expect(session.setLayout).toHaveBeenCalledWith('timeline');
    expect(session.patchView).toHaveBeenCalledWith({ grouping: 'days' });
  });

  it('lists only the sorts this view can apply and hands the choice to the page when it keeps its own', async () => {
    const session = fakeSession();
    const onSortChange = vi.fn();
    render(LibraryPhoneMenu, {
      session,
      current: 'timeline',
      sorts: ['captured-desc', 'captured-asc'],
      sort: 'captured-asc',
      onSortChange,
    });
    await openMenu();

    expect(screen.queryByRole('menuitemcheckbox', { name: 'frameleaf_library_sort_filename' })).toBeNull();
    expect(screen.getByRole('menuitemcheckbox', { name: 'frameleaf_library_sort_captured_oldest' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'frameleaf_library_sort_captured_newest' }));
    expect(onSortChange).toHaveBeenCalledWith('captured-desc');
    expect(session.patchView).not.toHaveBeenCalled();
  });

  it('carries Grid / List, Slideshow and Select all, and leaves out what the page does not offer', async () => {
    const session = fakeSession();
    const onViewChange = vi.fn();
    const onSlideshow = vi.fn();
    const onSelectAll = vi.fn();
    render(LibraryPhoneMenu, {
      session,
      current: 'browse',
      layouts: ['timeline'],
      view: 'grid',
      onViewChange,
      onSlideshow,
      onSelectAll,
      selectAllLabel: 'Select all 12',
    });
    await openMenu();

    // One layout on offer (Locked): no layout group.
    expect(screen.queryByRole('menuitemcheckbox', { name: 'frameleaf_library_layout_timeline' })).toBeNull();
    await fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'frameleaf_library_list_view' }));
    expect(onViewChange).toHaveBeenCalledWith('list');

    await openMenu();
    await fireEvent.click(screen.getByRole('menuitem', { name: 'slideshow' }));
    expect(onSlideshow).toHaveBeenCalledOnce();

    await openMenu();
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Select all 12' }));
    expect(onSelectAll).toHaveBeenCalledOnce();
  });

  it('lists Slideshow and Select all but does not offer them when there is nothing to act on', async () => {
    const onSlideshow = vi.fn();
    render(LibraryPhoneMenu, { session: fakeSession(), current: 'browse', onSlideshow, empty: true });
    await openMenu();

    const slideshow = screen.getByRole('menuitem', { name: 'slideshow' });
    expect(slideshow).toHaveAttribute('aria-disabled', 'true');
    await fireEvent.click(slideshow);
    expect(onSlideshow).not.toHaveBeenCalled();
  });
});
