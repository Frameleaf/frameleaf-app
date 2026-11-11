import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import YearScrubber from './YearScrubber.svelte';

/** Svelte's `bind:clientWidth` listens through one ResizeObserver; this one is driven by the test. */
let resized: (target: Element) => void = () => {};
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resized = (target) => callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe('YearScrubber', () => {
  const measure = async (element: HTMLElement, width: number) => {
    Object.defineProperty(element, 'clientWidth', { configurable: true, get: () => width });
    resized(element);
    await tick();
  };

  // The page hides the library (`display: none`) while the viewer is open, and a hidden element
  // measures 0. Reporting that gave the scrubber's column to the photos for a frame on the way back,
  // which laid every month out twice and left the grid a row or two from where it had been.
  it('keeps reporting its last real width while it is hidden', async () => {
    let column = 0;
    render(YearScrubber, {
      props: {
        timelineManager: new TimelineManager(),
        get scrubberWidth() {
          return column;
        },
        set scrubberWidth(value: number | undefined) {
          column = value ?? 0;
        },
      },
    });
    const scrubber = screen.getByTestId('frameleaf-year-scrubber');

    await measure(scrubber, 34);
    expect(column).toBe(34);
    await measure(scrubber, 0);
    expect(column).toBe(34);
    await measure(scrubber, 40);
    expect(column).toBe(40);
  });

  // Touch and narrow screens: the thin line keeps clear of the page header too, and says it is thin.
  it('keeps its track clear of the page header the host says is still on screen, as the thin line', () => {
    render(YearScrubber, { timelineManager: new TimelineManager(), thin: true, clear: 120 });
    const scrubber = screen.getByTestId('frameleaf-year-scrubber');
    expect(scrubber.style.getPropertyValue('--fl-scrub-clear')).toBe('120px');
    expect(scrubber).toHaveClass('is-thin');
  });

  // The thin line has no year labels: reached with the keyboard, its bubble names the month it is on.
  it('names the current month while the thin line holds keyboard focus', async () => {
    const timelineManager = {
      scrubberTimelineHeight: 1000,
      topSectionHeight: 0,
      scrubberMonths: [
        { year: 2026, month: 8, title: 'August 2026', assetCount: 3, height: 600 },
        { year: 2026, month: 7, title: 'July 2026', assetCount: 1, height: 400 },
      ],
    } as unknown as TimelineManager;
    render(YearScrubber, { timelineManager, thin: true, viewportTopMonth: { year: 2026, month: 7 } });
    const slider = screen.getByRole('slider');

    expect(screen.queryByText('July 2026')).not.toBeInTheDocument();
    await fireEvent.focus(slider);
    expect(screen.getByText('July 2026')).toBeInTheDocument();
    await fireEvent.blur(slider);
    expect(screen.queryByText('July 2026')).not.toBeInTheDocument();
  });

  // FL-1410: a phone set to 2031 never puts "2031" on the scrubber; those photos wait in one group at the end.
  it('labels the years of the dated months only, and names the dates to check when on them', async () => {
    const timelineManager = {
      scrubberTimelineHeight: 1000,
      topSectionHeight: 0,
      scrubberMonths: [
        { year: 2026, month: 8, title: 'August 2026', assetCount: 3, height: 400 },
        { year: 2024, month: 7, title: 'July 2024', assetCount: 1, height: 400 },
        { year: 1, month: 1, title: 'Dates to check', assetCount: 55, height: 200, toCheck: true },
      ],
    } as unknown as TimelineManager;
    const { container } = render(YearScrubber, {
      timelineManager,
      height: 600,
      thin: true,
      viewportTopMonth: { year: 1, month: 1 },
    });
    expect([...container.querySelectorAll('.fl-scrub-year')].map((label) => label.textContent)).toEqual([
      '2026',
      '2024',
    ]);
    expect(container.querySelectorAll('.fl-scrub-yeartick')).toHaveLength(2);
    // it keeps its place on the track
    expect(container.querySelectorAll('.fl-scrub-tick')).toHaveLength(3);
    await fireEvent.focus(screen.getByRole('slider'));
    expect(screen.getByText('Dates to check')).toBeInTheDocument();
  });

  // FL-1452: at the very bottom the top of the view is past the last month ('lead-out'); the marker
  // stayed on the first month there.
  it('keeps the marker on the last month at the very bottom of the timeline', () => {
    const timelineManager = {
      scrubberTimelineHeight: 1000,
      topSectionHeight: 0,
      scrubberMonths: [
        { year: 2026, month: 8, title: 'August 2026', assetCount: 3, height: 600 },
        { year: 2026, month: 7, title: 'July 2026', assetCount: 1, height: 400 },
      ],
    } as unknown as TimelineManager;
    const { container } = render(YearScrubber, {
      timelineManager,
      height: 600,
      viewportTopMonth: 'lead-out',
      viewportTopMonthScrollPercent: 0,
    });
    const marker = container.querySelector<HTMLElement>('.fl-scrub-marker')!;
    expect(marker.style.top).toBe('100%');
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '1');
    expect(container.querySelector('.fl-scrub-tick.is-current')).toBe(container.querySelectorAll('.fl-scrub-tick')[1]);
  });

  // FL-1452: the Years and Months cards leave the dates to check out; their scrubber has no dead end for them
  it('leaves the dates to check off the track over the cards', () => {
    const timelineManager = {
      scrubberTimelineHeight: 1000,
      topSectionHeight: 0,
      scrubberMonths: [
        { year: 2026, month: 8, title: 'August 2026', assetCount: 3, height: 600 },
        { year: 2024, month: 7, title: 'July 2024', assetCount: 1, height: 200 },
        { year: 0, month: 1, title: 'Dates to check', assetCount: 55, height: 200, toCheck: true },
      ],
    } as unknown as TimelineManager;
    const { container } = render(YearScrubber, {
      timelineManager,
      height: 600,
      datedOnly: true,
      viewportTopMonth: { year: 2024, month: 7 },
      viewportTopMonthScrollPercent: 1,
    });
    expect(container.querySelectorAll('.fl-scrub-tick')).toHaveLength(2);
    // the dated months fill the whole track
    expect(container.querySelector<HTMLElement>('.fl-scrub-marker')!.style.top).toBe('100%');
  });

  // LIB-P4: the header block spans the scrubber's own column too, so the track keeps clear of it there.
  it('keeps its track clear of the page header in its own column as well', () => {
    render(YearScrubber, { timelineManager: new TimelineManager(), clear: 120 });
    expect(screen.getByTestId('frameleaf-year-scrubber').style.getPropertyValue('--fl-scrub-clear')).toBe('120px');
  });
});
