import { fireEvent, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { AssetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import { frameleafShell, libraryLayout, libraryInspectorCollapsed } from '$lib/stores/preferences.store';
import { fromISODateTimeUTCToObject } from '$lib/utils/timeline-util';
import { renderWithTooltips } from '$tests/helpers';
import { timelineAssetFactory, toResponseDto } from '@test-data/factories/asset-factory';
import Timeline from './Timeline.svelte';

// A privacy-gated timeline can mount after the navigation event has completed.
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: { nsfwHiding: true } } }));
vi.mock('$app/navigation', () => ({
  afterNavigate: vi.fn(),
  beforeNavigate: vi.fn(),
  goto: vi.fn(),
  onNavigate: vi.fn(),
}));

vi.mock('$lib/components/assets/thumbnail/Thumbnail.svelte', async () => {
  const { default: component } = await import('@test-data/components/MockText.svelte');
  return { default: component };
});
vi.mock('$lib/elements/HotModuleReload.svelte', async () => {
  const { default: MockText } = await import('@test-data/components/MockText.svelte');
  return { default: MockText };
});

describe('Timeline delayed mounting', () => {
  it('retains multiple loaded months and the selection through a borrowed presentation remount', async () => {
    const assets = [1, 2].map((month) =>
      timelineAssetFactory.build({
        localDateTime: fromISODateTimeUTCToObject(`2024-0${month}-01T00:00:00Z`),
        fileCreatedAt: fromISODateTimeUTCToObject(`2024-0${month}-01T00:00:00Z`),
      }),
    );
    sdkMock.getTimeBuckets.mockResolvedValue([
      { count: 1, timeBucket: '2024-02-01' },
      { count: 1, timeBucket: '2024-01-01' },
    ]);
    sdkMock.getTimeBucket.mockImplementation(({ timeBucket }) =>
      Promise.resolve(toResponseDto(assets[timeBucket.startsWith('2024-01') ? 0 : 1])),
    );
    const manager = new TimelineManager();
    await manager.updateViewport({ width: 1200, height: 10_000 });
    await manager.updateOptions({ albumId: 'album' });
    await manager.loadTimelineMonth({ year: 2024, month: 1 }, { cancelable: false });
    await manager.loadTimelineMonth({ year: 2024, month: 2 }, { cancelable: false });
    expect(manager.months.flatMap((month) => month.getAssets())).toHaveLength(2);
    const months = [...manager.months];
    const requestsBeforeMount = sdkMock.getTimeBuckets.mock.calls.length;
    const selection = new AssetMultiSelectManager();
    selection.selectAsset(assets[0]);
    const props = {
      enableRouting: false,
      timelineManager: manager,
      manageTimelineLifecycle: false,
      assetInteraction: selection,
    };
    const first = renderWithTooltips(Timeline, props);
    first.unmount();
    const second = renderWithTooltips(Timeline, props);
    expect(manager.months).toEqual(months);
    expect(
      manager.months
        .flatMap((month) => month.getAssets())
        .map(({ id }) => id)
        .sort(),
    ).toEqual(assets.map(({ id }) => id).sort());
    expect(selection.assets.map(({ id }) => id)).toEqual([assets[0].id]);
    expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(requestsBeforeMount);
    second.unmount();
    manager.destroy();
  });
  it('borrows a route manager through presentation teardown and remount', () => {
    const manager = new TimelineManager();
    const destroy = vi.spyOn(manager, 'destroy');
    const props = {
      enableRouting: false,
      timelineManager: manager,
      manageTimelineLifecycle: false,
      assetInteraction: new AssetMultiSelectManager(),
    };
    const first = renderWithTooltips(Timeline, props);
    first.unmount();
    expect(destroy).not.toHaveBeenCalled();
    const second = renderWithTooltips(Timeline, props);
    second.unmount();
    expect(destroy).not.toHaveBeenCalled();
    manager.destroy();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('still destroys its internally owned default', () => {
    const destroy = vi.spyOn(TimelineManager.prototype, 'destroy');
    const view = renderWithTooltips(Timeline, {
      enableRouting: false,
      assetInteraction: new AssetMultiSelectManager(),
    });
    view.unmount();
    expect(destroy).toHaveBeenCalledOnce();
    destroy.mockRestore();
  });
  it('reveals a routed timeline without waiting for another navigation', async () => {
    const { container } = renderWithTooltips(Timeline, {
      enableRouting: true,
      assetInteraction: new AssetMultiSelectManager(),
    });
    await waitFor(() => expect(container.querySelector('#virtual-timeline')).not.toHaveClass('invisible'));
  });
});

it('switches real borrowed presentation without destroying the manager or clearing selected media', async () => {
  frameleafShell.set(true);
  libraryLayout.set('timeline');
  libraryInspectorCollapsed.set(false);
  sdkMock.getTimeBuckets.mockResolvedValue([]);
  const manager = new TimelineManager();
  const selection = new AssetMultiSelectManager();
  const asset = timelineAssetFactory.build({ city: 'Synthetic City', isVideo: false });
  selection.selectAsset(asset);
  const destroy = vi.spyOn(manager, 'destroy');
  const view = renderWithTooltips(Timeline, {
    enableRouting: false,
    timelineManager: manager,
    manageTimelineLifecycle: false,
    libraryLayoutsEnabled: true,
    assetInteraction: selection,
  });
  await fireEvent.click(view.getByRole('button', { name: 'Browse' }));
  await waitFor(() => expect(manager.libraryLayout).toBe('browse'));
  expect(view.queryByRole('complementary', { name: 'Selection inspector' })).not.toBeInTheDocument();
  await fireEvent.click(view.getByRole('button', { name: 'Work' }));
  expect(view.getByRole('complementary', { name: 'Selection inspector' })).toHaveTextContent('Synthetic City');
  await fireEvent.click(view.getByRole('button', { name: 'Hide inspector' }));
  expect(view.queryByRole('complementary', { name: 'Selection inspector' })).not.toBeInTheDocument();
  expect(manager.libraryLayout).toBe('work');
  expect(selection.assets).toEqual([asset]);
  frameleafShell.set(false);
  await waitFor(() => expect(view.queryByRole('group', { name: 'Library layout' })).not.toBeInTheDocument());
  expect(manager.libraryLayout).toBeUndefined();
  expect(destroy).not.toHaveBeenCalled();
  view.unmount();
  selection.destroy();
  manager.destroy();
  libraryLayout.set('timeline');
  libraryInspectorCollapsed.set(false);
});
