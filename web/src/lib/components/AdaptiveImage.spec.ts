import { AssetTypeEnum } from '@frameleaf/sdk';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import AdaptiveImage from './AdaptiveImage.svelte';

// This checks request/viewport transitions, not physical HDR display correctness.
describe('focused HDR viewing', () => {
  it('retains the accepted image and zoom until the other dynamic range loads', async () => {
    const asset = assetFactory.build({
      originalPath: 'image.heic',
      originalMimeType: 'image/heic',
      type: AssetTypeEnum.Image,
    });
    const reset = vi.spyOn(assetViewerManager, 'resetZoomState');
    try {
      const view = render(AdaptiveImage, { asset, container: { width: 400, height: 400 }, dynamicRange: 'auto' });
      const firstThumbnail = await view.findByTestId('thumbnail');
      await fireEvent.load(firstThumbnail);
      const preview = await view.findByTestId('preview');
      await fireEvent.load(preview);
      const previous = preview.getAttribute('src');
      reset.mockClear();
      await view.rerender({ asset, container: { width: 400, height: 400 }, dynamicRange: 'sdr' });
      expect(reset).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(view.container.querySelector('img[aria-hidden="true"]')?.getAttribute('src')).toBe(previous),
      );
      await waitFor(() => expect(view.getByTestId('thumbnail')).not.toBe(firstThumbnail));
      await fireEvent.load(view.getByTestId('thumbnail'));
      await waitFor(() =>
        expect(
          new URL(view.getByTestId('preview').getAttribute('src')!, 'http://x').searchParams.get('dynamicRange'),
        ).toBe('sdr'),
      );
      const next = view.getByTestId('preview');
      expect(new URL(next.getAttribute('src')!, 'http://x').searchParams.get('dynamicRange')).toBe('sdr');
      await fireEvent.load(next);
      await waitFor(() => expect(view.container.querySelector('img[aria-hidden="true"]')).toBeNull());
      expect(reset).not.toHaveBeenCalled();
      view.unmount();
    } finally {
      reset.mockRestore();
    }
  });
});
