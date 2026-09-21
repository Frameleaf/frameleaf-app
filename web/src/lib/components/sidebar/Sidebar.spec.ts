import { render, screen, fireEvent } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { vi } from 'vitest';
import SideBarSection from '$lib/components/sidebar/Sidebar.svelte';
import { sidebarCollapsed } from '$lib/stores/preferences.store';
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

it('toggles the existing persisted collapse preference in the Frameleaf rail', async () => {
  mocks.mediaQueryManager.isFullSidebar = true;
  sidebarCollapsed.set(false);
  render(SideBarSection, { frameleaf: true });
  const collapse = screen.getByRole('button');
  await fireEvent.click(collapse);
  expect(get(sidebarCollapsed)).toBe(true);
  expect(localStorage.getItem('sidebar-collapsed')).toBe('true');
  expect(screen.getByTestId('sidebar-parent')).toHaveClass('is-collapsed');
  sidebarCollapsed.set(false);
});

it('reverts appearance in place without remounting the sidebar or changing collapse state', async () => {
  mocks.mediaQueryManager.isFullSidebar = true;
  sidebarCollapsed.set(true);
  const { rerender } = render(SideBarSection, { frameleaf: true });
  const sidebar = screen.getByTestId('sidebar-parent');
  expect(sidebar).toHaveClass('frameleaf');
  expect(sidebar).toHaveAttribute('data-theme');
  await rerender({ frameleaf: false });
  expect(screen.getByTestId('sidebar-parent')).toBe(sidebar);
  expect(sidebar).not.toHaveClass('frameleaf');
  expect(sidebar).not.toHaveAttribute('data-theme');
  expect(get(sidebarCollapsed)).toBe(true);
  sidebarCollapsed.set(false);
});
