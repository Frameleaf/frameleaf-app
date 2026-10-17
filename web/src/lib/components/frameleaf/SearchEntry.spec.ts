import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { SEARCH_SHORTCUT_EVENT } from '$lib/frameleaf/search-shortcuts';
import { eventManager } from '$lib/managers/event-manager.svelte';
import SearchEntry from './SearchEntry.svelte';

const app = vi.hoisted(() => ({
  page: { url: new URL('http://localhost/photos'), route: { id: '/(user)/photos' }, params: {} },
}));
vi.mock('$app/state', () => ({ page: app.page }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { search: true, map: true, trash: true } },
}));

/** Design review, section 1 item 4: settings has one search field, not two. */
describe('SearchEntry', () => {
  beforeEach(() => {
    app.page.url = new URL('http://localhost/photos');
    document.body.replaceChildren();
  });

  it('is the top bar search on library pages', () => {
    render(SearchEntry);
    expect(screen.getByTestId('search-entry')).toBeInTheDocument();
  });

  it('suggests the prototype actions first in the empty command palette (SHELL-P3)', async () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    Element.prototype.scrollIntoView ??= () => {};
    localStorage.clear();
    render(SearchEntry, { onToggleLocked: vi.fn() });

    await fireEvent.keyDown(document, { key: 'p', ctrlKey: true, shiftKey: true });
    const titles = (await screen.findAllByRole('option')).map((option) => option.querySelector('strong')?.textContent);

    expect(titles.slice(0, 8)).toEqual([
      'frameleaf_search_command_upload_photos',
      'frameleaf_albums_create_album',
      'keyboard_shortcuts',
      'dark_theme',
      'frameleaf_locked_unlock_content',
      'support_and_feedback',
      'frameleaf_about_menu_item',
      'sign_out',
    ]);
  });

  it('draws nothing on settings pages, and the shortcut still reaches the page’s own field', async () => {
    app.page.url = new URL('http://localhost/user-settings?area=care');
    const field = document.createElement('input');
    field.id = 'settings-search';
    document.body.append(field);

    render(SearchEntry);
    expect(screen.queryByTestId('search-entry')).not.toBeInTheDocument();

    dispatchEvent(new CustomEvent(SEARCH_SHORTCUT_EVENT));
    await tick();
    expect(document.activeElement).toBe(field);
  });

  it('drops people, albums and places from the command palette when access changes', async () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    Element.prototype.scrollIntoView ??= () => {};
    localStorage.clear();
    sdkMock.getAllPeople.mockResolvedValue({ people: [{ id: 'p1', name: 'Locked Person' }] } as never);
    sdkMock.getAlbumTree.mockResolvedValue({ albums: [], collections: [], spaces: [] } as never);
    sdkMock.getSearchSuggestions.mockResolvedValue([]);
    render(SearchEntry);

    await fireEvent.keyDown(document, { key: 'p', ctrlKey: true, shiftKey: true });
    await fireEvent.input(await screen.findByRole('combobox'), { target: { value: 'Locked Person' } });
    expect(await screen.findByRole('option', { name: /Locked Person/ })).toBeInTheDocument();

    // The narrower session no longer lists that person; nothing from the earlier answer stays.
    sdkMock.getAllPeople.mockResolvedValue({ people: [] } as never);
    eventManager.emit('SessionLocked');
    await waitFor(() => expect(screen.queryByRole('option', { name: /Locked Person/ })).not.toBeInTheDocument());
  });
});
