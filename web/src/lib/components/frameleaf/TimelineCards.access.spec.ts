import { getTimelineHighlights } from '@frameleaf/sdk';
import { render, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import TimelineCards from '$lib/components/frameleaf/TimelineCards.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import en from '../../../../../i18n/en.json';

vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<typeof import('@frameleaf/sdk')>()),
  getTimelineHighlights: vi.fn(),
}));
vi.mock('$lib/stores/websocket', () => ({ websocketEvents: { on: vi.fn(() => () => {}) } }));
vi.mock('$lib/utils', () => ({ getAssetMediaUrl: vi.fn(() => '/private/test-media') }));

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

it('drops every card, key photo and place at once when the session locks', async () => {
  vi.mocked(getTimelineHighlights).mockResolvedValue([
    { timeBucket: '2026-01-01', count: 2, keyAssetId: 'locked-key', highlightAssetIds: [], places: ['Banff'] },
  ]);
  const { container } = render(TimelineCards, {
    timelineManager: { isInitialized: true, bucketQuery: {} } as TimelineManager,
    grouping: 'years',
    onOpen: vi.fn(),
  });
  await waitFor(() => expect(container.querySelector('[data-group-id="2026"]')).not.toBeNull());
  expect(container.querySelector(':scope .fl-tl-card-media img')).not.toBeNull();

  // The locked session's own answer leaves the Locked year out.
  vi.mocked(getTimelineHighlights).mockResolvedValue([]);
  eventManager.emit('SessionLocked');

  await waitFor(() => expect(container.querySelector('[data-group-id="2026"]')).toBeNull());
  expect(container.textContent).not.toContain('Banff');
  // And asked for again under the narrower access.
  await waitFor(() => expect(getTimelineHighlights).toHaveBeenCalledTimes(2));
});
