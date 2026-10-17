import type { LoadImageFunction } from '$lib/actions/image-loader.svelte';
import { cancelImageUrl } from '$lib/utils/sw-messaging';

export type ImageQuality = 'thumbnail' | 'preview' | 'original';

export type ImageStatus = 'unloaded' | 'success' | 'error';

export type ImageLoaderStatus = {
  urls: Record<ImageQuality, string | undefined>;
  quality: Record<ImageQuality, ImageStatus>;
  started: boolean;
  hasError: boolean;
};

type ImageLoaderCallbacks = {
  onUrlChange?: (url: string) => void;
  onImageReady?: () => void;
  onError?: () => void;
};

export type QualityConfig = {
  url: string;
  quality: ImageQuality;
  onAfterLoad?: (loader: AdaptiveImageLoader) => void;
  onAfterError?: (loader: AdaptiveImageLoader) => void;
};

export type QualityList = [
  QualityConfig & { quality: 'thumbnail' },
  QualityConfig & { quality: 'preview' },
  QualityConfig & { quality: 'original' },
];

export class AdaptiveImageLoader {
  private activeLoads = new Map<ImageQuality, { destroy?: () => void }>();
  private preloadStarted = false;
  private qualityConfigs: Record<ImageQuality, QualityConfig>;
  private highestLoadedQualityIndex = -1;
  private destroyed = false;

  status = $state<ImageLoaderStatus>({
    started: false,
    hasError: false,
    urls: { thumbnail: undefined, preview: undefined, original: undefined },
    quality: { thumbnail: 'unloaded', preview: 'unloaded', original: 'unloaded' },
  });

  constructor(
    private readonly qualityList: QualityList,
    private readonly callbacks?: ImageLoaderCallbacks,
    private readonly imageLoader?: LoadImageFunction,
  ) {
    this.qualityConfigs = {
      thumbnail: qualityList[0],
      preview: qualityList[1],
      original: qualityList[2],
    };
    this.status.urls.thumbnail = qualityList[0].url;
  }

  start() {
    if (this.destroyed || this.preloadStarted) {
      return;
    }
    if (!this.imageLoader) {
      throw new Error('Start requires imageLoader to be specified');
    }
    this.preloadStarted = true;
    this.loadQuality('thumbnail');
  }

  private loadQuality(quality: ImageQuality) {
    if (!this.imageLoader) {
      return;
    }
    const request: { destroy?: () => void } = {};
    this.activeLoads.set(quality, request);
    const finish = (callback: () => void) => {
      if (this.destroyed || this.activeLoads.get(quality) !== request) {
        return;
      }
      this.activeLoads.delete(quality);
      request.destroy?.();
      callback();
    };
    const destroy = this.imageLoader(
      this.qualityConfigs[quality].url,
      () => finish(() => this.onLoad(quality)),
      () => finish(() => this.onError(quality)),
      () => {
        if (this.activeLoads.get(quality) === request) {
          this.onStart(quality);
        }
      },
    );
    // A synchronous callback may have completed the request or destroyed the loader.
    if (this.activeLoads.get(quality) === request) {
      request.destroy = destroy;
    } else {
      destroy();
    }
  }

  onStart(_: ImageQuality) {
    if (this.destroyed) {
      return;
    }
    this.status.started = true;
  }

  onLoad(quality: ImageQuality) {
    if (this.destroyed) {
      return;
    }

    const config = this.qualityConfigs[quality];

    // eslint-disable-next-line unicorn/no-computed-property-existence-check
    if (!this.status.urls[quality]) {
      return;
    }

    const index = this.qualityList.indexOf(config);
    if (index <= this.highestLoadedQualityIndex) {
      return;
    }

    this.highestLoadedQualityIndex = index;
    this.status.quality[quality] = 'success';
    this.callbacks?.onUrlChange?.(config.url);
    if (this.destroyed) {
      return;
    }
    this.callbacks?.onImageReady?.();
    if (!this.destroyed) {
      config.onAfterLoad?.(this);
    }
  }

  onError(quality: ImageQuality) {
    if (this.destroyed) {
      return;
    }

    const config = this.qualityConfigs[quality];

    this.status.hasError = true;
    this.status.quality[quality] = 'error';
    this.status.urls[quality] = undefined;
    this.callbacks?.onError?.();

    if (!this.destroyed) {
      config.onAfterError?.(this);
    }
  }

  trigger(quality: ImageQuality) {
    if (this.destroyed) {
      return false;
    }

    const url = this.qualityConfigs[quality].url;
    if (!url) {
      this.qualityConfigs[quality].onAfterError?.(this);
      return false;
    }

    // eslint-disable-next-line unicorn/no-computed-property-existence-check
    if (this.status.urls[quality]) {
      return true;
    }

    this.status.hasError = false;
    this.status.quality[quality] = 'unloaded';
    this.status.urls[quality] = url;
    this.loadQuality(quality);
    return false;
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    if (this.imageLoader) {
      const requests = [...this.activeLoads.values()];
      this.activeLoads.clear();
      for (const request of requests) {
        request.destroy?.();
      }
      return;
    }

    for (const config of Object.values(this.qualityConfigs)) {
      cancelImageUrl(config.url);
    }
  }
}
