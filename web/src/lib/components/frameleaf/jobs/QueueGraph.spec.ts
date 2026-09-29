import { render } from '@testing-library/svelte';
import QueueGraph from './QueueGraph.svelte';

const media = vi.hoisted(() => ({ reducedMotion: false }));
vi.mock('$lib/stores/media-query-manager.svelte', () => ({ mediaQueryManager: media }));
vi.mock('uplot', () => ({
  default: class {
    setData = vi.fn();
    setScale = vi.fn();
    setSize = vi.fn();
    redraw = vi.fn();
    destroy = vi.fn();
  },
}));

/** FL-139: the queue graph's animation loop respects Reduce Motion and stops when the graph goes away. */
describe('QueueGraph', () => {
  let request: ReturnType<typeof vi.spyOn>;
  let cancel: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    request = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 7);
    cancel = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('scrolls every frame, and stops the loop when unmounted', () => {
    media.reducedMotion = false;
    const { unmount } = render(QueueGraph, { queueName: 'thumbnailGeneration' } as never);
    expect(request).toHaveBeenCalled();

    unmount();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it('never runs a frame loop under Reduce Motion, and stops its interval when unmounted', () => {
    media.reducedMotion = true;
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = render(QueueGraph, { queueName: 'thumbnailGeneration' } as never);
    expect(request).not.toHaveBeenCalled();

    unmount();
    expect(clear).toHaveBeenCalled();
  });
});
