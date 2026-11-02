import {
  captureVisible,
  readPngSize,
  ScreenshotFailure,
  within,
  type ScreenshotPreview,
} from './capture';
import { parseDiscovery, type PageDiscovery } from './discovery';
import {
  offerWholePageFallback,
  wholePagePrepare,
  wholePageRestore,
  wholePageStart,
  wholePageStep,
} from './whole-page-content';
import {
  blobToDataUrl,
  captureWholePage,
  fallbackMessage,
  WHOLE_PAGE_MAX_BYTES,
  WHOLE_PAGE_MAX_PIXELS,
  WHOLE_PAGE_MAX_SIDE,
  WholePageCancelled,
  WholePageFailure,
  type BarCandidate,
  type PageState,
  type Stitcher,
  type WholePageInfo,
  type WholePagePlan,
} from './whole-page';

export type WholePageOutcome =
  | { kind: 'done'; discovery: PageDiscovery; screenshot: ScreenshotPreview }
  | { kind: 'cancelled' }
  | { kind: 'fallback'; mode: 'visible' | 'area' };

const fail = () => new ScreenshotFailure();
const numbers = [
  'innerWidth',
  'innerHeight',
  'clientWidth',
  'clientHeight',
  'pageHeight',
  'scrollY',
  'pixelRatio',
  'zoom',
] as const;

/** Checks what the page script sent back; anything unexpected means the capture can't go on. */
export function parsePageState(value: unknown): PageState {
  if (!value || typeof value !== 'object')
    throw new WholePageFailure('capture');
  const state = value as Record<string, unknown>;
  if (state.cancelled === true) throw new WholePageCancelled();
  if (
    typeof state.url !== 'string' ||
    typeof state.title !== 'string' ||
    typeof state.panel !== 'boolean' ||
    !numbers.every(
      (key) => typeof state[key] === 'number' && Number.isFinite(state[key]),
    ) ||
    (state.innerWidth as number) <= 0 ||
    (state.innerHeight as number) <= 0 ||
    (state.clientWidth as number) <= 0 ||
    (state.clientHeight as number) <= 0 ||
    (state.innerWidth as number) > 32768 ||
    (state.innerHeight as number) > 32768
  )
    throw new WholePageFailure('capture');
  let candidates: BarCandidate[] | undefined;
  if (state.candidates !== undefined) {
    if (!Array.isArray(state.candidates) || state.candidates.length > 300)
      throw new WholePageFailure('capture');
    candidates = state.candidates.map((item: unknown) => {
      const value = (item ?? {}) as Record<string, unknown>;
      const [top, bottom, width, height] = [
        value.top,
        value.bottom,
        value.width,
        value.height,
      ].map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0));
      return {
        position: value.position === 'fixed' ? 'fixed' : 'sticky',
        top,
        bottom,
        width,
        height,
      };
    });
  }
  return {
    url: state.url,
    title: state.title.slice(0, 2000),
    panel: state.panel,
    cancelled: false,
    ...(Object.fromEntries(numbers.map((key) => [key, state[key]])) as Record<
      (typeof numbers)[number],
      number
    >),
    ...(candidates && { candidates }),
  };
}

/** A whole-page PNG on its way to being saved: checked from its header before it is decoded. */
export async function checkWholeCapture(
  blob: Blob,
  info: WholePageInfo,
): Promise<Blob> {
  const size = await readPngSize(blob, WHOLE_PAGE_MAX_BYTES);
  if (
    size.width < 1 ||
    size.height < 1 ||
    size.width > WHOLE_PAGE_MAX_SIDE ||
    size.height > WHOLE_PAGE_MAX_SIDE ||
    size.width * size.height > WHOLE_PAGE_MAX_PIXELS ||
    Math.abs(size.height / size.width - info.height / info.width) >
      0.02 * (info.height / info.width) + 2 / size.width
  )
    throw fail();
  return blob;
}

function canvasStitcher(plan: WholePagePlan): Stitcher<ImageBitmap> {
  const canvas = new OffscreenCanvas(plan.outputWidth, plan.outputHeight);
  const context = canvas.getContext('2d');
  if (!context) throw new WholePageFailure('capture');
  context.imageSmoothingQuality = 'high';
  return {
    draw(frame, at) {
      context.drawImage(
        frame,
        at.sx,
        at.sy,
        at.sw,
        at.sh,
        at.dx,
        at.dy,
        at.dw,
        at.dh,
      );
    },
    async finish() {
      let blob = await canvas.convertToBlob({ type: 'image/png' });
      if (blob.size > WHOLE_PAGE_MAX_BYTES) {
        // Very busy pages make large PNGs; make the picture smaller rather than lose it.
        const factor = Math.sqrt(WHOLE_PAGE_MAX_BYTES / blob.size) * 0.85;
        const smaller = new OffscreenCanvas(
          Math.max(1, Math.round(canvas.width * factor)),
          Math.max(1, Math.round(canvas.height * factor)),
        );
        const scaled = smaller.getContext('2d');
        if (!scaled) throw new WholePageFailure('capture');
        scaled.imageSmoothingQuality = 'high';
        scaled.drawImage(canvas, 0, 0, smaller.width, smaller.height);
        canvas.width = canvas.height = 0;
        blob = await smaller.convertToBlob({ type: 'image/png' });
        smaller.width = smaller.height = 0;
        if (blob.size > WHOLE_PAGE_MAX_BYTES)
          throw new WholePageFailure('capture');
      } else canvas.width = canvas.height = 0;
      return blob;
    },
    discard() {
      canvas.width = canvas.height = 0;
    },
  };
}

/**
 * Captures the whole page of the focused tab. The popup must already be closed. When the
 * page can't be captured whole, a message on the page offers "What you can see" or "Select
 * an area" instead and the choice is returned. A tab, window or page change fails.
 */
export async function takeWholePage(
  signal: AbortSignal,
): Promise<WholePageOutcome> {
  if (signal.aborted) throw fail();
  const lifetime = new AbortController();
  const outer = signal;
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
    pageUrl = tab.url,
    key = 'frameleaf-whole-' + crypto.randomUUID(),
    offerId = 'frameleaf-whole-offer-' + crypto.randomUUID();
  let changed = false;
  let documentId: string | undefined;
  let offering = false;
  const abort = () => {
    if (changed) return;
    changed = true;
    lifetime.abort();
  };
  const activated = (info: chrome.tabs.OnActivatedInfo) => {
    if (info.windowId === windowId && info.tabId !== tabId) abort();
  };
  const updated = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
    if (id === tabId && (info.url || info.status === 'loading')) abort();
  };
  const focused = (id: number) => {
    if (id !== windowId) abort();
  };
  chrome.tabs.onActivated.addListener(activated);
  chrome.tabs.onUpdated.addListener(updated);
  chrome.windows.onFocusChanged.addListener(focused);
  const target = () => ({
    tabId,
    ...(documentId && { documentIds: [documentId] }),
  });
  async function run<A extends unknown[], R>(
    func: (...args: A) => R,
    args: A,
    timeout = 15000,
  ) {
    const [result] = await within(
      chrome.scripting.executeScript({
        target: target(),
        world: 'ISOLATED',
        func: func as (...args: unknown[]) => R,
        args,
      }),
      signal,
      timeout,
    );
    if (
      !result?.documentId ||
      result.frameId !== 0 ||
      (documentId && result.documentId !== documentId)
    )
      throw new WholePageFailure('capture');
    documentId = result.documentId;
    return result.result as unknown;
  }
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
  const cleanUp = () =>
    chrome.scripting
      .executeScript({
        target: target(),
        world: 'ISOLATED',
        func: wholePageRestore,
        args: [key],
      })
      .then(
        () => {},
        () => {},
      );
  try {
    await active();
    let result;
    try {
      result = await captureWholePage(
        {
          start: async () => {
            const first = parsePageState(await run(wholePageStart, [key]));
            if (first.url !== pageUrl) throw fail();
            return first;
          },
          step: async (y, screen, total, hide, scan) =>
            parsePageState(
              await run(wholePageStep, [key, y, screen, total, hide, scan]),
            ),
          prepare: async () =>
            parsePageState(await run(wholePagePrepare, [key])),
          capture: async () => {
            await active();
            const dataUrl = await captureVisible(windowId, signal, true);
            if (
              typeof dataUrl !== 'string' ||
              !dataUrl.startsWith('data:image/png;base64,')
            )
              throw new WholePageFailure('capture');
            const blob = await within(
              fetch(dataUrl).then((response) => response.blob()),
              signal,
            );
            const size = await readPngSize(blob);
            if (size.width * size.height > 40_000_000)
              throw new WholePageFailure('capture');
            return within(createImageBitmap(blob), signal);
          },
          restore: () => within(cleanUp(), new AbortController().signal, 5000),
        },
        canvasStitcher,
        signal,
      );
    } catch (error) {
      if (changed) throw fail();
      if (outer.aborted || error instanceof WholePageCancelled)
        return { kind: 'cancelled' };
      if (!(error instanceof WholePageFailure)) throw fail();
      await active();
      offering = true;
      const choice = await run(
        offerWholePageFallback,
        [offerId, fallbackMessage(error.reason)],
        125000,
      );
      offering = false;
      if (changed || signal.aborted) throw fail();
      return choice === 'visible' || choice === 'area'
        ? { kind: 'fallback', mode: choice }
        : { kind: 'cancelled' };
    }
    if (changed || signal.aborted) throw fail();
    const { blob, plan, first, keptBars } = result;
    const output = await readPngSize(blob, WHOLE_PAGE_MAX_BYTES);
    const whole: WholePageInfo = {
      width: plan.width,
      height: plan.height,
      pageHeight: plan.pageHeight,
      cut: plan.cut,
      screens: plan.steps.length,
      keptBars,
      reduced: output.width < Math.round(plan.width * plan.pixelRatio) - 1,
    };
    return {
      kind: 'done',
      discovery: {
        tabId,
        documentId: documentId!,
        ...parseDiscovery(
          { documentUrl: pageUrl, title: first.title, candidates: [] },
          pageUrl,
        ),
      },
      screenshot: {
        mode: 'whole',
        dataUrl: await blobToDataUrl(blob),
        viewport: { width: plan.width, height: plan.height },
        whole,
      },
    };
  } catch (error) {
    if (error instanceof ScreenshotFailure) throw error;
    throw fail();
  } finally {
    chrome.tabs.onActivated.removeListener(activated);
    chrome.tabs.onUpdated.removeListener(updated);
    chrome.windows.onFocusChanged.removeListener(focused);
    if (offering)
      void chrome.scripting
        .executeScript({
          target: target(),
          world: 'ISOLATED',
          args: [offerId],
          func: (id: string) => document.getElementById(id)?.remove(),
        })
        .catch(() => {});
    void cleanUp();
  }
}
