import { fireEvent, render } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { sidebarCollapsed, sidebarWidth } from '$lib/stores/preferences.store';
import { sidebarStore } from '$lib/stores/sidebar.svelte';
import UserPageLayout from './UserPageLayout.svelte';

vi.mock('$lib/components/shared-components/side-bar/UserSidebar.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));

beforeEach(() => {
  sidebarCollapsed.set(false);
  sidebarWidth.set(300);
  sidebarStore.reset();
});

it.each(['release', 'close'])('ends an active resize on %s', async (change) => {
  const view = render(UserPageLayout, { hideNavbar: true });
  await fireEvent.pointerDown(view.getByRole('separator', { hidden: true }), { pointerId: 1, clientX: 300 });
  expect(sidebarStore.isResizing).toBe(true);
  if (change === 'close') {
    view.unmount();
  } else {
    await fireEvent.pointerUp(window, { pointerId: 1 });
  }
  expect(sidebarStore.isResizing).toBe(false);
  const width = get(sidebarWidth);
  await fireEvent.pointerMove(window, { pointerId: 1, clientX: 450 });
  expect(get(sidebarWidth)).toBe(width);
});

it('replaces a prior drag and clears its listeners when the layout closes', async () => {
  const view = render(UserPageLayout, { hideNavbar: true });
  const separator = view.getByRole('separator', { hidden: true });
  await fireEvent.pointerDown(separator, { pointerId: 1 });
  await fireEvent.pointerDown(separator, { pointerId: 2 });
  view.unmount();
  expect(sidebarStore.isResizing).toBe(false);
  await fireEvent.pointerMove(window, { clientX: 450 });
  expect(get(sidebarWidth)).toBe(300);
});
