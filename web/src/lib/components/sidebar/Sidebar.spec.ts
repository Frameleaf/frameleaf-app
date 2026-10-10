import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { vi } from 'vitest';
import SideBarSection from '$lib/components/sidebar/Sidebar.svelte';
import { sidebarStore } from '$lib/stores/sidebar.svelte';

const mocks = vi.hoisted(() => {
  return {
    mediaQueryManager: {
      isFullSidebar: false,
    },
  };
});

vi.mock('$lib/stores/media-query-manager.svelte', () => ({
  mediaQueryManager: mocks.mediaQueryManager,
}));

vi.mock('$lib/stores/sidebar.svelte', () => ({
  sidebarStore: {
    isOpen: false,
    reset: vi.fn(),
  },
}));

describe('Sidebar component', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.mediaQueryManager.isFullSidebar = false;
    sidebarStore.isOpen = false;
  });

  it.each`
    isFullSidebar | isSidebarOpen | expectedInert
    ${false}      | ${false}      | ${true}
    ${false}      | ${true}       | ${false}
    ${true}       | ${false}      | ${false}
    ${true}       | ${true}       | ${false}
  `(
    'inert is $expectedInert when isFullSidebar=$isFullSidebar and isSidebarOpen=$isSidebarOpen',
    ({ isFullSidebar, isSidebarOpen, expectedInert }) => {
      // setup
      mocks.mediaQueryManager.isFullSidebar = isFullSidebar;
      sidebarStore.isOpen = isSidebarOpen;

      // when
      render(SideBarSection);
      const parent = screen.getByTestId('sidebar-parent');

      // then
      expect(parent.inert).toBe(expectedInert);
    },
  );

  it('should set width when sidebar is expanded', () => {
    // setup
    mocks.mediaQueryManager.isFullSidebar = false;
    sidebarStore.isOpen = true;

    // when
    render(SideBarSection);
    const parent = screen.getByTestId('sidebar-parent');

    // then
    expect(parent.classList).toContain('sidebar:w-(--sidebar-width)'); // width driven by the --sidebar-width CSS var
    expect(parent.classList).toContain('w-[min(100vw,16rem)]');
    expect(parent.classList).toContain('shadow-2xl');
  });

  it('keeps a footer outside the list that scrolls, after it', () => {
    const children = createRawSnippet(() => ({ render: () => '<a href="/photos">Library</a>' }));
    const footer = createRawSnippet(() => ({ render: () => '<a href="/user-settings">Settings</a>' }));

    render(SideBarSection, { children, footer });
    const list = screen.getByTestId('sidebar-parent').querySelector<HTMLElement>('.fl-sidebar-list')!;
    const settings = screen.getByRole('link', { name: 'Settings' });

    expect(list).toContainElement(screen.getByRole('link', { name: 'Library' }));
    expect(list).not.toContainElement(settings);
    expect(list.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('should close the sidebar if it is open on initial render', () => {
    // setup
    mocks.mediaQueryManager.isFullSidebar = false;
    sidebarStore.isOpen = true;

    // when
    render(SideBarSection);

    // then
    expect(sidebarStore.reset).toHaveBeenCalled();
  });
});
