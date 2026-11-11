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

  // LIB-P4: the header block spans the scrubber's own column too, so the track keeps clear of it there.
  it('keeps its track clear of the page header in its own column as well', () => {
    render(YearScrubber, { timelineManager: new TimelineManager(), clear: 120 });
    expect(screen.getByTestId('frameleaf-year-scrubber').style.getPropertyValue('--fl-scrub-clear')).toBe('120px');
  });
});
