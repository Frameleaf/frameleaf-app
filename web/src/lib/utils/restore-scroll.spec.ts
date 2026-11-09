import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreScroll } from '$lib/utils/restore-scroll';

describe('restoreScroll', () => {
  let frames: FrameRequestCallback[];
  const nextFrame = () => frames.shift()?.(performance.now());
  /** An element whose scroll position is clamped to how tall its content currently is. */
  const scroller = (maxScroll: number) => {
    const element = {
      maxScroll,
      scrollTop: 0,
      scrollTo: ({ top }: { top: number }) => (element.scrollTop = Math.min(top, element.maxScroll)),
    };
    return element;
  };

  beforeEach(() => {
    frames = [];
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reaches the saved position once late content makes the page tall enough', () => {
    const element = scroller(103);
    restoreScroll(() => element as unknown as HTMLElement, 371);
    nextFrame();
    expect(element.scrollTop).toBe(103);
    element.maxScroll = 800;
    nextFrame();
    expect(element.scrollTop).toBe(371);
    expect(frames).toHaveLength(0);
  });

  it('stops when the person scrolls while the page is still filling in', () => {
    const element = scroller(103);
    restoreScroll(() => element as unknown as HTMLElement, 371);
    nextFrame();
    element.scrollTop = 40;
    element.maxScroll = 800;
    nextFrame();
    expect(element.scrollTop).toBe(40);
    expect(frames).toHaveLength(0);
  });

  it('gives up when the page never gets tall enough', () => {
    const element = scroller(103);
    restoreScroll(() => element as unknown as HTMLElement, 371, 100);
    nextFrame();
    vi.advanceTimersByTime(101);
    nextFrame();
    expect(frames).toHaveLength(0);
  });
});
