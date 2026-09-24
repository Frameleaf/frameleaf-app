import { render, waitFor } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import { vi } from 'vitest';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { peopleListItemFactory } from '@test-data/factories/person-factory';
import PeoplePage from './+page.svelte';
import { PEOPLE_CAP, PEOPLE_PAGE_SIZE } from './people-page';

// Small page and cap sizes keep the rendered grid cheap; the page reads both from this module.
vi.mock(import('./people-page'), () => ({ PEOPLE_PAGE_SIZE: 2, PEOPLE_CAP: 6 }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/people') } }));
vi.mock('$lib/components/layouts/UserPageLayout.svelte', async () => {
  return await import('@test-data/mocks/UserPageLayout.mock.svelte');
});

type Data = ComponentProps<typeof PeoplePage>['data'];
const data = (people: ReturnType<typeof peopleListItemFactory.build>[], hasNextPage: boolean): Data => ({
  error: undefined,
  meta: { title: 'People' },
  asset: undefined,
  people: { people, total: people.length, hidden: 0, hasNextPage },
});
const page = (size: number, prefix: string) =>
  Array.from({ length: size }, (_, index) => peopleListItemFactory.build({ id: `${prefix}${index}`, isHidden: false }));

// FL-37: the People grid reads every page up front for its sorts, in the largest pages the API
// allows, stops at a cap and never keeps reading after the page is gone.
describe('People library page loading', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    sdkMock.getMergeSuggestions.mockResolvedValue({ suggestions: [] });
    sdkMock.getAssetStatistics.mockResolvedValue({ images: 0, videos: 0, total: 0 });
  });

  it('reads the remaining pages in the largest page size and stops at the cap', async () => {
    sdkMock.getAllPeople.mockImplementation((options) => {
      return Promise.resolve({
        people: page(PEOPLE_PAGE_SIZE, `p${options?.page ?? 1}-`),
        total: 99_999,
        hidden: 0,
        hasNextPage: true,
      });
    });
    const { container } = render(PeoplePage, { data: data(page(PEOPLE_PAGE_SIZE, 'p1-'), true) });

    await waitFor(() => expect(container.textContent).toContain('frameleaf_people_truncated'), { timeout: 3000 });
    const calls = sdkMock.getAllPeople.mock.calls.map(([options]) => options);
    expect(calls).toEqual([
      { withHidden: true, page: 2, size: PEOPLE_PAGE_SIZE },
      { withHidden: true, page: 3, size: PEOPLE_PAGE_SIZE },
    ]);
    expect(container.querySelectorAll('.pl-card')).toHaveLength(PEOPLE_CAP);
  });

  it('stops reading pages once the page is destroyed', async () => {
    let resolveSecond: (value: never) => void = () => {};
    sdkMock.getAllPeople.mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));
    const { unmount } = render(PeoplePage, { data: data(page(3, 'a'), true) });
    unmount();
    resolveSecond({ people: page(3, 'b'), total: 9, hidden: 0, hasNextPage: true } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sdkMock.getAllPeople).toHaveBeenCalledOnce();
  });
});
