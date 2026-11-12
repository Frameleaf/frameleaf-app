import { fireEvent, render } from '@testing-library/svelte';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import Thumbnail from '$lib/components/assets/thumbnail/Thumbnail.svelte';
import { thumbnailFailures } from '$lib/frameleaf/thumbnail-state.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { getTabbable } from '$lib/utils/focus-util';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';

vi.mock('$lib/utils/navigation', () => ({
  currentUrlReplaceAssetId: vi.fn(),
  isSharedLinkRoute: vi.fn().mockReturnValue(false),
}));

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    enumerable: true,
    value: vi.fn().mockImplementation(function (query) {
      return {
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(), // deprecated
        removeListener: vi.fn(), // deprecated
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
});

describe('Thumbnail component', () => {
  beforeAll(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
  });

  it('should only contain a single tabbable element (the container)', () => {
    const asset = timelineAssetFactory.build({ isImage: true, isVideo: false });
    const { baseElement } = render(Thumbnail, {
      asset,
      selected: true,
    });

    const container = baseElement.querySelector('[data-thumbnail-focus-container]');
    expect(container).not.toBeNull();
    expect(container!.getAttribute('tabindex')).toBe('0');

    // Guarding against inserting extra tabbable elements in future in <Thumbnail/>
    const tabbables = getTabbable(container!);
    expect(tabbables.length).toBe(0);
  });

  it('shows thumbhash while image is loading', () => {
    const asset = timelineAssetFactory.build({ isImage: true, isVideo: false });
    const sut = render(Thumbnail, {
      asset,
      selected: true,
    });

    const thumbhash = sut.getByTestId('thumbhash');
    expect(thumbhash).not.toBeFalsy();
  });

  it.each(['unmount', 'pointercancel'])('cancels a pending hold on %s', (reason) => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    const sut = render(Thumbnail, {
      asset: timelineAssetFactory.build({ isImage: true, isVideo: false }),
      onSelect,
    });
    const container = sut.baseElement.querySelector('[data-thumbnail-focus-container]')!;
    container.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    try {
      if (reason === 'unmount') {
        sut.unmount();
      } else {
        container.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }));
      }
      vi.advanceTimersByTime(350);
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      if (reason !== 'unmount') {
        sut.unmount();
      }
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

// FL-1457: the viewer's filmstrip and stack strip draw this thumbnail; a photo still waiting for its thumbnail gets
// the Library's calm placeholder there too, and one that can't be made keeps the broken tile with its words.
describe('Thumbnail for a photo with no thumbnail yet (FL-1457)', () => {
  beforeAll(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
  });
  beforeEach(() => {
    vi.spyOn(authManager, 'authenticated', 'get').mockReturnValue(true);
    vi.spyOn(authManager, 'user', 'get').mockReturnValue({ id: 'owner-1', isAdmin: false } as never);
    vi.spyOn(thumbnailFailures, 'check').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    thumbnailFailures.ids.clear();
  });

  const waiting = () =>
    timelineAssetFactory.build({ isImage: true, isVideo: false, thumbhash: null, ownerId: 'owner-1' });

  it('shows the calm placeholder, not the broken tile, and asks which photos failed', async () => {
    const { container } = render(Thumbnail, { asset: waiting() });
    await fireEvent.error(container.querySelector('img')!);

    expect(container.querySelector('[data-thumbnail-pending]')).not.toBeNull();
    expect(container.querySelector('[data-broken-asset]')).toBeNull();
    expect(thumbnailFailures.check).toHaveBeenCalled();
  });

  it('keeps the broken tile with its words for a photo whose thumbnail failed', async () => {
    const asset = waiting();
    thumbnailFailures.ids.add(asset.id);
    const { container } = render(Thumbnail, { asset });
    await fireEvent.error(container.querySelector('img')!);

    expect(container.querySelector('[data-thumbnail-pending]')).toBeNull();
    expect(container.querySelector('[data-broken-asset]')).toHaveAccessibleName('frameleaf_thumbnail_cant_show');
  });
});
