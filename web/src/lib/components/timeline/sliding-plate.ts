import { tick } from 'svelte';

/**
 * A segmented control's pressed plate that slides between segments instead of jumping (review
 * finding 8). Put it on the control's container and pass the current value so it re-measures when
 * the value changes; the pressed segment is the child with `aria-pressed="true"`.
 *
 * It publishes `--plate-x` and `--plate-w` on the container and, once the first position has been
 * painted, sets `data-plate-ready`. The stylesheet draws the plate from those and moves it with a
 * token transition, so Reduce Motion (which clamps transitions) makes it jump. Until the attribute
 * is there (and wherever nothing can be measured) the control keeps its plain pressed style.
 */
export const slidingPlate = (node: HTMLElement, _?: unknown) => {
  const place = () => {
    const pressed = node.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!pressed || pressed.offsetWidth === 0) {
      delete node.dataset.plateReady;
      return false;
    }
    node.style.setProperty('--plate-x', `${pressed.offsetLeft}px`);
    node.style.setProperty('--plate-w', `${pressed.offsetWidth}px`);
    return true;
  };

  // After the first paint, so the plate does not slide in from the control's edge.
  const frame =
    place() && typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => (node.dataset.plateReady = ''))
      : 0;
  const settle = () => {
    if (place() && !frame) {
      node.dataset.plateReady = '';
    }
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(settle) : undefined;
  observer?.observe(node);

  return {
    update: () => void tick().then(settle),
    destroy: () => {
      observer?.disconnect();
      if (frame) {
        cancelAnimationFrame(frame);
      }
    },
  };
};
