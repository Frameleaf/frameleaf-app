import { render, waitFor } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import MockTagTimeline, { managers } from '@test-data/components/MockTagTimeline.svelte';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';
import TagsPage from './+page.svelte';

vi.mock('$lib/components/layouts/UserPageLayout.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));

const data = (path: string): ComponentProps<typeof TagsPage>['data'] => ({
  meta: { title: 'Tags' },
  asset: undefined,
  path,
  statistics: [],
  TagLibrary: MockTagTimeline,
  tags: ['A', 'B'].map((id) => ({ id, name: id, value: id, createdAt: '', updatedAt: '' })),
});

beforeEach(() => {
  vi.clearAllMocks();
  authManager.reset();
  managers.clear();
});

afterEach(() => authManager.reset());

it.each(['current', 'navigate', 'session', 'close'])(
  'applies tag removal only to its owning view: %s',
  async (change) => {
    const original = { removeAssets: vi.fn() };
    const replacement = { removeAssets: vi.fn() };
    managers.set('A', original as unknown as TimelineManager);
    managers.set('B', replacement as unknown as TimelineManager);
    const view = render(TagsPage, { data: data('A') });
    const asset = assetFactory.build({ tags: [] });
    const pending = deferredPromise<typeof asset>();
    sdkMock.getAssetInfo.mockReturnValueOnce(pending.promise);
    eventManager.emit('AssetsTag', [asset.id]);
    await waitFor(() => expect(sdkMock.getAssetInfo).toHaveBeenCalledWith({ id: asset.id }));
    if (change === 'navigate') {
      await view.rerender({ data: data('B') });
    } else if (change === 'session') {
      authManager.reset();
    } else if (change === 'close') {
      view.unmount();
    }
    pending.resolve(asset);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (change === 'current') {
      expect(original.removeAssets).toHaveBeenCalledWith([asset.id]);
    } else {
      expect(original.removeAssets).not.toHaveBeenCalled();
    }
    expect(replacement.removeAssets).not.toHaveBeenCalled();
  },
);
