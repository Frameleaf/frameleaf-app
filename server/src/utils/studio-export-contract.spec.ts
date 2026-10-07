import { describe, expect, it } from 'vitest';
import { ColorMatrix, ColorPrimaries, ColorTransfer } from 'src/enum.js';
import {
  buildStudioExportContract,
  findStudioExportOutputMismatch,
  findStudioExportRangeMismatch,
  isTimingUnchangedSingleSource,
  parseStudioExportContract,
  resolveStudioExportRange,
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

it('validates integer main-timeline ranges, preserves the graph and excludes out-of-range audio', () => {
  const input = graph([
    video('image', { type: 'image' }),
    { type: 'audio', mediaId: 'a', trackId: 'a1', from: 0, durationInFrames: 5 },
    { type: 'audio', mediaId: 'b', trackId: 'a1', from: 5, durationInFrames: 25 },
  ]);
  const before = structuredClone(input);
  const range = { inPoint: 5, outPoint: 7 };
  expect(resolveStudioExportRange(input, range)).toEqual({ ...range, cadence: '30000/1001' });
  const contract = buildStudioExportContract({ format: 'mp4-h264', color: 'preserve', range }, input, [
    facts('a', { audio: { channels: 8, channelLayout: '7.1', sampleRate: 96_000 } }) as never,
    facts('b') as never,
  ]);
  expect(contract.audio).toMatchObject({ channels: 2, channelLayout: 'stereo', sampleRate: 48_000 });
  expect(contract.range).toEqual({ ...range, cadence: '30000/1001' });
  expect(input).toEqual(before);
  for (const invalid of [
    { inPoint: -1, outPoint: 7 },
    { inPoint: 5.5, outPoint: 7 },
    { inPoint: 5, outPoint: 5 },
    { inPoint: 5, outPoint: 31 },
  ]) {
    expect(() => resolveStudioExportRange(input, invalid)).toThrow(StudioTimingError);
  }
  expect(() => resolveStudioExportRange(graph([video('c', { type: 'composition' })]), range)).toThrow(
    StudioTimingError,
  );
  expect(() => resolveStudioExportRange(graph([video('a', { durationInFrames: 1.5 })]), range)).toThrow(
    StudioTimingError,
  );
});

it('holds range output to exact rational packet duration, count and zero origin', () => {
  const range = { inPoint: 5, outPoint: 7, cadence: '30000/1001' };
  const stream = { timeBaseRational: { num: 1, den: 90_000 } } as never;
  const packets = {
    presentation: { startPts: 0, endPts: 6006 },
    presentationCadenceTicks: 3003,
    totalDuration: 6006,
    packetCount: 2,
    variableFrameRate: false,
  };
  expect(findStudioExportRangeMismatch(range, stream, packets as never)).toBeNull();
  for (const invalid of [
    null,
    { ...packets, packetCount: 3 },
    { ...packets, variableFrameRate: true },
    { ...packets, presentationCadenceTicks: undefined },
    { ...packets, presentationCadenceTicks: null },
    { ...packets, presentationCadenceTicks: 3000 },
    { ...packets, presentation: { startPts: 3003, endPts: 9009 } },
    { ...packets, totalDuration: 6007 },
    { ...packets, presentation: null },
  ]) {
    expect(findStudioExportRangeMismatch(range, stream, invalid as never)).toContain('rendered range');
  }
  expect(findStudioExportRangeMismatch(range, {} as never, packets as never)).toContain('rendered range');
  expect(
    findStudioExportRangeMismatch(
      { inPoint: 0, outPoint: 2, cadence: '48/1' },
      { timeBaseRational: { num: 1, den: 24 } } as never,
      {
        presentation: { startPts: 0, endPts: 1 },
        presentationCadenceTicks: 0.5,
        totalDuration: 1,
        packetCount: 2,
        variableFrameRate: false,
      } as never,
    ),
  ).toContain('rendered range');
  expect(
    findStudioExportRangeMismatch({ ...range, outPoint: Number.MAX_SAFE_INTEGER }, stream, packets as never),
  ).toContain('rendered range');
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
  it('requires and copies an explicit PQ mastering profile rather than source or preview defaults (FL-107)', () => {
    const settings = { format: 'mp4-hevc-main10', color: 'hdr10' };
    const project = { ...graph([]), colorManagement: { masteringPeakNits: 4000 } };
    expect(() => buildStudioExportContract(settings, project, [])).toThrow(/mastering/i);
    const mastering = { primaries: 'bt2020' as const, maxNits: 1000, minNits: 0.005 };
    const contract = buildStudioExportContract({ ...settings, mastering }, project, []);
    expect(contract.video).toEqual({ minBitDepth: 10, transfer: 'smpte2084', mastering });
    const pq = facts('a', {
      video: { timeBase: 90_000, pixelFormat: 'yuv420p10le', colorTransfer: ColorTransfer.Smpte2084 },
    });
    expect(() => buildStudioExportContract({ ...settings, color: 'preserve' }, graph([]), [pq])).toThrow(/mastering/i);
    expect(
      buildStudioExportContract({ ...settings, color: 'preserve', mastering }, graph([]), [pq]).video.mastering,
    ).toEqual(mastering);
    mastering.maxNits = 4000;
    expect(contract.video.mastering?.maxNits).toBe(1000);
    for (const invalid of [
      null,
      { ...mastering, minNits: 5000 },
      { ...mastering, maxNits: NaN },
      { ...mastering, minNits: 0.00001 },
      { ...mastering, maxNits: 10_001 },
      { ...mastering, primaries: 'unknown' },
      { ...mastering, maxCll: 900 },
    ]) {
      expect(() => buildStudioExportContract({ ...settings, mastering: invalid } as never, project, [])).toThrow(
        /mastering/i,
      );
    }
    expect(() =>
      buildStudioExportContract({ format: 'mp4-h264', color: 'preserve', mastering }, graph([]), []),
    ).toThrow(/mastering/i);
    expect(
      parseStudioExportContract({
        video: { ...contract.video, mastering: { ...mastering, minNits: -1 } },
        audio: null,
      }),
    ).toBeNull();
  });

  it('keeps an HDR transfer every source shares when preserving, and asks nothing of SDR H.264', () => {
    const hlg = facts('a', { video: { timeBase: 90_000, pixelFormat: 'yuv420p10le', colorTransfer: 18 } });
    expect(
      buildStudioExportContract({ format: 'mp4-hevc-main10', color: 'preserve' }, graph([]), [hlg as never]),
    ).toMatchObject({ video: { minBitDepth: 10, transfer: 'arib-std-b67' } });
    expect(
      buildStudioExportContract({ format: 'mp4-h264', color: 'preserve' }, graph([]), [facts('a') as never]),
    ).toEqual({ video: { minBitDepth: 8, transfer: null }, audio: null });
    expect(buildStudioExportContract({ format: 'webm-av1', color: 'preserve' }, graph([]), [])).toEqual({
      video: { minBitDepth: 10, transfer: null },
      audio: null,
    });
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

  it('preserves both PQ mastering and a selected frame range through construction and parsing', () => {
    const mastering = { primaries: 'bt2020' as const, maxNits: 1000, minNits: 0.005 };
    const range = { inPoint: 4, outPoint: 12 };
    const project = { ...graph([video('source')]), metadata: { fps: 24, frameRate: { num: 24, den: 1 } } };
    const contract = buildStudioExportContract(
      { format: 'mp4-hevc-main10', color: 'hdr10', mastering, range },
      project,
      [facts('source', { audio: null })] as never,
    );
    expect(contract).toMatchObject({ video: { mastering }, range: { ...range, cadence: '24/1' } });
    expect(parseStudioExportContract(contract)).toEqual(contract);
  });

  it('parses only a contract it wrote', () => {
    expect(parseStudioExportContract({ video: { minBitDepth: 10, transfer: null }, audio: null })).not.toBeNull();
    expect(parseStudioExportContract({ video: { minBitDepth: 12 } })).toBeNull();
    expect(parseStudioExportContract(null)).toBeNull();
  });
});

describe('findStudioExportOutputMismatch (FL-102)', () => {
  const contract = { video: { minBitDepth: 8 as const, transfer: null }, audio: null };
  const stream = {
    codecName: 'h264',
    pixelFormat: 'yuv420p',
    colorTransfer: ColorTransfer.Bt709,
    duration: 5,
    frameRate: 25,
  };

  it('refuses a result with no picture and accepts a silent one when nothing was promised', () => {
    expect(findStudioExportOutputMismatch(contract, { videoStreams: [], audioStreams: [] }, 'mp4-h264')).toMatch(
      'no video',
    );
    expect(
      findStudioExportOutputMismatch(contract, { videoStreams: [stream as never], audioStreams: [] }, 'mp4-h264'),
    ).toBeNull();
  });

  it('still checks alignment of an audio track nobody promised', () => {
    const audio = { codecName: 'aac', sampleRate: 48_000, duration: 3 };
    expect(
      findStudioExportOutputMismatch(
        contract,
        { videoStreams: [stream as never], audioStreams: [audio as never] },
        'mp4-h264',
      ),
    ).toMatch('misaligned');
  });

  it.each([
    ['mp4-h264', 'h264'],
    ['mp4-hevc-main10', 'hevc'],
    ['webm-av1', 'av1'],
    ['prores-422-hq', 'prores'],
  ])('accepts the actual codec of %s and refuses a changed or unknown codec', (format, codecName) => {
    const output = (codecName: string | null) => ({
      videoStreams: [{ ...stream, codecName, pixelFormat: 'yuv420p10le' } as never],
      audioStreams: [],
    });
    expect(findStudioExportOutputMismatch(contract, output(codecName), format)).toBeNull();
    expect(findStudioExportOutputMismatch(contract, output('vp9'), format)).toMatch('video codec');
    expect(findStudioExportOutputMismatch(contract, output(null), format)).toMatch('video codec');
  });

  it('holds an older eight-bit AV1 contract to the selected format minimum', () => {
    for (const pixelFormat of ['yuv420p', 'yuv420p9le', 'unknown']) {
      expect(
        findStudioExportOutputMismatch(
          contract,
          { videoStreams: [{ ...stream, codecName: 'av1', pixelFormat } as never], audioStreams: [] },
          'webm-av1',
        ),
      ).toMatch('below the 10-bit');
    }
  });

  it('refuses an unknown format even when the codec matches another supported format', () => {
    expect(
      findStudioExportOutputMismatch(contract, { videoStreams: [stream as never], audioStreams: [] }, 'toString'),
    ).toMatch('unsupported video format');
  });
});

describe.each([
  ['PQ', 'smpte2084', ColorTransfer.Smpte2084],
  ['HLG', 'arib-std-b67', ColorTransfer.AribStdB67],
] as const)('HDR export signalling (%s, FL-107)', (_, transfer, colorTransfer) => {
  const contract = { video: { minBitDepth: 10 as const, transfer }, audio: null };
  const stream = {
    codecName: 'hevc',
    pixelFormat: 'yuv420p10le',
    colorTransfer,
    colorPrimaries: ColorPrimaries.Bt2020,
    colorMatrix: ColorMatrix.Bt2020Nc,
    duration: 5,
    frameRate: 25,
  };

  it.each([
    ['BT.709 primaries', { colorPrimaries: ColorPrimaries.Bt709 }, /primaries/i],
    ['unknown primaries', { colorPrimaries: ColorPrimaries.Unknown }, /primaries/i],
    ['BT.709 matrix', { colorMatrix: ColorMatrix.Bt709 }, /matrix/i],
    ['unknown matrix', { colorMatrix: ColorMatrix.Unknown }, /matrix/i],
  ])('rejects %s even when ten-bit precision and transfer match', (_, tags, reason) => {
    expect(
      findStudioExportOutputMismatch(
        contract,
        { videoStreams: [{ ...stream, ...tags } as never], audioStreams: [] },
        'mp4-hevc-main10',
      ),
    ).toMatch(reason);
  });

  it('accepts ten-bit BT.2020 with the BT.2020 non-constant-luminance matrix', () => {
    expect(
      findStudioExportOutputMismatch(
        contract,
        { videoStreams: [stream as never], audioStreams: [] },
        'mp4-hevc-main10',
      ),
    ).toBeNull();
  });
});

it('keeps SDR BT.709 exports eligible without an HDR gamut requirement (FL-107)', () => {
  expect(
    findStudioExportOutputMismatch(
      { video: { minBitDepth: 8, transfer: null }, audio: null },
      {
        videoStreams: [
          {
            codecName: 'h264',
            pixelFormat: 'yuv420p',
            colorTransfer: ColorTransfer.Bt709,
            colorPrimaries: ColorPrimaries.Bt709,
            colorMatrix: ColorMatrix.Bt709,
            duration: 5,
            frameRate: 25,
          } as never,
        ],
        audioStreams: [],
      },
      'mp4-h264',
    ),
  ).toBeNull();
});

describe('sameTimeBase', () => {
  it('compares spellings exactly', () => {
    expect(sameTimeBase('2002/60000', '1001/30000')).toBe(true);
    expect(sameTimeBase('1/30000', '1001/30000')).toBe(false);
    expect(sameTimeBase('x', '1/1')).toBe(false);
  });
});

it('holds independently probed ST 2086 values to the declared profile, including each chromaticity (FL-107)', () => {
  const contract = {
    video: {
      minBitDepth: 10 as const,
      transfer: 'smpte2084' as const,
      mastering: { primaries: 'bt2020' as const, maxNits: 1000, minNits: 0.005 },
    },
    audio: null,
  };
  const data = {
    side_data_type: 'Mastering display metadata',
    red_x: '35400/50000',
    red_y: '14600/50000',
    green_x: '8500/50000',
    green_y: '39850/50000',
    blue_x: '6550/50000',
    blue_y: '2300/50000',
    white_point_x: '15635/50000',
    white_point_y: '16450/50000',
    max_luminance: '10000000/10000',
    min_luminance: '50/10000',
  };
  const probe = {
    videoStreams: [
      {
        codecName: 'hevc',
        pixelFormat: 'yuv420p10le',
        colorTransfer: ColorTransfer.Smpte2084,
        colorPrimaries: ColorPrimaries.Bt2020,
        colorMatrix: ColorMatrix.Bt2020Nc,
        duration: 5,
        frameRate: 25,
      } as never,
    ],
    audioStreams: [],
    mastering: [data],
  };
  expect(findStudioExportOutputMismatch(contract, probe, 'mp4-hevc-main10')).toBeNull();
  for (const key of Object.keys(data)) {
    expect(
      findStudioExportOutputMismatch(contract, { ...probe, mastering: [{ ...data, [key]: '0/1' }] }, 'mp4-hevc-main10'),
    ).toMatch(/mastering display/);
  }
  expect(findStudioExportOutputMismatch(contract, { ...probe, mastering: [] }, 'mp4-hevc-main10')).toMatch(
    /mastering display/,
  );
});
