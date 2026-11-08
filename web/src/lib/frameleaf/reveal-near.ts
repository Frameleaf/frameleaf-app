import type { Action } from 'svelte/action';

/** The page scrolls inside the layout, not the window, and a margin only counts against that scroller. */
const scrollParent = (element: HTMLElement): HTMLElement | null => {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') {
      return node;
    }
  }
  return null;
};

/** Without IntersectionObserver nothing can say what is near, so a list must show everything at once. */
export const canRevealNearby = () => typeof IntersectionObserver === 'function';

/**
 * One shared IntersectionObserver for a long list: `onNear` is called once for each watched element
 * when it comes within `rootMargin` of the visible area.
 */
export const createNearbyReveal = (onNear: (key: string) => void, rootMargin = '600px 0px') => {
  let observer: IntersectionObserver | undefined;
  const keys = new WeakMap<Element, string>();

  const watch: Action<HTMLElement, string> = (node, key) => {
    if (!canRevealNearby()) {
      return;
    }
    keys.set(node, key);
    observer ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            observer?.unobserve(entry.target);
            onNear(keys.get(entry.target)!);
          }
        }
      },
      { root: scrollParent(node), rootMargin },
    );
    observer.observe(node);
    return {
      update: (next: string) => void keys.set(node, next),
      destroy: () => observer?.unobserve(node),
    };
  };

  return { watch, disconnect: () => observer?.disconnect() };
};
