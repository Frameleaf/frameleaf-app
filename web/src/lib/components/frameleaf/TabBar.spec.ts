import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { SEARCH_SHORTCUT_EVENT } from '$lib/frameleaf/search-shortcuts';
import { Route } from '$lib/route';
import en from '../../../../../i18n/en.json';
import TabBar from './TabBar.svelte';

const app = vi.hoisted(() => ({ page: { url: new URL('http://localhost/photos') } }));
vi.mock('$app/state', () => ({ page: app.page }));

const at = (pathname: string) => {
  app.page.url = new URL(`http://localhost${pathname}`);
};

beforeEach(() => {
  addMessages('dev', en);
  at('/photos');
});

describe('TabBar', () => {
  it('offers Library, Memories, Albums and Search, in that order', () => {
    render(TabBar, { theme: 'dark' });
    const bar = screen.getByRole('navigation', { name: 'Sections' });

    expect([...bar.querySelectorAll('a, button')].map((item) => item.textContent?.trim())).toEqual([
      'Library',
      'Memories',
      'Albums',
      'Search',
    ]);
    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute('href', Route.photos());
    expect(screen.getByRole('link', { name: 'Memories' })).toHaveAttribute('href', Route.memories());
    expect(screen.getByRole('link', { name: 'Albums' })).toHaveAttribute('href', Route.albums());
  });

  it('marks the current section', () => {
    at('/albums');
    render(TabBar, { theme: 'light' });

    expect(screen.getByRole('link', { name: 'Albums' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Library' })).not.toHaveAttribute('aria-current');
  });

  it('opens the one search entry instead of a second search surface', async () => {
    const opened = vi.fn();
    addEventListener(SEARCH_SHORTCUT_EVENT, opened);
    render(TabBar, { theme: 'dark' });

    await fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(opened).toHaveBeenCalledOnce();
    removeEventListener(SEARCH_SHORTCUT_EVENT, opened);
  });

  it('is not drawn in Studio or the settings screens', () => {
    at('/studio');
    const studio = render(TabBar, { theme: 'dark' });
    expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull();
    studio.unmount();

    at('/user-settings');
    render(TabBar, { theme: 'dark' });
    expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull();
  });
});
