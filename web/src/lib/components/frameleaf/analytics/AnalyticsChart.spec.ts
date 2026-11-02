import { render } from '@testing-library/svelte';
import AnalyticsChart from '$lib/components/frameleaf/analytics/AnalyticsChart.svelte';

const ticks = (container: HTMLElement) =>
  [...container.querySelectorAll('text.tick')].map((node) => node.textContent ?? '').filter((text) => /\d/.test(text));

describe('AnalyticsChart', () => {
  it('gives item counts whole-number ticks, never 235.2 items', () => {
    const { container } = render(AnalyticsChart, {
      kind: 'line',
      title: 'Cumulative library item count',
      labels: ['Sep', 'Oct'],
      unit: 'items',
      datasets: [{ label: 'Library', values: [235, 261] }],
    });
    expect(ticks(container).length).toBeGreaterThan(1);
    for (const tick of ticks(container)) {
      expect(tick).toMatch(/^[\d,]+$/);
    }
  });

  it('keeps a small count on a tight whole-number axis', () => {
    const { container } = render(AnalyticsChart, {
      title: 'Arrivals',
      labels: ['Mon', 'Tue'],
      unit: 'items',
      datasets: [{ label: 'Photos', values: [1, 2] }],
    });
    expect(ticks(container)).toEqual(['0', '1', '2']);
  });

  it('draws at real pixel size, so labels and dots are never stretched', () => {
    const { container } = render(AnalyticsChart, {
      kind: 'line',
      title: 'Growth',
      labels: ['Sep'],
      unit: 'items',
      datasets: [{ label: 'Library', values: [239] }],
    });
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('preserveAspectRatio')).toBeNull();
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${svg.getAttribute('width')} ${svg.getAttribute('height')}`);
  });

  it('keeps fractional storage ticks for sizes', () => {
    const { container } = render(AnalyticsChart, {
      kind: 'line',
      title: 'Storage',
      labels: ['Sep', 'Oct'],
      unit: 'GB',
      datasets: [{ label: 'Originals', values: [1.2, 1.5] }],
    });
    expect(ticks(container).some((tick) => tick.includes('.'))).toBe(true);
  });
});
