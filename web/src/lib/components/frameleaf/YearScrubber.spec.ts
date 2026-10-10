import { render, screen } from '@testing-library/svelte';
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

  // Floating over the photos' edge it also floats over the page header, whose last control it covered.
  it('keeps its track clear of the page header the host says is still on screen, when it floats', () => {
    render(YearScrubber, { timelineManager: new TimelineManager(), overlay: true, clear: 120 });
    expect(screen.getByTestId('frameleaf-year-scrubber').style.getPropertyValue('--fl-scrub-clear')).toBe('120px');
  });

  it('asks for no clearance in its own column', () => {
    render(YearScrubber, { timelineManager: new TimelineManager(), clear: 120 });
    expect(screen.getByTestId('frameleaf-year-scrubber').style.getPropertyValue('--fl-scrub-clear')).toBe('');
  });
});
