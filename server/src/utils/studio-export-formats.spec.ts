import { describe, expect, it } from 'vitest';
import { ColorTransfer } from 'src/enum.js';
import {
  EMBEDDED_PROFILE,
  RenderOutputRefusal,
  SDR_ONLY,
  SIDECAR_PROFILE,
  evaluateRenderOutput,
  provesOutput,
  requiredOutput,
} from 'src/utils/render-admission.js';
import {
  StudioEmbeddedSubtitleSealSchema,
  findEmbeddedSubtitleMismatch,
  sealStudioEmbeddedSubtitles,
} from 'src/utils/studio-embedded-subtitles.js';
import { buildStudioExportContract, findStudioExportOutputMismatch } from 'src/utils/studio-export-contract.js';
import {
  STUDIO_EXPORT_FORMAT_SPECS,
  isStudioAudioFormat,
  studioExportAudioProblem,
  studioExportFormatSpec,
} from 'src/utils/studio-export-formats.js';
import { STUDIO_EXPORT_CONTENT_TYPES, STUDIO_EXPORT_FORMATS } from 'src/utils/studio-export.js';

/** What the bundled worker advertises after encoding every format at admission (studio/tools). */
const bundled = {
  codecs: [
    'webcodecs-avc',
    'aac',
    'libx265',
    'libsvtav1',
    'libvpx',
    'libvpx-vp9',
    'prores_ks',
    'libmp3lame',
    'pcm_s16le',
    'libopus',
    'mov_text',
    'subrip',
    'webvtt',
  ],
  formats: [
    'mp4',
    'mov',
    'mkv',
    'webm',
    'mp3',
    'm4a',
    'wav',
    ...Object.entries(STUDIO_EXPORT_FORMAT_SPECS)
      .filter(([, spec]) => spec.combination)
      .map(([format]) => format),
    'mp4-h264',
    SIDECAR_PROFILE,
    EMBEDDED_PROFILE,
  ],
};
const candidate = { gpuMemoryBytes: 4 * 1024 ** 3, ...bundled, colorPrecision: SDR_ONLY, engineDigest: 'e'.repeat(40) };
const request = (format: string, extra: Record<string, unknown> = {}) => ({
  format,
  color: 'preserve',
  resolution: '1080p',
  ...extra,
});

describe('the FL-105 export matrix', () => {
  it('lists every format once, with a container type the library or the project can hold', () => {
    expect(new Set(STUDIO_EXPORT_FORMATS).size).toBe(STUDIO_EXPORT_FORMATS.length);
    // The original seven keep their order (OpenAPI enum and stored settings).
    expect(STUDIO_EXPORT_FORMATS.slice(0, 7)).toEqual([
      'mp4-hevc-main10',
      'mp4-h264',
      'webm-av1',
      'prores-422-hq',
      'sdr-jpeg',
      'hdr-jpeg',
      'hdr-heic',
    ]);
    for (const format of STUDIO_EXPORT_FORMATS) {
      const spec = studioExportFormatSpec(format)!;
      expect(STUDIO_EXPORT_CONTENT_TYPES[spec.contentType], format).toMatchObject({ extension: spec.extension });
    }
    expect(studioExportFormatSpec('toString')).toBeNull();
    expect(isStudioAudioFormat('audio-wav')).toBe(true);
    expect(isStudioAudioFormat('mp4-h264')).toBe(false);
  });

  it.each(
    Object.entries(STUDIO_EXPORT_FORMAT_SPECS)
      .filter(([, spec]) => spec.combination)
      .map(([format]) => format),
  )('%s is offered only when the worker advertised that exact combination', (format) => {
    const output = requiredOutput({ format })!;
    expect(provesOutput(bundled, output)).toBe(true);
    // Codec and container evidence measured apart never stands in for the combination.
    expect(provesOutput({ ...bundled, formats: bundled.formats.filter((entry) => entry !== format) }, output)).toBe(
      false,
    );
    expect(evaluateRenderOutput([candidate], request(format))).toEqual({ supported: true });
  });

  it('keeps the original formats on their original evidence rule', () => {
    expect(provesOutput({ codecs: ['webcodecs-avc'], formats: ['mp4'] }, requiredOutput({ format: 'mp4-h264' })!)).toBe(
      true,
    );
    expect(
      provesOutput({ codecs: ['libx265'], formats: ['mp4'] }, requiredOutput({ format: 'mp4-hevc-main10' })!),
    ).toBe(true);
    expect(provesOutput({ codecs: ['libx265'], formats: ['mp4'] }, requiredOutput({ format: 'mp4-hevc' })!)).toBe(
      false,
    );
  });

  it('explains why an 8-bit worker cannot take a 10-bit format or an HDR picture kept as is', () => {
    for (const format of ['mp4-hevc-main10', 'webm-av1', 'prores-422-hq']) {
      expect(
        evaluateRenderOutput(
          [{ ...candidate, codecs: ['libx265', 'libsvtav1', 'prores_ks'], formats: ['mp4', 'webm', 'mov'] }],
          request(format),
        ),
      ).toEqual({
        supported: false,
        refusal: RenderOutputRefusal.IncompatibleColor,
      });
    }
    expect(evaluateRenderOutput([candidate], request('mkv-vp9', { minBitDepth: 10 }))).toEqual({
      supported: false,
      refusal: RenderOutputRefusal.IncompatibleColor,
    });
    const tenBit = { ...candidate, colorPrecision: { maxBitDepth: 10, hdr10: false, dolbyVision: false } };
    expect(evaluateRenderOutput([tenBit], request('mkv-vp9', { minBitDepth: 10 }))).toEqual({ supported: true });
    expect(evaluateRenderOutput([candidate], request('mkv-vp9', { color: 'hdr10' }))).toEqual({
      supported: false,
      refusal: RenderOutputRefusal.IncompatibleColor,
    });
  });

  it('pairs captions with every SDR video format at any resolution, through the container text track', () => {
    for (const [format, spec] of Object.entries(STUDIO_EXPORT_FORMAT_SPECS)) {
      const sdrVideo = spec.kind === 'video' && spec.bitDepth === 8;
      for (const subtitleMode of ['sidecar', 'embedded']) {
        const output = requiredOutput(request(format, { subtitleMode }))!;
        expect(provesOutput(bundled, output), `${format} ${subtitleMode}`).toBe(sdrVideo);
      }
    }
    const mkv = requiredOutput(request('mkv-vp9', { subtitleMode: 'embedded' }))!;
    expect(mkv).toMatchObject({ subtitleCodec: 'subrip', profiles: [EMBEDDED_PROFILE] });
    expect(provesOutput({ ...bundled, codecs: bundled.codecs.filter((codec) => codec !== 'subrip') }, mkv)).toBe(false);
    expect(requiredOutput(request('webm-vp9', { subtitleMode: 'embedded' }))).toMatchObject({
      subtitleCodec: 'webvtt',
    });
    // A worker with only the v2 profiles never stands in for one without them.
    expect(
      provesOutput(
        { ...bundled, formats: bundled.formats.filter((format) => format !== SIDECAR_PROFILE) },
        requiredOutput(request('mkv-h264', { subtitleMode: 'sidecar' }))!,
      ),
    ).toBe(false);
    // The 720p MP4/H.264 legacy profile still proves its own tuple.
    const legacy = { codecs: ['webcodecs-avc'], formats: ['mp4', 'mp4-h264+srt-sidecar-v1'] };
    expect(
      provesOutput(
        legacy,
        requiredOutput({ ...request('mp4-h264', { subtitleMode: 'sidecar' }), resolution: '720p' })!,
      ),
    ).toBe(true);
    expect(provesOutput(legacy, requiredOutput(request('mp4-h264', { subtitleMode: 'sidecar' }))!)).toBe(false);
  });

  it('judges sound alone at the smallest picture budget, whatever resolution is named', () => {
    const small = { ...candidate, gpuMemoryBytes: 2 * 1024 ** 3 };
    expect(evaluateRenderOutput([small], request('audio-wav', { resolution: '2160p' }))).toEqual({ supported: true });
    expect(evaluateRenderOutput([small], request('mkv-vp9', { resolution: '2160p' }))).toEqual({
      supported: false,
      refusal: RenderOutputRefusal.InsufficientMemory,
    });
  });

  it('gives sound alone no captions', () => {
    expect(provesOutput(bundled, requiredOutput(request('audio-aac'))!)).toBe(true);
    expect(provesOutput(bundled, requiredOutput(request('audio-aac', { subtitleMode: 'off' }))!)).toBe(true);
    for (const subtitleMode of ['burn', 'sidecar', 'embedded']) {
      expect(provesOutput(bundled, requiredOutput(request('audio-aac', { subtitleMode }))!)).toBe(false);
    }
  });
});

describe('sound-only exports (FL-105)', () => {
  const stereo = { policy: 'preserve', channels: 2, sampleRate: 48_000 };
  it('explains, before queueing, sound a format cannot carry unchanged', () => {
    expect(studioExportAudioProblem('mp4-h264', null)).toBeNull();
    expect(studioExportAudioProblem('audio-wav', null)).toMatch(/no sound/);
    expect(studioExportAudioProblem('audio-mp3', stereo)).toBeNull();
    expect(studioExportAudioProblem('audio-mp3', { ...stereo, channels: 6 })).toMatch(/at most two channels.*Stereo/);
    expect(studioExportAudioProblem('audio-mp3', { ...stereo, channels: 6, policy: 'stereo' })).toBeNull();
    expect(studioExportAudioProblem('audio-mp3', { ...stereo, sampleRate: 96_000 })).toMatch(/96000 Hz.*WAV/);
    expect(studioExportAudioProblem('audio-aac', { ...stereo, sampleRate: 96_000 })).toBeNull();
    expect(studioExportAudioProblem('audio-wav', { ...stereo, sampleRate: 192_000 })).toBeNull();
  });

  it('promises the sources sound and no picture transfer', () => {
    const graph = {
      metadata: { fps: 30 },
      timeline: {
        tracks: [{ id: 'a' }],
        items: [{ id: 'x', type: 'audio', trackId: 'a', mediaId: 'm', from: 0, durationInFrames: 30 }],
      },
    };
    const contract = buildStudioExportContract({ format: 'audio-wav', color: 'preserve' }, graph, [
      {
        assetId: 'm',
        video: { timeBase: 30_000, pixelFormat: 'yuv420p10le', colorTransfer: ColorTransfer.AribStdB67 },
        audio: { codecName: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 44_100 },
      } as never,
    ]);
    expect(contract.video).toEqual({ minBitDepth: 8, transfer: null });
    expect(contract.audio).toMatchObject({ channels: 2, sampleRate: 44_100 });
  });

  it('holds the result to one stream of the promised codec carrying the promised sound', () => {
    const contract = {
      video: { minBitDepth: 8 as const, transfer: null },
      audio: { policy: 'preserve' as const, channels: 2, channelLayout: 'stereo', sampleRate: 48_000 },
    };
    const audio = { codecName: 'mp3', channels: 2, channelLayout: 'stereo', sampleRate: 48_000, duration: 4 };
    const probe = (streams: Record<string, unknown>[], video: Record<string, unknown>[] = []) => ({
      videoStreams: video as never[],
      audioStreams: streams as never[],
    });
    expect(findStudioExportOutputMismatch(contract, probe([audio]), 'audio-mp3')).toBeNull();
    expect(findStudioExportOutputMismatch(contract, probe([audio], [{ codecName: 'h264' }]), 'audio-mp3')).toMatch(
      'also contains a picture',
    );
    expect(findStudioExportOutputMismatch(contract, probe([]), 'audio-mp3')).toMatch('0 audio streams');
    expect(findStudioExportOutputMismatch(contract, probe([{ ...audio, codecName: 'aac' }]), 'audio-mp3')).toMatch(
      'audio codec is aac',
    );
    expect(findStudioExportOutputMismatch(contract, probe([{ ...audio, channels: 1 }]), 'audio-mp3')).toMatch(
      '1 audio channels instead of 2',
    );
    expect(findStudioExportOutputMismatch(contract, probe([{ ...audio, sampleRate: 44_100 }]), 'audio-mp3')).toMatch(
      'sample rate',
    );
    expect(findStudioExportOutputMismatch(contract, probe([{ ...audio, duration: 0 }]), 'audio-mp3')).toMatch(
      'no measurable sound',
    );
    expect(
      findStudioExportOutputMismatch(contract, probe([{ ...audio, codecName: 'pcm_s16le' }]), 'audio-wav'),
    ).toBeNull();
    expect(findStudioExportOutputMismatch({ ...contract, audio: null }, probe([audio]), 'audio-mp3')).toMatch(
      'needs sound',
    );
  });

  it('holds every new video format to its own codec', () => {
    const contract = { video: { minBitDepth: 8 as const, transfer: null }, audio: null };
    for (const [format, spec] of Object.entries(STUDIO_EXPORT_FORMAT_SPECS)) {
      if (spec.kind !== 'video' || !spec.combination) continue;
      const output = (codecName: string) => ({
        videoStreams: [{ codecName, pixelFormat: spec.codec === 'prores' ? 'yuv422p10le' : 'yuv420p' } as never],
        audioStreams: [],
      });
      expect(findStudioExportOutputMismatch(contract, output(spec.codec), format), format).toBeNull();
      expect(findStudioExportOutputMismatch(contract, output('mpeg4'), format), format).toMatch('video codec');
    }
  });
});

describe('embedded caption tracks per container (FL-105)', () => {
  const binding = { revisionDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), engineDigest: 'c'.repeat(40) };
  const graph = {
    metadata: { fps: 24 },
    timeline: {
      tracks: [{ id: 'c', visible: true }],
      items: [
        {
          id: 'c',
          type: 'text',
          textRole: 'caption',
          captionSource: { type: 'subtitle-import' },
          trackId: 'c',
          from: 0,
          durationInFrames: 48,
          text: 'Caption',
        },
      ],
      transitions: [],
      keyframes: [],
    },
  };

  it.each([
    ['mp4-h264', 'mp4', 'mov_text'],
    ['mov-prores-422', 'mov', 'mov_text'],
    ['mkv-av1', 'mkv', 'subrip'],
    ['webm-vp9', 'webm', 'webvtt'],
  ])('seals %s with the %s text track', (format, container, codec) => {
    const seal = sealStudioEmbeddedSubtitles(graph, binding, undefined, format);
    expect(seal).toMatchObject({
      container,
      codec,
      language: 'und',
      source: { cueCount: 1, engineDigest: 'c'.repeat(40) },
    });
    expect(
      StudioEmbeddedSubtitleSealSchema.safeParse({ ...seal, codec: codec === 'webvtt' ? 'subrip' : 'webvtt' }).success,
    ).toBe(false);
  });

  it('refuses a format without a caption track', () => {
    for (const format of ['audio-mp3', 'sdr-jpeg', 'nope']) {
      expect(() => sealStudioEmbeddedSubtitles(graph, binding, undefined, format)).toThrow('no caption track');
    }
  });

  it('reads an undetermined language that Matroska and MOV leave untagged', () => {
    const seal = sealStudioEmbeddedSubtitles(graph, binding, undefined, 'mkv-h264');
    const content = '1\n00:00:00,000 --> 00:00:02,000\nCaption\n';
    const stream = { codec: 'subrip', language: null, default: 1, forced: 0 };
    expect(findEmbeddedSubtitleMismatch(seal, { streams: [stream], content })).toBeNull();
    expect(findEmbeddedSubtitleMismatch(seal, { streams: [{ ...stream, language: 'eng' }], content })).toMatch(
      'immutable',
    );
  });
});
