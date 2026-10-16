import { render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';
import ImagePanoramaViewer from './ImagePanoramaViewer.svelte';

vi.mock('./PhotoSphereViewerAdapter.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = vi.fn(() => 'blob:preview');
      static override revokeObjectURL = vi.fn();
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

it('releases a loaded preview when closed', async () => {
  sdkMock.viewAsset.mockResolvedValue(new Blob(['preview']));
  const view = render(ImagePanoramaViewer, { asset: assetFactory.build() });
  await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
  view.unmount();
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview'));
});

it('aborts a closed preview and cannot allocate a late blob URL', async () => {
  const pending = deferredPromise<Blob>();
  sdkMock.viewAsset.mockReturnValue(pending.promise);
  const view = render(ImagePanoramaViewer, { asset: assetFactory.build() });
  await waitFor(() => expect(sdkMock.viewAsset).toHaveBeenCalled());
  const signal = sdkMock.viewAsset.mock.lastCall?.[1]?.signal;
  view.unmount();
  pending.resolve(new Blob(['preview']));
  await tick();
  expect(signal?.aborted).toBe(true);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('releases the previous preview when another panorama replaces it', async () => {
  sdkMock.viewAsset.mockResolvedValue(new Blob(['preview']));
  const asset = assetFactory.build();
  const view = render(ImagePanoramaViewer, { asset });
  await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
  await view.rerender({ asset: { ...asset, id: 'replacement' } });
  await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(2));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
});
