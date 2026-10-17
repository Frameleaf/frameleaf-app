import { cancelImageUrl } from '$lib/utils/sw-messaging';

export function loadImage(src: string, onLoad: () => void, onError: () => void, onStart?: () => void) {
  onStart?.();
  const image = document.createElement('img');
  let active = true;

  const destroy = () => {
    if (!active) {
      return;
    }
    active = false;
    image.removeEventListener('load', handleLoad);
    image.removeEventListener('error', handleError);
    try {
      cancelImageUrl(src);
    } finally {
      image.remove();
    }
  };

  const complete = (callback: () => void) => {
    if (active) {
      destroy();
      callback();
    }
  };
  const handleLoad = () => complete(onLoad);
  const handleError = () => complete(onError);
  image.addEventListener('load', handleLoad);
  image.addEventListener('error', handleError);
  image.src = src;
  return destroy;
}

export type LoadImageFunction = typeof loadImage;
