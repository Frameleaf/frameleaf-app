import { fireEvent, render } from '@testing-library/svelte';
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
