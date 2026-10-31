import { flushSync } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { scrollMemory, scrollMemoryClearer } from '$lib/actions/scroll-memory';
import { SessionStorageKey } from '$lib/constants';
import { deferredPromise } from '@test-data/deferred';

const navigation = new SvelteMap<string, { url: URL }>();
vi.mock('$app/state', () => ({
  navigating: {
    get to() {
      return navigation.get('to') ?? null;
    },
  },
}));

beforeEach(() => {
  navigation.clear();
  sessionStorage.clear();
});

it('keeps scroll memory within the route and stops clearing it when destroyed', () => {
  const beforeClear = vi.fn();
  const action = scrollMemoryClearer(document.createElement('div'), { routeStartsWith: '/people', beforeClear });
  sessionStorage.setItem(SessionStorageKey.SCROLL_POSITION, '123');

  flushSync(() => navigation.set('to', { url: new URL('https://photos.test/people/person') }));
  expect(sessionStorage.getItem(SessionStorageKey.SCROLL_POSITION)).toBe('123');
  expect(beforeClear).not.toHaveBeenCalled();

  flushSync(() => navigation.set('to', { url: new URL('https://photos.test/albums') }));
  expect(sessionStorage.getItem(SessionStorageKey.SCROLL_POSITION)).toBeNull();
  expect(beforeClear).toHaveBeenCalledOnce();

  action.destroy();
  sessionStorage.setItem(SessionStorageKey.SCROLL_POSITION, '456');
  flushSync(() => navigation.set('to', { url: new URL('https://photos.test/tags') }));
  expect(sessionStorage.getItem(SessionStorageKey.SCROLL_POSITION)).toBe('456');
  expect(beforeClear).toHaveBeenCalledOnce();
});

it('saves the current scroll position on navigation into a subpage', async () => {
  const node = document.createElement('div');
  node.scrollTop = 321;
  const beforeSave = vi.fn();
  const action = scrollMemory(node, { routeStartsWith: '/people', beforeSave });
  await Promise.resolve();

  flushSync(() => navigation.set('to', { url: new URL('https://photos.test/people/person') }));
  expect(sessionStorage.getItem(SessionStorageKey.SCROLL_POSITION)).toBe('321');
  expect(beforeSave).toHaveBeenCalledOnce();
  action.destroy();
});

it('does not scroll, clear current page state or consume its saved position after destruction', async () => {
  const pending = deferredPromise<void>();
  const node = document.createElement('div');
  const scroll = vi.spyOn(node, 'scroll').mockImplementation(() => {});
  const beforeClear = vi.fn();
  const action = scrollMemory(node, {
    routeStartsWith: '/people',
    beforeClear,
    beforeScroll: () => pending.promise,
  });
  action.destroy();
  sessionStorage.setItem(SessionStorageKey.SCROLL_POSITION, '456');
  pending.resolve();
  await pending.promise;
  expect(scroll).not.toHaveBeenCalled();
  expect(beforeClear).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(SessionStorageKey.SCROLL_POSITION)).toBe('456');
});

it('restores a saved position and clears it after the active load completes', async () => {
  const pending = deferredPromise<void>();
  const node = document.createElement('div');
  const scroll = vi.spyOn(node, 'scroll').mockImplementation(() => {});
  const beforeClear = vi.fn();
  sessionStorage.setItem(SessionStorageKey.SCROLL_POSITION, '456');
  const action = scrollMemory(node, {
    routeStartsWith: '/people',
    beforeClear,
    beforeScroll: () => pending.promise,
  });
  pending.resolve();
  await pending.promise;
  expect(scroll).toHaveBeenCalledWith({ top: 456, behavior: 'instant' });
  expect(beforeClear).toHaveBeenCalledOnce();
  expect(sessionStorage.getItem(SessionStorageKey.SCROLL_POSITION)).toBeNull();
  action.destroy();
});
