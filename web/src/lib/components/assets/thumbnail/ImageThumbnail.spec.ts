import { fireEvent, render } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';

vi.mock('$lib/utils/sw-messaging', () => ({
  cancelImageUrl: vi.fn(),
}));

describe('ImageThumbnail component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an img element with correct attributes', () => {
    const { baseElement } = render(ImageThumbnail, {
      url: '/test-thumbnail.jpg',
      altText: 'Test image',
      widthStyle: '200px',
    });
    const img = baseElement.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/test-thumbnail.jpg');
    expect(img!.getAttribute('alt')).toBe('');
  });

  it('shows BrokenAsset on error', async () => {
    const { baseElement } = render(ImageThumbnail, {
      url: '/test-thumbnail.jpg',
      altText: 'Test image',
      widthStyle: '200px',
    });
    const img = baseElement.querySelector('img')!;
    await fireEvent.error(img);

    expect(baseElement.querySelector('img')).toBeNull();
    expect(baseElement.querySelector('span')?.textContent).toEqual('error_loading_image');
  });

  // FL-1409 (M5): a photo still waiting for its thumbnail is a calm placeholder, never the broken tile.
  it('shows the calm placeholder, not the broken tile, for a photo that is getting ready', async () => {
    const { baseElement } = render(ImageThumbnail, {
      url: '/test-thumbnail.jpg',
      altText: 'Test image',
      widthStyle: '200px',
      heightStyle: '150px',
      pending: true,
    });
    // It is calm from the start: the picture being asked for already has the placeholder's fill.
    expect(baseElement.querySelector('img')).toHaveClass('fl-thumb-pending');
    await fireEvent.error(baseElement.querySelector('img')!);

    const placeholder = baseElement.querySelector<HTMLElement>('[data-thumbnail-pending]')!;
    expect(placeholder).toHaveAccessibleName('frameleaf_thumbnail_pending');
    expect(placeholder).toHaveClass('fl-thumb-pending');
    // The size of the tile.
    expect(placeholder.style.width).toBe('200px');
    expect(placeholder.style.height).toBe('150px');
    expect(baseElement.querySelector('[data-broken-asset]')).toBeNull();
  });

  it('asks for a photo that is getting ready again by itself', async () => {
    vi.useFakeTimers();
    try {
      const { baseElement } = render(ImageThumbnail, {
        url: '/api/assets/a/thumbnail?size=thumbnail',
        altText: 'Test image',
        widthStyle: '200px',
        pending: true,
      });
      await fireEvent.error(baseElement.querySelector('img')!);
      expect(baseElement.querySelector('img')).toBeNull();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(baseElement.querySelector('img')).toHaveAttribute('src', '/api/assets/a/thumbnail?size=thumbnail&retry=1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a clear tile, in the words it is given, for a photo that can’t be shown', async () => {
    const { baseElement } = render(ImageThumbnail, {
      url: '/test-thumbnail.jpg',
      altText: 'Test image',
      widthStyle: '200px',
      brokenLabel: 'Can’t show this photo',
    });
    await fireEvent.error(baseElement.querySelector('img')!);

    expect(baseElement.querySelector('[data-thumbnail-pending]')).toBeNull();
    expect(baseElement.querySelector('[data-broken-asset]')).toHaveAccessibleName('Can’t show this photo');
  });

  it('calls onComplete with false on successful load', async () => {
    const onComplete = vi.fn();
    const { baseElement } = render(ImageThumbnail, {
      url: '/test-thumbnail.jpg',
      altText: 'Test image',
      widthStyle: '200px',
      onComplete,
    });
    const img = baseElement.querySelector('img')!;
    await fireEvent.load(img);
    expect(onComplete).toHaveBeenCalledWith(false);
  });

  it('calls onComplete with true on error', async () => {
    const onComplete = vi.fn();
    const { baseElement } = render(ImageThumbnail, {
      url: '/test-thumbnail.jpg',
      altText: 'Test image',
      widthStyle: '200px',
      onComplete,
    });
    const img = baseElement.querySelector('img')!;
    await fireEvent.error(img);
    expect(onComplete).toHaveBeenCalledWith(true);
  });

  it('applies hidden classes when hidden is true', () => {
    const { baseElement } = render(ImageThumbnail, {
      url: '/test-thumbnail.jpg',
      altText: 'Test image',
      widthStyle: '200px',
      hidden: true,
    });
    const img = baseElement.querySelector('img')!;
    const className = img.getAttribute('class') ?? '';
    expect(className).toContain('grayscale');
    expect(className).toContain('opacity');
  });

  it('sets alt text after loading', async () => {
    const { baseElement } = render(ImageThumbnail, {
      url: '/test-thumbnail.jpg',
      altText: 'Test image',
      widthStyle: '200px',
    });
    const img = baseElement.querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('');

    await fireEvent.load(img);
    expect(img.getAttribute('alt')).toBe('Test image');
  });

  it('loads a new URL after an earlier thumbnail failed', async () => {
    const onComplete = vi.fn();
    const { baseElement, rerender } = render(ImageThumbnail, {
      url: '/first.jpg',
      altText: 'Test image',
      widthStyle: '200px',
      onComplete,
    });
    await fireEvent.error(baseElement.querySelector('img')!);
    expect(baseElement.querySelector('[data-broken-asset]')).not.toBeNull();
    await rerender({ url: '/second.jpg' });
    expect(baseElement.querySelector('[data-broken-asset]')).toBeNull();
    const image = baseElement.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('/second.jpg');
    expect(image.getAttribute('alt')).toBe('');
    await fireEvent.load(image);
    expect(image.getAttribute('alt')).toBe('Test image');
    expect(onComplete.mock.calls).toEqual([[true], [false]]);
  });

  it('clears loaded accessibility state when the thumbnail URL changes', async () => {
    const { baseElement, rerender } = render(ImageThumbnail, {
      url: '/first.jpg',
      altText: 'Test image',
      widthStyle: '200px',
    });
    const first = baseElement.querySelector('img')!;
    await fireEvent.load(first);
    await rerender({ url: '/second.jpg' });
    const second = baseElement.querySelector('img')!;
    expect(second.getAttribute('src')).toBe('/second.jpg');
    expect(second.getAttribute('alt')).toBe('');
    await fireEvent.load(second);
    expect(second.getAttribute('alt')).toBe('Test image');
  });

  it('does not report an old image error against the replacement thumbnail', async () => {
    const onComplete = vi.fn();
    const { baseElement, rerender } = render(ImageThumbnail, {
      url: '/first.jpg',
      altText: 'Test image',
      widthStyle: '200px',
      onComplete,
    });
    const first = baseElement.querySelector('img')!;
    await rerender({ url: '/second.jpg' });
    await fireEvent.error(first);
    expect(baseElement.querySelector('[data-broken-asset]')).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('retries when it revisits a failed URL after displaying a different URL', async () => {
    const { baseElement, rerender } = render(ImageThumbnail, {
      url: '/failed.jpg',
      altText: 'Test image',
      widthStyle: '200px',
    });
    await fireEvent.error(baseElement.querySelector('img')!);
    await rerender({ url: '/intermediate.jpg' });
    await rerender({ url: '/failed.jpg' });
    const image = baseElement.querySelector('img');
    expect(image).not.toBeNull();
    expect(image!.getAttribute('src')).toBe('/failed.jpg');
    expect(baseElement.querySelector('[data-broken-asset]')).toBeNull();
  });
});

// FL-1457 (FL-1409 leftover): the pending placeholder's band of light does not move under reduced motion. Component
// styles are not applied under jsdom, so this reads the stylesheet: the band animates, and the reduced-motion block
// stops it.
describe('pending placeholder under prefers-reduced-motion (FL-1457)', () => {
  const style = readFileSync('src/lib/components/assets/thumbnail/ImageThumbnail.svelte', 'utf8').split('<style>')[1];

  it('animates the band normally', () => {
    expect(style).toMatch(/:global\(\.fl-thumb-pending\) \{[^}]*animation: fl-thumb-pending [^;]*infinite;/);
  });

  it('stops it when reduced motion is asked for', () => {
    const reduced = style.slice(style.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(
      /^@media \(prefers-reduced-motion: reduce\) \{\s*:global\(\.fl-thumb-pending\) \{\s*animation: none;/,
    );
  });
});
