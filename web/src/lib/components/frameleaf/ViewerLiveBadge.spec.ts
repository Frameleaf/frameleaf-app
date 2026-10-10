import '@testing-library/jest-dom';
import { fireEvent, render } from '@testing-library/svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import ViewerLiveBadge from './ViewerLiveBadge.svelte';

describe('ViewerLiveBadge (V-16)', () => {
  afterEach(() => {
    assetViewerManager.isPlayingMotionPhoto = false;
  });

  it('plays the clip while a mouse hovers it', async () => {
    const { getByTestId } = render(ViewerLiveBadge);
    const badge = getByTestId('viewer-live-badge');

    await fireEvent.pointerEnter(badge, { pointerType: 'mouse' });
    expect(assetViewerManager.isPlayingMotionPhoto).toBe(true);
    expect(badge).toHaveAttribute('aria-pressed', 'true');
    expect(badge).toHaveAccessibleName('frameleaf_viewer_stop_live_clip');

    await fireEvent.pointerLeave(badge, { pointerType: 'mouse' });
    expect(assetViewerManager.isPlayingMotionPhoto).toBe(false);
  });

  it('leaves a touch hover alone and toggles on a press', async () => {
    const { getByTestId } = render(ViewerLiveBadge);
    const badge = getByTestId('viewer-live-badge');

    await fireEvent.pointerEnter(badge, { pointerType: 'touch' });
    expect(assetViewerManager.isPlayingMotionPhoto).toBe(false);

    await fireEvent.click(badge);
    expect(assetViewerManager.isPlayingMotionPhoto).toBe(true);
    await fireEvent.click(badge);
    expect(assetViewerManager.isPlayingMotionPhoto).toBe(false);
  });
});
