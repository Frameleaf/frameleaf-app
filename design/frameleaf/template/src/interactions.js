// Motion helpers shared by the library and viewer. Each one degrades to an instant
// change when the browser lacks the API or the user prefers reduced motion.
import { flushSync } from 'react-dom';

export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches;

const tileImage = (id) =>
  id == null
    ? null
    : document.querySelector(`[data-asset-id="${CSS.escape(String(id))}"] img`);

/**
 * #11 Zoom open/close. Pairs the grid thumbnail with the viewer image (which carries
 * view-transition-name: fl-hero in CSS) so the photo grows out of, and back into, its tile.
 */
export function viewerTransition(fromId, toId, update) {
  const opening = fromId == null && toId != null;
  const closing = fromId != null && toId == null;
  const tile = opening ? tileImage(toId) : closing ? tileImage(fromId) : null;
  if (!tile || !document.startViewTransition || prefersReducedMotion()) {
    update();
    return;
  }
  if (closing) tile.scrollIntoView({ block: 'nearest' });
  if (opening) tile.style.viewTransitionName = 'fl-hero';
  const transition = document.startViewTransition(() => {
    flushSync(update);
    tile.style.viewTransitionName = opening ? '' : 'fl-hero';
  });
  transition.finished.finally(() => {
    tile.style.viewTransitionName = '';
  });
}

/**
 * #12 Grid zoom. Applies a new thumbnail size, then slides visible tiles from their old
 * positions to their new ones (FLIP) so the reflow reads as one continuous zoom.
 */
export function animateGridChange(container, apply) {
  const tiles = container
    ? [...container.querySelectorAll('.media-grid [data-asset-id]')].slice(
        0,
        120,
      )
    : [];
  const before = new Map(
    tiles.map((tile) => [tile, tile.getBoundingClientRect()]),
  );
  flushSync(apply);
  if (prefersReducedMotion()) return;
  const easing =
    getComputedStyle(container).getPropertyValue('--fl-spring').trim() ||
    'ease-out';
  for (const [tile, from] of before) {
    const to = tile.getBoundingClientRect();
    if (!to.width || !tile.isConnected) continue;
    tile.animate(
      [
        {
          transformOrigin: '0 0',
          transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width})`,
        },
        { transformOrigin: '0 0', transform: 'none' },
      ],
      { duration: 420, easing },
    );
  }
}
