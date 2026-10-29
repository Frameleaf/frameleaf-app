import { parseDiscovery, type PageDiscovery } from './discovery';
import { selectScreenshotArea } from './screenshot-selection';
export type Rectangle = { x: number; y: number; width: number; height: number };
export interface ScreenshotPreview {
  mode: 'visible' | 'area';
  dataUrl: string | null;
  viewport: { width: number; height: number };
  selection?: Rectangle;
}
export class ScreenshotFailure extends Error {
  constructor() {
    super(
      'Screenshot could not be captured safely. Keep the same web tab, viewport and browser window focused, then try again.',
    );
  }
}
const fail = () => new ScreenshotFailure();
const maxScreenshotBytes = 24 * 1024 * 1024;
async function within<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeout = 15000,
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    throw fail();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(fail());
      timer = setTimeout(abort, timeout);
      signal.addEventListener('abort', abort, { once: true });
      operation.then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
export function cropRectangle(
  image: { width: number; height: number },
  viewport: { width: number; height: number },
  selection: Rectangle,
): Rectangle {
  if (
    ![
      image.width,
      image.height,
      viewport.width,
      viewport.height,
      selection.x,
      selection.y,
      selection.width,
      selection.height,
    ].every(Number.isFinite) ||
    image.width <= 0 ||
    image.height <= 0 ||
    image.width * image.height > 40_000_000 ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    Math.abs(image.height - (image.width * viewport.height) / viewport.width) >
      2 ||
    selection.x < 0 ||
    selection.y < 0 ||
    selection.width <= 0 ||
    selection.height <= 0 ||
    selection.x + selection.width > viewport.width ||
    selection.y + selection.height > viewport.height
  )
    throw fail();
  const x = Math.floor((selection.x * image.width) / viewport.width),
    y = Math.floor((selection.y * image.height) / viewport.height);
  return {
    x,
    y,
    width:
      Math.ceil(
        ((selection.x + selection.width) * image.width) / viewport.width,
      ) - x,
    height:
      Math.ceil(
        ((selection.y + selection.height) * image.height) / viewport.height,
      ) - y,
  };
}
export async function cropCapture(
  blob: Blob,
  viewport: { width: number; height: number },
  selection?: Rectangle,
): Promise<Blob> {
  if (blob.size > maxScreenshotBytes || blob.type !== 'image/png') throw fail();
  const header = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
  if (
    header.length !== 24 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => header[index] === value,
    ) ||
    ![73, 72, 68, 82].every((value, index) => header[index + 12] === value)
  )
    throw fail();
  const fields = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  );
  if (fields.getUint32(8) !== 13) throw fail();
  // Admit PNG dimensions before allocating its decoded pixel buffer.
  cropRectangle(
    { width: fields.getUint32(16), height: fields.getUint32(20) },
    viewport,
    selection ?? { x: 0, y: 0, ...viewport },
  );
  const image = await createImageBitmap(blob);
  try {
    const rect = cropRectangle(
      image,
      viewport,
      selection ?? { x: 0, y: 0, ...viewport },
    );
    if (!selection) return blob;
    const canvas = new OffscreenCanvas(rect.width, rect.height);
    const context = canvas.getContext('2d');
    if (!context) throw fail();
    context.drawImage(
      image,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      rect.width,
      rect.height,
    );
    const cropped = await canvas.convertToBlob({ type: 'image/png' });
    if (cropped.size > maxScreenshotBytes) throw fail();
    return cropped;
  } finally {
    image.close();
  }
}
async function readFrame(
  tabId: number,
  overlay: string,
  signal: AbortSignal,
  documentId?: string,
) {
  const [frame] = await within(
    chrome.scripting.executeScript({
      target: { tabId, ...(documentId && { documentIds: [documentId] }) },
      world: 'ISOLATED',
      args: [overlay],
      func: async (id: string) => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return {
          url: document.URL,
          title: document.title.slice(0, 2000),
          width: innerWidth,
          height: innerHeight,
          scrollX,
          scrollY,
          scale: visualViewport?.scale ?? 1,
          left: visualViewport?.offsetLeft ?? 0,
          top: visualViewport?.offsetTop ?? 0,
          overlay: !!document.getElementById(id),
        };
      },
    }),
    signal,
  );
  const value = frame?.result;
  if (
    !frame?.documentId ||
    frame.frameId !== 0 ||
    !value ||
    !['width', 'height', 'scrollX', 'scrollY', 'scale', 'left', 'top'].every(
      (key) => Number.isFinite(value[key as keyof typeof value]),
    ) ||
    value.width <= 0 ||
    value.height <= 0 ||
    value.width > 32768 ||
    value.height > 32768 ||
    value.scale !== 1 ||
    value.left !== 0 ||
    value.top !== 0 ||
    value.overlay
  )
    throw fail();
  return { documentId: frame.documentId, ...value };
}
export async function takeScreenshot(
  mode: 'visible' | 'area',
  signal: AbortSignal,
): Promise<{ discovery: PageDiscovery; screenshot: ScreenshotPreview } | null> {
  if (signal.aborted) throw fail();
  const lifetime = new AbortController();
  signal = AbortSignal.any([signal, lifetime.signal]);
  const [tab] = await within(
    chrome.tabs.query({ active: true, lastFocusedWindow: true }),
    signal,
  );
  if (
    !tab?.id ||
    !tab.url ||
    !['https:', 'http:'].includes(new URL(tab.url).protocol) ||
    new URL(tab.url).username ||
    new URL(tab.url).password ||
    tab.url.length > 8192
  )
    throw fail();
  const tabId = tab.id,
    windowId = tab.windowId,
    overlay = 'frameleaf-area-' + crypto.randomUUID();
  let changed = false;
  let documentId: string | undefined;
  const activated = (info: chrome.tabs.OnActivatedInfo) => {
    if (info.windowId === windowId && info.tabId !== tabId) abort();
  };
  const updated = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
    if (id === tabId && (info.url || info.status === 'loading')) abort();
  };
  const focused = (id: number) => {
    if (id !== windowId) abort();
  };
  const remove = () => {
    if (mode === 'area')
      void chrome.scripting
        .executeScript({
          target: { tabId, ...(documentId && { documentIds: [documentId] }) },
          world: 'ISOLATED',
          args: [overlay],
          func: (id: string) => document.getElementById(id)?.remove(),
        })
        .catch(() => {});
  };
  const abort = () => {
    if (changed) return;
    changed = true;
    lifetime.abort();
    remove();
  };
  chrome.tabs.onActivated.addListener(activated);
  chrome.tabs.onUpdated.addListener(updated);
  chrome.windows.onFocusChanged.addListener(focused);
  signal.addEventListener('abort', abort, { once: true });
  const active = async () => {
    const [now] = await within(
      chrome.tabs.query({ active: true, lastFocusedWindow: true }),
      signal,
    );
    if (
      changed ||
      signal.aborted ||
      now?.id !== tabId ||
      now.windowId !== windowId ||
      !(await within(chrome.windows.get(windowId), signal)).focused
    )
      throw fail();
  };
  try {
    await active();
    const before = await readFrame(tabId, overlay, signal);
    documentId = before.documentId;
    if (before.url !== tab.url) throw fail();
    let selection: Rectangle | undefined;
    if (mode === 'area') {
      const [area] = await within(
        chrome.scripting.executeScript({
          target: { tabId, documentIds: [documentId] },
          world: 'ISOLATED',
          func: selectScreenshotArea,
          args: [overlay],
        }),
        signal,
        65000,
      );
      if (area?.documentId !== documentId || area.frameId !== 0) throw fail();
      if (changed || signal.aborted) throw fail();
      if (area.result === null) return null;
      selection = area.result;
      if (!selection) throw fail();
      cropRectangle(
        { width: before.width, height: before.height },
        before,
        selection,
      );
    }
    const same = (after: Awaited<ReturnType<typeof readFrame>>) => {
      for (const key of [
        'documentId',
        'url',
        'width',
        'height',
        'scrollX',
        'scrollY',
        'scale',
        'left',
        'top',
      ] as const)
        if (after[key] !== before[key]) throw fail();
    };
    same(await readFrame(tabId, overlay, signal, documentId));
    await active();
    const dataUrl = await within(
      chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
      signal,
    );
    same(await readFrame(tabId, overlay, signal, documentId));
    await active();
    if (
      typeof dataUrl !== 'string' ||
      !dataUrl.startsWith('data:image/png;base64,') ||
      dataUrl.length > Math.ceil(maxScreenshotBytes / 3) * 4 + 64
    )
      throw fail();
    return {
      discovery: {
        tabId,
        documentId,
        ...parseDiscovery(
          { documentUrl: tab.url, title: before.title, candidates: [] },
          tab.url,
        ),
      },
      screenshot: {
        mode,
        dataUrl,
        viewport: { width: before.width, height: before.height },
        ...(selection && { selection }),
      },
    };
  } catch {
    throw fail();
  } finally {
    signal.removeEventListener('abort', abort);
    chrome.tabs.onActivated.removeListener(activated);
    chrome.tabs.onUpdated.removeListener(updated);
    chrome.windows.onFocusChanged.removeListener(focused);
    remove();
  }
}
