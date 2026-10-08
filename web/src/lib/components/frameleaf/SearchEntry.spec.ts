import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_SHORTCUT_EVENT } from '$lib/frameleaf/search-shortcuts';
import SearchEntry from './SearchEntry.svelte';

const app = vi.hoisted(() => ({
  page: { url: new URL('http://localhost/photos'), route: { id: '/(user)/photos' }, params: {} },
}));
vi.mock('$app/state', () => ({ page: app.page }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

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
});
