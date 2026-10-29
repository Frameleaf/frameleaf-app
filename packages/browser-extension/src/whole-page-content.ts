// Serialized into the page's isolated world by chrome.scripting. Each function must be
// self-contained: no imports and no references to anything outside its own body. They read
// page geometry and move the page's scroll position; they never read pixels or credentials.
// State lives on the isolated world's global under a random key, which the page can't see.

interface WholePageSession {
  cancelled: boolean;
  restored: boolean;
  measure(scan: boolean): unknown;
  show(screen: number, total: number): void;
  hideBar(): void;
  hide(indices: number[]): void;
  touch(): void;
  restore(): void;
}

/** Shows the progress bar, blocks user scrolling and returns the page's measurements. */
export function wholePageStart(key: string): unknown {
  const scope = globalThis as unknown as Record<string, WholePageSession>;
  scope[key]?.restore();
  const root = document.scrollingElement ?? document.documentElement;
  const original = { x: scrollX, y: scrollY };
  const hidden: [HTMLElement | SVGElement, string, string][] = [];
  let candidates: (HTMLElement | SVGElement)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const host = document.createElement('div');
  host.id = key;
  host.style.cssText =
    'all:initial!important;position:fixed!important;top:12px!important;left:50%!important;transform:translateX(-50%)!important;z-index:2147483647!important;display:block!important;width:min(460px,calc(100vw - 32px))!important;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const card = document.createElement('div');
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');
  card.style.cssText =
    'box-sizing:border-box;display:flex;align-items:center;gap:12px;padding:12px 16px;border:1px solid #2b3236;border-radius:12px;background:#101416;color:#f2f4f5;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);';
  const text = document.createElement('div');
  text.style.cssText =
    'flex:1;display:flex;flex-direction:column;gap:6px;min-width:0;';
  const title = document.createElement('strong');
  title.style.cssText = 'font-weight:600;';
  title.textContent = 'Capturing the whole page';
  const help = document.createElement('small');
  help.style.cssText = 'color:#a7b0b5;font-size:12px;';
  help.textContent =
    'The page scrolls by itself. Keep this tab open. This bar is left out of the picture.';
  const track = document.createElement('div');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', 'Whole page capture');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.style.cssText =
    'height:4px;border-radius:2px;background:rgba(255,255,255,.12);overflow:hidden;';
  const fill = document.createElement('div');
  fill.style.cssText =
    'height:100%;width:0;background:#18d078;transition:width .2s;';
  track.append(fill);
  text.append(title, help, track);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.style.cssText =
    'flex:none;padding:6px 12px;border:1px solid #3a4247;border-radius:8px;background:#1b2124;color:#f2f4f5;font:600 13px system-ui,sans-serif;cursor:pointer;';
  card.append(text, cancel);
  shadow.append(card);

  const scrollKeys = new Set([
    ' ',
    'ArrowUp',
    'ArrowDown',
    'PageUp',
    'PageDown',
    'Home',
    'End',
  ]);
  const block = (event: Event) => event.preventDefault();
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      session.cancelled = true;
      session.restore();
    } else if (scrollKeys.has(event.key)) event.preventDefault();
  };

  const session: WholePageSession = {
    cancelled: false,
    restored: false,
    measure(scan: boolean) {
      let panel = false;
      if (root.scrollHeight <= root.clientHeight + 1) {
        let node = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        for (let depth = 0; node && depth < 64; depth++) {
          if (node === document.body || node === document.documentElement)
            break;
          const style = getComputedStyle(node);
          if (
            /(auto|scroll|overlay)/.test(style.overflowY) &&
            node.scrollHeight > node.clientHeight + 1 &&
            node.clientHeight >= innerHeight * 0.5
          ) {
            panel = true;
            break;
          }
          node = node.parentElement;
        }
      }
      let found: {
        position: string;
        top: number;
        bottom: number;
        width: number;
        height: number;
      }[] = [];
      if (scan) {
        candidates = [];
        found = [];
        const walker = document.createTreeWalker(
          document.documentElement,
          NodeFilter.SHOW_ELEMENT,
        );
        for (
          let visited = 0, node = walker.nextNode();
          node && visited < 20000 && candidates.length < 300;
          visited++, node = walker.nextNode()
        ) {
          if (
            node === host ||
            !(node instanceof HTMLElement || node instanceof SVGElement)
          )
            continue;
          const position = getComputedStyle(node).position;
          if (position !== 'fixed' && position !== 'sticky') continue;
          const rect = node.getBoundingClientRect();
          candidates.push(node);
          found.push({
            position,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          });
        }
      }
      return {
        url: document.URL,
        title: document.title.slice(0, 2000),
        innerWidth,
        innerHeight,
        clientWidth: root.clientWidth,
        clientHeight: root.clientHeight,
        pageHeight: root.scrollHeight,
        scrollY,
        pixelRatio: devicePixelRatio,
        zoom:
          (visualViewport?.scale ?? 1) === 1 &&
          (visualViewport?.offsetLeft ?? 0) === 0 &&
          (visualViewport?.offsetTop ?? 0) === 0
            ? 1
            : 0,
        panel,
        cancelled: session.cancelled,
        ...(scan && { candidates: found }),
      };
    },
    show(screen: number, total: number) {
      title.textContent = `Capturing the whole page · screen ${screen} of ${total}`;
      const percent = Math.round((screen / total) * 100);
      fill.style.width = percent + '%';
      track.setAttribute('aria-valuenow', String(percent));
      host.style.setProperty('visibility', 'visible', 'important');
      if (!host.isConnected) document.documentElement.append(host);
    },
    hideBar() {
      host.style.setProperty('visibility', 'hidden', 'important');
    },
    hide(indices: number[]) {
      for (const index of indices) {
        const node = candidates[index];
        if (!node || hidden.some(([value]) => value === node)) continue;
        hidden.push([
          node,
          node.style.getPropertyValue('visibility'),
          node.style.getPropertyPriority('visibility'),
        ]);
        node.style.setProperty('visibility', 'hidden', 'important');
      }
    },
    touch() {
      clearTimeout(timer);
      // If the extension stops talking to the page, put it back by itself.
      timer = setTimeout(() => session.restore(), 30000);
    },
    restore() {
      if (session.restored) return;
      session.restored = true;
      clearTimeout(timer);
      removeEventListener('keydown', onKey, true);
      removeEventListener('wheel', block, true);
      removeEventListener('touchmove', block, true);
      for (const [node, value, priority] of hidden.reverse()) {
        if (value) node.style.setProperty('visibility', value, priority);
        else node.style.removeProperty('visibility');
      }
      hidden.length = 0;
      candidates = [];
      host.remove();
      scrollTo({ left: original.x, top: original.y, behavior: 'instant' });
    },
  };
  cancel.addEventListener('click', () => {
    session.cancelled = true;
    session.restore();
  });
  addEventListener('keydown', onKey, true);
  addEventListener('wheel', block, { capture: true, passive: false });
  addEventListener('touchmove', block, { capture: true, passive: false });
  scope[key] = session;
  document.documentElement.append(host);
  session.show(0, 1);
  title.textContent = 'Capturing the whole page';
  session.touch();
  return session.measure(false);
}

/** Shows progress, scrolls to `y` and reports where the page landed. */
export async function wholePageStep(
  key: string,
  y: number,
  screen: number,
  total: number,
  hide: number[] | null,
  scan: boolean,
): Promise<unknown> {
  const session = (globalThis as unknown as Record<string, WholePageSession>)[
    key
  ];
  if (!session) return null;
  if (session.restored) return session.cancelled ? { cancelled: true } : null;
  session.touch();
  session.show(screen, total);
  if (hide) session.hide(hide);
  scrollTo({ left: 0, top: y, behavior: 'instant' });
  await new Promise<void>((resolve) => {
    const fallback = setTimeout(resolve, 300);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(fallback);
        resolve();
      }),
    );
  });
  if (session.restored) return session.cancelled ? { cancelled: true } : null;
  return session.measure(scan);
}

/** Hides the progress bar so the next picture leaves it out. */
export async function wholePagePrepare(key: string): Promise<unknown> {
  const session = (globalThis as unknown as Record<string, WholePageSession>)[
    key
  ];
  if (!session) return null;
  if (session.restored) return session.cancelled ? { cancelled: true } : null;
  session.touch();
  session.hideBar();
  await new Promise<void>((resolve) => {
    const fallback = setTimeout(resolve, 300);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(fallback);
        resolve();
      }),
    );
  });
  if (session.restored) return session.cancelled ? { cancelled: true } : null;
  return session.measure(false);
}

/** Puts the page back: scroll position, hidden bars and the progress bar. Safe to repeat. */
export function wholePageRestore(key: string): boolean {
  const scope = globalThis as unknown as Record<string, WholePageSession>;
  scope[key]?.restore();
  delete scope[key];
  return true;
}

/** Says the page can't be captured whole and offers the other screenshots instead. */
export function offerWholePageFallback(
  id: string,
  message: string,
): Promise<'visible' | 'area' | null> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const host = document.createElement('div');
    host.id = id;
    host.style.cssText =
      'all:initial!important;position:fixed!important;top:12px!important;left:50%!important;transform:translateX(-50%)!important;z-index:2147483647!important;display:block!important;width:min(440px,calc(100vw - 32px))!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const card = document.createElement('div');
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'false');
    card.setAttribute('aria-labelledby', id + '-title');
    card.setAttribute('aria-describedby', id + '-text');
    card.style.cssText =
      'box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid #2b3236;border-radius:12px;background:#101416;color:#f2f4f5;font:14px/1.45 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);';
    const heading = document.createElement('strong');
    heading.id = id + '-title';
    heading.style.cssText = 'font-size:16px;font-weight:600;';
    heading.textContent = 'This page can’t be captured whole';
    const text = document.createElement('p');
    text.id = id + '-text';
    text.style.cssText = 'margin:0;color:#a7b0b5;';
    text.textContent = message;
    const actions = document.createElement('div');
    actions.style.cssText =
      'display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;';
    const button = (label: string, primary: boolean) => {
      const value = document.createElement('button');
      value.type = 'button';
      value.textContent = label;
      value.style.cssText = `padding:8px 14px;border-radius:8px;font:600 13px system-ui,sans-serif;cursor:pointer;${primary ? 'border:1px solid #18d078;background:#18d078;color:#06140c;' : 'border:1px solid #3a4247;background:#1b2124;color:#f2f4f5;'}`;
      value.addEventListener('focus', () => {
        value.style.outline = '2px solid #18d078';
        value.style.outlineOffset = '2px';
      });
      value.addEventListener('blur', () => (value.style.outline = 'none'));
      return value;
    };
    const close = button('Close', false);
    const area = button('Select an area', false);
    const visible = button('Capture what you can see', true);
    actions.append(close, area, visible);
    card.append(heading, text, actions);
    shadow.append(card);
    let done = false;
    const finish = (value: 'visible' | 'area' | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      observer.disconnect();
      removeEventListener('keydown', onKey, true);
      host.remove();
      previous?.focus({ preventScroll: true });
      // Let the page repaint without this message before any screenshot is taken.
      const fallback = setTimeout(() => resolve(value), 300);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          clearTimeout(fallback);
          resolve(value);
        }),
      );
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(null);
      }
    };
    close.addEventListener('click', () => finish(null));
    area.addEventListener('click', () => finish('area'));
    visible.addEventListener('click', () => finish('visible'));
    addEventListener('keydown', onKey, true);
    const timer = setTimeout(() => finish(null), 120000);
    const observer = new MutationObserver(() => {
      if (!host.isConnected) finish(null);
    });
    document.documentElement.append(host);
    observer.observe(document.documentElement, { childList: true });
    visible.focus({ preventScroll: true });
  });
}
