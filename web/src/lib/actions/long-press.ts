export function longPress(element: HTMLElement, { onLongPress }: { onLongPress: () => void }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pointerId: number | undefined;
  let startX = 0;
  let startY = 0;
  let didPress = false;

  const stop = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    document.removeEventListener('scroll', stop, true);
    document.removeEventListener('wheel', stop, true);
    document.removeEventListener('contextmenu', contextMenu, true);
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', end, true);
    document.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('blur', stop);
  };

  const move = (event: PointerEvent) => {
    if (
      event.pointerId === pointerId &&
      (Math.abs(startX - event.clientX) >= 10 || Math.abs(startY - event.clientY) >= 10)
    ) {
      stop();
    }
  };
  const end = (event: PointerEvent) => {
    if (event.pointerId === pointerId) {
      stop();
    }
  };
  const cancel = (event: PointerEvent) => {
    if (event.pointerId === pointerId) {
      didPress = false;
      stop();
    }
  };
  const contextMenu = (event: MouseEvent) => {
    if (didPress && event.target instanceof Node && element.contains(event.target)) {
      event.preventDefault();
    }
    stop();
  };

  const start = (event: PointerEvent) => {
    stop();
    didPress = false;
    if (event.button !== 0) {
      return;
    }
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    document.addEventListener('scroll', stop, { capture: true, passive: true });
    document.addEventListener('wheel', stop, { capture: true, passive: true });
    document.addEventListener('contextmenu', contextMenu, { capture: true });
    document.addEventListener('pointermove', move, { capture: true, passive: true });
    document.addEventListener('pointerup', end, { capture: true, passive: true });
    document.addEventListener('pointercancel', cancel, { capture: true, passive: true });
    window.addEventListener('blur', stop);
    timer = setTimeout(() => {
      timer = undefined;
      didPress = true;
      onLongPress();
    }, 350);
  };

  const click = (event: MouseEvent) => {
    // Keyboard activation has no pointer click count and must remain available after a hold.
    if (didPress && event.detail > 0) {
      didPress = false;
      event.stopPropagation();
      event.preventDefault();
    }
  };
  element.addEventListener('click', click);
  element.addEventListener('pointerdown', start, { capture: true });
  return {
    destroy: () => {
      stop();
      element.removeEventListener('click', click);
      element.removeEventListener('pointerdown', start, true);
    },
  };
}
