import { render } from '@testing-library/svelte';
import { sidebarCollapsed, sidebarWidth } from '$lib/stores/preferences.store';
import { sidebarStore } from '$lib/stores/sidebar.svelte';
import UserShellFixture from '@test-data/components/UserShellFixture.svelte';

vi.mock('$lib/components/shared-components/navigation-bar/NavigationBar.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/shared-components/side-bar/UserSidebar.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));

beforeEach(() => {
  sidebarCollapsed.set(false);
  sidebarWidth.set(300);
  sidebarStore.reset();
});

/** FL-1796: a page change replaces the page, not the top bar and the rail around it. */
describe('UserShell', () => {
  const topBar = (container: HTMLElement) => container.querySelector(':scope header p');
  const grid = (container: HTMLElement) => container.querySelector('header')?.nextElementSibling ?? null;
  const rail = (container: HTMLElement) =>
    [...(grid(container)?.children ?? [])].find((child) => child.tagName === 'P') ?? null;

  it('keeps the same top bar and rail when one page replaces another', async () => {
    const view = render(UserShellFixture, { page: 'photos' });
    const bar = topBar(view.container);
    const sidebar = rail(view.container);
    expect(bar).not.toBeNull();
    expect(sidebar).not.toBeNull();
    expect(view.getByText('Photos page')).toBeInTheDocument();

    await view.rerender({ page: 'albums' });

    expect(view.getByText('Albums page')).toBeInTheDocument();
    expect(view.queryByText('Photos page')).not.toBeInTheDocument();
    expect(topBar(view.container)).toBe(bar);
    expect(rail(view.container)).toBe(sidebar);
    // the page's own addition to the rail arrives without rebuilding the rail
    expect(sidebar).toContainElement(view.getByRole('link', { name: 'Skip to albums' }));

    await view.rerender({ page: 'photos' });
    expect(rail(view.container)).toBe(sidebar);
    expect(view.queryByRole('link', { name: 'Skip to albums' })).not.toBeInTheDocument();
  });

  it('draws the page body in the same place as before: header, then the grid holding rail, handle and main', () => {
    const { container } = render(UserShellFixture, { page: 'photos' });
    const shellGrid = grid(container)!;
    expect(
      [...shellGrid.children].map((child) => (child.tagName === 'DIV' ? child.getAttribute('role') : child.tagName)),
    ).toEqual(['P', 'separator', 'MAIN']);
    expect(shellGrid).toHaveClass('grid', 'overflow-hidden');
    expect(shellGrid.getAttribute('style')).toContain('--sidebar-width: 300px');
  });

  it('keeps the top bar and drops the rail and its handle on a page without one', async () => {
    const view = render(UserShellFixture, { page: 'photos' });
    const bar = topBar(view.container);

    await view.rerender({ page: 'studio' });

    expect(topBar(view.container)).toBe(bar);
    expect(rail(view.container)).toBeNull();
    expect(view.queryByRole('separator', { hidden: true })).not.toBeInTheDocument();
    expect(grid(view.container)).toHaveClass('grid-cols-1');
  });

  it('draws nothing around a page that has no layout, and comes back for the next one', async () => {
    const view = render(UserShellFixture, { page: 'viewer' });
    expect(view.container.querySelector('header')).toBeNull();
    expect(view.getByText('Viewer page').parentElement).toHaveClass('contents');

    await view.rerender({ page: 'photos' });
    expect(topBar(view.container)).not.toBeNull();
    expect(rail(view.container)).not.toBeNull();

    await view.rerender({ page: 'viewer' });
    expect(view.container.querySelector('header')).toBeNull();
    expect(view.getByText('Viewer page')).toBeInTheDocument();
  });
});
