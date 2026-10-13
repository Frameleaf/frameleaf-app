import { toStore } from 'svelte/store';
import { navigating } from '$app/state';
import { SessionStorageKey } from '$lib/constants';
import { handlePromiseError } from '$lib/utils';

interface Options {
  /**
   * This must be kept the same in all subpages of this route for the scroll memory clearer to work.
   */
  routeStartsWith: string;
  /**
   * Function to clear additional data/state before scrolling (ex infinite scroll).
   */
  beforeClear?: () => void;
}

interface PageOptions extends Options {
  /**
   * Function to save additional data/state before scrolling (ex infinite scroll).
   */
  beforeSave?: () => void;
  /**
   * Function to load additional data/state before scrolling (ex infinite scroll).
   */
  beforeScroll?: () => Promise<void>;
}

/**
 * @param node The scroll slot element, typically from {@link UserPageLayout}
 */
export function scrollMemory(
  node: HTMLElement,
  { routeStartsWith, beforeSave, beforeClear, beforeScroll }: PageOptions,
) {
  const unsubscribeNavigating = toStore(() => navigating.to).subscribe((to) => {
    const existingScroll = sessionStorage.getItem(SessionStorageKey.SCROLL_POSITION);
    if (to && !existingScroll) {
      // Save current scroll information when going into a subpage.
      if (to.url.pathname.startsWith(routeStartsWith)) {
        beforeSave?.();
        sessionStorage.setItem(SessionStorageKey.SCROLL_POSITION, node.scrollTop.toString());
      } else {
        beforeClear?.();
        sessionStorage.removeItem(SessionStorageKey.SCROLL_POSITION);
      }
    }
  });

  handlePromiseError(
    (async () => {
      await beforeScroll?.();

      const newScroll = sessionStorage.getItem(SessionStorageKey.SCROLL_POSITION);
      if (newScroll) {
        node.scroll({
          top: Number(newScroll),
          behavior: 'instant',
        });
      }
      beforeClear?.();
      sessionStorage.removeItem(SessionStorageKey.SCROLL_POSITION);
    })(),
  );

  return {
    destroy() {
      unsubscribeNavigating();
    },
  };
}

export function scrollMemoryClearer(_node: HTMLElement, { routeStartsWith, beforeClear }: Options) {
  const unsubscribeNavigating = toStore(() => navigating.to).subscribe((to) => {
    // Forget scroll position from main page if going somewhere else.
    if (!to || to.url.pathname.startsWith(routeStartsWith)) {
      return;
    }

    beforeClear?.();
    sessionStorage.removeItem(SessionStorageKey.SCROLL_POSITION);
  });

  return {
    destroy() {
      unsubscribeNavigating();
    },
  };
}
