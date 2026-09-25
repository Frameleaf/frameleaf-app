import { render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { SlideshowTransition } from '$lib/frameleaf/slideshow-transitions';
import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
import { assetFactory } from '@test-data/factories/asset-factory';
import SlideshowMemoriesOverlay from './SlideshowMemoriesOverlay.svelte';

const media = vi.hoisted(() => ({ reducedMotion: false }));
vi.mock('$lib/stores/media-query-manager.svelte', () => ({
  mediaQueryManager: {
    get reducedMotion() {
      return media.reducedMotion;
    },
  },
}));

const asset = () =>
  assetFactory.build({
    localDateTime: '2024-05-03T10:00:00.000Z',
    exifInfo: { city: 'Porto' } as never,
  });

describe('SlideshowMemoriesOverlay (FL-36, FL-62)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    media.reducedMotion = false;
    slideshowStore.slideshowTransition.set(SlideshowTransition.Memories);
    slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
  });

  afterEach(() => {
    vi.useRealTimers();
    slideshowStore.slideshowState.set(SlideshowState.None);
    slideshowStore.slideshowTransition.set(SlideshowTransition.Fade);
  });

  it('opens with the title card, then shows the place over the day', () => {
    const { container } = render(SlideshowMemoriesOverlay, {
      asset: asset(),
      album: { albumName: 'Lisbon' } as never,
    });

    // decorative (aria-hidden), as in the prototype
    expect(container.querySelector(':scope .memories-title-card h2')?.textContent).toBe('Lisbon');
    expect(container.querySelector(':scope .memories-lower-third')).toBeNull();

    vi.advanceTimersByTime(3200);
    flushSync();
    expect(container.querySelector(':scope .memories-title-card')).toBeNull();
    expect(container.querySelector(':scope .memories-lower-third strong')?.textContent).toBe('Porto');
  });

  it('shows only while the slideshow plays', () => {
    slideshowStore.slideshowState.set(SlideshowState.PauseSlideshow);
    const { container } = render(SlideshowMemoriesOverlay, { asset: asset() });

    expect(container.querySelector(':scope .memories-title-card, :scope .memories-lower-third')).toBeNull();

    slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
    flushSync();
    expect(container.querySelector(':scope .memories-title-card')).not.toBeNull();
  });

  it('shows nothing for another transition or under Reduce Motion', () => {
    slideshowStore.slideshowTransition.set(SlideshowTransition.KenBurns);
    const first = render(SlideshowMemoriesOverlay, { asset: asset() });
    expect(first.container.querySelector(':scope .memories-title-card, :scope .memories-lower-third')).toBeNull();
    first.unmount();

    slideshowStore.slideshowTransition.set(SlideshowTransition.Memories);
    media.reducedMotion = true;
    const second = render(SlideshowMemoriesOverlay, { asset: asset() });
    expect(second.container.querySelector(':scope .memories-title-card, :scope .memories-lower-third')).toBeNull();
  });
});
