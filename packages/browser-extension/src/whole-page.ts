// "Whole page" screenshots: the page is scrolled one screen at a time, each screen is
// captured, and the screens are joined top to bottom. One picture is at most 30,000 CSS px
// tall; a taller page is cut there and the picture says so. It is never called complete.
// Everything here is pure so the planning, the cap, the bar handling and the restore rules
// can be tested without a browser.

export const WHOLE_PAGE_LIMIT = 30_000;
/** Largest stitched picture, in pixels. Matches the 40-million-pixel screenshot promise, with headroom for a full-width 30,000 px page. */
export const WHOLE_PAGE_MAX_PIXELS = 48_000_000;
/** Canvases can't be taller or wider than this. */
export const WHOLE_PAGE_MAX_SIDE = 32_000;
/** A whole-page PNG travels to the preview tab as a data URL, which must stay under the browser's message size limit. */
export const WHOLE_PAGE_MAX_BYTES = 40 * 1024 * 1024;
/** Chrome allows two visible-tab captures per second; leave a margin. */
export const CAPTURE_INTERVAL_MS = 550;
/** Pages with more fixed or sticky elements than this are measured only this far. */
export const MAX_BAR_CANDIDATES = 300;

export type WholePageReason =
  'grows' | 'resized' | 'scroll' | 'panel' | 'capture';

const reasons: Record<WholePageReason, string> = {
  grows: 'It keeps loading more as you scroll, so it has no end to capture to.',
  resized: 'The page or window changed size while it was being captured.',
  scroll: 'It stopped the page from scrolling, so its screens can’t be joined.',
  panel:
    'It scrolls inside a panel rather than as a whole page, so it has no end to capture to.',
  capture: 'The browser stopped taking pictures of it partway through.',
};

/** The page can't be captured whole; the user is offered "What you can see" instead. */
export class WholePageFailure extends Error {
  constructor(readonly reason: WholePageReason) {
    super(reasons[reason]);
  }
}
/** The user cancelled from the bar on the page (Cancel or Esc). */
export class WholePageCancelled extends Error {}

export const fallbackMessage = (reason: WholePageReason) =>
  `${reasons[reason]} You can save what you can see, or select an area, instead.`;

export interface WholePagePlan {
  /** CSS px of the joined picture. */
  width: number;
  height: number;
  pageHeight: number;
  viewportHeight: number;
  cut: boolean;
  /** CSS px of the page below the cut. */
  missing: number;
  /** Scroll positions, one per screen. */
  steps: number[];
  /** Image pixels per CSS px in each captured screen. */
  pixelRatio: number;
  /** Image pixels per CSS px in the joined picture; lower than pixelRatio when it had to be made smaller to fit. */
  outputScale: number;
  outputWidth: number;
  outputHeight: number;
}

const finite = (...values: number[]) => values.every(Number.isFinite);

export function planWholePage(input: {
  pageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  pixelRatio: number;
}): WholePagePlan {
  const { viewportWidth: width, viewportHeight, pixelRatio } = input;
  if (
    !finite(input.pageHeight, width, viewportHeight, pixelRatio) ||
    width < 1 ||
    viewportHeight < 1 ||
    pixelRatio <= 0 ||
    pixelRatio > 8 ||
    width > WHOLE_PAGE_MAX_SIDE
  )
    throw new WholePageFailure('capture');
  const pageHeight = Math.max(Math.ceil(input.pageHeight), viewportHeight);
  const height = Math.min(pageHeight, WHOLE_PAGE_LIMIT);
  const maxScroll = Math.max(0, pageHeight - viewportHeight);
  const screens = Math.ceil(height / viewportHeight);
  const steps = Array.from({ length: screens }, (_, k) =>
    Math.min(k * viewportHeight, maxScroll),
  );
  const outputScale = Math.min(
    pixelRatio,
    WHOLE_PAGE_MAX_SIDE / height,
    WHOLE_PAGE_MAX_SIDE / width,
    Math.sqrt(WHOLE_PAGE_MAX_PIXELS / (width * height)),
  );
  return {
    width,
    height,
    pageHeight,
    viewportHeight,
    cut: pageHeight > WHOLE_PAGE_LIMIT,
    missing: Math.max(0, pageHeight - WHOLE_PAGE_LIMIT),
    steps,
    pixelRatio,
    outputScale,
    outputWidth: Math.max(1, Math.round(width * outputScale)),
    outputHeight: Math.max(1, Math.round(height * outputScale)),
  };
}

export interface FrameDraw {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * Where screen `index`, captured with the page scrolled to `scrollY`, goes in the joined
 * picture. Each screen fills its own band, so a last screen that couldn't scroll a full
 * step overlaps the one before it rather than repeating content.
 */
export function frameDraw(
  plan: WholePagePlan,
  index: number,
  scrollY: number,
  frame: { width: number; height: number },
): FrameDraw {
  const vh = plan.viewportHeight;
  const top = index * vh;
  const bottom = Math.min(top + vh, plan.height);
  const offset = top - scrollY;
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= plan.steps.length ||
    !finite(scrollY) ||
    offset < -0.5 ||
    offset + (bottom - top) > vh + 0.5
  )
    throw new WholePageFailure('scroll');
  const r = plan.pixelRatio;
  const sy = Math.max(0, Math.round(offset * r));
  const sh = Math.min(
    frame.height - sy,
    Math.round((offset + bottom - top) * r) - sy,
  );
  const sw = Math.min(frame.width, Math.round(plan.width * r));
  const dy = Math.round(top * plan.outputScale);
  const dh =
    index === plan.steps.length - 1
      ? plan.outputHeight - dy
      : Math.round(bottom * plan.outputScale) - dy;
  if (sh < 1 || sw < 1 || dh < 1) throw new WholePageFailure('capture');
  return { sx: 0, sy, sw, sh, dx: 0, dy, dw: plan.outputWidth, dh };
}

export interface BarCandidate {
  position: string;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Bars that stay on screen are kept once, at the top: after the first screen, every fixed
 * element and every sticky element seen on the first screen is hidden until the end.
 * Sticky elements further down are left alone; they are part of the page there.
 */
export function chooseHiddenBars(
  candidates: BarCandidate[],
  viewportHeight: number,
): number[] {
  const hidden: number[] = [];
  candidates.slice(0, MAX_BAR_CANDIDATES).forEach((value, index) => {
    if (value.width <= 0 || value.height <= 0) return;
    if (value.position === 'fixed') hidden.push(index);
    else if (
      value.position === 'sticky' &&
      value.bottom > 0 &&
      value.top < viewportHeight
    )
      hidden.push(index);
  });
  return hidden;
}

/** What the page reports before each screen is captured. */
export interface PageState {
  url: string;
  title: string;
  innerWidth: number;
  innerHeight: number;
  clientWidth: number;
  clientHeight: number;
  pageHeight: number;
  scrollY: number;
  pixelRatio: number;
  zoom: number;
  /** The page's own content scrolls inside a panel rather than the page. */
  panel: boolean;
  cancelled: boolean;
  candidates?: BarCandidate[];
}

/** Fails unless the page still has the size the plan was made for. */
export function checkPageState(first: PageState, now: PageState) {
  if (now.cancelled) throw new WholePageCancelled();
  if (now.url !== first.url) throw new WholePageFailure('capture');
  if (
    now.innerWidth !== first.innerWidth ||
    now.innerHeight !== first.innerHeight ||
    now.clientWidth !== first.clientWidth ||
    now.clientHeight !== first.clientHeight ||
    now.pixelRatio !== first.pixelRatio ||
    now.zoom !== 1
  )
    throw new WholePageFailure('resized');
  if (Math.abs(now.pageHeight - first.pageHeight) > 1)
    throw new WholePageFailure('grows');
}

export interface Frame {
  width: number;
  height: number;
  close(): void;
}
export interface WholePageDriver<F extends Frame = Frame> {
  /** Shows the bar on the page and measures it. */
  start(): Promise<PageState>;
  /** Shows progress, scrolls to `y`, hides `hide` bars, and reports where it landed. */
  step(
    y: number,
    screen: number,
    total: number,
    hide: number[] | null,
    scan: boolean,
  ): Promise<PageState>;
  /** Hides the progress bar so it is left out of the picture. */
  prepare(): Promise<PageState>;
  capture(): Promise<F>;
  /** Puts the page back as it was: scroll position, hidden bars, the progress bar. Must be safe to call more than once. */
  restore(): Promise<void>;
}
export interface Stitcher<F extends Frame = Frame> {
  draw(frame: F, at: FrameDraw): void;
  finish(): Promise<Blob>;
  discard(): void;
}

export interface WholePageResult {
  blob: Blob;
  plan: WholePagePlan;
  first: PageState;
  /** Bars that stay on screen were found and kept once at the top. */
  keptBars: boolean;
}

/**
 * Captures and joins the screens. The page is always restored, whether the capture
 * finishes, fails or is cancelled, before the picture is encoded.
 */
export async function captureWholePage<F extends Frame>(
  driver: WholePageDriver<F>,
  stitcher: (plan: WholePagePlan) => Stitcher<F>,
  signal: AbortSignal,
): Promise<WholePageResult> {
  let canvas: Stitcher<F> | undefined;
  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    await driver.restore().catch(() => {});
  };
  const stop = () => {
    if (signal.aborted) throw new WholePageCancelled();
  };
  try {
    stop();
    const first = await driver.start();
    stop();
    if (first.cancelled) throw new WholePageCancelled();
    if (first.zoom !== 1) throw new WholePageFailure('capture');
    if (first.panel && first.pageHeight <= first.clientHeight + 1)
      throw new WholePageFailure('panel');
    const measure = (pixelRatio: number) =>
      planWholePage({
        pageHeight: first.pageHeight,
        viewportWidth: first.clientWidth,
        viewportHeight: first.clientHeight,
        pixelRatio,
      });
    // The screens don't depend on sharpness; the picture's pixels per CSS px are read
    // from the first capture, since it can differ from the page's devicePixelRatio.
    let plan = measure(1);
    let hide: number[] = [];
    let frameSize = { width: 0, height: 0 };
    for (const [index, y] of plan.steps.entries()) {
      const landed = await driver.step(
        y,
        index + 1,
        plan.steps.length,
        index === 1 && hide.length ? hide : null,
        index === 0,
      );
      stop();
      checkPageState(first, landed);
      if (index === 0)
        hide = chooseHiddenBars(landed.candidates ?? [], plan.viewportHeight);
      const ready = await driver.prepare();
      stop();
      checkPageState(first, ready);
      if (Math.abs(ready.scrollY - landed.scrollY) > 0.5)
        throw new WholePageFailure('scroll');
      // Validates the scroll position before spending a capture on it.
      frameDraw(plan, index, ready.scrollY, {
        width: Infinity,
        height: Infinity,
      });
      let frame: F;
      try {
        frame = await driver.capture();
      } catch (error) {
        stop();
        if (error instanceof WholePageCancelled) throw error;
        throw new WholePageFailure('capture');
      }
      try {
        stop();
        if (index === 0) {
          plan = measure(frame.width / first.innerWidth);
          frameSize = { width: frame.width, height: frame.height };
          if (Math.abs(frame.height - first.innerHeight * plan.pixelRatio) > 2)
            throw new WholePageFailure('resized');
          canvas = stitcher(plan);
        } else if (
          frame.width !== frameSize.width ||
          frame.height !== frameSize.height
        )
          throw new WholePageFailure('resized');
        canvas!.draw(frame, frameDraw(plan, index, ready.scrollY, frame));
      } finally {
        frame.close();
      }
    }
    await restore();
    stop();
    if (!canvas) throw new WholePageFailure('capture');
    const blob = await canvas.finish();
    canvas = undefined;
    return { blob, plan, first, keptBars: hide.length > 0 };
  } finally {
    canvas?.discard();
    await restore();
  }
}

const px = (value: number) => Math.round(value).toLocaleString('en-US');

export interface WholePageInfo {
  width: number;
  height: number;
  pageHeight: number;
  cut: boolean;
  screens: number;
  keptBars: boolean;
  /** The picture was made smaller than the screen's sharpness to fit. */
  reduced: boolean;
}

/** The caption under the preview. A cut picture is never called whole. */
export function wholePageCaption(info: WholePageInfo) {
  return info.cut
    ? `Cut short · ${px(info.width)} × ${px(info.height)} of ${px(info.pageHeight)} px · PNG`
    : `Whole page · ${px(info.width)} × ${px(info.height)} · PNG`;
}
/** The saved file's name, which Boards shows as the item's name. */
export function wholePageFilename(info: WholePageInfo, site: string) {
  const host = site.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 200);
  return info.cut
    ? `Screenshot, cut short at ${px(WHOLE_PAGE_LIMIT)} px · ${host}.png`
    : `Screenshot, whole page · ${host}.png`;
}
/** Added to the note of a cut picture so Boards says where it stops. */
export function wholePageCutNote(info: WholePageInfo) {
  return info.cut
    ? `Cut short at ${px(info.height)} px. The page goes on for another ${px(info.pageHeight - info.height)} px.`
    : '';
}
export function withCutNote(note: string, info: WholePageInfo) {
  const line = wholePageCutNote(info);
  if (!line) return note;
  const kept = note.trimEnd().slice(0, 10000 - line.length - 2);
  return kept ? `${kept}\n\n${line}` : line;
}

export function isWholePageInfo(value: unknown): value is WholePageInfo {
  if (!value || typeof value !== 'object') return false;
  const info = value as Record<string, unknown>;
  return (
    ['width', 'height', 'pageHeight', 'screens'].every(
      (key) =>
        typeof info[key] === 'number' &&
        Number.isFinite(info[key]) &&
        (info[key] as number) > 0,
    ) &&
    ['cut', 'keptBars', 'reduced'].every(
      (key) => typeof info[key] === 'boolean',
    ) &&
    (info.height as number) <= WHOLE_PAGE_LIMIT &&
    (info.cut as boolean) === (info.pageHeight as number) > WHOLE_PAGE_LIMIT
  );
}

/** Base64-encodes in chunks; service workers have no FileReader-free data URL helper. */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `data:${blob.type};base64,${btoa(binary)}`;
}
