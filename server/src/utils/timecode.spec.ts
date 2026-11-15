import { describe, expect, it } from 'vitest';
import {
  droppedPerMinute,
  framesToTimecode,
  isDropFrameTimecode,
  normalizeTimecode,
  timecodeToFrames,
} from 'src/utils/timecode';

const NTSC = { num: 30_000, den: 1001 };
const NTSC_60 = { num: 60_000, den: 1001 };

describe('normalizeTimecode', () => {
  it('keeps a non-drop timecode and writes every drop-frame separator as a semicolon', () => {
    expect(normalizeTimecode('01:00:00:00')).toBe('01:00:00:00');
    expect(normalizeTimecode('01:00:00;00')).toBe('01:00:00;00');
    expect(normalizeTimecode('01:00:00.00')).toBe('01:00:00;00');
    expect(normalizeTimecode('01:00:00,12')).toBe('01:00:00;12');
    expect(normalizeTimecode(' 10:20:30:119 ')).toBe('10:20:30:119');
  });

  it('refuses anything that is not a timecode', () => {
    for (const value of [
      undefined,
      null,
      3600,
      '',
      '1:00:00:00',
      '01:00:00',
      '24:00:00:00',
      '00:60:00:00',
      '00:00:60:00',
      '01-00-00-00',
      '01:00:00:0',
    ]) {
      expect(normalizeTimecode(value), String(value)).toBeNull();
    }
  });

  it('tells a drop-frame timecode by its separator', () => {
    expect(isDropFrameTimecode('00:00:00;00')).toBe(true);
    expect(isDropFrameTimecode('00:00:00:00')).toBe(false);
  });
});

describe('droppedPerMinute', () => {
  it('drops labels only at 29.97 and 59.94', () => {
    expect(droppedPerMinute(NTSC)).toBe(2);
    expect(droppedPerMinute({ num: 60_000, den: 1001 })).toBe(4);
    expect(droppedPerMinute({ num: 2997, den: 100 })).toBe(0);
    for (const rate of [
      { num: 24_000, den: 1001 },
      { num: 48_000, den: 1001 },
      { num: 120_000, den: 1001 },
      { num: 30, den: 1 },
      { num: 25, den: 1 },
    ]) {
      expect(droppedPerMinute(rate)).toBe(0);
    }
  });
});

describe('drop-frame at 29.97', () => {
  const cases: Array<[number, string]> = [
    [0, '00:00:00;00'],
    [1799, '00:00:59;29'],
    [1800, '00:01:00;02'],
    [1801, '00:01:00;03'],
    [3597, '00:01:59;29'],
    [3598, '00:02:00;02'],
    [16_183, '00:08:59;29'],
    [16_184, '00:09:00;02'],
    [17_981, '00:09:59;29'],
    [17_982, '00:10:00;00'],
    [17_983, '00:10:00;01'],
    [19_781, '00:10:59;29'],
    [19_782, '00:11:00;02'],
    [107_891, '00:59:59;29'],
    [107_892, '01:00:00;00'],
    [2_589_407, '23:59:59;29'],
    [2_589_408, '00:00:00;00'],
  ];

  it.each(cases)('frame %i is %s, and back', (frame, label) => {
    expect(framesToTimecode(frame, NTSC, true)).toBe(label);
    expect(timecodeToFrames(label, NTSC)).toBe(frame % 2_589_408);
  });

  it('skips labels 00 and 01 of every minute but each tenth', () => {
    expect(timecodeToFrames('00:01:00;00', NTSC)).toBeNull();
    expect(timecodeToFrames('00:01:00;01', NTSC)).toBeNull();
    expect(timecodeToFrames('00:09:00;01', NTSC)).toBeNull();
    expect(timecodeToFrames('00:10:00;00', NTSC)).toBe(17_982);
    expect(timecodeToFrames('00:01:01;00', NTSC)).toBe(1828);
  });

  it('counts every label round the clock without a gap or a repeat', () => {
    const seen = new Set<string>();
    for (let frame = 0; frame < 2_589_408; frame += 1) {
      const label = framesToTimecode(frame, NTSC, true)!;
      const back = timecodeToFrames(label, NTSC);
      if (back !== frame || seen.has(label)) {
        expect.fail(`${frame} -> ${label} -> ${back}`);
      }
      seen.add(label);
    }
    expect(seen.size).toBe(2_589_408);
  });

  it('counts a non-drop timecode at 29.97 frame by frame', () => {
    expect(framesToTimecode(1800, NTSC, false)).toBe('00:01:00:00');
    expect(timecodeToFrames('01:00:00:00', NTSC)).toBe(108_000);
    expect(timecodeToFrames('00:01:00:00', NTSC)).toBe(1800);
  });
});

describe('drop-frame at 59.94', () => {
  const cases: Array<[number, string]> = [
    [3599, '00:00:59;59'],
    [3600, '00:01:00;04'],
    [35_963, '00:09:59;59'],
    [35_964, '00:10:00;00'],
    [215_784, '01:00:00;00'],
  ];

  it.each(cases)('frame %i is %s, and back', (frame, label) => {
    expect(framesToTimecode(frame, NTSC_60, true)).toBe(label);
    expect(timecodeToFrames(label, NTSC_60)).toBe(frame);
  });

  it('skips labels 00 to 03', () => {
    for (const frames of ['00', '01', '02', '03']) {
      expect(timecodeToFrames(`00:01:00;${frames}`, NTSC_60)).toBeNull();
    }
    expect(timecodeToFrames('00:01:00;04', NTSC_60)).toBe(3600);
  });

  it('counts every label of the first hour', () => {
    for (let frame = 0; frame < 215_784; frame += 1) {
      const back = timecodeToFrames(framesToTimecode(frame, NTSC_60, true)!, NTSC_60);
      if (back !== frame) {
        expect.fail(`${frame} -> ${back}`);
      }
    }
  });
});

describe('every other rate counts each frame', () => {
  it.each([
    [{ num: 24_000, den: 1001 }, 86_400, '01:00:00:00'],
    [{ num: 48_000, den: 1001 }, 172_800, '01:00:00:00'],
    [{ num: 25, den: 1 }, 90_000, '01:00:00:00'],
    [{ num: 24, den: 1 }, 47, '00:00:01:23'],
    [{ num: 120, den: 1 }, 119, '00:00:00:119'],
  ])('%o: frame %i is %s', (rate, frame, label) => {
    expect(framesToTimecode(frame, rate, false)).toBe(label);
    expect(timecodeToFrames(label, rate)).toBe(frame);
  });

  it('reads a drop-frame label at a rate that has no drop-frame as non-drop', () => {
    expect(framesToTimecode(1800, { num: 30, den: 1 }, true)).toBe('00:01:00:00');
    expect(timecodeToFrames('00:01:00;00', { num: 30, den: 1 })).toBe(1800);
    expect(timecodeToFrames('00:01:00;00', { num: 24_000, den: 1001 })).toBe(1440);
  });

  it('wraps at 24 hours', () => {
    expect(framesToTimecode(25 * 86_400 + 3, { num: 25, den: 1 }, false)).toBe('00:00:00:03');
  });

  it('refuses frames beyond the second, bad rates and bad frames', () => {
    expect(timecodeToFrames('00:00:00:25', { num: 25, den: 1 })).toBeNull();
    expect(timecodeToFrames('00:00:00:00', { num: 0, den: 1 })).toBeNull();
    expect(timecodeToFrames('nonsense', { num: 25, den: 1 })).toBeNull();
    expect(framesToTimecode(-1, { num: 25, den: 1 }, false)).toBeNull();
    expect(framesToTimecode(1.5, { num: 25, den: 1 }, false)).toBeNull();
    expect(framesToTimecode(0, { num: 25, den: 0 }, false)).toBeNull();
  });
});
