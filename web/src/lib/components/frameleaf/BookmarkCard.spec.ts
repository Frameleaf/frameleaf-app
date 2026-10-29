import { LibraryScope, type BookmarkResponseDto } from '@frameleaf/sdk';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import BookmarkCard from './BookmarkCard.svelte';

const bookmark: BookmarkResponseDto = {
  id: 'book',
  ownerId: 'owner',
  title: '<b>Reference</b>',
  url: 'https://example.com/path',
  note: 'Private note',
  previewAssetId: null,
  libraryScope: LibraryScope.Design,
  createdAt: '2026-10-28T00:00:00Z',
  updatedAt: '2026-10-28T00:00:00Z',
  updateId: 'update',
  deletedAt: null,
  isArchived: false,
  isLocked: false,
};
describe('bookmark grid card', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });
  it('opens internal details, renders escaped text and never follows the website on a tile click', async () => {
    const onOpen = vi.fn();
    const { container } = render(BookmarkCard, { bookmark, onOpen });
    await fireEvent.click(screen.getByRole('button', { name: 'Open saved link <b>Reference</b>' }));
    expect(onOpen).toHaveBeenCalledWith(bookmark);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.queryByText('Private note')).toBeNull();
  });
  it('starts selection on a touch hold and suppresses its pointer click', async () => {
    vi.useFakeTimers();
    try {
      const onToggleSelect = vi.fn();
      const onOpen = vi.fn();
      render(BookmarkCard, { bookmark, onToggleSelect, onOpen });
      const button = screen.getByRole('button', { name: `Open saved link ${bookmark.title}` });
      await fireEvent.pointerDown(button, { button: 0, pointerId: 1, pointerType: 'touch', clientX: 20, clientY: 20 });
      await vi.advanceTimersByTimeAsync(400);
      await fireEvent.pointerUp(button, { pointerId: 1 });
      await fireEvent.click(button, { detail: 1 });
      expect(onToggleSelect).toHaveBeenCalledOnce();
      expect(onOpen).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses kind-aware identity for selection and keyboard activation', async () => {
    const onToggleSelect = vi.fn();
    const onOpen = vi.fn();
    render(BookmarkCard, { bookmark, selected: true, selecting: true, onToggleSelect, onOpen });
    expect(screen.getByRole('checkbox')).toBeChecked();
    const card = screen.getByRole('button', { name: 'Select saved link <b>Reference</b>' });
    expect(card).toHaveAttribute('aria-pressed', 'true');
    await fireEvent.click(card);
    expect(onToggleSelect).toHaveBeenCalledWith(bookmark, expect.anything());
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByTestId('frameleaf-bookmark-card')).toHaveAttribute('data-asset-id', 'bookmark:book');
  });
});
