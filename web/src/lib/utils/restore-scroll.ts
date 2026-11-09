/**
 * Puts a scrolling element back at `top`. The page can still be too short in its first frame, which
 * clamps the position, so this keeps trying as the content arrives. Scrolling by hand wins.
 */
export function restoreScroll(getElement: () => HTMLElement | undefined, top: number, timeoutMs = 3000): void {
  const deadline = performance.now() + timeoutMs;
  let placed: number | undefined;
  const place = () => {
    const element = getElement();
    if (!element || (placed !== undefined && element.scrollTop !== placed)) {
      return;
    }
    element.scrollTo({ top, behavior: 'instant' });
    placed = element.scrollTop;
    if (Math.abs(placed - top) >= 1 && performance.now() < deadline) {
      requestAnimationFrame(place);
    }
  };
  requestAnimationFrame(place);
}
