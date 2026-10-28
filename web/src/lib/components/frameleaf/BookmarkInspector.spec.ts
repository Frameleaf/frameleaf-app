import { LibraryScope, type BookmarkResponseDto } from '@frameleaf/sdk';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import BookmarkInspector from './BookmarkInspector.svelte';

const user = userAdminFactory.build();
const bookmark: BookmarkResponseDto = {
  id: 'book',
  ownerId: user.id,
  title: 'Reference',
  url: 'https://example.com',
  note: 'Original',
  rating: 2,
  previewAssetId: null,
  libraryScope: LibraryScope.Design,
  isArchived: false,
  isLocked: false,
  deletedAt: null,
  createdAt: '',
  updatedAt: '',
  updateId: '',
};
beforeEach(() => {
  vi.clearAllMocks();
  authManager.setUser(user);
  authManager.setPreferences(preferencesFactory.build());
  sdkMock.getBookmark.mockResolvedValue(bookmark);
});
it('saves owner notes and ratings through bookmark APIs', async () => {
  sdkMock.updateBookmark.mockResolvedValue({ ...bookmark, note: 'Packaging note', rating: 4 });
  render(BookmarkInspector, { id: bookmark.id, onClose: vi.fn() });
  const note = await screen.findByRole('textbox', { name: 'frameleaf_bookmark_note' });
  await fireEvent.input(note, { target: { value: 'Packaging note' } });
  await fireEvent.change(screen.getByRole('combobox', { name: 'rating' }), { target: { value: '4' } });
  await fireEvent.click(screen.getByRole('button', { name: 'save' }));
  await waitFor(() =>
    expect(sdkMock.updateBookmark).toHaveBeenCalledWith({
      id: bookmark.id,
      bookmarkUpdateDto: { title: 'Reference', note: 'Packaging note', rating: 4 },
    }),
  );
});
it('shows readable shared details without owner notes or edit controls', async () => {
  sdkMock.getBookmark.mockResolvedValue({ ...bookmark, ownerId: 'someone-else', note: null, rating: null });
  render(BookmarkInspector, { id: bookmark.id, onClose: vi.fn() });
  expect(await screen.findByRole('heading', { name: 'Reference' })).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'save' })).toBeNull();
});

it('uses the authorized shared search record and discards it on an access change', async () => {
  const shared = { ...bookmark, ownerId: 'someone-else', note: null, rating: null };
  sdkMock.getBookmark.mockRejectedValue(new Error('Owned endpoint refuses members'));
  const view = render(BookmarkInspector, { id: shared.id, bookmark: shared, onClose: vi.fn() });
  expect(await screen.findByRole('heading', { name: 'Reference' })).toBeInTheDocument();
  expect(sdkMock.getBookmark).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox')).toBeNull();
  eventManager.emit('SessionLocked');
  await waitFor(() => expect(screen.queryByRole('link')).toBeNull());
  expect(sdkMock.getBookmark).not.toHaveBeenCalled();
  await view.rerender({ id: shared.id, bookmark: { ...shared, title: 'Revalidated reference' }, onClose: vi.fn() });
  expect(await screen.findByRole('heading', { name: 'Revalidated reference' })).toBeInTheDocument();
  authManager.reset();
  eventManager.emit('AuthLogout');
  await waitFor(() => expect(screen.queryByRole('link')).toBeNull());
});
