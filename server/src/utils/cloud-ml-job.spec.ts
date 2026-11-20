import {
  cloudDeclaredFps,
  cloudSmoothMotionFactor,
  cloudVideoClip,
  cloudVideoClipRefusal,
  cloudVideoRequest,
  cloudVideoSettingsRefusal,
  isPlainVideoStream,
  isUnevenCadence,
} from 'src/utils/cloud-ml-job.js';
import { estimateRequestSchema } from 'src/utils/frameleaf-cloud.js';

/** Frameleaf Cloud's own count (`packages/contracts/src/ml/restoration.ts` `framesOf`): rounded half up. */
const cloudFrames = (seconds: number, fps: number) => Math.floor(seconds * fps + 0.5);

const stream = (over: Record<string, unknown> = {}) => ({
  width: 1920,
  height: 1080,
  frameCount: 150,
  frameRate: 30,
  frameRateRational: { num: 30, den: 1 },
  ...over,
});

describe('the clip a Frameleaf Cloud video request describes (FL-1725)', () => {
  it.each([
    [150, { num: 30, den: 1 }],
    [149, { num: 30_000, den: 1001 }],
    [120, { num: 24_000, den: 1001 }],
    [7, { num: 60_000, den: 1001 }],
    [1, { num: 25, den: 1 }],
    [431_568, { num: 24_000, den: 1001 }],
  ])('declares a length the cloud counts back to the same %i frames', (frameCount, frameRateRational) => {
    const clip = cloudVideoClip('v1', stream({ frameCount, frameRateRational }))!;
    // the worker takes exactly this count, or one more
    expect(cloudFrames(clip.durationSec, clip.fps)).toBe(frameCount);
    expect(clip.fps).toBeCloseTo(frameRateRational.num / frameRateRational.den, 9);
  });

  it("declares the stream's own width, not the display width of non-square pixels", () => {
    expect(cloudVideoClip('v1', stream({ width: 1920, codedWidth: 1440 }))).toMatchObject({
      width: 1440,
      height: 1080,
    });
    expect(cloudVideoClip('v1', stream())).toMatchObject({ width: 1920 });
  });

  it('uses the float rate when the probe kept no fraction', () => {
    expect(cloudVideoClip('v1', stream({ frameRateRational: null, frameRate: 25, frameCount: 50 }))).toEqual({
      inputId: 'v1',
      durationSec: 2,
      fps: 25,
      width: 1920,
      height: 1080,
    });
  });

  it.each([
    [undefined],
    [stream({ frameCount: 0 })],
    [stream({ frameCount: NaN })],
    [stream({ frameRate: null, frameRateRational: null })],
    [stream({ frameRate: 0, frameRateRational: { num: 0, den: 0 } })],
  ])('has nothing to declare without a frame count and a rate', (probed) => {
    expect(cloudVideoClip('v1', probed as never)).toBeNull();
  });
});

describe('what Frameleaf Cloud does not run, said before anything is sent (FL-1725)', () => {
  const clip = { inputId: 'v1', durationSec: 5, fps: 30, width: 1920, height: 1080 };

  it('takes restoration at 2 and Smooth motion at 2 or 4', () => {
    expect(cloudVideoSettingsRefusal('restoration', { upscale: 2, factor: null })).toBeNull();
    expect(cloudVideoSettingsRefusal('interpolation', { upscale: 1, factor: 2 })).toBeNull();
    expect(cloudVideoSettingsRefusal('interpolation', { upscale: 1, factor: 4 })).toBeNull();
    expect(cloudVideoSettingsRefusal('interpolation', { upscale: 1, factor: null })).toBeNull();
  });

  it('names video restoration at 4 and Smooth motion at 8', () => {
    expect(cloudVideoSettingsRefusal('restoration', { upscale: 4, factor: null })).toBe(
      'Frameleaf Cloud restores video at up to 2×. Choose 2×.',
    );
    expect(cloudVideoSettingsRefusal('interpolation', { upscale: 1, factor: 8 })).toBe(
      'Frameleaf Cloud smooths motion 2× or 4×. Choose one of those.',
    );
  });

  it("offers no more than the chosen model's catalogue limits", () => {
    expect(cloudVideoSettingsRefusal('interpolation', { upscale: 1, factor: 4 }, { maxFactor: 2 })).toBe(
      'Frameleaf Cloud smooths motion 2×. Choose that.',
    );
    expect(cloudVideoSettingsRefusal('interpolation', { upscale: 1, factor: 4 }, { maxFactor: 4 })).toBeNull();
    expect(cloudVideoSettingsRefusal('restoration', { upscale: 2, factor: null }, { maxScale: 1 })).toBe(
      'Frameleaf Cloud restores video at up to 1×. Choose 1×.',
    );
    // a limit above the contract's never widens what is sent
    expect(cloudVideoSettingsRefusal('restoration', { upscale: 4, factor: null }, { maxScale: 4 })).not.toBeNull();
    expect(cloudVideoSettingsRefusal('interpolation', { upscale: 1, factor: 8 }, { maxFactor: 8 })).not.toBeNull();
  });

  it("names a clip outside the cloud's frame rate, size or length", () => {
    expect(cloudVideoClipRefusal('restoration', clip)).toBeNull();
    expect(cloudVideoClipRefusal('restoration', { ...clip, width: 7680, height: 4320 })).toBeNull();
    expect(cloudVideoClipRefusal('interpolation', { ...clip, fps: 240 })).toContain('1 to 120 frames a second');
    expect(cloudVideoClipRefusal('interpolation', { ...clip, width: 7680, height: 4320 })).toContain('3840×2160');
    expect(cloudVideoClipRefusal('restoration', { ...clip, width: 8192 })).toContain('7680×4320');
    expect(cloudVideoClipRefusal('restoration', { ...clip, durationSec: 21_601 })).toContain('6 hours');
  });

  it('refuses exactly what the request schema would', () => {
    const body = (workload: 'restoration' | 'interpolation', described: typeof clip) => ({
      workload,
      modelSku: 'ms_HQ70Q4XQ',
      inputs: [{ inputId: 'v1', contentType: 'video/mp4', bytes: 1, sha256: 'a'.repeat(64) }],
      request: cloudVideoRequest(workload, described, { creative: false, upscale: 2, factor: 2 }),
    });
    for (const workload of ['restoration', 'interpolation'] as const) {
      for (const described of [
        clip,
        { ...clip, fps: 120 },
        { ...clip, fps: 120.01 },
        { ...clip, fps: 0.5 },
        { ...clip, width: 3840, height: 2160 },
        { ...clip, width: 3842, height: 2160 },
        { ...clip, width: 7680, height: 4320 },
        { ...clip, width: 7682, height: 4320 },
        { ...clip, width: 8, height: 8 },
        { ...clip, durationSec: 21_600 },
        { ...clip, durationSec: 21_600.5 },
      ]) {
        const accepted = estimateRequestSchema.safeParse(body(workload, described)).success;
        // the factor rule is the gateway's, not the schema's: 2× of these rates fits, or the rate is refused anyway
        const refused = cloudVideoClipRefusal(workload, described, workload === 'interpolation' ? 2 : null) !== null;
        const overSixty = workload === 'interpolation' && described.fps > 60 && described.fps <= 120;
        expect(refused, `${workload} ${JSON.stringify(described)}`).toBe(!accepted || overSixty);
      }
    }
  });
});

describe('the Smooth motion factor Frameleaf Cloud really gives (FL-1725)', () => {
  /** Frameleaf Cloud's `interpolationFactor` (`packages/contracts/src/ml/workloads.ts`), with no `targetFps`. */
  const cloudFactor = (fps: number, factor: 2 | 4) => {
    for (const f of factor === 4 ? [4, 2] : [2]) {
      if (fps * f <= 120 + 1e-9) {
        return f;
      }
    }
    return null;
  };
  const clip = { inputId: 'v1', durationSec: 5, fps: 30, width: 1920, height: 1080 };

  it("gives the cloud's own answer at every rate", () => {
    for (const fps of [
      1, 23.976, 24, 25, 29.97, 30, 30.0000000001, 47.952, 50, 59.94, 60, 60.00000001, 90, 100, 119.88, 120,
    ]) {
      for (const factor of [2, 4] as const) {
        expect(cloudSmoothMotionFactor(fps, factor), `${fps} ${factor}`).toBe(cloudFactor(fps, factor));
      }
    }
  });

  it('sends only a factor the cloud will run as asked', () => {
    expect(cloudVideoClipRefusal('interpolation', clip, 4)).toBeNull();
    expect(cloudVideoClipRefusal('interpolation', { ...clip, fps: 60 }, 2)).toBeNull();
    expect(cloudVideoClipRefusal('interpolation', { ...clip, fps: 50 }, 4)).toBe(
      'This video has 50 frames a second, so 4× would pass 120 frames a second. Choose 2×.',
    );
    expect(cloudVideoClipRefusal('interpolation', { ...clip, fps: 100 }, 2)).toBe(
      'This video has 100 frames a second. Frameleaf Cloud smooths motion up to 120 frames a second, so there is nothing it can add.',
    );
    expect(cloudVideoClipRefusal('interpolation', { ...clip, fps: 100 }, 4)).toContain('nothing it can add');
    // a restoration has no factor: its rate is only bounded
    expect(cloudVideoClipRefusal('restoration', { ...clip, fps: 100 })).toBeNull();
  });
});

describe('the frame rate declared to Frameleaf Cloud (FL-1725)', () => {
  it("is the limit itself for a rate within the worker's 0.01 over it", () => {
    expect(cloudDeclaredFps(30.0003, 4)).toBe(30);
    expect(cloudDeclaredFps(60.0001, 2)).toBe(60);
    expect(cloudDeclaredFps(30.009, 4)).toBe(30);
    expect(cloudDeclaredFps(120.004)).toBe(120);
    expect(cloudDeclaredFps(120.004, 2)).toBe(120);
  });

  it('is the measured rate otherwise', () => {
    expect(cloudDeclaredFps(30.011, 4)).toBe(30.011);
    expect(cloudDeclaredFps(29.97, 4)).toBe(29.97);
    expect(cloudDeclaredFps(30, 4)).toBe(30);
    expect(cloudDeclaredFps(30.0003, 2)).toBe(30.0003);
    expect(cloudDeclaredFps(30.0003)).toBe(30.0003);
    expect(cloudDeclaredFps(120.02)).toBe(120.02);
  });

  it('keeps the declared length counting back to the same frames, and sends the job', () => {
    const clip = cloudVideoClip(
      'v1',
      {
        width: 1920,
        height: 1080,
        frameCount: 900,
        frameRate: 30.0003,
        frameRateRational: { num: 300_003, den: 10_000 },
      },
      4,
    )!;
    expect(clip).toMatchObject({ fps: 30, durationSec: 30 });
    expect(Math.floor(clip.durationSec * clip.fps + 0.5)).toBe(900);
    expect(cloudVideoClipRefusal('interpolation', clip, 4)).toBeNull();
  });

  it('names a rate that is really over, to three decimals', () => {
    const clip = { inputId: 'v1', durationSec: 5, fps: 30.02, width: 1920, height: 1080 };
    expect(cloudVideoClipRefusal('interpolation', clip, 4)).toBe(
      'This video has 30.02 frames a second, so 4× would pass 120 frames a second. Choose 2×.',
    );
  });
});

describe('frames off an even grid (FL-1725)', () => {
  /** Presentation times from per-frame durations, starting at `start`. */
  const times = (durations: number[], start = 0) => {
    const pts: number[] = [];
    let at = start;
    for (const duration of durations) {
      pts.push(at);
      at += duration;
    }
    return pts;
  };
  /** Frameleaf Cloud's own test (`check_clip`): every frame within one frame period of the grid. */
  const cloudRefuses = (pts: number[]) => {
    const sorted = pts.toSorted((a, b) => a - b);
    const step = (sorted.at(-1)! - sorted[0]) / (sorted.length - 1);
    return sorted.some((time, index) => Math.abs(time - (sorted[0] + index * step)) > step);
  };

  it.each([
    ['one frame rate', times(Array.from({ length: 300 }, () => 512))],
    ['30 frames a second in milliseconds', times(Array.from({ length: 300 }, (_, i) => (i % 3 === 2 ? 34 : 33)))],
    [
      '29.97 frames a second in 1/90000',
      times(
        Array.from({ length: 300 }, () => 3003),
        1001,
      ),
    ],
    ['frames in decode order', [0, 1536, 512, 1024, 3072, 2048, 2560]],
  ])('is not %s', (_, pts) => {
    expect(isUnevenCadence(pts)).toBe(false);
  });

  it.each([
    [
      '30 then 25 frames a second in 1/12000',
      times([...Array.from({ length: 30 }, () => 400), ...Array.from({ length: 30 }, () => 480)]),
    ],
    [
      'every third frame dropped',
      times([...Array.from({ length: 30 }, () => 512), ...Array.from({ length: 30 }, () => 1536)]),
    ],
    [
      '1× then 1.4× durations',
      times([...Array.from({ length: 50 }, () => 100), ...Array.from({ length: 50 }, () => 140)]),
    ],
    // within 2% of each other frame to frame, yet many frames off the grid over a long clip
    [
      'a rate that drifts by 2%',
      times([...Array.from({ length: 1000 }, () => 1000), ...Array.from({ length: 1000 }, () => 1020)]),
    ],
    ['all frames at one time', [5, 5, 5]],
  ])('is %s', (_, pts) => {
    expect(isUnevenCadence(pts)).toBe(true);
  });

  it("is never looser than the cloud's test", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    for (let run = 0; run < 500; run++) {
      const pts = times(
        Array.from({ length: 20 + Math.floor(random() * 200) }, () => 500 + Math.floor(random() * 400 * random())),
      );
      if (!isUnevenCadence(pts)) {
        expect(cloudRefuses(pts)).toBe(false);
      }
    }
  });
});

describe('a stream that can be uploaded as it is (FL-1725)', () => {
  it('is one with no rotation and no hidden packets', () => {
    expect(isPlainVideoStream({ rotation: 0 }, { packets: 10, hidden: 0 })).toBe(true);
    expect(isPlainVideoStream({ rotation: NaN }, { packets: 10, hidden: 0 })).toBe(true);
    expect(isPlainVideoStream({ rotation: 360 }, { packets: 10, hidden: 0 })).toBe(true);
    for (const rotation of [90, -90, 180, 270]) {
      expect(isPlainVideoStream({ rotation }, { packets: 10, hidden: 0 })).toBe(false);
    }
    expect(isPlainVideoStream({ rotation: 0 }, { packets: 10, hidden: 1 })).toBe(false);
    expect(isPlainVideoStream({ rotation: 0 }, { packets: 10, hidden: 0, uneven: true })).toBe(false);
    expect(isPlainVideoStream({ rotation: 0 }, { packets: 0, hidden: 0 })).toBe(false);
    expect(isPlainVideoStream(undefined, { packets: 10, hidden: 0 })).toBe(false);
  });
});

describe('the request of a Frameleaf Cloud video job (FL-1725)', () => {
  const clip = { inputId: 'v1', durationSec: 5, fps: 30, width: 1920, height: 1080 };

  it('sends targetScale and the clip for a restoration, never scale', () => {
    expect(cloudVideoRequest('restoration', clip, { creative: true, upscale: 2, factor: null })).toEqual({
      mode: 'creative',
      targetScale: 2,
      items: [clip],
    });
  });

  it('sends the factor and the clip for Smooth motion', () => {
    expect(cloudVideoRequest('interpolation', clip, { creative: false, upscale: 1, factor: 4 })).toEqual({
      factor: 4,
      items: [clip],
    });
    expect(cloudVideoRequest('interpolation', clip, { creative: false, upscale: 1, factor: null })).toMatchObject({
      factor: 2,
    });
  });
});
