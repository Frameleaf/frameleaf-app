import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FRAME_RATE_NTSC_24, FRAME_RATE_NTSC_30, add, rational } from 'src/utils/rational-time.js';
import {
  StudioTimingError,
  audioSampleAt,
  cadenceFromDecimal,
  clipSourceTime,
  isFrameBoundary,
  nearestTimelineFrame,
  outputTimeBase,
  projectCadenceOf,
  sourcePresentationTicks,
  speedOf,
  timelineFrameTicks,
  timelineFrameTime,
  withProjectCadence,
} from 'src/utils/studio-timing.js';

describe('studio-timing (FL-93)', () => {
  describe('project cadence', () => {
    it('reads the stored rational, and legacy integer and NTSC decimal rates exactly', () => {
      expect(projectCadenceOf({ fps: 30_000 / 1001, frameRate: { num: 30_000, den: 1001 } })).toEqual(
        FRAME_RATE_NTSC_30,
      );
      expect(projectCadenceOf({ fps: 25 })).toEqual(rational(25, 1));
      expect(projectCadenceOf({ fps: 29.97 })).toEqual(FRAME_RATE_NTSC_30);
      expect(projectCadenceOf({ fps: 23.976 })).toEqual(FRAME_RATE_NTSC_24);
      expect(projectCadenceOf({ fps: 59.94 })).toEqual(rational(60_000, 1001));
      expect(projectCadenceOf({ fps: 24_000 / 1001 })).toEqual(FRAME_RATE_NTSC_24);
    });

    it('never approximates a rate it cannot read exactly', () => {
      expect(cadenceFromDecimal(27.3)).toBeNull();
      expect(cadenceFromDecimal(29.9)).toBeNull();
      expect(cadenceFromDecimal(0)).toBeNull();
      expect(cadenceFromDecimal('30')).toBeNull();
      expect(projectCadenceOf({})).toBeNull();
      expect(() => withProjectCadence({ fps: 27.3 })).toThrow(StudioTimingError);
    });

    it('reads the new fps when the editor changed it and left a stale rational behind', () => {
      expect(projectCadenceOf({ fps: 25, frameRate: { num: 30_000, den: 1001 } })).toEqual(rational(25, 1));
    });

    it('writes the rational and the engine float of the same rate, keeping other fields', () => {
      expect(withProjectCadence({ fps: 29.97, width: 1920 })).toEqual({
        fps: 30_000 / 1001,
        frameRate: { num: 30_000, den: 1001 },
        width: 1920,
      });
    });
  });

  describe('timeline frames', () => {
    it('adds no drift over an hour at 30000/1001 and 24000/1001', () => {
      // 107,892 frames at 29.97 is 3599.9964 s; the exact start of the last frame is known.
      expect(timelineFrameTime(107_892, FRAME_RATE_NTSC_30)).toEqual(rational(107_892 * 1001, 30_000));
      expect(timelineFrameTime(86_314, FRAME_RATE_NTSC_24)).toEqual(rational(86_314 * 1001, 24_000));
      for (const frame of [0, 1, 1000, 107_891, 107_892]) {
        expect(nearestTimelineFrame(timelineFrameTime(frame, FRAME_RATE_NTSC_30), FRAME_RATE_NTSC_30)).toBe(frame);
      }
    });

    it('rounds a time between frames to the nearest, halves away from zero', () => {
      const half = rational(1001, 60_000);
      expect(nearestTimelineFrame(half, FRAME_RATE_NTSC_30)).toBe(1);
      expect(nearestTimelineFrame(rational(1000, 60_000), FRAME_RATE_NTSC_30)).toBe(0);
    });

    it('reads a decimal speed exactly and refuses a nonsensical one', () => {
      expect(speedOf(1.5)).toEqual(rational(3, 2));
      expect(speedOf(0.25)).toEqual(rational(1, 4));
      expect(speedOf(undefined)).toEqual(rational(1, 1));
      expect(speedOf(-2)).toEqual(rational(1, 1));
    });
  });

  describe('source mapping', () => {
    const clip = { from: 100, sourceStart: 30, sourceCadence: FRAME_RATE_NTSC_30 };

    it('maps a timeline frame to the exact source instant, with speed', () => {
      expect(clipSourceTime(clip, 100, FRAME_RATE_NTSC_30)).toEqual(rational(30 * 1001, 30_000));
      expect(clipSourceTime(clip, 110, FRAME_RATE_NTSC_30)).toEqual(rational(40 * 1001, 30_000));
      expect(clipSourceTime({ ...clip, speed: 2 }, 110, FRAME_RATE_NTSC_30)).toEqual(rational(50 * 1001, 30_000));
    });

    it('maps across cadences: a 25 fps source on a 30000/1001 timeline', () => {
      const pal = { from: 0, sourceStart: 25, sourceCadence: rational(25, 1) };
      // one second in, then 30 timeline frames (1.001 s) later
      expect(clipSourceTime(pal, 30, FRAME_RATE_NTSC_30)).toEqual(add(rational(1, 1), rational(1001, 1000)));
    });

    it('walks a reversed clip back from its source end and never before its start', () => {
      const reversed = { ...clip, sourceEnd: 60, reversed: true };
      expect(clipSourceTime(reversed, 100, FRAME_RATE_NTSC_30)).toEqual(rational(59 * 1001, 30_000));
      expect(clipSourceTime(reversed, 129, FRAME_RATE_NTSC_30)).toEqual(rational(30 * 1001, 30_000));
      expect(clipSourceTime(reversed, 200, FRAME_RATE_NTSC_30)).toEqual(rational(30 * 1001, 30_000));
      expect(() => clipSourceTime({ ...clip, reversed: true }, 100, FRAME_RATE_NTSC_30)).toThrow(StudioTimingError);
    });

    it('finds the real picture of a variable-rate source with a nonzero origin, not a grid slot', () => {
      const source = { timeBase: '1/90000', originTicks: 6006 };
      // a picture at origin + 0.5 s is 45,000 ticks after the origin, whatever the rate did before it
      expect(sourcePresentationTicks(source, rational(1, 2))).toBe(6006 + 45_000);
      // an instant between ticks shows the tick before it
      expect(sourcePresentationTicks(source, rational(1, 180_001))).toBe(6006);
      expect(() => sourcePresentationTicks({ timeBase: '0/0', originTicks: 0 }, rational(1, 2))).toThrow(
        StudioTimingError,
      );
    });

    it('places audio samples on the same instant the picture uses', () => {
      const instant = clipSourceTime(clip, 130, FRAME_RATE_NTSC_30);
      // 60 frames of 1001/30000 s at 48 kHz is exactly 96,096 samples
      expect(audioSampleAt(instant, 48_000)).toBe(96_096);
      expect(audioSampleAt(instant, 44_100)).toBe(Math.floor((60 * 1001 * 44_100) / 30_000));
    });
  });

  describe('output grid and chunk boundaries', () => {
    const vfr = [{ timeBase: '1/90000' }];

    it('ticks once per frame when converting and in the source time base when passing through', () => {
      expect(outputTimeBase({ mode: 'convert', cadence: '30000/1001' }, [])).toEqual(rational(1001, 30_000));
      expect(outputTimeBase({ mode: 'passthrough', cadence: null }, vfr)).toEqual(rational(1, 90_000));
      expect(() => outputTimeBase({ mode: 'convert', cadence: null }, [])).toThrow(StudioTimingError);
      expect(() => outputTimeBase({ mode: 'passthrough', cadence: null }, [...vfr, ...vfr])).toThrow(StudioTimingError);
    });

    it('agrees on every chunk boundary between the timeline and the output grid', () => {
      const grid = rational(1001, 30_000);
      for (const frame of [0, 1, 299, 300, 107_892]) {
        const ticks = timelineFrameTicks(frame, FRAME_RATE_NTSC_30, grid);
        expect(ticks).toBe(frame);
        expect(isFrameBoundary(ticks!, FRAME_RATE_NTSC_30, grid)).toBe(true);
      }
      // on a 1/90000 grid a 29.97 frame start is 3003 ticks, exactly
      expect(timelineFrameTicks(10, FRAME_RATE_NTSC_30, rational(1, 90_000))).toBe(30_030);
      expect(isFrameBoundary(30_031, FRAME_RATE_NTSC_30, rational(1, 90_000))).toBe(false);
      // a 1/1000 grid cannot hold a 29.97 frame start
      expect(timelineFrameTicks(1, FRAME_RATE_NTSC_30, rational(1, 1000))).toBeNull();
    });
  });

  it('is mirrored for the web host, identical apart from the import of rational-time', () => {
    const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), 'utf8');
    const server = read('studio-timing.ts');
    const web = read('../../../web/src/lib/frameleaf/studio/studio-timing.ts');
    expect(web.replace("from './rational-time';", "from 'src/utils/rational-time.js';")).toBe(server);
  });
});
