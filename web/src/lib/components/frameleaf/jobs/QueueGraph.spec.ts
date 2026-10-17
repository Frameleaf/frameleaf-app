import type { QueueResponseDto } from '@frameleaf/sdk';
import { render } from '@testing-library/svelte';
import type { QueueSnapshot } from '$lib/types';
import QueueGraph from './QueueGraph.svelte';

const media = vi.hoisted(() => ({ reducedMotion: false }));
const queues = vi.hoisted(() => ({ snapshots: [] as QueueSnapshot[] }));
const chart = vi.hoisted(() => ({ create: vi.fn() }));
const queue = { name: 'thumbnailGeneration' } as QueueResponseDto;
vi.mock('$lib/managers/queue-manager.svelte', () => ({ queueManager: queues }));
vi.mock('$lib/stores/media-query-manager.svelte', () => ({ mediaQueryManager: media }));
vi.mock('uplot', () => ({
  default: class {
    constructor(_: unknown, data: unknown) {
      chart.create(data);
    }
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
    queues.snapshots = [];
    chart.create.mockClear();
    request = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 7);
    cancel = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('scrolls every frame, and stops the loop when unmounted', () => {
    media.reducedMotion = false;
    const { unmount } = render(QueueGraph, { queue });
    expect(request).toHaveBeenCalled();

    unmount();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it('never runs a frame loop under Reduce Motion, and stops its interval when unmounted', () => {
    media.reducedMotion = true;
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = render(QueueGraph, { queue });
    expect(request).not.toHaveBeenCalled();

    unmount();
    expect(clear).toHaveBeenCalled();
  });

  it('keeps every series aligned through failed polls and missing queues', () => {
    queues.snapshots = [
      {
        timestamp: 10,
        snapshot: [{ ...queue, statistics: { failed: 1, active: 2, waiting: 3, paused: 4 } } as QueueResponseDto],
      },
      { timestamp: 20 },
      { timestamp: 30, snapshot: [] },
      {
        timestamp: 40,
        snapshot: [{ ...queue, statistics: { failed: 5, active: 6, waiting: 7, paused: 8 } } as QueueResponseDto],
      },
    ];
    const { unmount } = render(QueueGraph, { queue });
    expect(chart.create).toHaveBeenCalledWith([
      [10, 20, 30, 40, Date.now() + 5000],
      [1, null, null, 5, 5],
      [2, null, null, 6, 6],
      [7, null, null, 15, 15],
    ]);
    unmount();
  });
});
