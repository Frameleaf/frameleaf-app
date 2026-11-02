import { describe, expect, it, vi } from 'vitest';
import {
  WHOLE_PAGE_LIMIT,
  WHOLE_PAGE_MAX_PIXELS,
  WHOLE_PAGE_MAX_SIDE,
  WholePageCancelled,
  WholePageFailure,
  blobToDataUrl,
  captureWholePage,
  checkPageState,
  chooseHiddenBars,
  fallbackMessage,
  frameDraw,
  isWholePageInfo,
  planWholePage,
  wholePageCaption,
  wholePageFilename,
  withCutNote,
  type FrameDraw,
  type PageState,
  type WholePageDriver,
} from './whole-page';
import { parsePageState } from './whole-page-capture';

const page = (overrides: Partial<PageState> = {}): PageState => ({
  url: 'https://page.example/',
  title: 'Page',
  innerWidth: 1455,
  innerHeight: 900,
  clientWidth: 1440,
  clientHeight: 900,
  pageHeight: 6820,
  scrollY: 0,
  pixelRatio: 1,
  zoom: 1,
  panel: false,
  cancelled: false,
  ...overrides,
});

describe('planning the screens', () => {
  it('splits a page into screens and ends exactly at the bottom', () => {
    const plan = planWholePage({
      pageHeight: 6820,
      viewportWidth: 1440,
      viewportHeight: 900,
      pixelRatio: 1,
    });
    expect(plan).toMatchObject({
      width: 1440,
      height: 6820,
      cut: false,
      missing: 0,
      outputWidth: 1440,
      outputHeight: 6820,
    });
    expect(plan.steps).toEqual([0, 900, 1800, 2700, 3600, 4500, 5400, 5920]);
  });
  it('captures a page shorter than the window as one screen', () => {
    const plan = planWholePage({
      pageHeight: 400,
      viewportWidth: 1000,
      viewportHeight: 800,
      pixelRatio: 2,
    });
    expect(plan.steps).toEqual([0]);
    expect(plan.height).toBe(800);
    expect(plan.outputHeight).toBe(1600);
  });
  it('cuts a taller page at 30,000 px and says how much is missing', () => {
    const plan = planWholePage({
      pageHeight: 41300,
      viewportWidth: 1440,
      viewportHeight: 900,
      pixelRatio: 1,
    });
    expect(plan.cut).toBe(true);
    expect(plan.height).toBe(WHOLE_PAGE_LIMIT);
    expect(plan.missing).toBe(11300);
    expect(plan.steps).toHaveLength(34);
    // The page goes on, so the last screen is a full step, not pulled back.
    expect(plan.steps.at(-1)).toBe(33 * 900);
  });
  it('is not cut at exactly the limit', () => {
    const plan = planWholePage({
      pageHeight: WHOLE_PAGE_LIMIT,
      viewportWidth: 1000,
      viewportHeight: 1000,
      pixelRatio: 1,
    });
    expect(plan.cut).toBe(false);
    expect(plan.steps).toHaveLength(30);
  });
  it('makes a sharp, tall picture smaller to fit the canvas and pixel limits', () => {
    const plan = planWholePage({
      pageHeight: 41300,
      viewportWidth: 1440,
      viewportHeight: 900,
      pixelRatio: 2,
    });
    expect(plan.outputScale).toBeLessThan(2);
    expect(plan.outputHeight).toBeLessThanOrEqual(WHOLE_PAGE_MAX_SIDE);
    expect(plan.outputWidth * plan.outputHeight).toBeLessThanOrEqual(
      WHOLE_PAGE_MAX_PIXELS + plan.outputWidth + plan.outputHeight,
    );
    const short = planWholePage({
      pageHeight: 3000,
      viewportWidth: 1280,
      viewportHeight: 720,
      pixelRatio: 2,
    });
    expect(short.outputScale).toBe(2);
  });
  it('rejects measurements it cannot trust', () => {
    for (const input of [
      { pageHeight: NaN, viewportWidth: 1, viewportHeight: 1, pixelRatio: 1 },
      { pageHeight: 10, viewportWidth: 0, viewportHeight: 1, pixelRatio: 1 },
      { pageHeight: 10, viewportWidth: 10, viewportHeight: 10, pixelRatio: 0 },
      {
        pageHeight: 10,
        viewportWidth: 40000,
        viewportHeight: 10,
        pixelRatio: 1,
      },
    ])
      expect(() => planWholePage(input)).toThrow(WholePageFailure);
  });
});

describe('joining the screens', () => {
  const plan = planWholePage({
    pageHeight: 2000,
    viewportWidth: 1000,
    viewportHeight: 800,
    pixelRatio: 2,
  });
  const frame = { width: 2030, height: 1600 };
  it('places each screen in its own band, overlapping the last one', () => {
    expect(plan.steps).toEqual([0, 800, 1200]);
    const draws = plan.steps.map((y, index) =>
      frameDraw(plan, index, y, frame),
    );
    expect(draws[0]).toEqual({
      sx: 0,
      sy: 0,
      sw: 2000,
      sh: 1600,
      dx: 0,
      dy: 0,
      dw: 2000,
      dh: 1600,
    });
    // The last screen could only scroll to 1200, so it starts 400 px into the frame.
    expect(draws[2]).toMatchObject({ sy: 800, sh: 800, dy: 3200, dh: 800 });
    // The bands cover the picture once, with no gaps.
    let bottom = 0;
    for (const draw of draws) {
      expect(draw.dy).toBe(bottom);
      bottom = draw.dy + draw.dh;
    }
    expect(bottom).toBe(plan.outputHeight);
  });
  it('leaves the scroll bar out of the picture', () => {
    expect(frameDraw(plan, 0, 0, frame).sw).toBe(2000);
  });
  it('fails when the page did not scroll where it was asked', () => {
    expect(() => frameDraw(plan, 1, 0, frame)).toThrow(WholePageFailure);
    expect(() => frameDraw(plan, 1, 900, frame)).toThrow(WholePageFailure);
    expect(() => frameDraw(plan, 3, 1200, frame)).toThrow(WholePageFailure);
    try {
      frameDraw(plan, 1, 0, frame);
    } catch (error) {
      expect((error as WholePageFailure).reason).toBe('scroll');
    }
  });
  it('tolerates sub-pixel scroll positions', () => {
    expect(() => frameDraw(plan, 1, 800.4, frame)).not.toThrow();
  });
});

describe('bars that stay on screen', () => {
  it('hides fixed bars and sticky ones seen on the first screen', () => {
    expect(
      chooseHiddenBars(
        [
          { position: 'fixed', top: 0, bottom: 60, width: 1000, height: 60 },
          { position: 'sticky', top: 60, bottom: 100, width: 1000, height: 40 },
          {
            position: 'sticky',
            top: 2400,
            bottom: 2440,
            width: 1000,
            height: 40,
          },
          { position: 'fixed', top: 0, bottom: 0, width: 0, height: 0 },
          { position: 'fixed', top: 820, bottom: 900, width: 300, height: 80 },
        ],
        900,
      ),
    ).toEqual([0, 1, 4]);
  });
});

describe('page checks', () => {
  it('fails honestly when the page grows, resizes, zooms or is cancelled', () => {
    const first = page();
    expect(() => checkPageState(first, page({ scrollY: 900 }))).not.toThrow();
    const reason = (now: PageState) => {
      try {
        checkPageState(first, now);
      } catch (error) {
        return error instanceof WholePageFailure ? error.reason : 'cancelled';
      }
    };
    expect(reason(page({ pageHeight: 9000 }))).toBe('grows');
    expect(reason(page({ clientWidth: 1200 }))).toBe('resized');
    expect(reason(page({ pixelRatio: 2 }))).toBe('resized');
    expect(reason(page({ zoom: 0 }))).toBe('resized');
    expect(reason(page({ cancelled: true }))).toBe('cancelled');
  });
  it('parses what the page sends and refuses anything else', () => {
    expect(parsePageState(page())).toMatchObject({ clientWidth: 1440 });
    expect(() => parsePageState({ cancelled: true })).toThrow(
      WholePageCancelled,
    );
    for (const value of [
      null,
      'x',
      { ...page(), innerWidth: 'wide' },
      { ...page(), clientHeight: 0 },
      { ...page(), candidates: 'many' },
    ])
      expect(() => parsePageState(value)).toThrow(WholePageFailure);
    expect(
      parsePageState({
        ...page(),
        candidates: [{ position: 'absolute', top: 'x' }],
      }).candidates,
    ).toEqual([{ position: 'sticky', top: 0, bottom: 0, width: 0, height: 0 }]);
  });
  it('offers the other screenshots in plain words', () => {
    expect(fallbackMessage('grows')).toBe(
      'It keeps loading more as you scroll, so it has no end to capture to. You can save what you can see, or select an area, instead.',
    );
  });
});

class FakeFrame {
  closed = false;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  close() {
    this.closed = true;
  }
}
function fakePage(
  options: {
    pageHeight?: number;
    growAt?: number;
    cancelAt?: number;
    stuckAt?: number;
    failCaptureAt?: number;
    bars?: boolean;
  } = {},
) {
  const log: string[] = [];
  const frames: FakeFrame[] = [];
  let scrollY = 300;
  let pageHeight = options.pageHeight ?? 2000;
  let steps = 0;
  let captures = 0;
  const state = (extra: Partial<PageState> = {}) =>
    page({
      innerWidth: 1000,
      clientWidth: 1000,
      clientHeight: 800,
      innerHeight: 800,
      pageHeight,
      scrollY,
      ...extra,
    });
  const driver: WholePageDriver<FakeFrame> = {
    start: async () => {
      log.push('start');
      return state();
    },
    step: async (y, screen, total, hide, scan) => {
      steps++;
      log.push(`step ${screen}/${total}${hide ? ` hide ${hide}` : ''}`);
      if (steps === options.growAt) pageHeight += 500;
      if (steps !== options.stuckAt) scrollY = y;
      return state({
        cancelled: steps === options.cancelAt,
        ...(scan && {
          candidates: options.bars
            ? [
                {
                  position: 'fixed',
                  top: 0,
                  bottom: 50,
                  width: 1000,
                  height: 50,
                },
              ]
            : [],
        }),
      });
    },
    prepare: async () => {
      log.push('prepare');
      return state();
    },
    capture: async () => {
      captures++;
      log.push('capture');
      if (captures === options.failCaptureAt) throw new Error('quota');
      const frame = new FakeFrame(1000, 800);
      frames.push(frame);
      return frame;
    },
    restore: vi.fn(async () => {
      log.push('restore');
      scrollY = 300;
    }),
  };
  const drawn: FrameDraw[] = [];
  const stitcher = {
    draw: (_frame: FakeFrame, at: FrameDraw) => void drawn.push(at),
    finish: vi.fn(async () => {
      log.push('finish');
      return new Blob(['png'], { type: 'image/png' });
    }),
    discard: vi.fn(),
  };
  return {
    driver,
    stitcher,
    log,
    frames,
    drawn,
    scroll: () => scrollY,
  };
}

describe('capturing and restoring', () => {
  const signal = () => new AbortController().signal;
  it('joins every screen, hides bars after the first, then restores before encoding', async () => {
    const fake = fakePage({ bars: true });
    const result = await captureWholePage(
      fake.driver,
      () => fake.stitcher,
      signal(),
    );
    expect(result.plan.steps).toEqual([0, 800, 1200]);
    expect(result.keptBars).toBe(true);
    expect(fake.log).toEqual([
      'start',
      'step 1/3',
      'prepare',
      'capture',
      'step 2/3 hide 0',
      'prepare',
      'capture',
      'step 3/3',
      'prepare',
      'capture',
      'restore',
      'finish',
    ]);
    expect(fake.frames.every((frame) => frame.closed)).toBe(true);
    expect(fake.drawn).toHaveLength(3);
    expect(fake.driver.restore).toHaveBeenCalledTimes(1);
    expect(fake.scroll()).toBe(300);
  });
  it.each([
    ['the page grows', { growAt: 2 }, 'grows'],
    ['scrolling is blocked', { stuckAt: 2 }, 'scroll'],
    ['a capture fails', { failCaptureAt: 2 }, 'capture'],
  ] as const)(
    'restores the page and fails when %s',
    async (_name, options, reason) => {
      const fake = fakePage(options);
      const error = await captureWholePage(
        fake.driver,
        () => fake.stitcher,
        signal(),
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(WholePageFailure);
      expect((error as WholePageFailure).reason).toBe(reason);
      expect(fake.driver.restore).toHaveBeenCalledTimes(1);
      expect(fake.stitcher.discard).toHaveBeenCalled();
      expect(fake.stitcher.finish).not.toHaveBeenCalled();
      expect(fake.scroll()).toBe(300);
      expect(fake.frames.every((frame) => frame.closed)).toBe(true);
    },
  );
  it('reads sharpness from the first capture and fails when later ones change size', async () => {
    const fake = fakePage();
    let count = 0;
    fake.driver.capture = async () => {
      count++;
      const frame = new FakeFrame(
        count === 1 ? 2000 : 1000,
        count === 1 ? 1600 : 800,
      );
      fake.frames.push(frame);
      return frame;
    };
    const error = await captureWholePage(
      fake.driver,
      () => fake.stitcher,
      signal(),
    ).catch((value: unknown) => value);
    expect((error as WholePageFailure).reason).toBe('resized');
    expect(fake.drawn[0]).toMatchObject({ sw: 2000, sh: 1600, dh: 1600 });
    expect(fake.driver.restore).toHaveBeenCalledTimes(1);
  });
  it('restores the page when cancelled from the page', async () => {
    const fake = fakePage({ cancelAt: 2 });
    await expect(
      captureWholePage(fake.driver, () => fake.stitcher, signal()),
    ).rejects.toBeInstanceOf(WholePageCancelled);
    expect(fake.driver.restore).toHaveBeenCalledTimes(1);
    expect(fake.log).not.toContain('finish');
  });
  it('restores the page when the extension stops the capture', async () => {
    const fake = fakePage();
    const controller = new AbortController();
    const capture = fake.driver.capture;
    fake.driver.capture = async () => {
      const frame = await capture();
      controller.abort();
      return frame;
    };
    await expect(
      captureWholePage(fake.driver, () => fake.stitcher, controller.signal),
    ).rejects.toBeInstanceOf(WholePageCancelled);
    expect(fake.driver.restore).toHaveBeenCalledTimes(1);
    expect(fake.frames.every((frame) => frame.closed)).toBe(true);
  });
  it('still restores when restoring itself fails, and when the page measures oddly at the start', async () => {
    const fake = fakePage();
    fake.driver.restore = vi.fn().mockRejectedValue(new Error('gone'));
    fake.driver.start = async () =>
      page({ panel: true, pageHeight: 800, clientHeight: 800 });
    const error = await captureWholePage(
      fake.driver,
      () => fake.stitcher,
      signal(),
    ).catch((value: unknown) => value);
    expect((error as WholePageFailure).reason).toBe('panel');
    expect(fake.driver.restore).toHaveBeenCalledTimes(1);
  });
});

describe('labels', () => {
  const info = {
    width: 1440,
    height: 6820,
    pageHeight: 6820,
    cut: false,
    screens: 8,
    keptBars: true,
    reduced: false,
  };
  const cut = { ...info, height: 30000, pageHeight: 41300, cut: true };
  it('calls a whole page whole and a cut page cut short, never complete', () => {
    expect(wholePageCaption(info)).toBe('Whole page · 1,440 × 6,820 · PNG');
    expect(wholePageCaption(cut)).toBe(
      'Cut short · 1,440 × 30,000 of 41,300 px · PNG',
    );
    expect(wholePageFilename(cut, 'alpinelodge.example')).toBe(
      'Screenshot, cut short at 30,000 px · alpinelodge.example.png',
    );
    expect(wholePageFilename(info, 'alpinelodge.example')).toBe(
      'Screenshot, whole page · alpinelodge.example.png',
    );
    expect(wholePageCaption(cut)).not.toMatch(/whole|complete/i);
    expect(wholePageFilename(cut, 'a')).not.toMatch(/whole|complete/i);
  });
  it('adds where it stops to the note of a cut picture only', () => {
    expect(withCutNote('Mine', info)).toBe('Mine');
    expect(withCutNote('Mine', cut)).toBe(
      'Mine\n\nCut short at 30,000 px. The page goes on for another 11,300 px.',
    );
    expect(withCutNote('', cut)).toMatch(/^Cut short/);
    expect(withCutNote('x'.repeat(10000), cut).length).toBeLessThanOrEqual(
      10000,
    );
  });
  it('refuses a picture that claims to be whole but is taller than the limit', () => {
    expect(isWholePageInfo(info)).toBe(true);
    expect(isWholePageInfo(cut)).toBe(true);
    expect(isWholePageInfo({ ...cut, cut: false })).toBe(false);
    expect(isWholePageInfo({ ...info, height: 40000, pageHeight: 40000 })).toBe(
      false,
    );
    expect(isWholePageInfo(null)).toBe(false);
  });
  it('encodes a data URL', async () => {
    expect(
      await blobToDataUrl(new Blob(['bytes'], { type: 'image/png' })),
    ).toBe('data:image/png;base64,Ynl0ZXM=');
  });
});
