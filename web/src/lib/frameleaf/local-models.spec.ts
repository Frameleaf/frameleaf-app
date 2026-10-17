import { HardwareBackend, type HardwareCheckResponseDto } from '@frameleaf/sdk';
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

const check = (ml: { model: string | null; vramGb: number | null; backend: HardwareBackend }, mlImage: string | null) =>
  ({
    checkedAt: '2026-09-26T09:00:00.000Z',
    server: {
      reachable: true,
      vendor: null,
      model: null,
      vramGb: null,
      driver: null,
      backend: HardwareBackend.Cpu,
      test: null,
      gpu: { present: null, visible: null, usable: null },
    },
    ml: {
      reachable: true,
      vendor: null,
      driver: null,
      test: null,
      gpu: { present: null, visible: null, usable: null },
      ...ml,
    },
    mlImage,
    issues: [],
    findings: [],
    workers: [],
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
    const hardware = localHardware(
      check({ model: 'NVIDIA GeForce RTX 3060', vramGb: 12, backend: HardwareBackend.Cuda }, 'cuda'),
    );
    expect(byName(localStops(LOCAL_DESCRIPTION_MODELS, hardware, 'both'))).toEqual({
      'Florence-2 base': { band: 'gpu', reason: null },
      'Florence-2 large': { band: 'gpu', reason: null },
      'Qwen2.5-VL 3B': { band: 'gpu', reason: null },
      // the CUDA image has no OpenVINO, so a Qwen model that does not fit the GPU has nowhere to run
      'Qwen2.5-VL 7B': { band: 'none', reason: 'memory' },
      'Qwen3-VL 30B-A3B': { band: 'none', reason: 'memory' },
      'Qwen2.5-VL 32B': { band: 'none', reason: 'memory' },
      'Qwen2.5-VL 72B': { band: 'none', reason: 'memory' },
    });
  });

  it('runs only Florence, on the processor, in the processor image (FL-427)', () => {
    const hardware = localHardware(check({ model: null, vramGb: null, backend: HardwareBackend.Cpu }, 'cpu'));
    expect(hardware).toEqual({ known: true, gpu: null, image: 'cpu' });
    expect(byName(localStops(LOCAL_DESCRIPTION_MODELS, hardware, 'local'))).toEqual({
      'Florence-2 base': { band: 'cpu', reason: null },
      'Florence-2 large': { band: 'cpu', reason: null },
      'Qwen2.5-VL 3B': { band: 'none', reason: 'image' },
      'Qwen2.5-VL 7B': { band: 'none', reason: 'image' },
      'Qwen3-VL 30B-A3B': { band: 'none', reason: 'image' },
      'Qwen2.5-VL 32B': { band: 'none', reason: 'image' },
      'Qwen2.5-VL 72B': { band: 'none', reason: 'image' },
    });
  });

  it('runs the converted Qwen models in the OpenVINO image, on its GPU or the processor, and never Florence', () => {
    const arc = byName(
      localStops(
        LOCAL_DESCRIPTION_MODELS,
        localHardware(check({ model: 'Intel Arc A770', vramGb: 16, backend: HardwareBackend.OpenVino }, 'openvino')),
        'local',
      ),
    );
    expect(arc['Florence-2 base']).toEqual({ band: 'none', reason: 'image' });
    expect(arc['Qwen2.5-VL 3B']).toEqual({ band: 'gpu', reason: null });
    expect(arc['Qwen2.5-VL 7B']).toEqual({ band: 'gpu', reason: null });
    expect(arc['Qwen3-VL 30B-A3B']).toEqual({ band: 'none', reason: 'image' });

    const processor = byName(
      localStops(
        LOCAL_DESCRIPTION_MODELS,
        localHardware(check({ model: null, vramGb: null, backend: HardwareBackend.Cpu }, 'openvino')),
        'local',
      ),
    );
    expect(processor['Qwen2.5-VL 3B']).toEqual({ band: 'cpu', reason: null });
    expect(processor['Qwen2.5-VL 7B']).toEqual({ band: 'cpu', reason: null });
  });

  it('runs Florence on the processor in a CUDA image that reaches no GPU, and nothing else', () => {
    const stops = byName(
      localStops(
        LOCAL_DESCRIPTION_MODELS,
        localHardware(check({ model: null, vramGb: null, backend: HardwareBackend.Cpu }, 'cuda')),
        'local',
      ),
    );
    expect(stops['Florence-2 base']).toEqual({ band: 'cpu', reason: null });
    expect(stops['Qwen2.5-VL 3B']).toEqual({ band: 'none', reason: 'memory-no-gpu' });
  });

  it('runs no description model in the ROCm image', () => {
    const hardware = localHardware(
      check({ model: 'AMD Radeon RX 7900 XTX', vramGb: 24, backend: HardwareBackend.RoCm }, 'rocm'),
    );
    const stops = localStops(LOCAL_DESCRIPTION_MODELS, hardware, 'local');
    expect(stops.every((stop) => stop.band === 'none' && stop.reason?.kind === 'image')).toBe(true);
  });

  it('shows every stop as white when the check does not say which image the container runs', () => {
    const hardware = localHardware(check({ model: null, vramGb: null, backend: HardwareBackend.Cpu }, null));
    expect(hardware.known).toBe(false);
    const stops = localStops(LOCAL_DESCRIPTION_MODELS, hardware, 'local');
    expect(stops.every((stop) => stop.band === 'cpu' && stop.reason === null)).toBe(true);
  });

  it('crosses out the local stops of work set to Cloud only', () => {
    const hardware = localHardware(
      check({ model: 'NVIDIA GeForce RTX 4090', vramGb: 24, backend: HardwareBackend.Cuda }, 'cuda'),
    );
    const stops = localStops(LOCAL_DESCRIPTION_MODELS, hardware, 'cloud');
    expect(stops.find((stop) => stop.model.name === 'Qwen2.5-VL 7B')).toMatchObject({
      band: 'gpu',
      reason: { kind: 'cloud-only' },
    });
  });
});
