import {
  MediaOperationDestination,
  StudioExportColor,
  StudioExportFormat,
  StudioExportResolution,
  type StudioRenderEvidenceDto,
} from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  evaluateStudioRender,
  studioRenderChoices,
  studioRenderRefusalFromError,
  studioRenderRefusalKey,
  type StudioRenderSettings,
} from '$lib/frameleaf/studio/render-output';

const GIB = 1024 ** 3;

const evidence = (overrides: Partial<StudioRenderEvidenceDto> = {}): StudioRenderEvidenceDto => ({
  destination: MediaOperationDestination.Lan,
  sessions: 1,
  gpuMemoryBytes: 8 * GIB,
  codecs: ['hevc_nvenc', 'h264_nvenc'],
  maxBitDepth: 10,
  hdr10: true,
  dolbyVision: false,
  ...overrides,
});

const settings: StudioRenderSettings = {
  format: StudioExportFormat.Mp4HevcMain10,
  color: StudioExportColor.Preserve,
  resolution: StudioExportResolution.$2160P,
};

describe('Studio render output (FL-42)', () => {
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
