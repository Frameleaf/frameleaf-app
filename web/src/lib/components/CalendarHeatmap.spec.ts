import { render } from '@testing-library/svelte';
import { Info } from 'luxon';
import { get } from 'svelte/store';
import CalendarHeatmap from '$lib/components/CalendarHeatmap.svelte';
import { locale } from '$lib/stores/preferences.store';

const originalLocale = get(locale);
beforeEach(() => locale.set('en'));
afterEach(() => {
  locale.set(originalLocale);
  vi.restoreAllMocks();
});

const dataFor = (counts: number[]) => ({
  from: '2024-01-01',
  to: '2024-01-31',
  totalCount: counts.reduce((a, b) => a + b, 0),
  series: counts.map((count, index) => ({ date: `2024-01-${String(index + 1).padStart(2, '0')}`, count })),
});

it('retains heatmap thresholds and shares each accessible label with its tooltip', () => {
  const weekdays = vi.spyOn(Info, 'weekdays');
  const itemLabel = vi.fn(({ count }: { count: number }) => `count=${count}`);
  const view = render(CalendarHeatmap, { data: dataFor([0, 1, 2, 3, 4, 5, 6, 7, 8]), itemLabel, totalLabel: String });
  const cells = [...view.container.querySelectorAll<HTMLElement>('[aria-label]')];
  const colors = [
    'bg-gray-200',
    'bg-immich-primary/30',
    'bg-immich-primary/30',
    'bg-immich-primary/50',
    'bg-immich-primary/50',
    'bg-immich-primary/70',
    'bg-immich-primary/70',
    'bg-immich-primary',
    'bg-immich-primary',
  ];
  expect(cells).toHaveLength(9);
  for (const [index, cell] of cells.entries()) {
    expect(cell.classList.contains(colors[index])).toBe(true);
    expect(cell.title).toBe(cell.getAttribute('aria-label'));
  }
  expect(itemLabel).toHaveBeenCalledTimes(9);
  expect(weekdays).toHaveBeenCalledTimes(1);
});

it('updates colors when the data maximum changes and keeps zero activity neutral', async () => {
  const itemLabel = ({ count }: { count: number }) => `count=${count}`;
  const view = render(CalendarHeatmap, { data: dataFor([2, 4]), itemLabel, totalLabel: String });
  expect(view.container.querySelector('[aria-label="count=2"]')).toHaveClass('bg-immich-primary/50');
  await view.rerender({ data: dataFor([2, 8]) });
  expect(view.container.querySelector('[aria-label="count=2"]')).toHaveClass('bg-immich-primary/30');
  await view.rerender({ data: dataFor([0, 0]) });
  expect(view.container.querySelector('[aria-label="count=0"]')).toHaveClass('bg-gray-200');
});
