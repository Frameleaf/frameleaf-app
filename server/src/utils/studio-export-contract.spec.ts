import { describe, expect, it } from 'vitest';
import { ColorTransfer } from 'src/enum.js';
import {
  buildStudioExportContract,
  findStudioExportOutputMismatch,
  isTimingUnchangedSingleSource,
  parseStudioExportContract,
  resolveStudioExportTiming,
  sameTimeBase,
} from 'src/utils/studio-export-contract.js';
import { StudioTimingError } from 'src/utils/studio-timing.js';

const video = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'video',
  trackId: 'v1',
  mediaId: id,
  from: 0,
  durationInFrames: 30,
  ...extra,
});
const graph = (items: Record<string, unknown>[], timeline: Record<string, unknown> = {}) => ({
  metadata: { fps: 30_000 / 1001, frameRate: { num: 30_000, den: 1001 } },
  timeline: { tracks: [{ id: 'v1' }, { id: 'a1' }], items, transitions: [], keyframes: [], ...timeline },
});
const facts = (assetId: string, overrides: Record<string, unknown> = {}) => ({
  assetId,
  video: { timeBase: 90_000, pixelFormat: 'yuv420p', colorTransfer: ColorTransfer.Bt709 },
  packets: {
    keyframePts: [3003, 93_093],
    keyframeAccDuration: [3003, 93_093],
    keyframeOwnDuration: [3003, 3003],
    totalDuration: 900_900,
    packetCount: 300,
    outputFrames: 300,
  },
  audio: { codecName: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 48_000 },
  ...overrides,
});

describe('isTimingUnchangedSingleSource (FL-93)', () => {
  it('is true only for one forward clip at its own speed, trims allowed', () => {
    expect(isTimingUnchangedSingleSource(graph([video('a', { sourceStart: 90 })]))).toBe(true);
    expect(isTimingUnchangedSingleSource(graph([video('a'), { type: 'audio', mediaId: 'a' }]))).toBe(true);
    expect(isTimingUnchangedSingleSource(graph([video('a', { speed: 0.5 })]))).toBe(false);
    expect(isTimingUnchangedSingleSource(graph([video('a', { isReversed: true })]))).toBe(false);
    expect(isTimingUnchangedSingleSource(graph([video('a'), video('b')]))).toBe(false);
    expect(isTimingUnchangedSingleSource(graph([video('a'), { type: 'text' }]))).toBe(false);
    expect(isTimingUnchangedSingleSource(graph([video('a')], { transitions: [{}] }))).toBe(false);
    expect(isTimingUnchangedSingleSource(graph([video('a')], { keyframes: [{}] }))).toBe(false);
  });
});

describe('resolveStudioExportTiming (FL-93)', () => {
  it('recovers a constant-rate cadence exactly from the stored packet durations', () => {
    const timing = resolveStudioExportTiming(graph([video('a'), video('b', { from: 30 })]), [
      { key: 'library-asset:a', facts: facts('a') as never },
      { key: 'library-asset:b', facts: facts('b') as never },
    ]);
    expect(timing.sources.map((source) => [source.cadence, source.originTicks, source.trackTimescale])).toEqual([
      ['30000/1001', 3003, 90_000],
      ['30000/1001', 3003, 90_000],
    ]);
    expect(timing.decision).toMatchObject({ mode: 'convert', cadence: '30000/1001' });
    expect(timing.timeBase).toBe('1001/30000');
  });

  it('renders a picture-less project on the declared cadence', () => {
    const timing = resolveStudioExportTiming(graph([]), []);
    expect(timing).toMatchObject({ decision: { mode: 'convert', cadence: '30000/1001' }, sources: [] });
  });

  it('refuses a graph without an exact rate and a source without a scan', () => {
    expect(() => resolveStudioExportTiming({ metadata: { fps: 12.5 } }, [])).toThrow(StudioTimingError);
    expect(() =>
      resolveStudioExportTiming(graph([video('a')]), [
        { key: 'library-asset:a', facts: facts('a', { packets: null }) as never },
      ]),
    ).toThrow(StudioTimingError);
  });
});

describe('buildStudioExportContract (FL-102)', () => {
  it('keeps an HDR transfer every source shares when preserving, and asks nothing of SDR H.264', () => {
    const hlg = facts('a', { video: { timeBase: 90_000, pixelFormat: 'yuv420p10le', colorTransfer: 18 } });
    expect(
      buildStudioExportContract({ format: 'mp4-hevc-main10', color: 'preserve' }, graph([]), [hlg as never]),
    ).toMatchObject({ video: { minBitDepth: 10, transfer: 'arib-std-b67' } });
    expect(
      buildStudioExportContract({ format: 'mp4-h264', color: 'preserve' }, graph([]), [facts('a') as never]),
    ).toEqual({ video: { minBitDepth: 8, transfer: null }, audio: null });
  });

  it('carries the widest audible layout at the highest rate, ignoring a muted track', () => {
    const items = [
      { type: 'audio', trackId: 'a1', mediaId: 'a' },
      { type: 'audio', trackId: 'a2', mediaId: 'b' },
      { type: 'audio', trackId: 'a1', mediaId: 'c' },
    ];
    const withMute = graph(items, { tracks: [{ id: 'a1' }, { id: 'a2', muted: true }] });
    const sources = [
      facts('a', { audio: { codecName: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 44_100 } }),
      facts('b', { audio: { codecName: 'eac3', channels: 8, channelLayout: '7.1', sampleRate: 96_000 } }),
      facts('c', { audio: { codecName: 'aac', channels: 6, channelLayout: '5.1', sampleRate: 48_000 } }),
    ];
    expect(
      buildStudioExportContract({ format: 'mp4-h264', color: 'preserve' }, withMute, sources as never).audio,
    ).toEqual({ policy: 'preserve', channels: 6, channelLayout: '5.1', sampleRate: 48_000 });
  });

  it('parses only a contract it wrote', () => {
    expect(parseStudioExportContract({ video: { minBitDepth: 10, transfer: null }, audio: null })).not.toBeNull();
    expect(parseStudioExportContract({ video: { minBitDepth: 12 } })).toBeNull();
    expect(parseStudioExportContract(null)).toBeNull();
  });
});

describe('findStudioExportOutputMismatch (FL-102)', () => {
  const contract = { video: { minBitDepth: 8 as const, transfer: null }, audio: null };
  const stream = { pixelFormat: 'yuv420p', colorTransfer: ColorTransfer.Bt709, duration: 5, frameRate: 25 };

  it('refuses a result with no picture and accepts a silent one when nothing was promised', () => {
    expect(findStudioExportOutputMismatch(contract, { videoStreams: [], audioStreams: [] })).toMatch('no video');
    expect(findStudioExportOutputMismatch(contract, { videoStreams: [stream as never], audioStreams: [] })).toBeNull();
  });

  it('still checks alignment of an audio track nobody promised', () => {
    const audio = { codecName: 'aac', sampleRate: 48_000, duration: 3 };
    expect(
      findStudioExportOutputMismatch(contract, { videoStreams: [stream as never], audioStreams: [audio as never] }),
    ).toMatch('misaligned');
  });
});

describe('sameTimeBase', () => {
  it('compares spellings exactly', () => {
    expect(sameTimeBase('2002/60000', '1001/30000')).toBe(true);
    expect(sameTimeBase('1/30000', '1001/30000')).toBe(false);
    expect(sameTimeBase('x', '1/1')).toBe(false);
  });
});
