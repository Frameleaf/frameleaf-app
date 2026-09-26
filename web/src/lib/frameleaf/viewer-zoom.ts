import { tick } from 'svelte';
import { prefersReducedMotion } from '$lib/frameleaf/motion';
import { isAssetViewerRoute } from '$lib/utils/navigation';

/**
 * The thumbnail-to-viewer zoom (FL-35), ported from the September 24 template's
 * `viewerTransition` (interactions.js:17-36) and `apple-style.css:333-352`.
 *
 * The template pairs the grid thumbnail with the viewer image under one
 * `view-transition-name`, so the photo grows out of its tile and shrinks back into it. Production's
 * viewer is route-driven (`[[assetId=id]]`), so the pairing runs from SvelteKit's `onNavigate`:
 * the old state is the tile (opening) or the viewer image (closing), and the new state is named
 * once the navigation has rendered.
 *
 * It degrades to an instant change when the browser has no View Transitions API, when Reduce
 * Motion is on (checked here in JavaScript as well as in CSS), when the navigation is not an open or
 * a close, or when there is no on-screen tile to grow from.
 */

/** The shared name, as `apple-style.css:334` gives `.mv-image`. */
export const HERO_TRANSITION_NAME = 'fl-hero';

/** The root property `app.css` reads for the hero's timing function. */
export const HERO_EASING_PROPERTY = '--fl-hero-easing';

const VIEWER_SELECTOR = '#immich-asset-viewer';

/** The part of a SvelteKit navigation target the zoom reads. */
export type ZoomNavigationTarget = {
  route?: { id?: string | null } | null;
  params?: Record<string, string> | null;
} | null;

export type ZoomNavigation = {
  from: ZoomNavigationTarget;
  to: ZoomNavigationTarget;
  complete: Promise<void>;
};

export type ZoomDirection = { kind: 'open' | 'close'; assetId: string };

/** Opening (grid → viewer) or closing (viewer → grid); `null` for anything else, such as next/previous. */
export const zoomDirection = (from: ZoomNavigationTarget, to: ZoomNavigationTarget): ZoomDirection | null => {
  const fromViewer = isAssetViewerRoute(from as Parameters<typeof isAssetViewerRoute>[0]);
  const toViewer = isAssetViewerRoute(to as Parameters<typeof isAssetViewerRoute>[0]);
  if (!fromViewer && toViewer && to?.params?.assetId) {
    return { kind: 'open', assetId: to.params.assetId };
  }
  if (fromViewer && !toViewer && from?.params?.assetId) {
    return { kind: 'close', assetId: from.params.assetId };
  }
  return null;
};

const isOnScreen = (element: Element) => {
  const box = element.getBoundingClientRect();
  return (
    box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth
  );
};

/** The visible grid thumbnail for an asset: a Frameleaf tile (`data-asset-id`) or a legacy one (`data-asset`). */
export const findTileImage = (assetId: string, root: ParentNode = document): HTMLElement | null => {
  const tiles = root.querySelectorAll(
    `[data-asset-id="${CSS.escape(assetId)}"], [data-asset="${CSS.escape(assetId)}"]`,
  );
  for (const tile of tiles) {
    if (tile.closest(VIEWER_SELECTOR)) {
      continue;
    }
    const image = tile.querySelector<HTMLElement>('img');
    if (image && isOnScreen(image)) {
      return image;
    }
  }
  return null;
};

/** The viewer's fitted image box (`AdaptiveImage` marks it) or its video. */
export const findViewerHero = (root: ParentNode = document): HTMLElement | null => {
  const hero = root.querySelector<HTMLElement>(
    `${VIEWER_SELECTOR} [data-viewer-hero], ${VIEWER_SELECTOR} [data-viewer-content] video`,
  );
  return hero && isOnScreen(hero) ? hero : null;
};

type StartViewTransition = (update: () => Promise<void>) => { finished: Promise<unknown> };

const viewTransitionStarter = (): StartViewTransition | undefined => {
  if (typeof document === 'undefined') {
    return undefined;
  }
  const start = Reflect.get(document, 'startViewTransition') as StartViewTransition | undefined;
  return typeof start === 'function' ? start.bind(document) : undefined;
};

const setName = (element: HTMLElement | null, name: string) => {
  if (element) {
    element.style.setProperty('view-transition-name', name);
  }
};

/**
 * `onNavigate` handler: returns a promise that resolves once the old state is captured (so
 * SvelteKit then renders the new page inside the transition), or nothing for an instant change.
 */
export const viewerZoomTransition = (navigation: ZoomNavigation): Promise<void> | undefined => {
  const direction = zoomDirection(navigation.from, navigation.to);
  const start = viewTransitionStarter();
  if (!direction || !start || prefersReducedMotion()) {
    return;
  }

  const before = direction.kind === 'open' ? findTileImage(direction.assetId) : findViewerHero();
  if (!before) {
    return;
  }

  let after: HTMLElement | null = null;
  const root = document.documentElement;
  const clear = () => {
    setName(before, '');
    setName(after, '');
    root.style.removeProperty(HERO_EASING_PROPERTY);
  };

  // The pseudo-elements live on <html>, outside the .frameleaf roots that define the spring.
  const spring = getComputedStyle(before).getPropertyValue('--fl-spring').trim();
  if (spring) {
    root.style.setProperty(HERO_EASING_PROPERTY, spring);
  }
  setName(before, HERO_TRANSITION_NAME);
  return new Promise<void>((resolve) => {
    try {
      const transition = start(async () => {
        resolve();
        try {
          await navigation.complete;
        } catch {
          // A cancelled or failed navigation leaves the page as it was; the transition just settles.
        }
        // The viewer mounts through a portal and measures itself in effects: let both settle.
        await tick();
        await tick();
        setName(before, '');
        after = direction.kind === 'open' ? findViewerHero() : findTileImage(direction.assetId);
        setName(after, HERO_TRANSITION_NAME);
      });
      void transition.finished.then(clear).catch(clear);
    } catch {
      clear();
      resolve();
    }
  });
};
