import { tick } from 'svelte';
import { contextMenuNavigation } from '$lib/actions/context-menu-navigation';
import { deferredPromise } from '@test-data/deferred';

vi.mock('svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('svelte')>()),
  tick: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(tick).mockReset().mockResolvedValue(undefined);
});
afterEach(() => document.body.replaceChildren());

function setup(isOpen = true) {
  const node = document.createElement('div');
  const container = document.createElement('ul');
  container.innerHTML = '<li role="menuitem" id="first">First</li><li role="menuitem" id="second">Second</li>';
  node.append(container);
  document.body.append(node);
  const options = {
    isOpen,
    container: isOpen ? container : (undefined as HTMLElement | undefined),
    selectedId: undefined as string | undefined,
    openDropdown: vi.fn(),
    closeDropdown: vi.fn(),
    selectionChanged: vi.fn((id: string | undefined) => {
      options.selectedId = id;
    }),
  };
  const action = contextMenuNavigation(node, options);
  if (!action) {
    throw new Error('Action was not created');
  }
  return {
    node,
    container,
    options,
    press: (key: string) => node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
    update: (patch: Partial<typeof options>) => {
      Object.assign(options, patch);
      action.update?.(options);
    },
    destroy: () => action.destroy?.(),
  };
}

it('selects the first item in the container published while the menu opens', async () => {
  const pending = deferredPromise<void>();
  vi.mocked(tick).mockReturnValue(pending.promise);
  const view = setup(false);
  view.press('ArrowDown');
  view.update({ container: view.container, isOpen: true });
  pending.resolve();
  await pending.promise;
  expect(view.options.selectedId).toBe('first');
  view.destroy();
});

it('discards pending selection after destruction', async () => {
  const pending = deferredPromise<void>();
  vi.mocked(tick).mockReturnValue(pending.promise);
  const view = setup();
  view.press('ArrowDown');
  view.destroy();
  pending.resolve();
  await pending.promise;
  expect(view.options.selectionChanged).not.toHaveBeenCalled();
});

it('does not apply an older key press after closing and reopening the same container', async () => {
  const pending = deferredPromise<void>();
  vi.mocked(tick).mockReturnValue(pending.promise);
  const view = setup();
  view.press('ArrowDown');
  view.update({ isOpen: false });
  view.update({ isOpen: true });
  pending.resolve();
  await pending.promise;
  expect(view.options.selectionChanged).not.toHaveBeenCalled();
  view.destroy();
});

it('keeps both rapid key presses within the same live menu', async () => {
  const pending = deferredPromise<void>();
  vi.mocked(tick).mockReturnValue(pending.promise);
  const view = setup();
  view.press('ArrowDown');
  view.press('ArrowDown');
  pending.resolve();
  await pending.promise;
  expect(view.options.selectedId).toBe('second');
  expect(view.options.selectionChanged).toHaveBeenCalledTimes(2);
  view.destroy();
});

it('does not apply an older key press to a replaced open menu', async () => {
  const pending = deferredPromise<void>();
  vi.mocked(tick).mockReturnValue(pending.promise);
  const view = setup();
  view.press('ArrowDown');
  const replacement = document.createElement('ul');
  replacement.innerHTML = '<li role="menuitem" id="replacement">Replacement</li>';
  view.node.append(replacement);
  view.update({ container: replacement });
  pending.resolve();
  await pending.promise;
  expect(view.options.selectionChanged).not.toHaveBeenCalled();
  view.destroy();
});

it('navigates and activates valid menu IDs that are not CSS identifiers', async () => {
  const view = setup();
  const items = view.container.querySelectorAll<HTMLElement>('[role="menuitem"]');
  items[0].id = '1:first';
  items[1].id = '2:second';
  const click = vi.fn();
  items[1].addEventListener('click', click);
  view.press('ArrowDown');
  await tick();
  expect(view.options.selectedId).toBe('1:first');
  view.press('ArrowDown');
  await tick();
  expect(view.options.selectedId).toBe('2:second');
  view.press('Enter');
  expect(click).toHaveBeenCalledOnce();
  view.destroy();
});
