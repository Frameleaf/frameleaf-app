import { waitFor } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import MapTimelinePanel from './MapTimelinePanel.svelte';

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: {} } }));
vi.mock('$app/navigation', () => ({
  afterNavigate: vi.fn(),
  beforeNavigate: vi.fn(),
  goto: vi.fn(),
  onNavigate: vi.fn(),
}));
vi.mock('$lib/elements/HotModuleReload.svelte', async () => {
  const { default: component } = await import('@test-data/components/MockText.svelte');
  return { default: component };
});

it('consumes map scope on the real timeline and restores it after a zero-result scope and Back', async () => {
  sdkMock.getTimeBuckets.mockResolvedValue([]);
  const destroy = vi.spyOn(TimelineManager.prototype, 'destroy');
  const props = $state({
    bbox: { west: -120, south: 40, east: -110, north: 50 },
    selectedClusterIds: new Set<string>(),
    assetCount: 0,
    onClose: vi.fn(),
  });
  const view = renderWithTooltips(MapTimelinePanel, props);
  await waitFor(() => expect(sdkMock.getTimeBuckets.mock.calls.at(-1)?.[0]).toMatchObject({ bbox: '-120,40,-110,50' }));
  props.bbox = { west: 10, south: 20, east: 30, north: 40 };
  flushSync();
  await waitFor(() => expect(sdkMock.getTimeBuckets.mock.calls.at(-1)?.[0]).toMatchObject({ bbox: '10,20,30,40' }));
  props.bbox = { west: -120, south: 40, east: -110, north: 50 };
  flushSync();
  await waitFor(() => expect(sdkMock.getTimeBuckets.mock.calls.at(-1)?.[0]).toMatchObject({ bbox: '-120,40,-110,50' }));
  expect(destroy).not.toHaveBeenCalled();
  view.unmount();
  expect(destroy).toHaveBeenCalledOnce();
  destroy.mockRestore();
});
