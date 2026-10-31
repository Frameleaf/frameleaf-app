import { describe, expect, it } from 'vitest';
import en from '../../../../i18n/en.json';
import {
  BANDS,
  CLOUD_DEFAULT_MODELS,
  LADDER_WORKLOADS,
  MATCHED_WORKLOADS,
  PRICE_MULTIPLIER,
  bandFor,
  cloudPositions,
  composeFixes,
  estimateCost,
  fixStepKey,
  fixYaml,
  gpuClassLabelKey,
  gpuClasses,
  gpuProblems,
  gpuProfileFor,
  interpolationEstimate,
  interpolationWork,
  isCloudOffered,
  ladderFor,
  ladderStates,
  localTwinId,
  matchedLadders,
  modelLadders,
  modelLicenceNoteKey,
  modelNoteKey,
  positionById,
  positionState,
  problemById,
  problemExplainKey,
  quotedUnitCost,
  resolvePosition,
  startFees,
  workloadUnitKey,
  type DetectedGpu,
  type LadderWorkload,
} from './gpu-model-catalog';

/**
 * Ported from the prototype's tests/gpu-model-catalog.test.mjs (effd05ffb7). The prototype's sample
 * hardware states are fixtures here: production reads the GPU each container really reports.
 */
const gpus: Record<string, DetectedGpu | null> = {
  'cpu-only': null,
  gtx1650: { name: 'GeForce GTX 1650', vramGb: 4, backend: 'CUDA', profile: 'gtx1650_4' },
  rtx3060: { name: 'GeForce RTX 3060', vramGb: 12, backend: 'CUDA', profile: 'rtx3060_12' },
  rtx4090: { name: 'GeForce RTX 4090', vramGb: 24, backend: 'CUDA', profile: 'rtx4090_24' },
};
const bands = (workload: LadderWorkload, gpu: DetectedGpu | null, cpuProfile?: 'cpu8' | 'mac_docker') =>
  ladderFor(workload).map((item) => bandFor(item, gpu, cpuProfile));
const messages = en as unknown as Record<string, string>;

describe('gpu model catalogue (FL-159, CLD-201)', () => {
  it('runs ladders light to heavy with at most two models per size class; Studio export is local only', () => {
    const order = ['cpu', 'tiny', 'small', 'medium', 'large', 'xl'];
    for (const workload of LADDER_WORKLOADS) {
      const ladder = ladderFor(workload);
      // Smooth motion is RIFE only (owner decision 2026-09-27); Studio export has two encoders
      const least = { interpolation: 1, render: 2 } as Partial<Record<string, number>>;
      expect(ladder.length).toBeGreaterThanOrEqual(least[workload] ?? 3);
      if (workload === 'render') {
        expect(cloudPositions(workload)).toHaveLength(0);
      } else {
        expect(cloudPositions(workload).length).toBeGreaterThanOrEqual(1);
      }
      const sizes = ladder.map((item) => order.indexOf(item.sizeClass));
      expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
      for (const size of order) {
        expect(ladder.filter((item) => item.sizeClass === size).length).toBeLessThanOrEqual(2);
      }
    }
    expect(ladderFor('descriptions').at(-1)?.id).toBe('qwen3.5-122b-a10b@1');
  });

  it('bands follow the detected GPU: white on CPU, green on the GPU, blue beyond it', () => {
    expect(bands('descriptions', gpus['cpu-only'])).toEqual([
      'cpu',
      'cpu',
      'cpu',
      'cpu',
      'cpu',
      'cloud',
      'cloud',
      'cloud',
      'cloud',
      'cloud',
    ]);
    expect(bands('descriptions', gpus.gtx1650)).toEqual([
      'gpu',
      'gpu',
      'gpu',
      'gpu',
      'gpu',
      'cloud',
      'cloud',
      'cloud',
      'cloud',
      'cloud',
    ]);
    expect(bands('descriptions', gpus.rtx3060)).toEqual([
      'gpu',
      'gpu',
      'gpu',
      'gpu',
      'gpu',
      'gpu',
      'gpu',
      'cloud',
      'cloud',
      'cloud',
    ]);
    expect(bands('descriptions', gpus.rtx4090).slice(-3)).toEqual(['gpu', 'gpu', 'cloud']);
    expect(bands('restoration', gpus['cpu-only'])).toEqual(['cloud', 'cloud', 'cloud']);
    expect(bands('restoration', gpus.rtx3060)).toEqual(['gpu', 'cloud', 'cloud']);
  });

  it('matches a detected card to its research profile only by name and memory', () => {
    expect(gpuProfileFor('NVIDIA GeForce RTX 3060', 12)).toBe('rtx3060_12');
    expect(gpuProfileFor('AMD Radeon RX 7900 XTX', 24)).toBe('rx7900xtx_24');
    expect(gpuProfileFor('NVIDIA GeForce RTX 3060', 0)).toBeNull();
    expect(gpuProfileFor('NVIDIA A2000', 6)).toBeNull();
    // An unrated card is judged by memory.
    const card: DetectedGpu = { name: 'NVIDIA A2000', vramGb: 6, backend: 'CUDA', profile: null };
    expect(bandFor(positionById('realbasicvsr@1'), card)).toBe('gpu');
    expect(bandFor(positionById('seedvr2-3b@1'), card)).toBe('cloud');
  });

  it('the route disables stops with a reason: local only blocks blue, cloud only keeps hosted models', () => {
    const gpu = gpus.gtx1650;
    const local = ladderStates('descriptions', { gpu, route: 'local' });
    expect(
      local
        .filter((entry) => entry.band === 'cloud')
        .every((entry) => entry.disabled && entry.reasons[0].key === 'frameleaf_model_reason_local_only'),
    ).toBe(true);
    expect(local.filter((entry) => entry.band === 'gpu').every((entry) => !entry.disabled)).toBe(true);
    const cloud = ladderStates('descriptions', { gpu, route: 'cloud' });
    expect(cloud.every((entry) => entry.band === 'cloud' && entry.runsOn === 'cloud')).toBe(true);
    const encoders = ladderStates('render', { gpu, route: 'cloud' });
    expect(
      encoders
        .filter((entry) => entry.band !== 'cloud')
        .every((entry) => entry.disabled && entry.reasons[0].key === 'frameleaf_model_reason_cloud_only'),
    ).toBe(true);
    expect(ladderStates('descriptions', { gpu, route: 'both' }).every((entry) => !entry.disabled)).toBe(true);
    const resolved = resolvePosition('descriptions', 'qwen3.5-122b-a10b@1', { gpu, route: 'local' });
    expect(resolved?.runsOn).toBe('local');
    expect(resolved?.fallback).toBe(true);
    // The prototype fell back to the lightest cloud model; the FL-146 owner decision sets a licensed default.
    expect(resolvePosition('descriptions', null, { gpu: null, route: 'cloud' })?.item.id).toBe('qwen3.5-9b@1');
    expect(resolvePosition('upscale', null, { gpu: null, route: 'cloud' })?.item.id).toBe(
      ladderStates('upscale', { gpu: null, route: 'cloud' }).find((entry) => !entry.disabled)?.item.id,
    );
  });

  it('every stop carries text and an icon, never colour alone', () => {
    const gpu = gpus.gtx1650;
    const [cpu] = ladderStates('descriptions', { gpu: null });
    expect(cpu.band).toBe('cpu');
    expect(cpu.seconds).toBeGreaterThan(0);
    const green = positionState(positionById('moondream2@1')!, { gpu });
    expect(green.band).toBe('gpu');
    expect(green.seconds).toBeGreaterThan(0);
    const blue = positionState(positionById('qwen3.5-122b-a10b@1')!, { gpu });
    expect(blue.quote?.per).toBe(100);
    expect(blue.quote?.usd).toBeGreaterThan(0);
    expect(positionState(positionById('qwen3.5-4b@1')!, { gpu }).speedClass).toBe('slow');
    for (const band of Object.values(BANDS)) {
      expect(band.icon).toMatch(/^mdi/);
      expect(messages[band.labelKey]).toBeTruthy();
    }
  });

  it('estimate maths: 2× loaded rate, a start fee per worker, the hold from p90', () => {
    expect(PRICE_MULTIPLIER).toBe(2);
    for (const item of gpuClasses) {
      expect(Math.abs(item.customerUsdPerSec - item.loadedUsdPerSec * 2)).toBeLessThan(1e-7);
    }
    expect(Math.abs(gpuClasses.find((item) => item.id === 'gpu48pro')!.customerUsdPerSec - 0.00130035)).toBeLessThan(
      1e-7,
    );
    expect(Math.abs(gpuClasses.find((item) => item.id === 'gpu80pro')!.customerUsdPerSec - 0.00370161)).toBeLessThan(
      1e-7,
    );
    const item = positionById('qwen3.5-27b@1')!;
    const rate = gpuClasses.find((entry) => entry.id === item.cloud!.gpuClass)!.customerUsdPerSec;
    const estimate = estimateCost(item, 250)!;
    expect(estimate.startFee).toBe(startFees[item.cloud!.feeClass].customerUsd);
    expect(estimate.workers).toBe(1);
    expect(Math.abs(estimate.p50 - (estimate.startFee + 250 * item.cloud!.secondsPerUnit.p50 * rate))).toBeLessThan(
      1e-6,
    );
    expect(estimate.hold).toBe(Math.ceil(estimate.p90 * 100) / 100);
    expect(estimateCost(item, 1)!.p50).toBeGreaterThan(estimateCost(item, 1)!.perUnit.p50);
    expect(estimateCost(item, 0)).toBeNull();
    const video = estimateCost('seedvr2-3b@1', 1)!;
    expect(video.workers).toBe(2);
    expect(estimateCost('seedvr2-3b@1', 60)!.workers).toBe(5);
    expect(Math.abs(video.p50 - (2 * video.startFee + video.workSeconds.p50 * video.rate))).toBeLessThan(1e-6);
    for (const fee of Object.values(startFees)) {
      const cls = gpuClasses.find((entry) => entry.id === fee.gpuClass)!;
      expect(fee.customerUsd + 1e-9).toBeGreaterThanOrEqual(2 * 1.07 * (fee.coldStartP90 + 5) * cls.flexUsdPerSec);
    }
    expect(quotedUnitCost(positionById('qwen3.5-9b@1'))!.usd).toBeGreaterThan(0);
  });

  it('offers every position with a cloud offer, whatever its licence allows for commercial hosting (FL-451)', () => {
    const qwen = positionById('qwen3.5-9b@1')!;
    for (const commercialHosted of ['yes', 'conditions', 'no'] as const) {
      const item = { ...qwen, commercialHosted, licence: 'CC-BY-NC-4.0 (non-commercial)' };
      expect(isCloudOffered(item), commercialHosted).toBe(true);
      expect(positionState(item, { gpu: null, route: 'cloud' }).runsOn).toBe('cloud');
    }
    const offered = Object.values(modelLadders)
      .flat()
      .filter((item) => item.cloud !== null);
    expect(cloudPositions()).toEqual(offered);
  });

  it('offers the nllb-clip models, MusicGen-small and Qwen2.5-VL-3B on the cloud like any other (FL-451)', () => {
    const qwen = positionById('qwen3.5-9b@1')!;
    for (const id of [
      'nllb-clip-base-siglip__mrl@1',
      'nllb-clip-large-siglip__v1@1',
      'musicgen-small@1',
      'Xenova/musicgen-small',
      'Qwen/Qwen2.5-VL-3B-Instruct',
      'qwen2.5-vl-3b@1',
      'llmware/qwen2.5-vl-3b-ov',
    ]) {
      const item = { ...qwen, id };
      expect(isCloudOffered(item), id).toBe(true);
      for (const route of ['cloud', 'both'] as const) {
        expect(positionState(item, { gpu: null, route }).runsOn, `${id} ${route}`).toBe('cloud');
      }
    }
    // a position without a cloud offer is still never hosted
    expect(isCloudOffered({ ...qwen, cloud: null })).toBe(false);
  });

  it('defaults cloud descriptions to a commercially licensed catalogue pick (FL-146)', () => {
    const id = CLOUD_DEFAULT_MODELS.descriptions!;
    const item = positionById(id)!;
    expect(item.workload).toBe('descriptions');
    expect(isCloudOffered(item)).toBe(true);
    expect(item.licence).toMatch(/^(Apache-2\.0|MIT)$/);
    // Nothing chosen and nothing runs here: the cloud default, not the lightest cloud model.
    expect(resolvePosition('descriptions', '', { gpu: null, route: 'cloud' })?.item.id).toBe(id);
  });

  it('every problem points at a real fix, and the fixes are the right ones per vendor', () => {
    expect(gpuProblems.length).toBeGreaterThanOrEqual(19);
    for (const problem of gpuProblems) {
      if (problem.fix) {
        expect(composeFixes[problem.fix]).toBeTruthy();
      }
      expect(messages[problemExplainKey(problem.id)]).toBeTruthy();
    }
    for (const [id, fix] of Object.entries(composeFixes)) {
      for (let step = 1; step <= fix.steps; step++) {
        expect(messages[fixStepKey(id as keyof typeof composeFixes, step)]).toBeTruthy();
      }
    }
    expect(composeFixes.nvidia.yaml).toMatch(/reservations:\s+devices:\s+- driver: nvidia/);
    expect(composeFixes.nvidia.yaml).not.toMatch(/\/dev\/dri/);
    expect(composeFixes.intel.yaml).toMatch(/\/dev\/dri/);
    expect(composeFixes.intel.yaml).toMatch(/group_add/);
    expect(composeFixes.amd.yaml).toMatch(/\/dev\/kfd/);
    expect(JSON.stringify({ composeFixes, gpuProblems, gpuClasses, modelLadders })).not.toMatch(/runpod|immich/i);
  });

  it('fills a fix with what the check found (FL-159)', () => {
    expect(fixYaml('render-group', { gid: 107 })).toContain('- "107"');
    expect(fixYaml('wrong-gpu', { pciAddress: '0000:0a:00.0' })).toContain(
      '/dev/dri/by-path/pci-0000:0a:00.0-render:/dev/dri/renderD128',
    );
    expect(fixYaml('rocm-gfx', { gfxVersion: '11.0.0' })).toContain('HSA_OVERRIDE_GFX_VERSION=11.0.0');
    // The reference list shows examples; the Mac has nothing to put in docker compose.
    expect(fixYaml('render-group')).toContain('- "993"');
    expect(fixYaml('macos')).toBeNull();
    for (const id of ['wrong-gpu', 'unraid', 'macos', 'render-group', 'nvidia-bf16']) {
      expect(problemById(id)).toBeTruthy();
    }
    expect(problemById('nvidia-bf16')?.note).toBe(true);
  });

  it('has copy for every model, GPU class and unit', () => {
    for (const item of Object.values(modelLadders).flat()) {
      expect(messages[modelNoteKey(item)], item.id).toBeTruthy();
      if (item.licenceNote) {
        expect(messages[modelLicenceNoteKey(item)], item.id).toBeTruthy();
      }
    }
    for (const item of gpuClasses) {
      expect(messages[gpuClassLabelKey(item.id)]).toBeTruthy();
    }
    for (const workload of LADDER_WORKLOADS) {
      expect(messages[workloadUnitKey(workload)]).toContain('{count');
    }
  });

  it('smooth motion is RIFE only (owner decision 2026-09-27): no FILM option anywhere, cloud tier commercial-OK', () => {
    expect(ladderFor('interpolation').map((item) => item.id)).toEqual(['rife-4.25@1']);
    expect(positionById('film@1')).toBeNull();
    expect(bands('interpolation', gpus['cpu-only'])).toEqual(['cpu']);
    expect(bands('interpolation', gpus.rtx3060)).toEqual(['gpu']);
    for (const item of cloudPositions('interpolation')) {
      expect(item.licence).toMatch(/^(MIT|Apache-2\.0)$/);
    }
  });

  it('smooth motion estimates: new frames per source minute, chunked cloud workers, ~2× size at double rate', () => {
    const work = interpolationWork({ durationSeconds: 120, sourceFps: 30, targetFps: 60 });
    expect(work).toEqual({ ratio: 2, units: 2, sizeFactor: 2 });
    expect(interpolationWork({ durationSeconds: 60, sourceFps: 25, targetFps: 50 }).sizeFactor).toBe(2);
    expect(interpolationWork({ durationSeconds: 60, sourceFps: 30, targetFps: 120 }).units).toBe(3);
    const local = interpolationEstimate(positionById('rife-4.25@1')!, work, { gpu: gpus.gtx1650 });
    expect(local.runsOn).toBe('gpu');
    expect(local.seconds).toBeGreaterThan(0);
    expect(local.cost).toBeNull();
  });

  describe('smart search and faces (FL-455)', () => {
    const ids = (workload: 'search' | 'faces', options: Parameters<typeof ladderStates>[1] = {}) =>
      ladderStates(workload, options).map((entry) => entry.item.id);

    it("lists this server's models light to heavy, and the cloud stop only while Frameleaf Cloud offers it", () => {
      expect(ids('search')).toEqual([
        'ViT-B-32__openai',
        'ViT-B-16-SigLIP-384__webli',
        'ViT-SO400M-16-SigLIP2-384__webli',
      ]);
      expect(ids('faces')).toEqual(['buffalo_s', 'buffalo_m', 'buffalo_l', 'antelopev2']);
      expect(ids('search', { cloudMatched: ['face', 'enrichment'] })).not.toContain('ViT-B-16-SigLIP-384__webli@cloud');
      expect(ids('search', { cloudMatched: ['clip'] }).slice(-2)).toEqual([
        'ViT-B-32__openai@cloud',
        'ViT-B-16-SigLIP-384__webli@cloud',
      ]);
      expect(ids('faces', { cloudMatched: ['face'] }).slice(-2)).toEqual(['buffalo_l@cloud', 'antelopev2@cloud']);
    });

    it("shows only the cloud stop of the model this server is set to (A3: the release's pins)", () => {
      const search = (model: string) => ids('search', { cloudMatched: ['clip'], model });
      expect(search('ViT-B-32__openai').filter((id) => id.endsWith('@cloud'))).toEqual(['ViT-B-32__openai@cloud']);
      expect(search('ViT-B-16-SigLIP-384__webli').filter((id) => id.endsWith('@cloud'))).toEqual([
        'ViT-B-16-SigLIP-384__webli@cloud',
      ]);
      // a model the release does not pin for the cloud gets no blue stop at all
      expect(search('ViT-SO400M-16-SigLIP2-384__webli').some((id) => id.endsWith('@cloud'))).toBe(false);
      const faces = (model: string) => ids('faces', { cloudMatched: ['face'], model });
      expect(faces('antelopev2').filter((id) => id.endsWith('@cloud'))).toEqual(['antelopev2@cloud']);
      expect(faces('buffalo_l').filter((id) => id.endsWith('@cloud'))).toEqual(['buffalo_l@cloud']);
      expect(faces('buffalo_s').some((id) => id.endsWith('@cloud'))).toBe(false);
      // the local stops stay whatever the model
      expect(faces('buffalo_s').slice(0, 4)).toEqual(['buffalo_s', 'buffalo_m', 'buffalo_l', 'antelopev2']);
      expect(localTwinId('antelopev2@cloud')).toBe('antelopev2');
      expect(localTwinId('antelopev2')).toBe('antelopev2');
    });

    it('turns the cloud stop blue only when matched; every other stop stays white or green', () => {
      const cloudSearch = positionById('ViT-B-16-SigLIP-384__webli@cloud')!;
      expect(cloudSearch.cloudMatch).toBe('clip');
      expect(isCloudOffered(cloudSearch)).toBe(false);
      expect(isCloudOffered(cloudSearch, ['clip'])).toBe(true);
      expect(bandFor(cloudSearch, gpus.rtx4090)).toBe('none');
      expect(bandFor(cloudSearch, gpus.rtx4090, 'cpu8', ['clip'])).toBe('cloud');
      expect(cloudPositions('search')).toEqual([]);
      expect(cloudPositions('search', ['clip'])).toEqual([positionById('ViT-B-32__openai@cloud'), cloudSearch]);
      // never part of the routed cloud list (the Cloud processing estimate)
      expect(cloudPositions().some((item) => item.cloudMatch)).toBe(false);

      const matched = ['clip', 'face'];
      for (const workload of MATCHED_WORKLOADS) {
        const states = ladderStates(workload, { gpu: gpus.gtx1650, route: 'both', cloudMatched: matched });
        expect(states.map((entry) => entry.band)).toEqual([...states.slice(0, -2).map(() => 'gpu'), 'cloud', 'cloud']);
        expect(states.every((entry) => !entry.disabled)).toBe(true);
        const cpu = ladderStates(workload, { gpu: null, cloudMatched: matched });
        expect(cpu.slice(0, -2).every((entry) => entry.band === 'cpu')).toBe(true);
        // only this server's model has a cloud offer
        expect(
          ladderFor(workload)
            .filter((item) => item.cloud)
            .every((item) => item.cloudMatch),
        ).toBe(true);
      }
      // Local only crosses the blue stop out with the reason, like any other ladder
      const local = ladderStates('faces', { gpu: null, route: 'local', cloudMatched: ['face'] }).at(-1)!;
      expect(local.band).toBe('cloud');
      expect(local.reasons[0].key).toBe('frameleaf_model_reason_local_only');
    });

    it('prices the cloud stop with the Frameleaf Cloud contract figures', () => {
      const search = estimateCost('ViT-B-16-SigLIP-384__webli@cloud', 1000, ['clip'])!;
      expect(search.rate).toBe(0.00076906);
      expect(search.startFee).toBe(0.08);
      expect(search.workers).toBe(1);
      expect(search.p50).toBeCloseTo(0.0892, 4);
      expect(search.p90).toBeCloseTo(0.0985, 4);
      expect(search.hold).toBe(0.1);
      const faces = estimateCost('buffalo_l@cloud', 1000, ['face'])!;
      expect(faces.p50).toBeCloseTo(0.1031, 4);
      expect(faces.p90).toBeCloseTo(0.1261, 4);
      // the pinned models' stops carry the Cloud model ladder's planning figures
      const vit = estimateCost('ViT-B-32__openai@cloud', 1000, ['clip'])!;
      expect(vit.p50).toBeCloseTo(0.0862, 4);
      expect(vit.p90).toBeCloseTo(0.0923, 4);
      const antelope = estimateCost('antelopev2@cloud', 1000, ['face'])!;
      expect(antelope.p50).toBeCloseTo(0.1108, 4);
      expect(antelope.p90).toBeCloseTo(0.1415, 4);
      // not offered, no estimate
      expect(estimateCost('buffalo_l@cloud', 1000)).toBeNull();
      expect(estimateCost('buffalo_l@cloud', 1000, ['clip'])).toBeNull();
      const quote = quotedUnitCost(positionById('ViT-B-16-SigLIP-384__webli@cloud'), ['clip'])!;
      expect(quote.per).toBe(1000);
      expect(quote.usd).toBeCloseTo(0.0092, 4);
      const state = positionState(positionById('buffalo_l@cloud')!, { cloudMatched: ['face'] });
      expect(state.quote?.usd).toBeCloseTo(0.0231, 4);
      // the research tables every other ladder uses are unchanged
      expect(startFees['small-24'].customerUsd).toBe(0.05);
    });

    it('has copy for every model and unit', () => {
      for (const item of Object.values(matchedLadders).flat()) {
        expect(messages[modelNoteKey(item)], item.id).toBeTruthy();
      }
      for (const workload of MATCHED_WORKLOADS) {
        expect(messages[workloadUnitKey(workload)]).toContain('{count');
      }
      // what is searched for never goes to the cloud
      expect(messages[modelNoteKey({ id: 'ViT-B-16-SigLIP-384__webli@cloud' })]).toMatch(
        /search for is always read on this server/,
      );
    });
  });
});
