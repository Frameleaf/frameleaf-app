import { render } from '@testing-library/svelte';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import Thumbnail from '$lib/components/assets/thumbnail/Thumbnail.svelte';
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
