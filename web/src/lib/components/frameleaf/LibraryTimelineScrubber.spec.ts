import { AssetVisibility } from '@frameleaf/sdk';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import LibraryTimeline from '$lib/components/frameleaf/LibraryTimeline.svelte';
import { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import { fromISODateTimeUTCToObject } from '$lib/utils/timeline-util';
import { timelineAssetFactory, toResponseDto } from '@test-data/factories/asset-factory';

vi.mock('$app/navigation', () => ({ afterNavigate: vi.fn(), beforeNavigate: vi.fn(), goto: vi.fn() }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: {} } }));

const inMonth = (month: string, count: number) =>
  timelineAssetFactory.buildList(count).map((asset) => {
    const at = fromISODateTimeUTCToObject(`${month}-10T12:00:00.000Z`);
    return { ...asset, fileCreatedAt: at, localDateTime: at };
  });

// FL-1457 (FL-1389 leftover): the prototype draws the year scrubber in Timeline only; Browse and Work (no day
// headers) have none at any width, desktop included. A page with no Timeline to switch to keeps it.
describe('LibraryTimeline year scrubber by layout (FL-1457)', () => {
  let manager: TimelineManager;
  let session: LibrarySessionStore;

  beforeEach(async () => {
    vi.resetAllMocks();
    const months = ['2024-03', '2023-03', '2022-03', '2021-03'];
    sdkMock.getTimeBuckets.mockResolvedValue(months.map((month) => ({ timeBucket: `${month}-01`, count: 60 })));
    sdkMock.getTimeBucket.mockImplementation(({ timeBucket }) =>
      Promise.resolve(toResponseDto(...inMonth(timeBucket.slice(0, 7), 60))),
    );
    manager = new TimelineManager();
    await manager.updateOptions({ visibility: AssetVisibility.Timeline });
    await manager.updateViewport({ width: 1200, height: 300 });
    await tick();
    session = new LibrarySessionStore({ userId: 'user-1', pageSize: 10 });
  });

  const renderLayout = (showDayHeaders: boolean, keepThinScrubber = false) =>
    render(LibraryTimeline, { timelineManager: manager, session, grouping: 'days', showDayHeaders, keepThinScrubber });

  it('draws it in Timeline on a desktop', async () => {
    renderLayout(true);
    expect(await screen.findByRole('slider')).toBeInTheDocument();
  });

  it('draws none in Browse or Work on a desktop', async () => {
    renderLayout(false);
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('keeps it on a page with no Timeline to switch to', async () => {
    renderLayout(false, true);
    expect(await screen.findByRole('slider')).toBeInTheDocument();
  });
});
