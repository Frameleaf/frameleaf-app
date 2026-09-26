import { describe, expect, it } from 'vitest';
import { defaults } from 'src/dtos/config.dto.js';
import { AssetEditAction, AssetEditActionItem } from 'src/dtos/editing.dto.js';
import {
  AssetFileType,
  ColorMatrix,
  ColorPrimaries,
  ColorTransfer,
  DvProfile,
  ToneMapping,
  VideoCodec,
} from 'src/enum.js';
import { DecodeSupport } from 'src/utils/media-decode.js';
import {
  AudioChannelPolicy,
  EDITED_MASTER_HIGH_BIT_DEPTH_FORMAT,
  EDITED_MASTER_MAX_CRF,
  EditedMasterColorPolicy,
  FRAMELEAF_RENDERER,
  MediaPolicyError,
  MediaPolicyViolation,
  applyEditedMasterAudioPolicy,
  applyEditedMasterPixelFormatPolicy,
  assertOriginalPreserved,
  assertRenderSourceIsOriginal,
  buildEditedMasterLineage,
  computeRecipeRevision,
  getDeliveryAudioChannelArgs,
  getEditedMasterColorArgs,
  getEditedMasterColorRange,
  getEditedMasterFfmpegConfig,
  getEditedMasterLineagePath,
  getEditedMasterTimingArgs,
  getFfmpegColorMatrixName,
  isHighBitDepth,
  isPlaybackProxyFileType,
  parseFfprobeColorRange,
  qualifyMetadataOnlyRotation,
  resolveEditedMasterColorPolicy,
  validateVideoMaster,
} from 'src/utils/media-policy.js';
import { FRAME_RATE_NTSC_30 } from 'src/utils/rational-time.js';
import { OutputCadenceMode } from 'src/utils/video-timing.js';
import { probeStub } from 'test/fixtures/media.stub.js';

const ffmpeg = defaults.ffmpeg;
const sdrStream = probeStub.videoStreamH264.videoStream;
const hdrStream = probeStub.videoStreamHDR.videoStream;
const dolbyVisionStream = probeStub.videoStreamDolbyVision.videoStream;

const preserve = { policy: EditedMasterColorPolicy.Preserve, reason: 'test' };
const toneMap = { policy: EditedMasterColorPolicy.ToneMap, reason: 'test' };

const crop: AssetEditActionItem = {
  action: AssetEditAction.Crop,
  parameters: { x: 2, y: 4, width: 300, height: 200 },
};
const rotate: AssetEditActionItem = { action: AssetEditAction.Rotate, parameters: { angle: 90 } };

describe('assertOriginalPreserved', () => {
  it('throws when the render output is the original file', () => {
    expect(() =>
      assertOriginalPreserved({ originalPath: '/library/a.mp4', outputPath: '/library/a.mp4' }),
    ).toThrowError(MediaPolicyError);
  });

  it('throws when the output resolves to the original through a relative path', () => {
    expect(() =>
      assertOriginalPreserved({ originalPath: '/library/a.mp4', outputPath: '/library/sub/../a.mp4' }),
    ).toThrowError(MediaPolicyError);
  });

  it('reports the violation code so callers can fail the job rather than crash', () => {
    try {
      assertOriginalPreserved({ originalPath: '/library/a.mp4', outputPath: '/library/a.mp4' });
      expect.unreachable('expected a policy error');
    } catch (error) {
      expect((error as MediaPolicyError).code).toBe(MediaPolicyViolation.OriginalWouldBeOverwritten);
    }
  });

  it('allows a derived output beside the original', () => {
    expect(() =>
      assertOriginalPreserved({ originalPath: '/library/a.mp4', outputPath: '/encoded/a_edited.mp4' }),
    ).not.toThrow();
  });
});

describe('assertRenderSourceIsOriginal', () => {
  it('allows the original as the render source', () => {
    expect(() =>
      assertRenderSourceIsOriginal({ originalPath: '/library/a.mp4', sourcePath: '/library/a.mp4' }),
    ).not.toThrow();
  });

  it('refuses to render a new master from an existing edited master', () => {
    expect(() =>
      assertRenderSourceIsOriginal({
        originalPath: '/library/a.mp4',
        sourcePath: '/encoded/a_edited.mp4',
        derivedPaths: ['/encoded/a_edited.mp4'],
      }),
    ).toThrowError(/derived file/);
  });

  it('refuses to render a new master from a playback proxy', () => {
    try {
      assertRenderSourceIsOriginal({
        originalPath: '/library/a.mp4',
        sourcePath: '/encoded/a.mp4',
        derivedPaths: ['/encoded/a.mp4'],
      });
      expect.unreachable('expected a policy error');
    } catch (error) {
      expect((error as MediaPolicyError).code).toBe(MediaPolicyViolation.DerivedSourceForNewMaster);
    }
  });
});

describe('isPlaybackProxyFileType', () => {
  it.each([AssetFileType.EncodedVideo, AssetFileType.Preview, AssetFileType.Thumbnail])(
    'treats %s as a replaceable proxy',
    (type) => {
      expect(isPlaybackProxyFileType(type)).toBe(true);
    },
  );

  it('does not treat the full-size rendition as a proxy', () => {
    expect(isPlaybackProxyFileType(AssetFileType.FullSize)).toBe(false);
  });
});

describe('getEditedMasterFfmpegConfig', () => {
  it('ignores the playback target resolution', () => {
    const config = getEditedMasterFfmpegConfig({ ...ffmpeg, targetResolution: '720' }, sdrStream);
    expect(config.targetResolution).toBe('original');
  });

  it('clamps a coarse playback CRF to the master quality target', () => {
    const config = getEditedMasterFfmpegConfig({ ...ffmpeg, crf: 30 }, sdrStream);
    expect(config.crf).toBe(EDITED_MASTER_MAX_CRF);
  });

  it('keeps a CRF that is already finer than the master target', () => {
    const config = getEditedMasterFfmpegConfig({ ...ffmpeg, crf: 12 }, sdrStream);
    expect(config.crf).toBe(12);
  });

  it('removes the playback bitrate ceiling and its two-pass rate control', () => {
    const config = getEditedMasterFfmpegConfig({ ...ffmpeg, maxBitrate: '4500k', twoPass: true }, sdrStream);
    expect(config.maxBitrate).toBe('0');
    expect(config.twoPass).toBe(false);
  });

  it('promotes H.264 to HEVC when the source carries more than 8 bits per component', () => {
    const config = getEditedMasterFfmpegConfig({ ...ffmpeg, targetVideoCodec: VideoCodec.H264 }, hdrStream);
    expect(config.targetVideoCodec).toBe(VideoCodec.Hevc);
  });

  it('leaves the codec alone for an 8-bit source', () => {
    const config = getEditedMasterFfmpegConfig({ ...ffmpeg, targetVideoCodec: VideoCodec.H264 }, sdrStream);
    expect(config.targetVideoCodec).toBe(VideoCodec.H264);
  });

  it('leaves the preset alone, which trades encoding time rather than the quality target', () => {
    const config = getEditedMasterFfmpegConfig({ ...ffmpeg, preset: 'ultrafast' }, sdrStream);
    expect(config.preset).toBe('ultrafast');
  });
});

describe('isHighBitDepth', () => {
  it.each(['yuv420p10le', 'yuv422p10le', 'yuv444p12le', 'p010le', 'p016be'])('detects %s', (pixelFormat) => {
    expect(isHighBitDepth({ pixelFormat })).toBe(true);
  });

  it.each(['yuv420p', 'yuvj420p', 'nv12', 'rgb24'])('does not flag %s', (pixelFormat) => {
    expect(isHighBitDepth({ pixelFormat })).toBe(false);
  });
});

describe('applyEditedMasterPixelFormatPolicy', () => {
  it('rewrites the playback 8-bit conversion to its 10-bit equivalent when preserving a 10-bit source', () => {
    expect(applyEditedMasterPixelFormatPolicy(['format=yuv420p'], hdrStream, preserve)).toEqual([
      `format=${EDITED_MASTER_HIGH_BIT_DEPTH_FORMAT}`,
    ]);
  });

  it('leaves the chain alone when the render deliberately tone maps', () => {
    expect(applyEditedMasterPixelFormatPolicy(['format=yuv420p'], hdrStream, toneMap)).toEqual(['format=yuv420p']);
  });

  it('leaves the chain alone for an 8-bit source', () => {
    expect(applyEditedMasterPixelFormatPolicy(['format=yuv420p'], sdrStream, preserve)).toEqual(['format=yuv420p']);
  });

  it('does not disturb other filters', () => {
    expect(applyEditedMasterPixelFormatPolicy(['scale=-2:1080', 'format=yuv420p'], hdrStream, preserve)).toEqual([
      'scale=-2:1080',
      `format=${EDITED_MASTER_HIGH_BIT_DEPTH_FORMAT}`,
    ]);
  });
});

describe('resolveEditedMasterColorPolicy', () => {
  it('preserves an SDR source', () => {
    expect(resolveEditedMasterColorPolicy(sdrStream, ffmpeg).policy).toBe(EditedMasterColorPolicy.Preserve);
  });

  it('records a tone map as a deliberate decision rather than performing it silently', () => {
    const decision = resolveEditedMasterColorPolicy(hdrStream, { tonemap: ToneMapping.Hable });
    expect(decision.policy).toBe(EditedMasterColorPolicy.ToneMap);
    expect(decision.reason).toContain('hable');
  });

  it('carries HDR through when tone mapping is disabled', () => {
    const decision = resolveEditedMasterColorPolicy(hdrStream, { tonemap: ToneMapping.Disabled });
    expect(decision.policy).toBe(EditedMasterColorPolicy.Preserve);
  });

  it('refuses Dolby Vision profile 5, which has no qualified edited-master path', () => {
    try {
      resolveEditedMasterColorPolicy({ ...hdrStream, dvProfile: DvProfile.Dvhe05 }, ffmpeg);
      expect.unreachable('expected a policy error');
    } catch (error) {
      expect((error as MediaPolicyError).code).toBe(MediaPolicyViolation.UnsupportedPreservation);
    }
  });

  it('allows a Dolby Vision profile that has a usable base layer', () => {
    expect(() => resolveEditedMasterColorPolicy(dolbyVisionStream, ffmpeg)).not.toThrow();
  });
});

describe('getEditedMasterTimingArgs', () => {
  it('pins the frame timing to passthrough so a variable-rate source is never resampled', () => {
    expect(getEditedMasterTimingArgs(sdrStream)).toEqual(expect.arrayContaining(['-fps_mode', 'passthrough']));
  });

  it('pins the output timescale to the source time base', () => {
    expect(getEditedMasterTimingArgs({ timeBase: 600 })).toEqual([
      '-fps_mode',
      'passthrough',
      '-video_track_timescale',
      '600',
    ]);
  });

  it('omits the timescale when the source time base is unknown', () => {
    expect(getEditedMasterTimingArgs({ timeBase: null })).toEqual(['-fps_mode', 'passthrough']);
  });

  it('never emits a constant-frame-rate mode on its own', () => {
    expect(getEditedMasterTimingArgs(sdrStream)).not.toContain('cfr');
  });

  // FL-93
  it('takes the timescale from the exact time base rather than the persisted denominator', () => {
    expect(getEditedMasterTimingArgs({ timeBase: 30_000, timeBaseRational: { num: 1, den: 30_000 } })).toEqual([
      '-fps_mode',
      'passthrough',
      '-video_track_timescale',
      '30000',
    ]);
    // A time base that carries a numerator still gets a grid every tick lands on exactly.
    expect(getEditedMasterTimingArgs({ timeBase: 30_000, timeBaseRational: { num: 1001, den: 30_000 } })).toEqual([
      '-fps_mode',
      'passthrough',
      '-video_track_timescale',
      '30000',
    ]);
  });

  it('passes the source timing through when a declared cadence is the one it already has', () => {
    const decision = {
      mode: OutputCadenceMode.Passthrough,
      cadence: null,
      reason: 'test',
    };

    expect(getEditedMasterTimingArgs({ timeBase: 600 }, decision)).toEqual([
      '-fps_mode',
      'passthrough',
      '-video_track_timescale',
      '600',
    ]);
  });

  it('writes a requested cadence conversion as an exact rational, never as 29.97', () => {
    const decision = {
      mode: OutputCadenceMode.Convert,
      cadence: FRAME_RATE_NTSC_30,
      reason: 'test',
    };

    expect(getEditedMasterTimingArgs({ timeBase: 30_000 }, decision)).toEqual([
      '-fps_mode',
      'cfr',
      '-r',
      '30000/1001',
      '-video_track_timescale',
      '30000',
    ]);
  });
});

describe('getEditedMasterColorArgs', () => {
  it('tags the source colour volume when it is preserved', () => {
    expect(getEditedMasterColorArgs(hdrStream, preserve)).toEqual([
      '-color_primaries',
      'bt2020',
      '-color_trc',
      'smpte2084',
      '-colorspace',
      'bt2020nc',
    ]);
  });

  it('tags the tone-mapped result rather than the source it came from', () => {
    expect(getEditedMasterColorArgs(hdrStream, toneMap)).toEqual([
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt709',
    ]);
  });

  it('leaves unknown tags off rather than guessing at them', () => {
    const unknown = {
      colorPrimaries: ColorPrimaries.Unknown,
      colorTransfer: ColorTransfer.Unknown,
      colorMatrix: ColorMatrix.Unknown,
    };
    expect(getEditedMasterColorArgs(unknown, preserve)).toEqual([]);
  });

  it('tags only a range the filter graph converted to, and never a tone-mapped result (FL-102)', () => {
    const fullRange = { ...hdrStream, colorRange: 'pc' as const };
    expect(getEditedMasterColorArgs(fullRange, preserve, 'pc')).toEqual(expect.arrayContaining(['-color_range', 'pc']));
    // The source's own range is not enough: without a stated conversion the pixels' range is unknown.
    expect(getEditedMasterColorArgs(fullRange, preserve)).not.toContain('-color_range');
    expect(getEditedMasterColorArgs(fullRange, toneMap, 'pc')).not.toContain('-color_range');
  });
});

describe('parseFfprobeColorRange (FL-102)', () => {
  it('reads both spellings ffprobe uses and leaves anything else unstated', () => {
    expect(parseFfprobeColorRange('tv')).toBe('tv');
    expect(parseFfprobeColorRange('mpeg')).toBe('tv');
    expect(parseFfprobeColorRange('pc')).toBe('pc');
    expect(parseFfprobeColorRange('jpeg')).toBe('pc');
    expect(parseFfprobeColorRange('unknown')).toBeNull();
    expect(parseFfprobeColorRange(undefined)).toBeNull();
  });
});

describe('getEditedMasterColorRange (FL-102)', () => {
  it('keeps the range the source states when the colour volume is preserved', () => {
    expect(getEditedMasterColorRange({ colorRange: 'pc' }, preserve)).toBe('pc');
    expect(getEditedMasterColorRange({ colorRange: 'tv' }, preserve)).toBe('tv');
  });

  it('delivers limited range for a tone-mapped render or a source that does not say', () => {
    expect(getEditedMasterColorRange({ colorRange: 'pc' }, toneMap)).toBe('tv');
    expect(getEditedMasterColorRange({ colorRange: null }, preserve)).toBe('tv');
    expect(getEditedMasterColorRange({}, preserve)).toBe('tv');
  });
});

describe('applyEditedMasterAudioPolicy', () => {
  const aac = { index: 1, codecName: 'aac', bitrate: 100, profile: null };

  it('removes the playback stereo downmix', () => {
    const options = ['-c:v', 'h264', '-c:a', 'aac', '-map', '0:0', '-map', '0:1', '-ac', '2'];
    applyEditedMasterAudioPolicy(options, { audioStream: aac, hasAudioFilters: false, muted: false });
    expect(options).not.toContain('-ac');
    expect(options).not.toContain('2');
  });

  it('stream-copies an untouched track so its layout survives exactly', () => {
    const options = ['-c:v', 'h264', '-c:a', 'aac', '-ac', '2'];
    const result = applyEditedMasterAudioPolicy(options, { audioStream: aac, hasAudioFilters: false, muted: false });
    expect(result.streamCopy).toBe(true);
    expect(options).toEqual(['-c:v', 'h264', '-c:a', 'copy']);
  });

  it('re-encodes when the recipe touches audio, and still does not force stereo', () => {
    const options = ['-c:v', 'h264', '-c:a', 'aac', '-ac', '2'];
    const result = applyEditedMasterAudioPolicy(options, { audioStream: aac, hasAudioFilters: true, muted: false });
    expect(result.streamCopy).toBe(false);
    expect(options).toEqual(['-c:v', 'h264', '-c:a', 'aac']);
    expect(result.args).not.toContain('-ac');
  });

  it('does not stream-copy a codec the master container cannot hold', () => {
    const options = ['-c:v', 'h264', '-c:a', 'aac', '-ac', '2'];
    const result = applyEditedMasterAudioPolicy(options, {
      audioStream: { ...aac, codecName: 'opus' },
      hasAudioFilters: false,
      muted: false,
    });
    expect(result.streamCopy).toBe(false);
    expect(options).toContain('aac');
  });

  it('pins a known channel layout and sample rate when it must re-encode', () => {
    const options = ['-c:a', 'aac', '-ac', '2'];
    const result = applyEditedMasterAudioPolicy(options, {
      audioStream: { ...aac, channels: 6, channelLayout: '5.1', sampleRate: 48_000 },
      hasAudioFilters: true,
      muted: false,
    });
    expect(result.args).toEqual(['-ac', '6', '-channel_layout', '5.1', '-ar', '48000']);
  });

  it('adds nothing for a muted recipe', () => {
    const options = ['-c:a', 'aac', '-ac', '2'];
    const result = applyEditedMasterAudioPolicy(options, { audioStream: aac, hasAudioFilters: false, muted: true });
    expect(result).toEqual({ streamCopy: false, args: [] });
    expect(options).toEqual(['-c:a', 'aac']);
  });

  it('adds nothing when the source has no audio', () => {
    const options = ['-c:v', 'h264'];
    const result = applyEditedMasterAudioPolicy(options, { hasAudioFilters: false, muted: false });
    expect(result).toEqual({ streamCopy: false, args: [] });
  });
});

describe('qualifyMetadataOnlyRotation', () => {
  const mp4 = { formatName: 'mov,mp4,m4a,3gp,3g2,mj2' };
  const h264 = { codecName: 'h264', rotation: 0 };
  const aac = { codecName: 'aac' };

  it('qualifies a lone right-angle rotation of a remuxable source', () => {
    expect(qualifyMetadataOnlyRotation({ edits: [rotate], videoStream: h264, audioStream: aac, format: mp4 })).toEqual({
      angle: 90,
      displayRotation: -90,
    });
  });

  it('qualifies without an audio track', () => {
    expect(qualifyMetadataOnlyRotation({ edits: [rotate], videoStream: h264, format: mp4 })).not.toBeNull();
  });

  it('does not qualify when the recipe also changes the pixels', () => {
    const edits = [rotate, crop];
    expect(qualifyMetadataOnlyRotation({ edits, videoStream: h264, audioStream: aac, format: mp4 })).toBeNull();
  });

  it('does not qualify a non-right-angle recipe', () => {
    const straighten: AssetEditActionItem = { action: AssetEditAction.Straighten, parameters: { angle: 3 } };
    expect(qualifyMetadataOnlyRotation({ edits: [straighten], videoStream: h264, format: mp4 })).toBeNull();
  });

  it('does not qualify when the source already carries a display matrix to compose with', () => {
    expect(
      qualifyMetadataOnlyRotation({ edits: [rotate], videoStream: { ...h264, rotation: 90 }, format: mp4 }),
    ).toBeNull();
  });

  it('does not qualify a video codec the master container cannot hold', () => {
    expect(
      qualifyMetadataOnlyRotation({ edits: [rotate], videoStream: { ...h264, codecName: 'vp9' }, format: mp4 }),
    ).toBeNull();
  });

  it('does not qualify an audio codec the master container cannot hold', () => {
    expect(
      qualifyMetadataOnlyRotation({
        edits: [rotate],
        videoStream: h264,
        audioStream: { codecName: 'opus' },
        format: mp4,
      }),
    ).toBeNull();
  });

  it('does not qualify a container whose packets cannot be remuxed', () => {
    expect(
      qualifyMetadataOnlyRotation({ edits: [rotate], videoStream: h264, format: { formatName: 'matroska,webm' } }),
    ).toBeNull();
  });

  it.each([
    [90, -90],
    [180, 180],
    [270, 90],
  ])('turns a %i degree clockwise recipe into %i degrees counter-clockwise', (angle, displayRotation) => {
    const edit: AssetEditActionItem = { action: AssetEditAction.Rotate, parameters: { angle } };
    expect(qualifyMetadataOnlyRotation({ edits: [edit], videoStream: h264, format: mp4 })).toEqual({
      angle,
      displayRotation,
    });
  });
});

describe('computeRecipeRevision', () => {
  it('is stable for the same recipe', () => {
    expect(computeRecipeRevision([crop, rotate])).toBe(computeRecipeRevision([crop, rotate]));
  });

  it('is independent of the key order the parameters were serialised in', () => {
    const reordered: AssetEditActionItem = {
      action: AssetEditAction.Crop,
      parameters: { height: 200, width: 300, y: 4, x: 2 },
    };
    expect(computeRecipeRevision([reordered])).toBe(computeRecipeRevision([crop]));
  });

  it('changes when a parameter changes', () => {
    const wider: AssetEditActionItem = {
      action: AssetEditAction.Crop,
      parameters: { x: 2, y: 4, width: 301, height: 200 },
    };
    expect(computeRecipeRevision([wider])).not.toBe(computeRecipeRevision([crop]));
  });

  it('changes when the actions are reordered, because the render order differs', () => {
    expect(computeRecipeRevision([rotate, crop])).not.toBe(computeRecipeRevision([crop, rotate]));
  });

  it('gives an empty recipe its own stable revision', () => {
    expect(computeRecipeRevision([])).toBe(computeRecipeRevision([]));
  });
});

describe('buildEditedMasterLineage', () => {
  const lineage = buildEditedMasterLineage({
    sourceAssetId: 'asset-id',
    sourceOriginalPath: '/library/a.mp4',
    sourceChecksum: 'Y2hlY2tzdW0=',
    edits: [crop, rotate],
    color: preserve,
    createdAt: new Date('2026-09-22T00:00:00.000Z'),
  });

  it('records the source asset and the original it was rendered from', () => {
    expect(lineage.sourceAssetId).toBe('asset-id');
    expect(lineage.sourceOriginalPath).toBe('/library/a.mp4');
    expect(lineage.sourceChecksum).toBe('Y2hlY2tzdW0=');
  });

  it('records the recipe revision and the ordered actions', () => {
    expect(lineage.recipeRevision).toBe(computeRecipeRevision([crop, rotate]));
    expect(lineage.recipeActions).toEqual([AssetEditAction.Crop, AssetEditAction.Rotate]);
  });

  it('records the renderer identity so a stale master can be recognised', () => {
    expect(lineage.renderer).toBe(FRAMELEAF_RENDERER);
    expect(lineage.rendererVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('records the colour decision so a loss is never silent', () => {
    expect(lineage.color).toEqual(preserve);
  });

  it('stamps the render time', () => {
    expect(lineage.createdAt).toBe('2026-09-22T00:00:00.000Z');
  });

  it('records how a video source was qualified for decoding only when given one (FL-101)', () => {
    expect(lineage.decode).toBeUndefined();
    const video = buildEditedMasterLineage({
      sourceAssetId: 'asset-id',
      sourceOriginalPath: '/library/a.mp4',
      edits: [crop],
      color: preserve,
      decode: { matrixEntry: null, support: DecodeSupport.Supported, reason: 'outside the advertised tested matrix' },
    });
    expect(video.decode).toEqual({
      matrixEntry: null,
      support: 'supported',
      reason: 'outside the advertised tested matrix',
    });
  });
});

describe('getEditedMasterLineagePath', () => {
  it('sits beside the master it describes', () => {
    expect(getEditedMasterLineagePath('/encoded/a_edited.mp4')).toBe('/encoded/a_edited.mp4.lineage.json');
  });
});

describe('getDeliveryAudioChannelArgs', () => {
  const surround = { channels: 6, channelLayout: '5.1', sampleRate: 48_000 };

  it('emits exactly one stereo downmix when the target asks for one', () => {
    expect(getDeliveryAudioChannelArgs(surround, AudioChannelPolicy.DownmixStereo)).toEqual(['-ac', '2']);
  });

  it('downmixes on request even when nothing is known about the source', () => {
    expect(getDeliveryAudioChannelArgs(undefined, AudioChannelPolicy.DownmixStereo)).toEqual(['-ac', '2']);
  });

  it('pins the probed channel count, layout and sample rate when preserving', () => {
    expect(getDeliveryAudioChannelArgs(surround, AudioChannelPolicy.Preserve)).toEqual([
      '-ac',
      '6',
      '-channel_layout',
      '5.1',
      '-ar',
      '48000',
    ]);
  });

  it('preserves a 7.1 layout', () => {
    const track = { channels: 8, channelLayout: '7.1', sampleRate: 96_000 };
    expect(getDeliveryAudioChannelArgs(track, AudioChannelPolicy.Preserve)).toEqual([
      '-ac',
      '8',
      '-channel_layout',
      '7.1',
      '-ar',
      '96000',
    ]);
  });

  it('preserves a mono track', () => {
    const track = { channels: 1, channelLayout: 'mono', sampleRate: 44_100 };
    expect(getDeliveryAudioChannelArgs(track, AudioChannelPolicy.Preserve)).toEqual([
      '-ac',
      '1',
      '-channel_layout',
      'mono',
      '-ar',
      '44100',
    ]);
  });

  it('emits nothing at all for facts it does not know, rather than a silent downmix', () => {
    const unknown = { channels: null, channelLayout: null, sampleRate: null };
    expect(getDeliveryAudioChannelArgs(unknown, AudioChannelPolicy.Preserve)).toEqual([]);
    expect(getDeliveryAudioChannelArgs({}, AudioChannelPolicy.Preserve)).toEqual([]);
    expect(getDeliveryAudioChannelArgs(undefined, AudioChannelPolicy.Preserve)).toEqual([]);
  });

  it('skips a zero channel count or sample rate', () => {
    const zeroed = { channels: 0, channelLayout: '5.1', sampleRate: 0 };
    expect(getDeliveryAudioChannelArgs(zeroed, AudioChannelPolicy.Preserve)).toEqual(['-channel_layout', '5.1']);
  });
});

describe('getFfmpegColorMatrixName', () => {
  it('names the matrices ffmpeg accepts', () => {
    expect(getFfmpegColorMatrixName(ColorMatrix.Bt709)).toBe('bt709');
    expect(getFfmpegColorMatrixName(ColorMatrix.Bt2020Nc)).toBe('bt2020nc');
  });

  it('returns null rather than a guess for a code point with no name', () => {
    expect(getFfmpegColorMatrixName(ColorMatrix.Unknown)).toBeNull();
    expect(getFfmpegColorMatrixName(ColorMatrix.Reserved)).toBeNull();
  });
});

describe('validateVideoMaster (FL-39)', () => {
  const preserve = { policy: EditedMasterColorPolicy.Preserve, reason: 'Source is SDR.' };
  const toneMap = { policy: EditedMasterColorPolicy.ToneMap, reason: 'tone mapped' };
  const source = { ...sdrStream, width: 3840, height: 2160, rotation: 0 };
  const expectViolation = (run: () => void, message: string) => {
    expect(run).toThrow(MediaPolicyError);
    expect(run).toThrow(message);
  };

  it('accepts a baked master whose raster matches the recipe', () => {
    expect(() =>
      validateVideoMaster({
        source,
        output: { ...source, width: 2160, height: 3840 },
        dimensions: { width: 2160, height: 3840 },
        colorDecision: preserve,
      }),
    ).not.toThrow();
  });

  it('validates the displayed raster and stored rotation of a packet-preserving quarter turn', () => {
    const rotated = { ...source, rotation: -90 };
    const dimensions = { width: 2160, height: 3840 };
    const check = (output: typeof rotated, expectedRotation?: number) => () =>
      validateVideoMaster({ source, output, dimensions, expectedRotation, colorDecision: preserve, packetCopy: true });

    expect(check(rotated, -90)).not.toThrow();
    expectViolation(check({ ...rotated, rotation: 90 }, -90), 'dimensions');
    expectViolation(check(rotated), 'dimensions');
    expectViolation(check({ ...rotated, width: 1920 }, -90), 'dimensions');
    expectViolation(check({ ...rotated, pixelFormat: 'yuv420p10le' }, -90), 'packet copy');
    expectViolation(check({ ...rotated, colorTransfer: ColorTransfer.Smpte2084 }, -90), 'packet copy');
  });

  it('rejects a missing master stream', () => {
    expectViolation(
      () => validateVideoMaster({ source, output: undefined, dimensions: source, colorDecision: preserve }),
      'dimensions',
    );
  });

  it('keeps precision and declared colour intent when preserving', () => {
    const hdr = {
      ...source,
      pixelFormat: 'yuv420p10le',
      colorTransfer: ColorTransfer.Smpte2084,
      colorPrimaries: ColorPrimaries.Bt2020,
      colorMatrix: ColorMatrix.Bt2020Nc,
    };
    const check = (output: Partial<typeof hdr>) => () =>
      validateVideoMaster({ source: hdr, output: { ...hdr, ...output }, dimensions: hdr, colorDecision: preserve });

    expect(check({})).not.toThrow();
    // a different high-precision layout is still a preserving delivery
    expect(check({ pixelFormat: 'yuv422p10le' })).not.toThrow();
    expectViolation(check({ pixelFormat: 'yuv420p' }), 'precision');
    expectViolation(check({ colorTransfer: ColorTransfer.Bt709 }), 'color intent');
  });

  it('does not invent colour intent the source never declared', () => {
    const untagged = { ...source, colorPrimaries: ColorPrimaries.Unknown, colorTransfer: ColorTransfer.Unknown };
    expect(() =>
      validateVideoMaster({
        source: untagged,
        output: { ...untagged, colorPrimaries: ColorPrimaries.Bt709, colorTransfer: ColorTransfer.Bt709 },
        dimensions: untagged,
        colorDecision: preserve,
      }),
    ).not.toThrow();
  });

  it('requires a tone-mapped master to leave HDR', () => {
    const hdr = { ...source, pixelFormat: 'yuv420p10le', colorTransfer: ColorTransfer.Smpte2084 };
    const check = (output: Partial<typeof hdr>) => () =>
      validateVideoMaster({ source: hdr, output: { ...hdr, ...output }, dimensions: hdr, colorDecision: toneMap });

    expect(check({ pixelFormat: 'yuv420p', colorTransfer: ColorTransfer.Bt709 })).not.toThrow();
    expectViolation(check({ pixelFormat: 'yuv420p' }), 'HDR');
  });
});
