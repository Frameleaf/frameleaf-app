/** Serialized into the isolated page world: DOM coordinates only, never credentials or pixels. */
export function selectScreenshotArea(
  id: string,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const host = document.createElement('div');
    host.id = id;
    host.style.cssText =
      'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const layer = document.createElement('div');
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-label', 'Select screenshot area');
    layer.tabIndex = 0;
    layer.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.16);cursor:crosshair;touch-action:none;user-select:none;outline:none;color:#fff;font:16px system-ui;';
    const help = document.createElement('p');
    help.id = id + '-instructions';
    layer.setAttribute('aria-describedby', help.id);
    help.setAttribute('role', 'status');
    help.textContent =
      'Drag an area. Or use arrows to position, Enter to mark each corner. Shift moves 10 pixels. Escape cancels.';
    help.style.cssText =
      'position:absolute;top:12px;left:12px;right:12px;margin:0;padding:12px;background:#101416;border-radius:8px;pointer-events:none;';
    const box = document.createElement('div');
    box.style.cssText =
      'position:absolute;border:2px solid #18d078;box-sizing:border-box;pointer-events:none;';
    const cursor = document.createElement('div');
    cursor.style.cssText =
      'position:absolute;width:8px;height:8px;border:2px solid white;border-radius:50%;transform:translate(-50%,-50%);pointer-events:none;';
    layer.append(help, box, cursor);
    shadow.append(layer);
    let point = {
      x: Math.floor(innerWidth / 2),
      y: Math.floor(innerHeight / 2),
    };
    let start: typeof point | null = null;
    let dragging = false;
    let done = false;
    const rectangle = () => ({
      x: Math.min(start!.x, point.x),
      y: Math.min(start!.y, point.y),
      width: Math.abs(point.x - start!.x),
      height: Math.abs(point.y - start!.y),
    });
    const draw = () => {
      cursor.style.left = point.x + 'px';
      cursor.style.top = point.y + 'px';
      if (start) {
        const r = rectangle();
        box.style.left = r.x + 'px';
        box.style.top = r.y + 'px';
        box.style.width = r.width + 'px';
        box.style.height = r.height + 'px';
      }
    };
    const finish = (value: ReturnType<typeof rectangle> | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      observer.disconnect();
      host.remove();
      previous?.focus({ preventScroll: true });
      const fallback = setTimeout(() => resolve(null), 1000);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          clearTimeout(fallback);
          resolve(value);
        }),
      );
    };
    const confirm = () => {
      if (start) {
        const r = rectangle();
        if (r.width >= 1 && r.height >= 1) finish(r);
      }
    };
    const move = (event: PointerEvent) => {
      point = {
        x: Math.max(0, Math.min(innerWidth, event.clientX)),
        y: Math.max(0, Math.min(innerHeight, event.clientY)),
      };
      draw();
    };
    layer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      move(event);
      start = { ...point };
      dragging = true;
      layer.setPointerCapture(event.pointerId);
      draw();
    });
    layer.addEventListener('pointermove', (event) => {
      if (dragging) move(event);
    });
    layer.addEventListener('pointerup', (event) => {
      if (!dragging) return;
      move(event);
      dragging = false;
      confirm();
    });
    layer.addEventListener('pointercancel', () => finish(null));
    layer.addEventListener('wheel', (event) => event.preventDefault(), {
      passive: false,
    });
    layer.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(null);
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (start) confirm();
        else {
          start = { ...point };
          help.textContent =
            'Choose the opposite corner with arrows, then Enter. Escape cancels.';
          draw();
        }
        return;
      }
      const delta = event.shiftKey ? 10 : 1;
      const steps: Record<string, [number, number]> = {
        ArrowLeft: [-delta, 0],
        ArrowRight: [delta, 0],
        ArrowUp: [0, -delta],
        ArrowDown: [0, delta],
      };
      const step = steps[event.key];
      if (step) {
        event.preventDefault();
        point = {
          x: Math.max(0, Math.min(innerWidth, point.x + step[0])),
          y: Math.max(0, Math.min(innerHeight, point.y + step[1])),
        };
        draw();
      }
    });
    const timer = setTimeout(() => finish(null), 60000);
    const observer = new MutationObserver(() => {
      if (!host.isConnected) finish(null);
    });
    document.documentElement.append(host);
    observer.observe(document.documentElement, { childList: true });
    draw();
    layer.focus({ preventScroll: true });
  });
}
