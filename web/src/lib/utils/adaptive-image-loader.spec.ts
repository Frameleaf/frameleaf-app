import { loadImage, type LoadImageFunction } from '$lib/actions/image-loader.svelte';
import { AdaptiveImageLoader, type QualityList } from '$lib/utils/adaptive-image-loader.svelte';
import { cancelImageUrl } from '$lib/utils/sw-messaging';

vi.mock('$lib/utils/sw-messaging', () => ({
  cancelImageUrl: vi.fn(),
}));

function createQualityList(overrides?: {
  onAfterLoad?: Record<string, (loader: AdaptiveImageLoader) => void>;
  onAfterError?: Record<string, (loader: AdaptiveImageLoader) => void>;
}): QualityList {
  return [
    {
      quality: 'thumbnail',
      url: '/thumbnail.jpg',
      onAfterLoad: overrides?.onAfterLoad?.thumbnail,
      onAfterError: overrides?.onAfterError?.thumbnail,
    },
    {
      quality: 'preview',
      url: '/preview.jpg',
      onAfterLoad: overrides?.onAfterLoad?.preview,
      onAfterError: overrides?.onAfterError?.preview,
    },
    {
      quality: 'original',
      url: '/original.jpg',
      onAfterLoad: overrides?.onAfterLoad?.original,
      onAfterError: overrides?.onAfterError?.original,
    },
  ];
}

function controlledImageLoader() {
  const requests: {
    url: string;
    onLoad: () => void;
    onError: () => void;
    onStart?: () => void;
    destroy: ReturnType<typeof vi.fn>;
  }[] = [];
  const imageLoader: LoadImageFunction = (url, onLoad, onError, onStart) => {
    const destroy = vi.fn();
    requests.push({ url, onLoad, onError, onStart, destroy });
    onStart?.();
    return destroy;
  };
  return { imageLoader, requests };
}

describe('AdaptiveImageLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('initializes with thumbnail URL set', () => {
      const loader = new AdaptiveImageLoader(createQualityList());
      expect(loader.status.urls.thumbnail).toBe('/thumbnail.jpg');
      expect(loader.status.urls.preview).toBeUndefined();
      expect(loader.status.urls.original).toBeUndefined();
    });

    it('initializes all qualities as unloaded', () => {
      const loader = new AdaptiveImageLoader(createQualityList());
      expect(loader.status.quality.thumbnail).toBe('unloaded');
      expect(loader.status.quality.preview).toBe('unloaded');
      expect(loader.status.quality.original).toBe('unloaded');
    });
  });

  describe('onStart', () => {
    it('sets started to true', () => {
      const loader = new AdaptiveImageLoader(createQualityList());
      expect(loader.status.started).toBe(false);
      loader.onStart('thumbnail');
      expect(loader.status.started).toBe(true);
    });

    it('is a no-op after destroy', () => {
      const loader = new AdaptiveImageLoader(createQualityList());
      loader.destroy();
      loader.onStart('thumbnail');
      expect(loader.status.started).toBe(false);
    });
  });

  describe('onLoad', () => {
    it('sets quality to success and calls callbacks', () => {
      const onUrlChange = vi.fn();
      const onImageReady = vi.fn();
      const loader = new AdaptiveImageLoader(createQualityList(), { onUrlChange, onImageReady });

      loader.onLoad('thumbnail');

      expect(loader.status.quality.thumbnail).toBe('success');
      expect(onUrlChange).toHaveBeenCalledWith('/thumbnail.jpg');
      expect(onImageReady).toHaveBeenCalledOnce();
    });

    it('calls onAfterLoad callback', () => {
      const onAfterLoad = vi.fn();
      const qualityList = createQualityList({ onAfterLoad: { thumbnail: onAfterLoad } });
      const loader = new AdaptiveImageLoader(qualityList);

      loader.onLoad('thumbnail');

      expect(onAfterLoad).toHaveBeenCalledWith(loader);
    });

    it('ignores load if URL is not set', () => {
      const onImageReady = vi.fn();
      const loader = new AdaptiveImageLoader(createQualityList(), { onImageReady });

      loader.onLoad('preview');

      expect(loader.status.quality.preview).toBe('unloaded');
      expect(onImageReady).not.toHaveBeenCalled();
    });

    it('ignores load if a higher quality is already loaded', () => {
      const onUrlChange = vi.fn();
      const loader = new AdaptiveImageLoader(createQualityList(), { onUrlChange });

      loader.onLoad('thumbnail');
      loader.trigger('preview');
      loader.onLoad('preview');

      onUrlChange.mockClear();
      loader.onLoad('thumbnail');

      expect(onUrlChange).not.toHaveBeenCalled();
    });

    it('is a no-op after destroy', () => {
      const onImageReady = vi.fn();
      const loader = new AdaptiveImageLoader(createQualityList(), { onImageReady });

      loader.destroy();
      loader.onLoad('thumbnail');

      expect(onImageReady).not.toHaveBeenCalled();
    });
  });

  describe('onError', () => {
    it('sets quality to error and clears URL', () => {
      const onError = vi.fn();
      const loader = new AdaptiveImageLoader(createQualityList(), { onError });

      loader.onError('thumbnail');

      expect(loader.status.quality.thumbnail).toBe('error');
      expect(loader.status.urls.thumbnail).toBeUndefined();
      expect(loader.status.hasError).toBe(true);
      expect(onError).toHaveBeenCalledOnce();
    });

    it('calls onAfterError callback', () => {
      const onAfterError = vi.fn();
      const qualityList = createQualityList({ onAfterError: { thumbnail: onAfterError } });
      const loader = new AdaptiveImageLoader(qualityList);

      loader.onError('thumbnail');

      expect(onAfterError).toHaveBeenCalledWith(loader);
    });

    it('is a no-op after destroy', () => {
      const onError = vi.fn();
      const loader = new AdaptiveImageLoader(createQualityList(), { onError });

      loader.destroy();
      loader.onError('thumbnail');

      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('trigger', () => {
    it('sets the URL for the quality', () => {
      const loader = new AdaptiveImageLoader(createQualityList());

      loader.trigger('preview');

      expect(loader.status.urls.preview).toBe('/preview.jpg');
    });

    it('returns true if URL is already set', () => {
      const loader = new AdaptiveImageLoader(createQualityList());

      expect(loader.trigger('thumbnail')).toBe(true);
    });

    it('returns false when triggering a new quality', () => {
      const loader = new AdaptiveImageLoader(createQualityList());

      expect(loader.trigger('preview')).toBe(false);
    });

    it('clears hasError when triggering', () => {
      const loader = new AdaptiveImageLoader(createQualityList());

      loader.onError('thumbnail');
      expect(loader.status.hasError).toBe(true);

      loader.trigger('preview');
      expect(loader.status.hasError).toBe(false);
    });

    it('calls imageLoader when provided', () => {
      const imageLoader = vi.fn(() => vi.fn());
      const loader = new AdaptiveImageLoader(createQualityList(), undefined, imageLoader);

      loader.trigger('preview');

      expect(imageLoader).toHaveBeenCalledWith(
        '/preview.jpg',
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
      );
    });

    it('returns false after destroy', () => {
      const loader = new AdaptiveImageLoader(createQualityList());

      loader.destroy();

      expect(loader.trigger('preview')).toBe(false);
    });

    it('calls onAfterError if URL is empty', () => {
      const onAfterError = vi.fn();
      const qualityList = createQualityList({ onAfterError: { preview: onAfterError } });
      (qualityList[1] as { url: string }).url = '';
      const loader = new AdaptiveImageLoader(qualityList);

      expect(loader.trigger('preview')).toBe(false);
      expect(onAfterError).toHaveBeenCalledWith(loader);
    });
  });

  describe('start', () => {
    it('throws if no imageLoader is provided', () => {
      const loader = new AdaptiveImageLoader(createQualityList());
      expect(() => loader.start()).toThrow('Start requires imageLoader to be specified');
    });

    it('calls imageLoader with thumbnail URL', () => {
      const imageLoader = vi.fn(() => vi.fn());
      const loader = new AdaptiveImageLoader(createQualityList(), undefined, imageLoader);

      loader.start();

      expect(imageLoader).toHaveBeenCalledWith(
        '/thumbnail.jpg',
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
      );
    });
  });

  describe('destroy', () => {
    it('cancels all image URLs when no imageLoader', () => {
      const loader = new AdaptiveImageLoader(createQualityList());

      loader.destroy();

      expect(cancelImageUrl).toHaveBeenCalledWith('/thumbnail.jpg');
      expect(cancelImageUrl).toHaveBeenCalledWith('/preview.jpg');
      expect(cancelImageUrl).toHaveBeenCalledWith('/original.jpg');
    });

    it('calls destroy functions when imageLoader is provided', () => {
      const destroyFn = vi.fn();
      const imageLoader = vi.fn(() => destroyFn);
      const loader = new AdaptiveImageLoader(createQualityList(), undefined, imageLoader);

      loader.start();
      loader.destroy();

      expect(destroyFn).toHaveBeenCalledOnce();
      expect(cancelImageUrl).not.toHaveBeenCalled();
    });
  });

  describe('progressive loading flow', () => {
    it('thumbnail load triggers preview via onAfterLoad', () => {
      const triggerSpy = vi.fn();
      const qualityList = createQualityList({
        onAfterLoad: {
          thumbnail: (loader) => {
            triggerSpy();
            loader.trigger('preview');
          },
        },
      });
      const loader = new AdaptiveImageLoader(qualityList);

      loader.onLoad('thumbnail');

      expect(triggerSpy).toHaveBeenCalledOnce();
      expect(loader.status.urls.preview).toBe('/preview.jpg');
    });

    it('thumbnail error triggers preview via onAfterError', () => {
      const qualityList = createQualityList({
        onAfterError: {
          thumbnail: (loader) => loader.trigger('preview'),
        },
      });
      const loader = new AdaptiveImageLoader(qualityList);

      loader.onError('thumbnail');

      expect(loader.status.urls.preview).toBe('/preview.jpg');
    });
  });
  describe('request lifecycle', () => {
    afterEach(() => vi.restoreAllMocks());
    it('starts the thumbnail only once, including after it completes', () => {
      const { imageLoader, requests } = controlledImageLoader();
      const loader = new AdaptiveImageLoader(createQualityList(), undefined, imageLoader);
      loader.start();
      loader.start();
      requests[0].onLoad();
      loader.start();
      expect(requests.map(({ url }) => url)).toEqual(['/thumbnail.jpg']);
    });

    it('does not start requests after destroy', () => {
      const { imageLoader, requests } = controlledImageLoader();
      const loader = new AdaptiveImageLoader(createQualityList(), undefined, imageLoader);
      loader.destroy();
      loader.start();
      expect(requests).toHaveLength(0);
      expect(loader.status.started).toBe(false);
    });

    it('cleans up each pending request only once', () => {
      const { imageLoader, requests } = controlledImageLoader();
      const loader = new AdaptiveImageLoader(createQualityList(), undefined, imageLoader);
      loader.start();
      loader.trigger('preview');
      loader.destroy();
      loader.destroy();
      expect(requests[0].destroy).toHaveBeenCalledOnce();
      expect(requests[1].destroy).toHaveBeenCalledOnce();
    });

    it('sends service worker cancellation only once for each configured URL', () => {
      const loader = new AdaptiveImageLoader(createQualityList());
      loader.destroy();
      loader.destroy();
      expect(vi.mocked(cancelImageUrl).mock.calls).toEqual([['/thumbnail.jpg'], ['/preview.jpg'], ['/original.jpg']]);
    });

    it('releases settled requests before retrying and ignores their late callbacks', () => {
      const { imageLoader, requests } = controlledImageLoader();
      const onError = vi.fn();
      const onImageReady = vi.fn();
      const loader = new AdaptiveImageLoader(createQualityList(), { onError, onImageReady }, imageLoader);
      loader.trigger('preview');
      requests[0].onError();
      expect(requests[0].destroy).toHaveBeenCalledOnce();
      expect(loader.trigger('preview')).toBe(false);
      expect(loader.status.quality.preview).toBe('unloaded');
      expect(loader.status.hasError).toBe(false);
      requests[0].onStart?.();
      requests[0].onLoad();
      requests[0].onError();
      expect(loader.status.urls.preview).toBe('/preview.jpg');
      expect(loader.status.quality.preview).toBe('unloaded');
      expect(loader.status.hasError).toBe(false);
      expect(onError).toHaveBeenCalledOnce();
      expect(onImageReady).not.toHaveBeenCalled();
      requests[1].onLoad();
      expect(loader.status.quality.preview).toBe('success');
      expect(onImageReady).toHaveBeenCalledOnce();
      loader.destroy();
      expect(requests[0].destroy).toHaveBeenCalledOnce();
      expect(requests[1].destroy).toHaveBeenCalledOnce();
    });

    it('keeps progressive fallback and quality ordering while releasing completed requests', () => {
      const { imageLoader, requests } = controlledImageLoader();
      const onUrlChange = vi.fn();
      const qualityList = createQualityList({
        onAfterError: {
          thumbnail: (loader) => loader.trigger('preview'),
          preview: (loader) => loader.trigger('original'),
        },
      });
      const loader = new AdaptiveImageLoader(qualityList, { onUrlChange }, imageLoader);
      loader.start();
      requests[0].onError();
      requests[1].onError();
      requests[2].onLoad();
      requests[0].onLoad();
      requests[1].onError();
      expect(requests.map(({ url }) => url)).toEqual(['/thumbnail.jpg', '/preview.jpg', '/original.jpg']);
      expect(onUrlChange).toHaveBeenCalledExactlyOnceWith('/original.jpg');
      expect(loader.status.quality).toEqual({ thumbnail: 'error', preview: 'error', original: 'success' });
      expect(loader.status.hasError).toBe(false);
      expect(requests.every(({ destroy }) => destroy.mock.calls.length === 1)).toBe(true);
      loader.destroy();
      expect(requests.every(({ destroy }) => destroy.mock.calls.length === 1)).toBe(true);
    });

    it('cleans up requests that synchronously finish or destroy the loader', () => {
      const destroy = vi.fn();
      const imageLoader: LoadImageFunction = (_url, onLoad, _onError, onStart) => {
        onStart?.();
        onLoad();
        return destroy;
      };
      const loader = new AdaptiveImageLoader(
        createQualityList(),
        { onImageReady: () => loader.destroy() },
        imageLoader,
      );
      loader.start();
      expect(loader.status.quality.thumbnail).toBe('success');
      expect(destroy).toHaveBeenCalledOnce();
      loader.destroy();
      expect(destroy).toHaveBeenCalledOnce();
    });

    it('stops lifecycle callbacks if an earlier callback destroys the loader', () => {
      const onImageReady = vi.fn();
      const onAfterLoad = vi.fn();
      const qualityList = createQualityList({ onAfterLoad: { thumbnail: onAfterLoad } });
      const loader = new AdaptiveImageLoader(qualityList, {
        onUrlChange: () => loader.destroy(),
        onImageReady,
      });
      loader.onLoad('thumbnail');
      expect(onImageReady).not.toHaveBeenCalled();
      expect(onAfterLoad).not.toHaveBeenCalled();
    });

    it('releases the real preload image listeners after completion', () => {
      const image = document.createElement('img');
      vi.spyOn(document, 'createElement').mockReturnValueOnce(image);
      const onImageReady = vi.fn();
      const loader = new AdaptiveImageLoader(createQualityList(), { onImageReady }, loadImage);
      loader.start();
      image.dispatchEvent(new Event('load'));
      expect(loader.status.quality.thumbnail).toBe('success');
      expect(onImageReady).toHaveBeenCalledOnce();
      expect(cancelImageUrl).toHaveBeenCalledExactlyOnceWith('/thumbnail.jpg');
      image.dispatchEvent(new Event('error'));
      expect(loader.status.hasError).toBe(false);
      loader.destroy();
      expect(cancelImageUrl).toHaveBeenCalledOnce();
    });
  });
});
