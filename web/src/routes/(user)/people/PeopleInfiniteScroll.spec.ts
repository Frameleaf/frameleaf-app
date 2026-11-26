import { render, waitFor } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { vi } from 'vitest';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { peopleListItemFactory } from '@test-data/factories/person-factory';
import PeopleInfiniteScroll from './PeopleInfiniteScroll.svelte';

const people = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    peopleListItemFactory.build({ id: `p${index}`, name: `Person ${index}` }),
  );
const children = createRawSnippet<[{ person: { id: string }; index: number }]>((entry) => ({
  render: () => `<span class="card" data-index="${entry().index}">${entry().person.id}</span>`,
}));
const ids = (container: HTMLElement) => [...container.querySelectorAll('.card')].map((card) => card.textContent);

/** A 4-column grid of 200px cards with a 20px gap in an 800px window: what the browser would report. */
const measurable = () => {
  const computed = getComputedStyle;
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = computed(element, pseudo);
    if (element instanceof HTMLElement && /library-grid|managed-grid/.test(element.className)) {
      const grid: Record<string, string> = { gridTemplateColumns: '196px 196px 196px 196px', rowGap: '20px' };
      return new Proxy(style, { get: (target, key: string) => grid[key] ?? Reflect.get(target, key) });
    }
    return style;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = this.classList.contains('cell') ? 200 : 0;
    // the grid starts at the top of the page, so it sits above the window by what has been scrolled
    return { top: -scrollY, left: 0, right: 0, bottom: 0, x: 0, y: 0, width: 196, height } as DOMRect;
  });
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(844);
};

// FL-1801: a long People grid mounts only the cards near the viewport.
describe('PeopleInfiniteScroll', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('mounts every card of a list short enough to animate', () => {
    measurable();
    const { container } = render(PeopleInfiniteScroll, { people: people(100), loadNextPage: () => {}, children });

    expect(ids(container)).toHaveLength(100);
  });

  it('mounts a bounded window of a long list and leaves room for the rest', async () => {
    measurable();
    const { container } = render(PeopleInfiniteScroll, { people: people(5000), loadNextPage: () => {}, children });
    const grid = container.querySelector<HTMLElement>('.library-grid')!;

    // 800px shows four 220px rows; three more are kept ready below
    await waitFor(() => expect(ids(container)).toHaveLength(7 * 4));
    expect(ids(container)[0]).toBe('p0');
    expect(grid.style.paddingTop).toBe('');
    expect(grid.style.minHeight).toBe(`${1250 * 220 - 20}px`);

    // far down the list: the window moves, the count stays bounded and the height stays the same
    vi.spyOn(globalThis, 'scrollY', 'get').mockReturnValue(1000 * 220);
    dispatchEvent(new Event('scroll'));
    await waitFor(() => expect(ids(container)[0]).toBe(`p${(1000 - 3) * 4}`));
    expect(ids(container)).toHaveLength((3 + 4 + 3) * 4);
    expect(container.querySelector<HTMLElement>('.card')?.dataset.index).toBe(String((1000 - 3) * 4));
    expect(grid.style.paddingTop).toBe(`${(1000 - 3) * 220}px`);
    expect(grid.style.minHeight).toBe(`${1250 * 220 - 20}px`);

    // scrolled past the end (a footer, an overscroll): the last rows stay, never the whole list
    vi.spyOn(globalThis, 'scrollY', 'get').mockReturnValue(9000 * 220);
    dispatchEvent(new Event('scroll'));
    await waitFor(() => expect(ids(container).at(-1)).toBe('p4999'));
    expect(ids(container)).toHaveLength(4 * 4);
    expect(grid.style.paddingTop).toBe(`${(1250 - 4) * 220}px`);
  });

  it('mounts everything where nothing can be measured, rather than nothing', async () => {
    const { container } = render(PeopleInfiniteScroll, { people: people(200), loadNextPage: () => {}, children });

    await waitFor(() => expect(ids(container)).toHaveLength(200));
  });
});
