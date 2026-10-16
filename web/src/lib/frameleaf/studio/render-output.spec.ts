import {
  MediaOperationDestination,
  StudioExportColor,
  StudioExportFormat,
  StudioExportResolution,
  type StudioRenderEvidenceDto,
} from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import {
  evaluateStudioRender,
  studioRenderChoices,
  studioRenderRefusalFromError,
  studioRenderRefusalKey,
  type StudioRenderSettings,
} from '$lib/frameleaf/studio/render-output';

const GIB = 1024 ** 3;

const evidence = (overrides: Partial<StudioRenderEvidenceDto> = {}): StudioRenderEvidenceDto => {
  const row = {
    destination: MediaOperationDestination.Lan,
    sessions: 1,
    gpuMemoryBytes: 8 * GIB,
    codecs: ['hevc_nvenc', 'h264_nvenc'],
    maxBitDepth: 10,
    hdr10: true,
    dolbyVision: false,
    ...overrides,
  };
  return {
    ...row,
    candidates: [
      {
        gpuMemoryBytes: row.gpuMemoryBytes,
        outputFormats: [StudioExportFormat.Mp4HevcMain10, StudioExportFormat.Mp4H264],
        maxBitDepth: row.maxBitDepth,
        hdr10: row.hdr10,
        dolbyVision: row.dolbyVision,
      },
    ],
    ...overrides,
  };
};

const settings: StudioRenderSettings = {
  format: StudioExportFormat.Mp4HevcMain10,
  color: StudioExportColor.Preserve,
  resolution: StudioExportResolution.$2160P,
};

describe('Studio render output (FL-42)', () => {
  it('requires the paired profile on the SAME qualified writer, for an SDR video format', () => {
    const paired = {
      format: StudioExportFormat.Mp4H264,
      color: StudioExportColor.Preserve,
      resolution: StudioExportResolution.$720P,
      subtitleMode: 'sidecar',
      quality: 'high',
    } as StudioRenderSettings;
    const row = evidence();
    expect(evaluateStudioRender([row], MediaOperationDestination.Lan, paired).supported).toBe(false);
    row.candidates![0].sidecarOutputFormats = [StudioExportFormat.Mp4H264];
    expect(evaluateStudioRender([row], MediaOperationDestination.Lan, paired).supported).toBe(true);
    // FL-105: a paired profile covers every resolution and quality; the server still checks the tuple.
    for (const change of [{ quality: 'medium' }, { resolution: StudioExportResolution.$1080P }]) {
      expect(
        evaluateStudioRender([row], MediaOperationDestination.Lan, { ...paired, ...change } as StudioRenderSettings)
          .supported,
      ).toBe(true);
    }
    for (const change of [{ format: StudioExportFormat.Mp4HevcMain10 }, { color: StudioExportColor.Hdr10 }]) {
      expect(
        evaluateStudioRender([row], MediaOperationDestination.Lan, { ...paired, ...change } as StudioRenderSettings)
          .supported,
      ).toBe(false);
    }
    row.candidates![0].outputFormats = [];
    expect(evaluateStudioRender([row], MediaOperationDestination.Lan, paired).supported).toBe(false);
  });
  it('offers embedded only from the exact same admitted profile, preserving legacy Sidecar evidence', () => {
    const embedded = {
      format: StudioExportFormat.Mp4H264,
      color: StudioExportColor.Preserve,
      resolution: StudioExportResolution.$720P,
      subtitleMode: 'embedded',
      quality: 'high',
    } as StudioRenderSettings;
    const row = evidence();
    row.candidates![0].sidecarOutputFormats = [StudioExportFormat.Mp4H264];
    expect(evaluateStudioRender([row], MediaOperationDestination.Lan, embedded).supported).toBe(false);
    row.candidates![0].embeddedOutputFormats = [StudioExportFormat.Mp4H264];
    expect(evaluateStudioRender([row], MediaOperationDestination.Lan, embedded).supported).toBe(true);
    for (const patch of [{ format: StudioExportFormat.WebmAv1 }, { color: StudioExportColor.Hdr10 }]) {
      expect(
        evaluateStudioRender([row], MediaOperationDestination.Lan, { ...embedded, ...patch } as StudioRenderSettings)
          .supported,
      ).toBe(false);
    }
    row.candidates![0].outputFormats = [];
    expect(evaluateStudioRender([row], MediaOperationDestination.Lan, embedded).supported).toBe(false);
  });
  it('offers the FL-105 matrix formats a worker verified, with captions and sound alone', () => {
    const row = evidence({ maxBitDepth: 8, hdr10: false });
    const [candidate] = row.candidates!;
    candidate.outputFormats = [
      StudioExportFormat.Mp4H264,
      StudioExportFormat.MkvVp9,
      StudioExportFormat.MovProres422,
      StudioExportFormat.AudioWav,
      StudioExportFormat.Prores422Hq,
    ];
    candidate.sidecarOutputFormats = [StudioExportFormat.MkvVp9];
    candidate.embeddedOutputFormats = [StudioExportFormat.MkvVp9];
    const at = (patch: Partial<StudioRenderSettings>) =>
      evaluateStudioRender([row], MediaOperationDestination.Lan, {
        format: StudioExportFormat.MkvVp9,
        color: StudioExportColor.Preserve,
        resolution: StudioExportResolution.$1080P,
        ...patch,
      } as StudioRenderSettings);
    expect(at({})).toEqual({ supported: true });
    expect(at({ format: StudioExportFormat.MovProres422 })).toEqual({ supported: true });
    expect(at({ format: StudioExportFormat.MkvAv1 })).toEqual({ supported: false, refusal: 'codec-unavailable' });
    // ProRes 422 HQ promises a 10-bit picture this 8-bit worker did not verify.
    expect(at({ format: StudioExportFormat.Prores422Hq })).toEqual({ supported: false, refusal: 'incompatible-color' });
    expect(at({ subtitleMode: 'sidecar' } as never)).toEqual({ supported: true });
    expect(at({ subtitleMode: 'embedded' } as never)).toEqual({ supported: true });
    expect(at({ format: StudioExportFormat.MovProres422, subtitleMode: 'sidecar' } as never)).toEqual({
      supported: false,
      refusal: 'codec-unavailable',
    });
    expect(at({ format: StudioExportFormat.AudioWav })).toEqual({ supported: true });
    expect(at({ format: StudioExportFormat.AudioWav, subtitleMode: 'off' } as never)).toEqual({ supported: true });
    expect(at({ format: StudioExportFormat.AudioWav, subtitleMode: 'burn' } as never)).toEqual({
      supported: false,
      refusal: 'codec-unavailable',
    });
    // Sound alone is judged at the smallest picture size, whatever resolution is chosen.
    row.candidates![0].gpuMemoryBytes = 2 * GIB;
    const choices = studioRenderChoices([row], MediaOperationDestination.Lan, {
      format: StudioExportFormat.MkvVp9,
      color: StudioExportColor.Preserve,
      resolution: StudioExportResolution.$2160P,
    });
    expect(choices.formats.find((choice) => choice.value === StudioExportFormat.AudioWav)?.verdict).toEqual({
      supported: true,
    });
    expect(choices.formats.find((choice) => choice.value === StudioExportFormat.MkvVp9)?.verdict).toEqual({
      supported: false,
      refusal: 'insufficient-memory',
    });
  });

  it('accepts a combination a qualified session verified', () => {
    expect(evaluateStudioRender([evidence()], MediaOperationDestination.Lan, settings)).toEqual({ supported: true });
  });

  it('refuses in the order the server does: worker, memory, encoder, colour', () => {
    const lan = MediaOperationDestination.Lan;
    expect(evaluateStudioRender([], lan, settings)).toEqual({ supported: false, refusal: 'no-qualified-worker' });
    expect(evaluateStudioRender([evidence({ sessions: 0 })], lan, settings)).toMatchObject({
      refusal: 'no-qualified-worker',
    });
    expect(evaluateStudioRender([evidence()], MediaOperationDestination.Local, settings)).toMatchObject({
      refusal: 'no-qualified-worker',
    });
    expect(evaluateStudioRender([evidence({ gpuMemoryBytes: 4 * GIB })], lan, settings)).toMatchObject({
      refusal: 'insufficient-memory',
    });
    expect(evaluateStudioRender([evidence({ gpuMemoryBytes: null })], lan, settings)).toMatchObject({
      refusal: 'insufficient-memory',
    });
    expect(
      evaluateStudioRender([evidence()], lan, { ...settings, format: StudioExportFormat.Prores422Hq }),
    ).toMatchObject({ refusal: 'codec-unavailable' });
    expect(
      evaluateStudioRender([evidence()], lan, { ...settings, color: StudioExportColor.DolbyVision }),
    ).toMatchObject({ refusal: 'incompatible-color' });
    expect(evaluateStudioRender([evidence({ maxBitDepth: 8 })], lan, settings)).toMatchObject({
      refusal: 'incompatible-color',
    });
  });

  it('never combines memory, writer or colour proof from different sessions (FL-342)', () => {
    const row = evidence();
    const [candidate] = row.candidates!;
    const mixed = evidence({
      sessions: 2,
      candidates: [
        { ...candidate, outputFormats: [StudioExportFormat.Mp4H264], maxBitDepth: 8, hdr10: false },
        { ...candidate, gpuMemoryBytes: 2 * GIB },
      ],
    });
    expect(
      evaluateStudioRender([mixed], MediaOperationDestination.Lan, { ...settings, color: StudioExportColor.Hdr10 }),
    ).toEqual({ supported: false, refusal: 'codec-unavailable' });
    expect(
      evaluateStudioRender([mixed], MediaOperationDestination.Lan, {
        ...settings,
        resolution: StudioExportResolution.$720P,
        color: StudioExportColor.Hdr10,
      }),
    ).toEqual({ supported: true });
    expect(
      evaluateStudioRender(
        [
          evidence({
            candidates: [
              { ...candidate, maxBitDepth: 8, hdr10: false },
              { ...candidate, outputFormats: [StudioExportFormat.Mp4H264] },
            ],
          }),
        ],
        MediaOperationDestination.Lan,
        { ...settings, color: StudioExportColor.Hdr10 },
      ),
    ).toEqual({ supported: false, refusal: 'incompatible-color' });
  });

  it('requires per-session writer/container proof even if the legacy aggregate looks capable', () => {
    for (const candidates of [undefined, [], [{ ...evidence().candidates![0], outputFormats: [] }]]) {
      expect(evaluateStudioRender([evidence({ candidates })], MediaOperationDestination.Lan, settings).supported).toBe(
        false,
      );
    }
  });

  it('judges every choice against the other two settings as chosen', () => {
    const choices = studioRenderChoices([evidence({ gpuMemoryBytes: 4 * GIB })], MediaOperationDestination.Lan, {
      ...settings,
      resolution: StudioExportResolution.$1080P,
    });
    const verdict = <T>(list: { value: T; verdict: { supported: boolean } }[], value: T) =>
      list.find((choice) => choice.value === value)?.verdict;

    expect(verdict(choices.resolutions, StudioExportResolution.$1080P)).toEqual({ supported: true });
    expect(verdict(choices.resolutions, StudioExportResolution.$2160P)).toEqual({
      supported: false,
      refusal: 'insufficient-memory',
    });
    expect(verdict(choices.formats, StudioExportFormat.Mp4H264)).toEqual({ supported: true });
    expect(verdict(choices.formats, StudioExportFormat.WebmAv1)).toEqual({
      supported: false,
      refusal: 'codec-unavailable',
    });
    expect(verdict(choices.colors, StudioExportColor.Hdr10)).toEqual({ supported: true });
  });

  it('names every refusal and reads it from a refused export', () => {
    for (const refusal of [
      'no-qualified-worker',
      'insufficient-memory',
      'codec-unavailable',
      'incompatible-color',
    ] as const) {
      expect(studioRenderRefusalKey(refusal)).toMatch(/^frameleaf_studio_render_refusal_/);
      expect(studioRenderRefusalFromError({ code: 'studio_export_unsupported', reason: refusal })).toBe(refusal);
    }
    expect(studioRenderRefusalFromError({ code: 'other', reason: 'codec-unavailable' })).toBeNull();
    expect(studioRenderRefusalFromError({ code: 'studio_export_unsupported', reason: 'something-new' })).toBeNull();
    expect(studioRenderRefusalFromError(null)).toBeNull();
  });
});
