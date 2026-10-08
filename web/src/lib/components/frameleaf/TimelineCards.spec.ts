import { getTimelineHighlights } from '@frameleaf/sdk';
import { render, waitFor, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { addMessages } from 'svelte-i18n';
import TimelineCards from '$lib/components/frameleaf/TimelineCards.svelte';
import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import en from '../../../../../i18n/en.json';

const bus = vi.hoisted(() => ({ handlers: new Map<string, (value: unknown) => void>() }));
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<typeof import('@frameleaf/sdk')>()),
  getTimelineHighlights: vi.fn(),
}));
vi.mock('$lib/stores/websocket', () => ({
  websocketEvents: {
    on: vi.fn((name: string, handler: (value: unknown) => void) => {
      bus.handlers.set(name, handler);
      return () => bus.handlers.delete(name);
    }),
  },
}));
vi.mock('$lib/managers/event-manager.svelte', () => ({ eventManager: { on: vi.fn(() => () => {}) } }));
vi.mock('$lib/utils', () => ({ getAssetMediaUrl: vi.fn(() => '/private/test-media') }));
beforeEach(() => {
  vi.clearAllMocks();
  bus.handlers.clear();
  addMessages('dev', en);
});

it('an owner-local effect invalidates an outstanding highlights page before the debounced fresh page applies', async () => {
  const pending = deferred<Awaited<ReturnType<typeof getTimelineHighlights>>>();
  vi.mocked(getTimelineHighlights)
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue([{ timeBucket: '2026-01-01', count: 2, keyAssetId: null, highlightAssetIds: [], places: [] }]);
  const { container } = render(TimelineCards, {
    timelineManager: { isInitialized: true, bucketQuery: {} } as TimelineManager,
    grouping: 'years',
    onOpen: vi.fn(),
  });
  await waitFor(() => expect(getTimelineHighlights).toHaveBeenCalledTimes(1));
  bus.handlers.get('AssetLocalEffectsV1')?.({
    streamEpoch: 'owner-stream',
    sequence: '2',
    effectId: 'restore',
    assetIds: ['source'],
    revokedOperationIds: [],
  });
  pending.resolve([{ timeBucket: '2025-01-01', count: 999, keyAssetId: null, highlightAssetIds: [], places: [] }]);
  await tick();
  expect(container.querySelector('[data-group-id="2025"]')).toBeNull();
  await waitFor(() => expect(container.querySelector('[data-group-id="2026"]')).not.toBeNull(), { timeout: 3000 });
  expect(container.querySelector('[data-group-id="2025"]')).toBeNull();
  expect(getTimelineHighlights).toHaveBeenCalledTimes(2);
  bus.handlers.get('AssetLocalEffectsV1')?.({
    streamEpoch: 'owner-stream',
    sequence: '1',
    effectId: 'late-trash',
    assetIds: ['source'],
    revokedOperationIds: [],
  });
  await tick();
  expect(getTimelineHighlights).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('frameleaf-timeline-cards')).toHaveAttribute('aria-busy', 'false');
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
};
