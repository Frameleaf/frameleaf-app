import { render } from '@testing-library/svelte';
import { DateTime } from 'luxon';
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
});

it('lays a year out in week columns of square cells with the month names underneath', () => {
  // As getHeatmapRange asks for it: 52 weeks back to a Sunday.
  const from = DateTime.fromISO('2025-10-12', { zone: 'utc' });
  const series = Array.from({ length: 52 * 7 + 5 }, (_, index) => ({
    date: from.plus({ days: index }).toISODate()!,
    count: index % 3,
  }));
  const view = render(CalendarHeatmap, {
    data: { from: series[0].date, to: series.at(-1)!.date, totalCount: 1, series },
    itemLabel: ({ date }: { date: string }) => date,
    totalLabel: String,
  });
  const root = view.container.querySelector<HTMLElement>('.heatmap')!;
  // The grid has one column per week and fits its container: every column shares the width.
  const weeks = Number(root.style.getPropertyValue('--weeks'));
  expect(weeks).toBeGreaterThanOrEqual(53);
  expect(weeks).toBeLessThanOrEqual(54);
  for (const cell of root.querySelectorAll(':scope .heat > .cell')) {
    expect(cell).toHaveClass('cell');
  }
  // Twelve month names, from the first full month to this one, each under the week it starts in.
  const months = [...root.querySelectorAll<HTMLElement>(':scope .months span')];
  expect(months.map((month) => month.textContent)).toEqual([
    'Nov',
    'Dec',
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
  ]);
  const columns = months.map((month) => Number(month.style.gridColumnStart));
  expect(columns).toEqual([...columns].sort((a, b) => a - b));
  expect(columns.at(-1)).toBeLessThanOrEqual(weeks);
  // No sideways scroller: the component draws none.
  expect(view.container.querySelector('.overflow-x-auto')).toBeNull();
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
