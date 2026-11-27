/**
 * FL-1833: the Fullscreen API across the browsers Frameleaf meets on an iPad. Every iPad browser is
 * WebKit. Safari from iPadOS 16.4 has the standard API; earlier iPadOS has only the `webkit`-prefixed
 * one (a request that returns nothing, and `webkitfullscreenchange`); browsers built on WebKit's
 * embedded view may have neither. `fullscreenSupported()` says whether this page can ask for full
 * screen at all; where it cannot, the viewer falls back to its own in-page full screen.
 */

type PrefixedDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type PrefixedElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

const doc = () => (typeof document === 'undefined' ? undefined : (document as PrefixedDocument));

export const fullscreenSupported = (): boolean => {
  const d = doc();
  return !!d && (d.fullscreenEnabled || !!d.webkitFullscreenEnabled);
};

export const fullscreenElement = (): Element | null => {
  const d = doc();
  return d?.fullscreenElement ?? d?.webkitFullscreenElement ?? null;
};

export const requestFullscreen = async (element: HTMLElement): Promise<void> => {
  const target = element as PrefixedElement;
  if (typeof target.requestFullscreen === 'function') {
    await target.requestFullscreen({ navigationUI: 'hide' });
  } else if (typeof target.webkitRequestFullscreen === 'function') {
    await webkitRequest(target as PrefixedElement & { webkitRequestFullscreen: () => Promise<void> | void });
  } else {
    throw new TypeError('Full screen is not supported');
  }
};

/**
 * The prefixed request returns nothing and reports a refusal only as `webkitfullscreenerror`, so the
 * promise settles on the change or the error (or rejects if neither arrives), letting the caller
 * fall back when the browser says no.
 */
const webkitRequest = (target: PrefixedElement & { webkitRequestFullscreen: () => Promise<void> | void }) =>
  new Promise<void>((resolve, reject) => {
    const settle = (ok: boolean) => {
      clearTimeout(timer);
      document.removeEventListener('webkitfullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenerror', onError);
      if (ok) {
        resolve();
      } else {
        reject(new TypeError('Full screen was refused'));
      }
    };
    const onChange = () => settle(true);
    const onError = () => settle(false);
    const timer = setTimeout(() => settle(!!fullscreenElement()), 1000);
    document.addEventListener('webkitfullscreenchange', onChange);
    document.addEventListener('webkitfullscreenerror', onError);
    try {
      void target.webkitRequestFullscreen();
    } catch {
      settle(false);
    }
  });

export const exitFullscreen = async (): Promise<void> => {
  const d = doc();
  if (!d || !fullscreenElement()) {
    return;
  }
  if (typeof d.exitFullscreen === 'function') {
    await d.exitFullscreen();
  } else if (typeof d.webkitExitFullscreen === 'function') {
    await d.webkitExitFullscreen();
  }
};

/** Calls `listener` whenever the page enters or leaves full screen; returns the unsubscribe. */
export const onFullscreenChange = (listener: () => void): (() => void) => {
  const d = doc();
  if (!d) {
    return () => {};
  }
  d.addEventListener('fullscreenchange', listener);
  d.addEventListener('webkitfullscreenchange', listener);
  return () => {
    d.removeEventListener('fullscreenchange', listener);
    d.removeEventListener('webkitfullscreenchange', listener);
  };
};
