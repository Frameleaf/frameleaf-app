import { cleanup, fireEvent, render } from '@testing-library/svelte';
import Image from '$lib/components/Image.svelte';
import { cancelImageUrl } from '$lib/utils/sw-messaging';

vi.mock('$lib/utils/sw-messaging', () => ({
  cancelImageUrl: vi.fn(),
}));

describe('Image component', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    cleanup();
    if (vi.isFakeTimers()) {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('renders an img element when src is provided', () => {
    const { baseElement } = render(Image, { src: '/test.jpg', alt: 'test' });
    const img = baseElement.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/test.jpg');
  });

  it('does not render an img element when src is undefined', () => {
    const { baseElement } = render(Image, { src: undefined });
    const img = baseElement.querySelector('img');
    expect(img).toBeNull();
  });

  it('calls onStart when src is set', () => {
    const onStart = vi.fn();
    render(Image, { src: '/test.jpg', onStart });
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('calls onLoad when image loads', async () => {
    const onLoad = vi.fn();
    const { baseElement } = render(Image, { src: '/test.jpg', onLoad });
    const img = baseElement.querySelector('img')!;
    await fireEvent.load(img);
    expect(onLoad).toHaveBeenCalledOnce();
  });

  it('calls onError when image fails to load', async () => {
    const onError = vi.fn();
    const { baseElement } = render(Image, { src: '/test.jpg', onError });
    const img = baseElement.querySelector('img')!;
    await fireEvent.error(img);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(onError.mock.calls[0][0].message).toBe('Failed to load image: /test.jpg');
  });

  it('calls cancelImageUrl on unmount', () => {
    vi.useFakeTimers();
    const { unmount } = render(Image, { src: '/test.jpg' });
    expect(cancelImageUrl).not.toHaveBeenCalled();
    unmount();
    vi.runAllTimers();
    expect(cancelImageUrl).toHaveBeenCalledWith('/test.jpg');
  });

  it('leaves a shared image loading until the last element using it unmounts', () => {
    vi.useFakeTimers();
    const first = render(Image, { src: '/shared.jpg' });
    const second = render(Image, { src: '/shared.jpg' });
    first.unmount();
    vi.runAllTimers();
    expect(cancelImageUrl).not.toHaveBeenCalled();
    second.unmount();
    vi.runAllTimers();
    expect(cancelImageUrl).toHaveBeenCalledExactlyOnceWith('/shared.jpg');
  });

  it('leaves the image loading for an element that replaces it in the same update', () => {
    vi.useFakeTimers();
    const first = render(Image, { src: '/replaced.jpg' });
    first.unmount();
    const second = render(Image, { src: '/replaced.jpg' });
    vi.runAllTimers();
    expect(cancelImageUrl).not.toHaveBeenCalled();
    second.unmount();
    vi.runAllTimers();
    expect(cancelImageUrl).toHaveBeenCalledExactlyOnceWith('/replaced.jpg');
  });

  it('does not call onLoad after unmount', async () => {
    const onLoad = vi.fn();
    const { baseElement, unmount } = render(Image, { src: '/test.jpg', onLoad });
    const img = baseElement.querySelector('img')!;
    unmount();
    await fireEvent.load(img);
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('does not call onError after unmount', async () => {
    const onError = vi.fn();
    const { baseElement, unmount } = render(Image, { src: '/test.jpg', onError });
    const img = baseElement.querySelector('img')!;
    unmount();
    await fireEvent.error(img);
    expect(onError).not.toHaveBeenCalled();
  });

  it('passes through additional HTML attributes', () => {
    const { baseElement } = render(Image, {
      src: '/test.jpg',
      alt: 'test alt',
      class: 'my-class',
      draggable: false,
    });
    const img = baseElement.querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('test alt');
    expect(img.getAttribute('draggable')).toBe('false');
  });

  it('replaces the image and restarts when the source changes', async () => {
    const onStart = vi.fn();
    const { baseElement, rerender } = render(Image, { src: '/first.jpg', onStart });
    const first = baseElement.querySelector('img')!;
    await rerender({ src: '/second.jpg' });
    const second = baseElement.querySelector('img')!;
    expect(second.getAttribute('src')).toBe('/second.jpg');
    expect(second).not.toBe(first);
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it('removes an undefined source and can load again', async () => {
    const { baseElement, rerender } = render(Image, { src: '/first.jpg' });
    await rerender({ src: undefined });
    expect(baseElement.querySelector('img')).toBeNull();
    await rerender({ src: '/second.jpg' });
    expect(baseElement.querySelector('img')!.getAttribute('src')).toBe('/second.jpg');
  });

  it('ignores late events from the replaced image', async () => {
    const onLoad = vi.fn();
    const onError = vi.fn();
    const { baseElement, rerender } = render(Image, { src: '/first.jpg', onLoad, onError });
    const first = baseElement.querySelector('img')!;
    await rerender({ src: '/second.jpg' });
    await fireEvent.load(first);
    await fireEvent.error(first);
    expect(onLoad).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    await fireEvent.load(baseElement.querySelector('img')!);
    expect(onLoad).toHaveBeenCalledOnce();
  });

  it('keeps shared ownership when one component changes its source', async () => {
    vi.useFakeTimers();
    const first = render(Image, { src: '/shared.jpg' });
    const second = render(Image, { src: '/shared.jpg' });
    await first.rerender({ src: '/replacement.jpg' });
    vi.runAllTimers();
    expect(cancelImageUrl).not.toHaveBeenCalled();
    second.unmount();
    vi.runAllTimers();
    expect(cancelImageUrl).toHaveBeenCalledExactlyOnceWith('/shared.jpg');
    first.unmount();
    vi.runAllTimers();
    expect(vi.mocked(cancelImageUrl).mock.calls).toEqual([['/shared.jpg'], ['/replacement.jpg']]);
  });

  it('does not cancel a URL that is reacquired before its deferred cancellation', async () => {
    vi.useFakeTimers();
    const { rerender, unmount } = render(Image, { src: '/reused.jpg' });
    await rerender({ src: undefined });
    await rerender({ src: '/reused.jpg' });
    vi.runAllTimers();
    expect(cancelImageUrl).not.toHaveBeenCalled();
    unmount();
    vi.runAllTimers();
    expect(cancelImageUrl).toHaveBeenCalledExactlyOnceWith('/reused.jpg');
  });

  it('sends one cancellation per URL after rapid source reuse and unmount', async () => {
    vi.useFakeTimers();
    const { rerender, unmount } = render(Image, { src: '/cycled.jpg' });
    await rerender({ src: '/intermediate.jpg' });
    await rerender({ src: '/cycled.jpg' });
    unmount();
    vi.runAllTimers();
    expect(vi.mocked(cancelImageUrl).mock.calls).toEqual([['/cycled.jpg'], ['/intermediate.jpg']]);
  });
});
