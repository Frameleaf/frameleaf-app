import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { invalidateAll } from '$app/navigation';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { deferredPromise } from '@test-data/deferred';
import { personFactory } from '@test-data/factories/person-factory';
import type { PageData } from './$types';
import PersonPage from './+page.svelte';

const hero = vi.hoisted(() => ({ mounts: 0, onFacesChanged: undefined as (() => Promise<void>) | undefined }));
vi.mock('$app/navigation', () => ({ afterNavigate: vi.fn(), goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$app/state', () => ({
  page: {
    params: {},
    url: new URL('http://localhost/people/person'),
    route: { id: '/(user)/people/[personId]' },
  },
}));
vi.mock(
  '$lib/components/layouts/UserPageLayout.svelte',
  async () => import('@test-data/mocks/UserPageLayout.mock.svelte'),
);
vi.mock(
  '$lib/components/frameleaf/LibraryView.svelte',
  async () => import('@test-data/mocks/UserPageLayout.mock.svelte'),
);
vi.mock('$lib/components/OnEvents.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/timeline/TimelineAssetViewer.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/people/PersonHero.svelte', () => ({
  default: (_anchor: unknown, props: { onFacesChanged: () => Promise<void> }) => {
    hero.mounts++;
    hero.onFacesChanged = props.onFacesChanged;
  },
}));
vi.mock('$lib/utils/handle-error', async (original) => ({ ...(await original<object>()), handleError: vi.fn() }));
const data = (id = 'original') =>
  ({
    person: personFactory.build({ id }),
    statistics: { assets: 1, photos: 1, videos: 0 },
  }) as PageData;
beforeEach(() => {
  vi.clearAllMocks();
  hero.mounts = 0;
  hero.onFacesChanged = undefined;
  authManager.reset();
});

it('refreshes the current person timeline after face changes', async () => {
  vi.mocked(invalidateAll).mockResolvedValue();
  render(PersonPage, { data: data() });
  expect(hero.mounts).toBe(1);
  await hero.onFacesChanged!();
  await tick();
  expect(hero.mounts).toBe(2);
});

it.each(['replacement', 'away and back', 'session'] as const)(
  'does not remount a replacement timeline after %s during face-count refresh',
  async (change) => {
    const pending = deferredPromise<void>();
    vi.mocked(invalidateAll).mockReturnValue(pending.promise);
    const original = data();
    const view = render(PersonPage, { data: original });
    const done = hero.onFacesChanged!();
    if (change === 'session') {
      authManager.reset();
    } else {
      await view.rerender({ data: data('replacement') });
      if (change === 'away and back') {
        await view.rerender({ data: original });
      }
    }
    const mounts = hero.mounts;
    pending.resolve();
    await done;
    await tick();
    expect(hero.mounts).toBe(mounts);
  },
);

it('keeps a same-person loader revalidation eligible for timeline refresh', async () => {
  const pending = deferredPromise<void>();
  vi.mocked(invalidateAll).mockReturnValue(pending.promise);
  const view = render(PersonPage, { data: data() });
  const done = hero.onFacesChanged!();
  await view.rerender({ data: data() });
  pending.resolve();
  await done;
  await tick();
  expect(hero.mounts).toBe(2);
});

it.each([false, true])('reports a refresh failure only for its current view (retired: %s)', async (retired) => {
  const pending = deferredPromise<void>();
  vi.mocked(invalidateAll).mockReturnValue(pending.promise);
  const view = render(PersonPage, { data: data() });
  const done = hero.onFacesChanged!();
  if (retired) {
    view.unmount();
  }
  pending.reject(new Error('Offline'));
  await done;
  expect(handleError).toHaveBeenCalledTimes(retired ? 0 : 1);
});

it.each(['close', 'replacement', 'session'] as const)('ignores the retired hero callback after %s', async (change) => {
  const view = render(PersonPage, { data: data() });
  const done = hero.onFacesChanged!;
  if (change === 'close') {
    view.unmount();
  } else if (change === 'session') {
    authManager.reset();
  } else {
    await view.rerender({ data: data('replacement') });
  }
  const mounts = hero.mounts;
  await done();
  await tick();
  expect(invalidateAll).not.toHaveBeenCalled();
  expect(hero.mounts).toBe(mounts);
});
