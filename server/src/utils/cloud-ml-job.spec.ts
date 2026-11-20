import {
  cloudVideoClip,
  cloudVideoClipRefusal,
  cloudVideoRequest,
  cloudVideoSettingsRefusal,
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
        expect(cloudVideoClipRefusal(workload, described) === null, `${workload} ${JSON.stringify(described)}`).toBe(
          accepted,
        );
      }
    }
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
