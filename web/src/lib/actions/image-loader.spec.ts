import { loadImage } from '$lib/actions/image-loader.svelte';
import { cancelImageUrl } from '$lib/utils/sw-messaging';

vi.mock('$lib/utils/sw-messaging', () => ({ cancelImageUrl: vi.fn() }));

describe('preload image lifecycle', () => {
  let image: HTMLImageElement;

  beforeEach(() => {
    vi.mocked(cancelImageUrl).mockReset();
    image = document.createElement('img');
    vi.spyOn(document, 'createElement').mockReturnValueOnce(image);
    vi.spyOn(image, 'addEventListener');
    vi.spyOn(image, 'removeEventListener');
  });

  afterEach(() => {
    image.remove();
    vi.restoreAllMocks();
  });

  it('starts once and assigns the requested source', () => {
    const onStart = vi.fn();
    const onLoad = vi.fn();
    const onError = vi.fn();
    const destroy = loadImage('/preview.jpg', onLoad, onError, onStart);
    expect(onStart).toHaveBeenCalledOnce();
    expect(image.getAttribute('src')).toBe('/preview.jpg');
    expect(onLoad).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    destroy();
  });

  it.each(['load', 'error'] as const)('notifies %s once and releases the image before notification', (event) => {
    const notify = vi.fn(() => {
      expect(image.removeEventListener).toHaveBeenCalledTimes(2);
      expect(image.isConnected).toBe(false);
    });
    const other = vi.fn();
    document.body.append(image);
    const destroy = loadImage('/preview.jpg', event === 'load' ? notify : other, event === 'error' ? notify : other);

    image.dispatchEvent(new Event(event));
    image.dispatchEvent(new Event('load'));
    image.dispatchEvent(new Event('error'));
    destroy();
    destroy();
    expect(notify).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
    expect(cancelImageUrl).toHaveBeenCalledExactlyOnceWith('/preview.jpg');
  });

  it('cancels a pending image only once and ignores late completion', () => {
    const onLoad = vi.fn();
    const onError = vi.fn();
    const destroy = loadImage('/preview.jpg', onLoad, onError);
    destroy();
    destroy();
    image.dispatchEvent(new Event('load'));
    image.dispatchEvent(new Event('error'));
    expect(onLoad).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(cancelImageUrl).toHaveBeenCalledExactlyOnceWith('/preview.jpg');
  });

  it('does not allocate an image when the startup callback fails', () => {
    const error = new Error('startup failed');
    expect(() =>
      loadImage('/preview.jpg', vi.fn(), vi.fn(), () => {
        throw error;
      }),
    ).toThrow(error);
    expect(document.createElement).not.toHaveBeenCalled();
    expect(cancelImageUrl).not.toHaveBeenCalled();
  });

  it('removes the image even if service-worker cancellation throws', () => {
    const error = new Error('cancellation failed');
    vi.mocked(cancelImageUrl).mockImplementation(() => {
      throw error;
    });
    document.body.append(image);
    const destroy = loadImage('/preview.jpg', vi.fn(), vi.fn());
    expect(destroy).toThrow(error);
    expect(image.isConnected).toBe(false);
    expect(image.removeEventListener).toHaveBeenCalledTimes(2);
    expect(destroy).not.toThrow();
    expect(cancelImageUrl).toHaveBeenCalledOnce();
  });

  it('ignores already captured handlers after cancellation', () => {
    const onLoad = vi.fn();
    const onError = vi.fn();
    const destroy = loadImage('/preview.jpg', onLoad, onError);
    const handleLoad = vi
      .mocked(image.addEventListener)
      .mock.calls.find(([type]) => type === 'load')![1] as EventListener;
    const handleError = vi
      .mocked(image.addEventListener)
      .mock.calls.find(([type]) => type === 'error')![1] as EventListener;
    destroy();
    handleLoad.call(image, new Event('load'));
    handleError.call(image, new Event('error'));
    expect(onLoad).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(cancelImageUrl).toHaveBeenCalledOnce();
  });

  it.each(['load', 'error'] as const)('retains cleanup when the %s callback throws', (event) => {
    const error = new Error('callback failed');
    const notify = () => {
      throw error;
    };
    document.body.append(image);
    const destroy = loadImage(
      '/preview.jpg',
      event === 'load' ? notify : vi.fn(),
      event === 'error' ? notify : vi.fn(),
    );
    const handler = vi.mocked(image.addEventListener).mock.calls.find(([type]) => type === event)![1] as EventListener;
    expect(() => handler.call(image, new Event(event))).toThrow(error);
    expect(image.isConnected).toBe(false);
    expect(image.removeEventListener).toHaveBeenCalledTimes(2);
    destroy();
    expect(cancelImageUrl).toHaveBeenCalledOnce();
  });
});
