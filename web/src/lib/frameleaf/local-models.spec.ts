import type { HardwareCheckResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import en from '$i18n/en.json';
import { ROUTED_WORKLOADS } from '$lib/frameleaf/cloud-ml';
import {
  LOCAL_DESCRIPTION_MODELS,
  localHardware,
  localModelsFor,
  localStops,
  type LocalStop,
} from '$lib/frameleaf/local-models';
import {
  DESCRIPTION_MODEL_PROFILES,
  FALLBACK_MODEL_PROFILES,
} from '../../routes/admin/system-settings/machine-learning/machine-learning-helpers';

type Backend = HardwareCheckResponseDto['ml']['backend'];

const check = (ml: { model: string | null; vramGb: number | null; backend: Backend }) =>
  ({
    checkedAt: '2026-09-26T09:00:00.000Z',
    server: {
      reachable: true,
      vendor: null,
      model: null,
      vramGb: null,
      driver: null,
      backend: 'CPU',
      test: null,
    },
    ml: { reachable: true, vendor: null, driver: null, test: null, ...ml },
    mlImage: null,
    issues: [],
    benchmark: null,
  }) as HardwareCheckResponseDto;

const byName = (stops: LocalStop[]) =>
  Object.fromEntries(stops.map((stop) => [stop.model.name, { band: stop.band, reason: stop.reason?.kind ?? null }]));

describe('local model stops (FL-189)', () => {
  it('offers only model names the description setting already accepts, lightest first', () => {
    const accepted = new Set([...DESCRIPTION_MODEL_PROFILES, ...FALLBACK_MODEL_PROFILES].map((entry) => entry.value));
    for (const model of LOCAL_DESCRIPTION_MODELS) {
      expect(accepted.has(model.value), model.value).toBe(true);
    }
    const memory = LOCAL_DESCRIPTION_MODELS.map((model) => model.vramGb);
    expect(memory).toEqual([...memory].sort((a, b) => a - b));
    // the default the server ships with is a stop
    expect(LOCAL_DESCRIPTION_MODELS.map((model) => model.value)).toContain('Qwen/Qwen2.5-VL-3B-Instruct');
  });

  it('has a note for every stop', () => {
    const admin = (en as { admin: Record<string, string> }).admin;
    for (const model of LOCAL_DESCRIPTION_MODELS) {
      expect(admin[model.noteKey.replace('admin.', '')], model.noteKey).toBeTruthy();
    }
  });

  it('gives only descriptions a local model setting', () => {
    expect(ROUTED_WORKLOADS.filter((row) => localModelsFor(row).length > 0)).toEqual(['descriptions']);
  });

  it('shows every stop as white, with nothing crossed out, before a hardware check', () => {
    const hardware = localHardware(null);
    expect(hardware.known).toBe(false);
    const stops = localStops(LOCAL_DESCRIPTION_MODELS, hardware, 'local');
    expect(stops.every((stop) => stop.band === 'cpu' && stop.reason === null)).toBe(true);
  });

  it('colours the models that fit a CUDA GPU green, and crosses out the ones that need more memory', () => {
    const hardware = localHardware(check({ model: 'NVIDIA GeForce RTX 3060', vramGb: 12, backend: 'CUDA' }));
    expect(byName(localStops(LOCAL_DESCRIPTION_MODELS, hardware, 'both'))).toEqual({
      'Florence-2 base': { band: 'gpu', reason: null },
      'Florence-2 large': { band: 'gpu', reason: null },
      'Qwen2.5-VL 3B': { band: 'gpu', reason: null },
      'Qwen2.5-VL 7B': { band: 'cpu', reason: null },
      'Qwen3-VL 30B-A3B': { band: 'none', reason: 'memory' },
      'Qwen2.5-VL 32B': { band: 'none', reason: 'memory' },
      'Qwen2.5-VL 72B': { band: 'none', reason: 'memory' },
    });
  });

  it('keeps CUDA-only models off a GPU that does not use CUDA', () => {
    const hardware = localHardware(check({ model: 'Intel Arc A770', vramGb: 16, backend: 'OpenVINO' }));
    const stops = byName(localStops(LOCAL_DESCRIPTION_MODELS, hardware, 'local'));
    expect(stops['Florence-2 base']).toEqual({ band: 'none', reason: 'cuda' });
    expect(stops['Qwen2.5-VL 3B']).toEqual({ band: 'gpu', reason: null });
    expect(stops['Qwen2.5-VL 7B']).toEqual({ band: 'gpu', reason: null });
  });

  it('runs the converted models on the processor when the check found no GPU', () => {
    const hardware = localHardware(check({ model: null, vramGb: null, backend: 'CPU' }));
    expect(hardware).toEqual({ known: true, gpu: null });
    const stops = byName(localStops(LOCAL_DESCRIPTION_MODELS, hardware, 'local'));
    expect(stops['Qwen2.5-VL 3B']).toEqual({ band: 'cpu', reason: null });
    expect(stops['Florence-2 large']).toEqual({ band: 'none', reason: 'memory-no-gpu' });
  });

  it('crosses out the local stops of work set to Cloud only', () => {
    const hardware = localHardware(check({ model: 'NVIDIA GeForce RTX 4090', vramGb: 24, backend: 'CUDA' }));
    const stops = localStops(LOCAL_DESCRIPTION_MODELS, hardware, 'cloud');
    expect(stops.find((stop) => stop.model.name === 'Qwen2.5-VL 7B')).toMatchObject({
      band: 'gpu',
      reason: { kind: 'cloud-only' },
    });
  });
});
